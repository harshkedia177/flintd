import { execFile } from "node:child_process"
import { access, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { JsonValue, ModelProvider } from "@flintd/core"

const exec = promisify(execFile)
const MAX_OUTPUT_BYTES = 1024 * 1024

export interface SmokeContext {
  root: string
  url: string
  token: string
  // This harness's own directory under the run's temporary tree: where a binary it has to install goes.
  dir: string
  // This harness's own flintd home: the daemon's port and token, and nothing the daemon itself reads back.
  flintdHome: string
  home: string
  project: string
  seededTool: string | null
  // The arguments the held-out suite called the seeded Tool with, so the drive names a call that really works.
  seededArgs: Record<string, JsonValue>
  provider: ModelProvider
  // The meter lane a harness sends its own model calls to, so what it spends is counted with everything else.
  meterBase: string
  apiKey: string
  model: string
  // How many calls the daemon has recorded against the seeded Tool, read before the harness runs.
  callsBefore: number
  calls(): Promise<number>
}

export interface Step {
  name: string
  ok: boolean
  note: string
}

export type HarnessStatus = "pass" | "handshake" | "fail" | "skipped"

export interface HarnessOutcome {
  harness: string
  // `pass` means this harness really called a Tool. `handshake` means it reached the daemon and no more.
  status: HarnessStatus
  binary: string | null
  version: string | null
  reason: string
  steps: Step[]
  durationMs: number
}

export interface Ran {
  code: number
  stdout: string
  stderr: string
}

export type Smoke = (context: SmokeContext) => Promise<Omit<HarnessOutcome, "durationMs">>

export async function which(binary: string): Promise<string | null> {
  const found = await run("which", [binary], {}).catch(() => null)
  return found === null || found.code !== 0 ? null : found.stdout.trim()
}

// A harness this machine does not hold is installed under the run's own directory. Never globally, and never into
// the operator's own tree: the prefix and the HOME both go with the run.
export async function installed(binary: string, spec: string, dir: string): Promise<string | null> {
  const found = await which(binary)
  if (found !== null) return found
  const prefix = join(dir, "npm")
  await mkdir(prefix, { recursive: true })
  const done = await run("npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, spec], {
    env: { HOME: prefix, npm_config_cache: join(prefix, "cache") },
    timeoutMs: 600_000,
  })
  if (done.code !== 0) return null
  const path = join(prefix, "node_modules", ".bin", binary)
  return access(path).then(
    () => path,
    () => null,
  )
}

export async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<Ran> {
  try {
    const running = exec(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...options.env },
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    })
    // A CLI whose stdin is a pipe waits for the end of it: `codex exec` appends piped stdin to its prompt, and
    // nothing here ever writes any. Without this the drive runs to its own timeout and records no call.
    running.child.stdin?.end()
    const done = await running
    return { code: 0, stdout: done.stdout, stderr: done.stderr }
  } catch (cause) {
    const failed = cause as { code?: unknown; stdout?: string; stderr?: string; message?: string }
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message ?? "",
    }
  }
}

// The harness never sees the operator's own HOME, and never the daemon's flintd home either: `flintd init` writes
// into the home it is given, and the daemon under test must not have its own consent or skillExports rewritten.
export function harnessEnv(context: SmokeContext): Record<string, string> {
  return {
    HOME: context.home,
    XDG_CONFIG_HOME: join(context.home, ".config"),
    XDG_DATA_HOME: join(context.home, ".local", "share"),
    FLINTD_HOME: context.flintdHome,
    FLINTD_TOKEN: context.token,
  }
}

// A flintd home of this harness's own, holding the daemon's port and token and nothing else it could break.
export async function ownHome(dir: string, port: number, token: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, "config.json"), `${JSON.stringify({ port }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(dir, "token"), `${token}\n`, { mode: 0o600 })
  return dir
}

export async function flintdInit(context: SmokeContext, harness: string, extra: string[] = []): Promise<Ran> {
  return run(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      join(context.root, "packages/daemon/bin/flintd.ts"),
      "init",
      "--harness",
      harness,
      "--scope",
      "user",
      "--transcripts",
      "no",
      ...extra,
    ],
    { cwd: context.project, env: harnessEnv(context) },
  )
}

export async function version(binary: string, args: string[] = ["--version"]): Promise<string | null> {
  const said = await run(binary, args, { timeoutMs: 30_000 })
  const line = `${said.stdout}${said.stderr}`.trim().split("\n")[0]
  return line === undefined || line === "" ? null : line
}

export function skipped(harness: string, reason: string): Omit<HarnessOutcome, "durationMs"> {
  return { harness, status: "skipped", binary: null, version: null, reason, steps: [] }
}

// `pass` is earned only by a step named "a tool call the daemon recorded"; everything else that works is a handshake.
export function verdict(
  harness: string,
  binary: string,
  found: string | null,
  steps: Step[],
  reason: string,
): Omit<HarnessOutcome, "durationMs"> {
  const called = steps.find((step) => step.name === CALL_STEP)
  const status: HarnessStatus = steps.some((step) => !step.ok && step.name !== CALL_STEP)
    ? "fail"
    : called?.ok === true
      ? "pass"
      : "handshake"
  return { harness, status, binary, version: found, steps, reason }
}

export const CALL_STEP = "a tool call the daemon recorded"

// The one assertion that is not the harness's own word: the daemon's own count of calls against the seeded Tool.
export async function calledTheTool(context: SmokeContext, said: Ran): Promise<Step> {
  if (context.seededTool === null) {
    return { name: CALL_STEP, ok: false, note: "no Tool reached Verified in the held-out suite, so there was none to call" }
  }
  const after = await context.calls()
  return {
    name: CALL_STEP,
    ok: after > context.callsBefore,
    note:
      after > context.callsBefore
        ? `${context.seededTool} went from ${context.callsBefore} to ${after} calls`
        : `${context.seededTool} still has ${after} calls. ${note(said, context)}`,
  }
}

// The one instruction the drive gives a harness: the Tool, and the arguments the held-out suite already proved.
export function callPrompt(context: Pick<SmokeContext, "seededTool" | "seededArgs">): string {
  const args = JSON.stringify(context.seededArgs)
  return (
    `Use the flintd MCP server. Call the tool named tool_run with ` +
    `{"name": "${context.seededTool}", "args": ${args}} and nothing else first. ` +
    `If it refuses because the arguments are wrong, call tool_read with {"name": "${context.seededTool}"}, read the ` +
    `argument schema, and call tool_run again with arguments that match it. Then answer with the result and nothing else.`
  )
}

// The results file is committed, and a harness prints what it sends: the bearer token never survives this.
export function note(said: Ran, context: SmokeContext): string {
  const kept = `${said.stdout}${said.stderr}`
    .split("\n")
    .filter((line) => !/authorization|bearer|api[_-]?key/i.test(line))
    .join(" ")
    .replaceAll(context.token, "[redacted]")
    .replaceAll(context.apiKey, "[redacted]")
    .replaceAll(/\s+/g, " ")
    .trim()
  return kept.length > 400 ? `${kept.slice(0, 400)}…` : kept
}

// The two `flintd init` steps every harness shares: write the config, then let `--check` say it is complete.
export async function connected(context: SmokeContext, harness: string): Promise<Step[]> {
  const written = await flintdInit(context, harness)
  const checked = await flintdInit(context, harness, ["--check"])
  return [
    { name: "flintd init", ok: written.code === 0, note: note(written, context) },
    { name: "flintd init --check", ok: checked.code === 0, note: note(checked, context) },
  ]
}
