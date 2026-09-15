import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { BUNDLE, bundleRoot } from "./bundle.ts"
import { awaitReady } from "./engine.ts"
import type { ExecuteRequest, Runner, RunnerHooks, WorkerMessage } from "./engine.ts"
import { ToolError } from "./errors.ts"
import { manifestRoot } from "./files.ts"
import { NODE_BUILTINS } from "./manifest.ts"
import { CONTAINER_ENGINES } from "./types.ts"
import type { ContainerEngineName, ContainerStatus } from "./types.ts"

const run = promisify(execFile)

const DETECT_TIMEOUT_MS = 5_000
const REMOVE_TIMEOUT_MS = 10_000
// A container holds a whole Node runtime, so it gets bounds of its own: a fork bomb, a leak or a spin costs the container and not the machine.
const MEMORY = "512m"
const CPUS = "1"
const PIDS_LIMIT = 256
// Anything longer is a Body writing to the channel itself, and it is dropped rather than held.
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_LOG_CHUNK_BYTES = 16 * 1024
// name[:tag][@digest], where the name may carry a registry host and its port: registry.example.com:5000/team/node.
const IMAGE_TAG =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(:[0-9]{1,5})?(\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}){0,7}(:[a-zA-Z0-9._-]{1,127})?(@sha256:[a-f0-9]{64})?$/
// Never root: the uid flintd runs as, so what a command writes belongs to the person who started flintd, and a root flintd falls back to this.
const IMAGE_USER = "1000:1000"

export interface ContainerSpec {
  container: string
  image: string
  user: string
  // A Tool that declares none gets a tmpfs there, so a command always has a working directory and no path of the Library is in the container.
  workspace: string | undefined
  bundle: string
  child: string
  argument: string
}

// The seam a hosted runtime is added behind: one implementation drives the `docker` command line, which podman and nerdctl also answer.
export interface ContainerEngine {
  readonly name: string
  version(withinMs: number): Promise<string>
  start(spec: ContainerSpec): ChildProcess
  remove(container: string, withinMs: number): Promise<void>
}

export interface ContainerOptions {
  engine: ContainerEngineName
  image: string
  timeoutMs: number
}

export interface ContainerTier {
  readonly timeoutMs: number
  detect(): Promise<void>
  status(): ContainerStatus
  // The refusal a Tool that asks for a container reads on a machine that has none, or undefined when it can run.
  unavailable(toolName: string): ToolError | undefined
  start(libraryDir: string, request: ExecuteRequest, hooks: RunnerHooks, log: (message: string) => void): Promise<Runner>
}

function dockerEngine(): ContainerEngine {
  return {
    name: "docker",
    async version(withinMs: number): Promise<string> {
      const { stdout } = await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: withinMs })
      const version = stdout.trim()
      if (version === "") throw new Error("`docker version` named no server version, so no engine is running")
      return version
    },
    start(spec: ContainerSpec): ChildProcess {
      return spawn("docker", dockerArguments(spec), { stdio: ["pipe", "pipe", "pipe"] })
    },
    async remove(container: string, withinMs: number): Promise<void> {
      // `--rm` takes the container away on its own, so both of these answer "no such container" on the happy path.
      await run("docker", ["kill", container], { timeout: withinMs }).catch(() => undefined)
      await run("docker", ["rm", "-f", container], { timeout: withinMs }).catch(() => undefined)
    },
  }
}

function dockerArguments(spec: ContainerSpec): string[] {
  // A bare --tmpfs is root-owned and mode 755 and the container is not root, so 1777 is what makes /workspace writable at all.
  const workspace =
    spec.workspace === undefined ? ["--tmpfs", "/workspace:mode=1777"] : ["-v", `${spec.workspace}:/workspace`]
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    spec.container,
    // ADR 0002: every call out of a Body goes through the Proxy on the main thread, so the container opens no socket of its own and `ctx.fetch` still works.
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(PIDS_LIMIT),
    "--memory",
    MEMORY,
    "--cpus",
    CPUS,
    "--user",
    spec.user,
    "--workdir",
    "/workspace",
    ...workspace,
    "-v",
    `${spec.bundle}:/bundle:ro`,
    "-v",
    `${spec.child}:/runner.ts:ro`,
    spec.image,
    "node",
    "--disable-warning=ExperimentalWarning",
    "/runner.ts",
    spec.argument,
  ]
}

// The image a Body runs in carries the Node major flintd itself runs, so a Body behaves the same in either tier.
function defaultContainerImage(): string {
  return `node:${process.versions.node.split(".")[0] as string}-alpine`
}

export function createContainerTier(options: ContainerOptions): ContainerTier {
  const engine = options.engine === "none" ? undefined : dockerEngine()
  const name = engine?.name ?? options.engine
  let version: string | null = null
  let reason: string | null = options.engine === "none" ? 'the flintd config sets "containerEngine" to "none"' : null
  // A probe that found nothing is not kept, so an engine started later is found by the next start(), and one that stopped by the `start` below.
  let probe: Promise<string> | undefined

  async function detect(): Promise<void> {
    if (engine === undefined) return
    probe ??= engine.version(DETECT_TIMEOUT_MS)
    try {
      version = await probe
      reason = null
    } catch (cause) {
      probe = undefined
      version = null
      reason = causeLine(cause)
    }
  }

  function ready(): ContainerEngine | undefined {
    return version === null ? undefined : engine
  }

  function refusal(toolName: string): ToolError {
    return new ToolError(
      "not_implemented",
      `${toolName} asks for "exec" in its Manifest, which runs the Tool in a container, and this machine has no container engine flintd can use: ${reason ?? "flintd has not looked for one yet"}. Install Docker, or another OCI runtime that answers the same \`docker\` command line, and start it; or take "exec" out of the Manifest with tool_update.`,
      { tool: toolName, tier: "container", engine: name },
    )
  }

  return {
    timeoutMs: options.timeoutMs,
    detect,
    status: () => ({ available: ready() !== undefined, engine: name, version }),
    unavailable: (toolName) => (ready() === undefined ? refusal(toolName) : undefined),

    async start(libraryDir, request, hooks, log): Promise<Runner> {
      const running = ready()
      if (running === undefined) throw refusal(request.toolName)
      const declared = request.manifest.fs
      const spec: ContainerSpec = {
        container: `flintd-${randomUUID()}`,
        image: options.image,
        user: containerUser(),
        workspace: declared === undefined ? undefined : await manifestRoot(libraryDir, declared, request.toolName),
        bundle: await bundleRoot(),
        child: fileURLToPath(new URL("./tier-child.ts", import.meta.url)),
        argument: JSON.stringify({ tier: "container", builtins: NODE_BUILTINS, bundle: bundleInContainer() }),
      }
      try {
        return await startContainer(running, spec, hooks, log)
      } catch (cause) {
        // An engine that stopped since the detection would otherwise keep answering "available", so it is asked again here.
        probe = undefined
        await detect()
        throw ready() === undefined ? refusal(request.toolName) : cause
      }
    },
  }
}

function containerUser(): string {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined || uid === 0) return IMAGE_USER
  return `${uid}:${gid}`
}

// The Bundle is mounted read-only, so a bare specifier resolves to the one file `pnpm build` wrote for it, exactly as it does in the Node tier.
function bundleInContainer(): Record<string, string> {
  return Object.fromEntries(BUNDLE.map((name) => [name, `file:///bundle/${name}.mjs`]))
}

async function startContainer(
  engine: ContainerEngine,
  spec: ContainerSpec,
  hooks: RunnerHooks,
  log: (message: string) => void,
): Promise<Runner> {
  const child = engine.start(spec)
  let onMessage: (message: WorkerMessage) => void = () => undefined
  let onError: (cause: unknown) => void = () => undefined
  let onExit: () => void = () => undefined
  readFrames(
    child,
    (message) => onMessage(message),
    (line) => log(line),
  )
  child.on("error", (cause) => onError(cause))
  child.on("exit", () => onExit())
  try {
    await awaitReady((message, error) => {
      onMessage = message
      onError = error
      onExit = () => error(new Error("the container stopped before it was ready"))
      return () => undefined
    })
  } catch (cause) {
    await stop(engine, spec.container, child)
    throw cause
  }
  onMessage = hooks.message
  onError = hooks.error
  onExit = hooks.exit
  return {
    ref: () => child.ref(),
    unref: () => child.unref(),
    // A container that has gone takes its own error; the pool hears about it through the exit hook instead.
    send: (command) => {
      child.stdin?.write(`${JSON.stringify(command)}\n`, () => undefined)
    },
    terminate: () => stop(engine, spec.container, child),
  }
}

// A command the Body runs can write to pid 1's stdout, so a frame from here is trusted for nothing but the one call this runner holds.
function readFrames(child: ChildProcess, message: (message: WorkerMessage) => void, log: (line: string) => void): void {
  let held = ""
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    held += chunk
    for (let cut = held.indexOf("\n"); cut >= 0; cut = held.indexOf("\n")) {
      const line = held.slice(0, cut)
      held = held.slice(cut + 1)
      if (line === "") continue
      try {
        message(JSON.parse(line) as WorkerMessage)
      } catch {
        log(line.slice(0, MAX_LOG_CHUNK_BYTES))
      }
    }
    if (held.length > MAX_FRAME_BYTES) {
      held = ""
      log(`the container wrote more than ${MAX_FRAME_BYTES} bytes with no line break, and it was dropped`)
    }
  })
  child.stdout?.on("error", () => undefined)
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    const text = chunk.slice(0, MAX_LOG_CHUNK_BYTES).trimEnd()
    if (text !== "") log(text)
  })
  child.stderr?.on("error", () => undefined)
}

// Killing the container kills its process namespace, so whatever a command started inside it dies with it.
async function stop(engine: ContainerEngine, container: string, child: ChildProcess): Promise<void> {
  await engine.remove(container, REMOVE_TIMEOUT_MS)
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

// What the engine itself said, because "Cannot connect to the Docker daemon" is the sentence an operator can act on.
function causeLine(cause: unknown): string {
  const held = cause as { code?: unknown; stderr?: unknown }
  if (held.code === "ENOENT") return "there is no `docker` command on the PATH"
  const written = typeof held.stderr === "string" ? held.stderr.trim() : ""
  const message = written === "" ? (cause instanceof Error ? cause.message : String(cause)) : written
  return message.split("\n")[0] ?? "the engine did not answer"
}

export function assertContainerEngine(value: unknown): ContainerEngineName {
  if (value === undefined) return "docker"
  if (typeof value === "string" && (CONTAINER_ENGINES as readonly string[]).includes(value)) {
    return value as ContainerEngineName
  }
  throw new ToolError(
    "internal_error",
    `createFlint takes \`containerEngine\` as one of ${CONTAINER_ENGINES.join(", ")}.`,
    { option: "containerEngine" },
  )
}

export function assertContainerImage(value: unknown): string {
  if (value === undefined) return defaultContainerImage()
  if (typeof value === "string" && IMAGE_TAG.test(value)) return value
  throw new ToolError(
    "internal_error",
    "createFlint takes `containerImage` as one image reference, such as \"node:26-alpine\" or \"node@sha256:<digest>\".",
    { option: "containerImage" },
  )
}
