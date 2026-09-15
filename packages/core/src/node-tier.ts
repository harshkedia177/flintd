import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BUNDLE, bundleRoot } from "./bundle.ts"
import { ToolError } from "./errors.ts"
import { awaitReady } from "./engine.ts"
import { NODE_BUILTINS } from "./manifest.ts"
import type { ExecutionLimits } from "./quickjs.ts"
import type { Runner, RunnerHooks } from "./engine.ts"

// What a process needs to start and to read a locale, and nothing that says who the user is.
const KEPT_ENVIRONMENT = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"]
// One chunk at a time is a memory guard, not a policy: the per-line and per-call log caps are `maxLogBytes` and `maxLogLines`, and the main thread applies both.
const MAX_LOG_CHUNK_BYTES = 16 * 1024
const TERMINATE_WAIT_MS = 2000
const MIN_OLD_SPACE_MIB = 32

export async function startNodeRunner(
  libraryDir: string,
  root: string,
  limits: ExecutionLimits,
  hooks: RunnerHooks,
  log: (message: string) => void,
): Promise<Runner> {
  const granted = root === "" ? undefined : await grantedRoot(libraryDir, root)
  const bundle = await grantedBundle()
  const script = fileURLToPath(new URL("./tier-child.ts", import.meta.url))
  // The child imports nothing of flintd's own, so the permission model grants it the Manifest root, the Bundle
  // directory it may import from, and no more. `--allow-net` is never passed, so from Node 25 a socket is refused too.
  // The heap bound is V8's own, in MiB: `memoryLimitBytes` binds this tier the way it binds QuickJS.
  const args = [
    "--disable-warning=ExperimentalWarning",
    `--max-old-space-size=${oldSpaceMiB(limits.memoryLimitBytes)}`,
    "--permission",
    `--allow-fs-read=${bundle.granted}`,
  ]
  if (granted !== undefined) args.push(`--allow-fs-read=${granted}`, `--allow-fs-write=${granted}`)
  // The allowlist travels as an argument, so the child reads no flintd file to know what a Body may import.
  args.push(script, JSON.stringify({ tier: "node", builtins: NODE_BUILTINS, bundle: bundle.files }))
  const child = spawn(process.execPath, [...args], {
    detached: true,
    env: scrubbed(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  capture(child.stdout, log)
  capture(child.stderr, log)
  try {
    await awaitReady((onMessage, onError) => {
      const onExit = (): void => onError(new Error("the Node tier stopped before it was ready"))
      child.on("message", onMessage as (message: unknown) => void)
      child.on("error", onError)
      child.on("exit", onExit)
      return () => {
        child.off("message", onMessage as (message: unknown) => void)
        child.off("error", onError)
        child.off("exit", onExit)
      }
    })
  } catch (cause) {
    await stop(child)
    throw cause
  }
  child.on("message", hooks.message as (message: unknown) => void)
  child.on("error", hooks.error)
  child.on("exit", hooks.exit)
  return {
    ref: () => child.ref(),
    unref: () => child.unref(),
    // A child that has gone takes its own error; the pool hears about it through the exit hook instead.
    send: (command) => child.send(command, () => undefined),
    terminate: () => stop(child),
  }
}

// V8 takes whole mebibytes, and it refuses to start under a floor of its own, so a tiny limit becomes the floor.
function oldSpaceMiB(bytes: number): number {
  return Math.max(MIN_OLD_SPACE_MIB, Math.floor(bytes / (1024 * 1024)))
}

// The permission model reads real paths, so the grant and the paths the child resolves are both the real ones.
async function grantedBundle(): Promise<{ granted: string; files: Record<string, string> }> {
  const real = await bundleRoot()
  const files = Object.fromEntries(
    BUNDLE.map((name) => [name, pathToFileURL(join(real, `${name}.mjs`)).href] as const),
  )
  return { granted: `${real}/*`, files }
}

async function grantedRoot(libraryDir: string, root: string): Promise<string> {
  const real = await realpath(join(libraryDir, root)).catch(() => undefined)
  if (real === undefined) {
    throw new ToolError(
      "call_failed",
      `The Manifest names the filesystem root ${JSON.stringify(root)}, and there is no such directory in the Library at ${libraryDir}. Create it, then call the Tool again.`,
      { fs: root },
    )
  }
  return real
}

// The Node tier carries no credential. What is left is what a process needs to start and to read a locale.
function scrubbed(): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const name of KEPT_ENVIRONMENT) {
    const value = process.env[name]
    if (value !== undefined) kept[name] = value
  }
  return kept
}

function capture(stream: NodeJS.ReadableStream | null, log: (message: string) => void): void {
  if (stream === null) return
  stream.on("data", (chunk: Buffer) => {
    const text = chunk.subarray(0, MAX_LOG_CHUNK_BYTES).toString("utf8").trimEnd()
    if (text !== "") log(text)
  })
  stream.on("error", () => undefined)
}

// The child owns its process group, so the signal reaches whatever it started as well as the child itself.
async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid
  if (child.exitCode === null && child.signalCode === null && pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
  await new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done()
      return
    }
    const timer = setTimeout(done, TERMINATE_WAIT_MS)
    child.once("exit", () => {
      clearTimeout(timer)
      done()
    })
  })
}
