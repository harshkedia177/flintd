import { existsSync, readFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { ToolError } from "./errors.ts"

// The curated set a Body may import, fixed for this release (ADR 0003), and built into BUNDLE_DIR rather than read from node_modules.
export const BUNDLE: readonly string[] = [
  "cheerio",
  "date-fns",
  "jsonpath-plus",
  "lodash-es",
  "marked",
  "papaparse",
  "yaml",
  "zod",
]

// cheerio decodes its entity tables with `Buffer`, which the QuickJS tier does not have.
export const BUNDLE_NODE_ONLY: readonly string[] = ["cheerio"]

export const BUNDLE_DIR = fileURLToPath(new URL("../dist/bundle/", import.meta.url))

const held = new Map<string, string>()

// The Bundle is built, not committed, so a flintd installed without it would fail at the first import of the first Body rather than at the door.
export function assertBundle(): void {
  const missing = BUNDLE.filter((name) => !existsSync(bundlePath(name)))
  if (missing.length === 0) return
  throw new ToolError(
    "store_error",
    `This flintd ships no Bundle file for ${missing.join(", ")}, so no Body could import one. Run \`pnpm build\` in the flintd checkout, which writes them to ${BUNDLE_DIR}, and start flintd again.`,
    { missing, dir: BUNDLE_DIR },
  )
}

// The Node tier grants the real directory to the permission model and the container tier mounts it, so both ask here.
export async function bundleRoot(): Promise<string> {
  const real = await realpath(BUNDLE_DIR).catch(() => undefined)
  if (real === undefined) {
    throw new ToolError(
      "worker_unavailable",
      `The Bundle directory ${BUNDLE_DIR} is not there, so no Body could import a Bundle package. Run \`pnpm build\` and start flintd again.`,
      { dir: BUNDLE_DIR },
    )
  }
  return real
}

function bundlePath(name: string): string {
  return `${BUNDLE_DIR}${name}.mjs`
}

// Process-wide on purpose: a Bundle file is fixed for the release and read-only, so it cannot go stale.
export function bundleText(name: string): string {
  const cached = held.get(name)
  if (cached !== undefined) return cached
  const text = readFileSync(bundlePath(name), "utf8")
  held.set(name, text)
  return text
}
