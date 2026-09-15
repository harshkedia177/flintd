import { constants } from "node:fs"
import { open, readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { ToolError } from "./errors.ts"
import { flintdOwns } from "./manifest.ts"
import { redact } from "./redact.ts"
import { capBytes, isPlainObject } from "./validate.ts"
import type { ExecuteRequest } from "./engine.ts"
import type { JsonValue } from "./types.ts"

const MAX_PATH_LENGTH = 1024
const MAX_ENTRIES = 1000
const LISTING_DEPTH = 3
const LISTING_ENTRIES = 200
const LISTING_BYTES = 4096
// Windows has no O_NOFOLLOW and no symlink a Body could meet without an administrator, so there it is nothing.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

export type FileCall = "fs.read" | "fs.write" | "fs.list"

// Every file a Body reaches is resolved here, on the main thread, against the Manifest root of the call in flight.
export async function fileCall(
  libraryDir: string,
  request: ExecuteRequest,
  name: FileCall,
  argument: JsonValue,
): Promise<JsonValue> {
  const root = await rootOf(libraryDir, request)
  if (name === "fs.write") {
    const { path, text } = writeArgument(request.toolName, argument)
    const target = await resolveForWrite(root, path, request)
    const bytes = Buffer.byteLength(text, "utf8")
    if (bytes > request.limits.maxResultBytes) {
      throw refuse(
        `${request.toolName} tried to write ${bytes} bytes to ${JSON.stringify(path)} and the limit is ${request.limits.maxResultBytes}. Write less, or split the work across more than one call.`,
      )
    }
    await guard(() => write(target, text), request.toolName, path)
    return { path, bytes }
  }
  const path = pathArgument(request.toolName, name, argument)
  const target = await resolveExisting(root, path, request)
  const found = await guard(() => stat(target), request.toolName, path)
  if (name === "fs.read") {
    if (found.isDirectory()) {
      throw refuse(`${JSON.stringify(path)} is a directory. Use ctx.fs.list to see what is in it.`)
    }
    if (found.size > request.limits.maxResultBytes) {
      throw refuse(
        `${JSON.stringify(path)} is ${found.size} bytes and ${request.toolName} may read ${request.limits.maxResultBytes}. Read a smaller file, or have the Tool work on one part at a time.`,
      )
    }
    return guard(() => readFile(target, "utf8"), request.toolName, path)
  }
  if (!found.isDirectory()) {
    throw refuse(`${JSON.stringify(path)} is a file. Use ctx.fs.read to read it.`)
  }
  const entries = await guard(() => readdir(target, { withFileTypes: true }), request.toolName, path)
  if (entries.length > MAX_ENTRIES) {
    throw refuse(
      `${JSON.stringify(path)} holds ${entries.length} entries and ctx.fs.list answers at most ${MAX_ENTRIES}. List a directory below it.`,
    )
  }
  return entries
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

// Another process can put a symlink at the last name after the parent was resolved, so the open refuses one and the write goes through the fd.
async function write(target: string, text: string): Promise<void> {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW)
  try {
    await handle.writeFile(text, "utf8")
  } finally {
    await handle.close()
  }
}

async function rootOf(libraryDir: string, request: ExecuteRequest): Promise<string> {
  const declared = request.manifest.fs
  if (declared === undefined) {
    throw refuse(
      `${request.toolName} asked for a file, and nothing grants it a filesystem root. A Tool reaches a file only when its Manifest declares "fs" and one person has approved that Manifest.`,
      "fs",
    )
  }
  return manifestRoot(libraryDir, declared, request.toolName)
}

// The one place a declared root becomes a real directory, so a root that leads out of the Library is refused once rather than in each tier.
export async function manifestRoot(libraryDir: string, declared: string, toolName: string): Promise<string> {
  const real = await realpath(join(libraryDir, declared)).catch(() => undefined)
  if (real === undefined) {
    throw refuse(
      `The Manifest of ${toolName} declares the filesystem root ${JSON.stringify(declared)}, and there is no such directory in the Library at ${libraryDir}. Create it, then call the Tool again.`,
    )
  }
  const library = await realpath(libraryDir)
  if (!inside(library, real) || flintdOwned(library, real)) {
    throw refuse(
      `The Manifest root ${JSON.stringify(declared)} of ${toolName} leads outside the Library directory, or into a directory flintd owns. Name a directory of your own inside the Library.`,
    )
  }
  return real
}

// What the Manifest root holds now, for a prompt that has to name a path that is really there. It travels to a
// model, so it is bounded in depth, in entries and in bytes, and every name goes through the redaction first.
export async function listManifestRoot(libraryDir: string, declared: string, toolName: string): Promise<string | null> {
  const root = await manifestRoot(libraryDir, declared, toolName).catch(() => undefined)
  if (root === undefined) return null
  const found: string[] = []
  await walk(root, "", 1, found)
  return capBytes(redact(found.join("\n")), LISTING_BYTES)
}

async function walk(dir: string, prefix: string, depth: number, found: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (found.length >= LISTING_ENTRIES) return
    if (entry.isDirectory()) {
      found.push(`${prefix}${entry.name}/`)
      if (depth < LISTING_DEPTH) await walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1, found)
    } else if (entry.isFile()) {
      found.push(`${prefix}${entry.name}`)
    }
  }
}

async function resolveExisting(root: string, path: string, request: ExecuteRequest): Promise<string> {
  const target = requested(root, path, request.toolName)
  // A dangling symlink and a missing file both fail here, and both are the same answer to the Body.
  const real = await realpath(target).catch(() => undefined)
  if (real === undefined) {
    throw refuse(`${request.toolName} asked for ${JSON.stringify(path)}, and there is no such file inside its Manifest root.`)
  }
  assertInside(root, real, path, request.toolName)
  return real
}

async function resolveForWrite(root: string, path: string, request: ExecuteRequest): Promise<string> {
  const target = requested(root, path, request.toolName)
  const existing = await realpath(target).catch(() => undefined)
  if (existing !== undefined) {
    assertInside(root, existing, path, request.toolName)
    return existing
  }
  const holder = await realpath(dirname(target)).catch(() => undefined)
  if (holder === undefined) {
    throw refuse(
      `${request.toolName} tried to write ${JSON.stringify(path)}, and the directory that would hold it does not exist inside its Manifest root. Write into a directory that is already there.`,
    )
  }
  const real = join(holder, basename(target))
  assertInside(root, real, path, request.toolName)
  return real
}

// The lexical check catches "..", and the real-path check above it catches every symlink that leads out.
function requested(root: string, path: string, toolName: string): string {
  if (path.length > MAX_PATH_LENGTH || path.includes("\0")) {
    throw refuse(`${toolName} asked for a path of ${path.length} characters. Use a path of at most ${MAX_PATH_LENGTH} characters with no null byte.`)
  }
  if (isAbsolute(path)) {
    throw refuse(
      `${toolName} asked for the absolute path ${JSON.stringify(path)}. A Tool names a path relative to its Manifest root, such as "notes/today.md".`,
    )
  }
  const target = resolve(root, path)
  if (!inside(root, target)) throw outside(toolName, path)
  return target
}

function assertInside(root: string, real: string, path: string, toolName: string): void {
  if (!inside(root, real)) throw outside(toolName, path)
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function flintdOwned(library: string, target: string): boolean {
  const within = relative(library, target)
  // The Library directory itself is flintd's: a root that resolved to it would put tools/, the index and the lock inside the Manifest root.
  if (within === "") return true
  if (within.startsWith("..")) return false
  return flintdOwns(within.split(sep)[0] as string)
}

function outside(toolName: string, path: string): ToolError {
  return refuse(
    `${toolName} asked for ${JSON.stringify(path)}, which is outside the filesystem root its Manifest declares. A Tool reaches only what its Manifest asks for and an Approval granted.`,
  )
}

function pathArgument(toolName: string, name: FileCall, argument: JsonValue): string {
  if (typeof argument !== "string" || argument.length === 0) {
    throw refuse(`${toolName} called ctx.${name} without a path. Pass the path as a string.`)
  }
  return argument
}

function writeArgument(toolName: string, argument: JsonValue): { path: string; text: string } {
  if (!isPlainObject(argument) || typeof argument["path"] !== "string" || argument["path"].length === 0) {
    throw refuse(`${toolName} called ctx.fs.write without a path. Call it as ctx.fs.write(path, text).`)
  }
  if (typeof argument["text"] !== "string") {
    throw refuse(`${toolName} called ctx.fs.write with something that is not text. Call it as ctx.fs.write(path, text).`)
  }
  return { path: argument["path"], text: argument["text"] }
}

async function guard<T>(action: () => Promise<T>, toolName: string, path: string): Promise<T> {
  try {
    return await action()
  } catch (cause) {
    if (cause instanceof ToolError) throw cause
    const code = (cause as { code?: string }).code ?? "unknown"
    throw refuse(`${toolName} could not use ${JSON.stringify(path)}: the filesystem answered ${code}.`)
  }
}

// `capability` marks the one refusal a Manifest waiting for its Approval causes, so a save can defer that Example.
function refuse(message: string, capability?: string): ToolError {
  return new ToolError("call_failed", message, capability === undefined ? {} : { capability })
}
