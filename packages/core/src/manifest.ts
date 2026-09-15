import { createHash } from "node:crypto"
import { isAbsolute, normalize } from "node:path"
import { bodyImports } from "./body.ts"
import { BUNDLE, BUNDLE_NODE_ONLY } from "./bundle.ts"
import { ToolError } from "./errors.ts"
import { LOCK_FILE } from "./lock.ts"
import { canonicalJson, isPlainObject } from "./validate.ts"
import { TIERS } from "./types.ts"
import type { JsonValue, Manifest, Tier } from "./types.ts"

// The directories and files flintd owns inside a Library. A Manifest may not name one, and no file helper reaches one.
const FLINTD_PATHS: readonly string[] = ["tools", "index.sqlite", LOCK_FILE, ".git", ".gitignore"]

// The SQLite sidecars carry the index name with a suffix, so the check is a prefix for that one entry.
export function flintdOwns(segment: string): boolean {
  return FLINTD_PATHS.includes(segment) || segment.startsWith("index.sqlite")
}

// The Node builtins a Body may import. Every one is pure computation: nothing here opens a file, a socket or a process.
export const NODE_BUILTINS: readonly string[] = [
  "node:assert",
  "node:buffer",
  "node:crypto",
  "node:path",
  "node:punycode",
  "node:querystring",
  "node:string_decoder",
  "node:url",
  "node:util",
  "node:zlib",
]

const MANIFEST_FIELDS = ["fs", "hosts", "connections", "exec"] as const
export const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
export const CONNECTION_NAME = /^[a-z][a-z0-9_-]{0,59}$/
const MAX_PATH_LENGTH = 200
const MAX_LIST = 20

export function assertManifest(value: unknown): Manifest {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw refuse(`A Manifest is a JSON object with the fields ${MANIFEST_FIELDS.join(", ")}, and it may be empty.`, {})
  }
  const unknown = Object.keys(value).filter((key) => !(MANIFEST_FIELDS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw refuse(
      `A Manifest holds only ${MANIFEST_FIELDS.join(", ")}, and this one holds ${unknown.join(", ")}. Remove what flintd does not read.`,
      { fields: unknown },
    )
  }
  const manifest: Manifest = {}
  const root = manifestRoot(value["fs"])
  if (root !== undefined) manifest.fs = root
  const hosts = names(value["hosts"], "hosts", HOSTNAME, hostAdvice)
  if (hosts.length > 0) manifest.hosts = hosts
  const connections = names(value["connections"], "connections", CONNECTION_NAME, connectionAdvice)
  if (connections.length > 0) manifest.connections = connections
  if (value["exec"] !== undefined && typeof value["exec"] !== "boolean") {
    throw refuse('The Manifest field "exec" is true or false: true asks to run a command, which needs the container tier.', {})
  }
  if (value["exec"] === true) manifest.exec = true
  return manifest
}

export function isEmptyManifest(manifest: Manifest): boolean {
  return Object.keys(manifest).length === 0
}

export function manifestHash(manifest: Manifest): string {
  return createHash("sha256").update(canonicalJson(manifest as unknown as JsonValue)).digest("hex")
}

// The sentence a person reads before deciding, so an Approval never asks about a hash.
export function manifestSummary(manifest: Manifest): string {
  const asks: string[] = []
  if (manifest.fs !== undefined) asks.push(`read and write files under ${JSON.stringify(manifest.fs)} in the Library directory`)
  if (manifest.hosts !== undefined) asks.push(`reach the hosts ${manifest.hosts.join(", ")}`)
  if (manifest.connections !== undefined) asks.push(`use the Connections ${manifest.connections.join(", ")}`)
  if (manifest.exec === true) asks.push("run a command in a container")
  return asks.length === 0 ? "nothing outside itself" : asks.join(", ")
}

// The lowest tier that serves the Manifest and the Body's imports. It refuses an import the Bundle does not hold.
export function tierFor(name: string, manifest: Manifest, body: string): Tier {
  // The Manifest is read before the Body: a Tool that asks for exec is the container tier's, whatever it imports.
  if (manifest.exec === true) return "container"
  return importsOf(name, body) ? "node" : "quickjs"
}

export function assertTier(value: unknown, name: string): Tier {
  if (typeof value === "string" && (TIERS as readonly string[]).includes(value)) return value as Tier
  throw new ToolError(
    "store_error",
    `The file tool.json of the Tool ${name} names the tier ${JSON.stringify(value)}, and a tier is one of ${TIERS.join(", ")}. Fix the file, or bring an earlier Version back with tool_update.`,
    { name },
  )
}

function importsOf(name: string, body: string): boolean {
  let needsNode = false
  for (const specifier of bodyImports(body)) {
    if (specifier === null) {
      throw new ToolError(
        "invalid_source",
        `${name} imports a module whose name is worked out while it runs, and flintd checks every import against the Bundle before it saves. Write the name as a literal string.`,
        { tool: name },
      )
    }
    if (BUNDLE.includes(specifier)) {
      if (BUNDLE_NODE_ONLY.includes(specifier)) needsNode = true
      continue
    }
    if (NODE_BUILTINS.includes(specifier)) {
      needsNode = true
      continue
    }
    throw new ToolError(
      "invalid_source",
      `${name} imports ${JSON.stringify(specifier)}, and a Body imports only what flintd ships. ${bundleAdvice()}`,
      { tool: name, specifier },
    )
  }
  return needsNode
}

function bundleAdvice(): string {
  return `The Bundle holds: ${BUNDLE.join(", ")}. A Body may also import these Node builtins: ${NODE_BUILTINS.join(", ")}. Importing a Node builtin, or ${BUNDLE_NODE_ONLY.join(", ")}, moves the Tool to the Node tier.`
}

function manifestRoot(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.trim().length === 0) {
    throw refuse('The Manifest field "fs" is one directory path, relative to the Library directory, for example "workspace".', {})
  }
  if (value.length > MAX_PATH_LENGTH || value.includes("\0")) {
    throw refuse(`The Manifest field "fs" must be a path of at most ${MAX_PATH_LENGTH} characters with no null byte.`, {})
  }
  // The container tier mounts this root as `<root>:/workspace`, so a ":" in it would be read as the mount's own separator.
  if (value.includes(":")) {
    throw refuse(`The Manifest root ${JSON.stringify(value)} holds a ":", and a Manifest root is one directory name without one. Rename the directory and name it here.`, { fs: value })
  }
  if (isAbsolute(value)) {
    throw refuse(`The Manifest root ${JSON.stringify(value)} is an absolute path. Name one directory relative to the Library directory.`, { fs: value })
  }
  const cleaned = normalize(value).replace(/\/+$/, "")
  if (cleaned === "" || cleaned === "." || cleaned.split("/").includes("..")) {
    throw refuse(
      `The Manifest root ${JSON.stringify(value)} is not one directory inside the Library. Name a directory such as "workspace"; ".." and the Library directory itself are refused.`,
      { fs: value },
    )
  }
  const first = cleaned.split("/")[0] as string
  if (flintdOwns(first)) {
    throw refuse(
      `The Manifest root ${JSON.stringify(value)} is inside ${first}, which belongs to flintd itself. Name a directory of your own, such as "workspace".`,
      { fs: value },
    )
  }
  return cleaned
}

function names(value: unknown, field: string, pattern: RegExp, advice: (entry: string) => string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw refuse(`The Manifest field ${JSON.stringify(field)} is a list of names.`, { field })
  if (value.length > MAX_LIST) {
    throw refuse(`The Manifest field ${JSON.stringify(field)} holds ${value.length} names, and the limit is ${MAX_LIST}.`, { field })
  }
  const found: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || !pattern.test(entry)) {
      throw refuse(advice(typeof entry === "string" ? entry : String(entry)), { field })
    }
    if (!found.includes(entry)) found.push(entry)
  }
  return found.sort()
}

function hostAdvice(entry: string): string {
  return `The Manifest host ${JSON.stringify(entry)} is not a hostname. Write the exact lower-case host a call reaches, such as "api.example.com", with no scheme, no port, no path and no wildcard.`
}

function connectionAdvice(entry: string): string {
  return `The Manifest Connection ${JSON.stringify(entry)} is not a Connection name. Use lower-case letters, digits, underscores and hyphens, starting with a letter.`
}

function refuse(message: string, details: Record<string, JsonValue>): ToolError {
  return new ToolError("invalid_manifest", message, details)
}
