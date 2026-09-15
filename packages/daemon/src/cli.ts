import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import { createInterface } from "node:readline/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { DEFAULT_OBSERVER_TIMEOUT_MS, TOOL_STATES, ToolError, createFlint, libraryName } from "@flintd/core"
import type {
  ApprovalEntry,
  FindEntry,
  FlintStatus,
  JsonValue,
  LibraryEntry,
  LogEntry,
  RetirementProposal,
} from "@flintd/core"
import { createFlint as connect } from "@flintd/sdk"
import type { FlintClient } from "@flintd/sdk"
import { CONFIG_FILE, CONNECTIONS_FILE, clearPort, ensureToken, flintdHome, livePid, livePort, publishPort, readConfig, readToken } from "./config.ts"
import { HARNESSES, SCOPES, isHarness, isScope } from "./harness.ts"
import { runInit } from "./init.ts"
import { VERSION } from "./version.ts"
import { exportSkills, startExports } from "./export.ts"
import { startObserver } from "./observe.ts"
import type { ObserverSchedule } from "./observe.ts"
import type { ExportStatus, ExportWatch } from "./export.ts"
import { serve } from "./server.ts"

// The daemon is idle when it ran no call for this long, and only an idle daemon observes.
const DEFAULT_IDLE_MINUTES = 10
const START_WAIT_MS = 10_000
const START_POLL_MS = 250
const STOP_WAIT_MS = 10_000

const USAGE = `flintd — the local daemon for a Library of Tools an agent writes for itself.

  flintd serve [--verbose]                  start the daemon on 127.0.0.1
  flintd stop                               stop the daemon this machine is running
  flintd init --harness <name> [--scope user|project] [--transcripts yes|no] [--check] [--dry-run]
                                            connect one harness to this daemon
  flintd status                             what the daemon holds
  flintd tools list [--state <state>]       the Tools in the Library
  flintd tools show <name> [--source]       one Tool
  flintd tools history <name>               the Versions of one Tool
  flintd tools restore <name> <version>     bring a Version back
  flintd tools retire <name>                take a Tool out of use
  flintd observe [--dry-run]                run the Observer now and report what it proposed
  flintd observe --proposals                the Tools the Observer proposes for retirement
  flintd observe --retire <name>            retire one Tool the Observer proposed
  flintd find <query> [--limit <n>]         the Tools closest to what you describe
  flintd call <name> [json-args]            run a Tool
  flintd report <call-id> <outcome>         say a call helped or hurt: positive or negative
  flintd approvals list                     the Manifests waiting for a decision
  flintd approvals approve <tool>           let a Tool have what its Manifest asks for
  flintd approvals deny <tool>              refuse it
  flintd connect <name> --host <h> --header <text>
                                            store a Connection a Tool reaches by name
  flintd connect --list                     the Connections this flintd holds
  flintd connect --remove <name>            take one out
  flintd export --to <dir> [--dry-run]      write one SKILL.md for each Active Tool into a skills directory

  --version <id>  the Version of the Tool an Approval decision names

  --host <host>   one host a Connection may be sent to; write it once for each host
  --header <text> the header a Connection sends, as "Name: value"

  --to <dir>      the skills directory an export writes into
  --dry-run       say what an export or an init would change and write nothing; on observe, list the
                  candidates and ask no model
  --proposals     list the retirement proposals the Observer holds, and run nothing
  --retire <name> retire the Tool of that name, which is the operator's own decision

  --harness <name>   one of claude-code, codex, opencode, hermes, openclaw, pi
  --scope <scope>    user for the home directory, project for this directory; the default is user
  --transcripts <yes|no>  whether a hook may carry the transcript path of a session; the default is no
  --check            say what is configured for that harness and write nothing; exit 1 when something is missing

  --verbose       write every ctx.log line of every call to stdout, as it happens
  --limit <n>     how many Tools a find returns
  --note <text>   the one line that says why, on a report or on an Approval decision
  --json          write the answer as JSON
  --url <url>     the daemon to talk to; the default is the configured port on 127.0.0.1
  --token <token> the bearer token of that daemon; FLINTD_TOKEN sets it too
`

export async function main(argv: string[]): Promise<number> {
  // Read before parseArgs: a command always comes first, so a leading flag is the bare one, and `--version` is
  // also a string option further in, where it names the Version of a Tool.
  const leading = argv[0]
  if (leading === "--help" || leading === "-h") {
    process.stdout.write(USAGE)
    return 0
  }
  if (leading === "--version" || leading === "-v") {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let values: {
    json?: boolean
    source?: boolean
    state?: string
    limit?: string
    version?: string
    note?: string
    url?: string
    token?: string
    host?: string[]
    header?: string
    remove?: string
    list?: boolean
    verbose?: boolean
    to?: string
    "dry-run"?: boolean
    harness?: string
    scope?: string
    transcripts?: string
    check?: boolean
    proposals?: boolean
    retire?: string
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        source: { type: "boolean", default: false },
        state: { type: "string" },
        limit: { type: "string" },
        version: { type: "string" },
        note: { type: "string" },
        url: { type: "string" },
        token: { type: "string" },
        host: { type: "string", multiple: true },
        header: { type: "string" },
        remove: { type: "string" },
        list: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        to: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        harness: { type: "string" },
        scope: { type: "string" },
        transcripts: { type: "string" },
        check: { type: "boolean", default: false },
        proposals: { type: "boolean", default: false },
        retire: { type: "string" },
      },
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (cause) {
    return usage(cause instanceof Error ? cause.message : String(cause))
  }

  const [command, ...rest] = positionals
  if (command === undefined || command === "help") {
    process.stdout.write(USAGE)
    return command === undefined ? 2 : 0
  }

  try {
    if (command === "serve") return await runServe(values.verbose === true)
    if (command === "stop") return await runStop()
    if (command === "init") return await runInitCommand(values)
    // `observe` waits for a whole run, which is bounded by observerTimeoutMs and not by the client's own default.
    const client = await connectClient(values.url, values.token, command === "observe" ? await observeTimeoutMs() : undefined)
    switch (command) {
      case "status":
        return await runStatus(client, values.json === true)
      case "tools":
        return await runTools(client, rest, values)
      case "observe":
        return await runObserve(client, values)
      case "find":
        return await runFind(client, rest, values.limit, values.json === true)
      case "call":
        return await runCall(client, rest)
      case "report":
        return await runReport(client, rest, values.note)
      case "approvals":
        return await runApprovals(client, rest, values)
      case "connect":
        return await runConnect(client, rest, values)
      case "export":
        return await runExport(client, values.to, values["dry-run"] === true, values.json === true)
      default:
        return usage(`flintd has no command ${JSON.stringify(command)}.`)
    }
  } catch (cause) {
    if (!(cause instanceof ToolError)) throw cause
    process.stderr.write(`${cause.code}: ${cause.message}\n`)
    return 1
  }
}

async function runServe(verbose: boolean): Promise<number> {
  const config = await readConfig()
  const token = await ensureToken(config.home)
  let consented = transcriptHarnesses(config.home, [])
  const flint = createFlint({
    userDir: config.libraryDir,
    ...(config.projectLibraryDir === null ? {} : { projectDir: config.projectLibraryDir }),
    ...(config.libraryRemote === null ? {} : { userRemote: config.libraryRemote }),
    ...(config.projectLibraryRemote === null ? {} : { projectRemote: config.projectLibraryRemote }),
    ...(config.syncTimeoutMs === null ? {} : { syncTimeoutMs: config.syncTimeoutMs }),
    ...(config.modelTimeoutMs === null ? {} : { modelTimeoutMs: config.modelTimeoutMs }),
    ...(config.heldOutTimeoutMs === null ? {} : { heldOutTimeoutMs: config.heldOutTimeoutMs }),
    ...(config.stopGraceMs === null ? {} : { stopGraceMs: config.stopGraceMs }),
    ...(config.activeCap === null ? {} : { activeCap: config.activeCap }),
    ...(config.activeListLimit === null ? {} : { activeListLimit: config.activeListLimit }),
    ...(config.heldOutConcurrency === null ? {} : { heldOutConcurrency: config.heldOutConcurrency }),
    ...(config.findLimit === null ? {} : { findLimit: config.findLimit }),
    ...(config.duplicateThreshold === null ? {} : { duplicateThreshold: config.duplicateThreshold }),
    ...(config.duplicateBand === null ? {} : { duplicateBand: config.duplicateBand }),
    ...(config.duplicateCosine === null ? {} : { duplicateCosine: config.duplicateCosine }),
    ...(config.duplicateCosineBand === null ? {} : { duplicateCosineBand: config.duplicateCosineBand }),
    ...(config.duplicateMaxJudgments === null ? {} : { duplicateMaxJudgments: config.duplicateMaxJudgments }),
    ...(config.siblingThreshold === null ? {} : { siblingThreshold: config.siblingThreshold }),
    ...(config.siblingCosine === null ? {} : { siblingCosine: config.siblingCosine }),
    ...(config.searchCosine === null ? {} : { searchCosine: config.searchCosine }),
    ...(config.observerRepeats === null ? {} : { observerRepeats: config.observerRepeats }),
    ...(config.observerWindowDays === null ? {} : { observerWindowDays: config.observerWindowDays }),
    ...(config.observerTimeoutMs === null ? {} : { observerTimeoutMs: config.observerTimeoutMs }),
    ...(config.observerMaxCandidates === null ? {} : { observerMaxCandidates: config.observerMaxCandidates }),
    ...(config.retireContribution === null ? {} : { retireContribution: config.retireContribution }),
    ...(config.retireMinCalls === null ? {} : { retireMinCalls: config.retireMinCalls }),
    ...(config.retireIdleDays === null ? {} : { retireIdleDays: config.retireIdleDays }),
    // The Observer reads the Observations of a harness only where the operator answered yes to transcripts, and
    // asks at every run, whatever started it, so `flintd init --transcripts no` is obeyed without a restart.
    transcriptHarnesses: () => {
      consented = transcriptHarnesses(config.home, consented)
      return consented
    },
    ...(config.maxFetchBytes === null ? {} : { maxFetchBytes: config.maxFetchBytes }),
    ...(config.fetchTimeoutMs === null ? {} : { fetchTimeoutMs: config.fetchTimeoutMs }),
    ...(config.callTimeoutMs === null ? {} : { callTimeoutMs: config.callTimeoutMs }),
    ...(config.maxArgsBytes === null ? {} : { maxArgsBytes: config.maxArgsBytes }),
    ...(config.maxResultBytes === null ? {} : { maxResultBytes: config.maxResultBytes }),
    ...(config.maxBodyBytes === null ? {} : { maxBodyBytes: config.maxBodyBytes }),
    ...(config.maxCallDepth === null ? {} : { maxCallDepth: config.maxCallDepth }),
    ...(config.maxLogLines === null ? {} : { maxLogLines: config.maxLogLines }),
    ...(config.maxLogBytes === null ? {} : { maxLogBytes: config.maxLogBytes }),
    ...(config.maxExecBytes === null ? {} : { maxExecBytes: config.maxExecBytes }),
    ...(config.memoryLimitBytes === null ? {} : { memoryLimitBytes: config.memoryLimitBytes }),
    ...(config.terminateAfterMs === null ? {} : { terminateAfterMs: config.terminateAfterMs }),
    ...(config.containerImage === null ? {} : { containerImage: config.containerImage }),
    ...(config.containerEngine === null ? {} : { containerEngine: config.containerEngine }),
    ...(config.containerTimeoutMs === null ? {} : { containerTimeoutMs: config.containerTimeoutMs }),
    ...(config.warmNodeRunners === null ? {} : { warmNodeRunners: config.warmNodeRunners }),
    // A log line is a Body's own writing, redacted but never trusted, so it goes out only when asked for.
    ...(verbose ? { onLog: (entry: LogEntry) => process.stdout.write(`${entry.tool} ${entry.callId ?? "-"}: ${entry.message}\n`) } : {}),
    // The Connections live beside the token in the flintd home, whatever directory the Library is in.
    connectionsFile: join(config.home, CONNECTIONS_FILE),
    connections: config.connections,
    ...(config.model === null ? {} : { model: config.model }),
  })
  await flint.start()
  let daemon
  let exports: ExportWatch | undefined
  let observer: ObserverSchedule | undefined
  try {
    exports =
      config.skillExports.length === 0
        ? undefined
        : await startExports(flint, config.skillExports, (said) => process.stderr.write(`${said}\n`))
    daemon = await serve({
      flint,
      token,
      port: config.port,
      ...(config.stopGraceMs === null ? {} : { stopGraceMs: config.stopGraceMs }),
      ...(config.mcpClientQuirks === null ? {} : { clientQuirks: config.mcpClientQuirks }),
      ...(exports === undefined ? {} : { exports: exports.status }),
    })
    observer = startObserver(flint, {
      idleMs: (config.observerIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000,
      ...(config.stopGraceMs === null ? {} : { stopGraceMs: config.stopGraceMs }),
      onLog: (said) => process.stdout.write(`${said}\n`),
    })
    await publishPort(config.home, daemon.port)
  } catch (cause) {
    await observer?.stop()
    await exports?.stop()
    await flint.stop()
    throw cause
  }
  process.stdout.write(`flintd listening on ${daemon.url}\n`)
  process.stdout.write(`MCP ${daemon.mcpUrl}\n`)
  for (const library of (await flint.status()).libraries) {
    process.stdout.write(`Library ${library.library}  ${library.dir}${remoteOf(library.remote)}\n`)
    if (library.error !== null) process.stderr.write(`sync ${library.library}: ${library.error}\n`)
  }
  for (const exported of exports?.status() ?? []) {
    process.stdout.write(`skills ${exported.dir}  ${exported.skills} skills\n`)
  }
  process.stdout.write(`token ${config.home}/token\n`)
  await new Promise<void>((done) => {
    const stop = (): void => {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
      done()
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
  })
  await exports?.stop()
  await clearPort(config.home)
  await daemon.close()
  // The Flint goes first: its own stop() is what cancels an observer run, and the schedule then has nothing to wait for.
  await flint.stop()
  await observer.stop()
  return 0
}

// The answer is read here and not through readConfig, because the Observer asks for it inside a run and a run is
// no place to wait on a file. A file that is gone or half written leaves the answer that stood.
function transcriptHarnesses(home: string, held: string[]): string[] {
  let raw: { harnesses?: Record<string, { transcripts?: boolean }> }
  try {
    raw = JSON.parse(readFileSync(join(home, CONFIG_FILE), "utf8")) as typeof raw
  } catch {
    return held
  }
  return Object.entries(raw.harnesses ?? {})
    .filter(([, settings]) => settings?.transcripts === true)
    .map(([harness]) => harness)
}

async function runInitCommand(values: {
  harness?: string
  scope?: string
  transcripts?: string
  check?: boolean
  "dry-run"?: boolean
  json?: boolean
}): Promise<number> {
  const harness = values.harness
  if (!isHarness(harness)) return usage(`\`flintd init\` needs --harness with one of ${HARNESSES.join(", ")}.`)
  const scope = values.scope ?? "user"
  if (!isScope(scope)) return usage(`A --scope is one of ${SCOPES.join(", ")}.`)
  const check = values.check === true
  const dryRun = values["dry-run"] === true
  if (check && dryRun) return usage("`flintd init` takes --check or --dry-run, not both.")
  const home = flintdHome()
  const config = await readConfig(home)
  const held = config.harnesses[harness]?.transcripts === true
  // A check reads and never writes, so it never asks the one question an init asks.
  const transcripts = check ? held : await transcriptAnswer(values.transcripts, harness, held)
  if (transcripts === undefined) return usage("A --transcripts is yes or no.")
  const report = await runInit({
    harness,
    scope,
    transcripts,
    home,
    cwd: process.cwd(),
    port: await daemonPort(home, config.port, !check && !dryRun),
    mode: check ? "check" : dryRun ? "dry-run" : "write",
  })
  if (values.json === true) return write(report as unknown as JsonValue)
  for (const edit of report.edits) {
    const said =
      edit.action === "incomplete"
        ? "installed, dependencies missing"
        : check
          ? edit.action === "unchanged"
            ? "configured"
            : "missing"
          : edit.action
    process.stdout.write(`${said}\t${edit.what}\t${edit.path}\n`)
  }
  process.stdout.write(`transcripts ${report.transcripts ? "on" : "off"}\n`)
  process.stdout.write(`MCP ${report.mcpUrl}\n`)
  process.stdout.write(`skills ${report.skillsDir}\n`)
  for (const note of report.notes) process.stdout.write(`note ${note}\n`)
  // The token is never written to a harness config and never printed: the operator carries it in one environment variable.
  if (harness !== "pi") {
    process.stdout.write(`Set FLINTD_TOKEN before you start ${harness}:\n  export FLINTD_TOKEN="$(cat ${join(home, "token")})"\n`)
  }
  if (dryRun) process.stdout.write("nothing written\n")
  return check && report.edits.some((edit) => edit.action !== "unchanged") ? 1 : 0
}

// A daemon a person started has to be endable without hunting for a process. Stopping one that is not running is
// not a failure: a script that ends what it started should not have to ask first.
async function runStop(): Promise<number> {
  const home = flintdHome()
  const pid = await livePid(home)
  const port = await livePort(home)
  // An operating system reuses a pid, so an alive pid alone is not proof this daemon is the process behind it.
  // A daemon that published both and answers on the port is; anything else is a stale file to clear and not a
  // process to signal.
  if (pid === undefined || port === undefined || !(await answers(port))) {
    await clearPort(home)
    process.stdout.write("no flintd daemon is running\n")
    return 0
  }
  process.kill(pid, "SIGTERM")
  for (let waited = 0; waited < STOP_WAIT_MS; waited += START_POLL_MS) {
    await new Promise((done) => setTimeout(done, START_POLL_MS))
    if ((await livePid(home)) === undefined) {
      process.stdout.write(`stopped flintd ${pid}\n`)
      return 0
    }
  }
  process.stderr.write(`flintd ${pid} did not stop within ${STOP_WAIT_MS} ms. Send it SIGKILL if it stays.\n`)
  return 1
}

// `init` needs a port a harness config can name and a token the daemon wrote, and both come from a running daemon.
// Telling a person to start a service before they can connect their agent is most of the friction of setting this up.
// A check and a dry run change nothing, so neither starts anything.
async function daemonPort(home: string, configured: number, start: boolean): Promise<number> {
  const held = configured !== 0 ? configured : await livePort(home)
  if (held !== undefined && held !== 0 && (await answers(held))) return held
  if (!start) return held ?? 0
  const child = spawn(process.execPath, [process.argv[1] ?? "", "serve"], { detached: true, stdio: "ignore" })
  child.unref()
  for (let waited = 0; waited < START_WAIT_MS; waited += START_POLL_MS) {
    await new Promise((done) => setTimeout(done, START_POLL_MS))
    // A configured port is where it will listen; port 0 means only the daemon itself can say where it landed.
    const found = configured !== 0 ? configured : await livePort(home)
    if (found !== undefined && found !== 0 && (await answers(found))) return found
  }
  return configured !== 0 ? configured : 0
}

// Any answer at all means a daemon owns the port: an unauthenticated request is refused, and a refusal is an answer.
async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/mcp`, { signal: AbortSignal.timeout(START_POLL_MS) })
    return true
  } catch {
    return false
  }
}

async function transcriptAnswer(given: string | undefined, harness: string, held: boolean): Promise<boolean | undefined> {
  if (given === "yes") return true
  if (given === "no") return false
  if (given !== undefined) return undefined
  if (process.stdin.isTTY !== true) return held
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const said = await reader.question(
      `May flintd read the transcripts ${harness} writes, to learn which Tools to propose? [y/N] `,
    )
    return said.trim().toLowerCase().startsWith("y")
  } finally {
    reader.close()
  }
}

async function runStatus(client: FlintClient, asJson: boolean): Promise<number> {
  const status = (await client.status()) as FlintStatus & { exports?: ExportStatus[] }
  if (asJson) return write(status as unknown as JsonValue)
  process.stdout.write(`${status.running ? "running" : "stopped"}  ${status.dir}\n`)
  process.stdout.write(
    `${status.tools} tools, ${status.active}/${status.activeCap} active, ${status.retired} retired, ${status.invalid.length} invalid\n`,
  )
  process.stdout.write(
    status.model.configured
      ? `model ${String(status.model.provider)} ${String(status.model.model)}\n`
      : "model not configured\n",
  )
  process.stdout.write(
    status.observer.lastRunAt === null
      ? "observer has not run yet\n"
      : `observer ran ${status.observer.lastRunAt}: ${status.observer.candidates} candidates, ${status.observer.drafts} drafts, ${status.observer.retirements} retirement proposals\n`,
  )
  for (const library of status.libraries) {
    const sync = library.error === null ? "" : `  sync failed: ${library.error}`
    const rebuilt = library.movedIndex === undefined ? "" : `  index moved to ${library.movedIndex} and rebuilt`
    process.stdout.write(
      `  ${library.library}\t${library.dir}${remoteOf(library.remote)}\t${library.tools} tools${sync}${rebuilt}\n`,
    )
  }
  for (const exported of status.exports ?? []) {
    process.stdout.write(`  skills\t${exported.dir}\t${exported.error ?? `${exported.skills} skills`}\n`)
  }
  for (const flagged of status.review) process.stdout.write(`  review\t${flagged.name}\t${flagged.library}\n`)
  for (const broken of status.invalid) {
    process.stdout.write(`  ${broken.name}\t${broken.library}\t${broken.code}\t${broken.message}\n`)
  }
  return 0
}

async function runTools(
  client: FlintClient,
  rest: string[],
  values: { json?: boolean; source?: boolean; state?: string },
): Promise<number> {
  const [action, name, version] = rest
  const asJson = values.json === true
  switch (action) {
    case "list": {
      if (values.state !== undefined && !(TOOL_STATES as readonly string[]).includes(values.state)) {
        return usage(`--state takes one of ${TOOL_STATES.join(", ")}.`)
      }
      const all = (await client.library()) as LibraryEntry[]
      const tools = values.state === undefined ? all : all.filter((tool) => tool.state === values.state)
      if (asJson) return write(tools as unknown as JsonValue)
      for (const tool of tools) {
        const flag = tool.needs_review ? "\tneeds review" : ""
        process.stdout.write(
          `${tool.name}\t${tool.library}\t${tool.state}\t${tool.tier}\t${tool.approval ?? "no approval needed"}\t${tool.contribution.toFixed(2)}\t${tool.calls} calls\t${tool.lastCallAt ?? "never used"}${flag}\t${tool.description}\n`,
        )
      }
      if (tools.length === 0) process.stdout.write("no Tools\n")
      return 0
    }
    case "show": {
      if (name === undefined) return usage("`flintd tools show` needs the name of a Tool.")
      const tool = (await client.call("tool_read", { name, include_source: values.source === true })) as {
        name: string
        description: string
        state: string
        parameters: JsonValue
        held_out: { status: string; reason?: string; failures: { index: number; reason: string }[] }
        deferred?: number[]
        source?: string
      }
      if (asJson) return write(tool as unknown as JsonValue)
      process.stdout.write(`${tool.name}  ${tool.state}\n${tool.description}\n`)
      if (tool.deferred !== undefined) process.stdout.write(`deferred examples ${tool.deferred.join(", ")}\n`)
      process.stdout.write(`held-out ${tool.held_out.status}\n`)
      if (tool.held_out.reason !== undefined) process.stdout.write(`  ${tool.held_out.reason}\n`)
      const failed = tool.held_out.failures[0]
      if (failed !== undefined) process.stdout.write(`  example ${failed.index}: ${failed.reason}\n`)
      process.stdout.write(`${JSON.stringify(tool.parameters, null, 2)}\n`)
      if (tool.source !== undefined) process.stdout.write(`${tool.source}\n`)
      return 0
    }
    case "history": {
      if (name === undefined) return usage("`flintd tools history` needs the name of a Tool.")
      const history = (await client.call("tool_history", { name })) as {
        versions: { id: string; timestamp: string; operation: string | null; channel: string | null }[]
      }
      if (asJson) return write(history as unknown as JsonValue)
      for (const version of history.versions) {
        process.stdout.write(
          `${version.id.slice(0, 12)}\t${version.timestamp}\t${version.operation ?? "?"}\t${version.channel ?? "?"}\n`,
        )
      }
      return 0
    }
    case "restore": {
      if (name === undefined || version === undefined) {
        return usage("`flintd tools restore` needs the name of a Tool and a Version id.")
      }
      return write(await client.call("tool_update", { name, restore_version: version }))
    }
    case "retire": {
      if (name === undefined) return usage("`flintd tools retire` needs the name of a Tool.")
      return write(await client.call("tool_retire", { name }))
    }
    default:
      return usage("`flintd tools` takes list, show, history, restore or retire.")
  }
}

async function runObserve(
  client: FlintClient,
  values: { json?: boolean; "dry-run"?: boolean; proposals?: boolean; retire?: string },
): Promise<number> {
  const asJson = values.json === true
  if (values.retire !== undefined) {
    // The retire runs through the meta tool every other retire runs through: the Observer never retires a Tool itself.
    const done = await client.call("tool_retire", { name: values.retire })
    if (asJson) return write(done)
    const result = done as { name: string; state: string; restore_version: string }
    process.stdout.write(`${result.name}\t${result.state}\trestore ${result.restore_version}\n`)
    return 0
  }
  if (values.proposals === true) {
    const proposals = await client.observer.proposals()
    if (asJson) return write(proposals as unknown as JsonValue)
    for (const one of proposals) printProposal(one)
    if (proposals.length === 0) process.stdout.write("no retirement proposals\n")
    return 0
  }
  const run = await client.observer.run({ dryRun: values["dry-run"] === true })
  if (asJson) return write(run as unknown as JsonValue)
  for (const candidate of run.candidates) {
    process.stdout.write(`candidate\t${candidate.sessions} sessions\t${candidate.pattern}\n`)
  }
  for (const draft of run.drafts) process.stdout.write(`draft\t${draft.name}\t${draft.library}\t${draft.version}\n`)
  for (const refusal of run.refusals) {
    process.stdout.write(`refused\t${refusal.name ?? refusal.pattern}\t${refusal.code}\t${refusal.reason}\n`)
  }
  for (const one of run.retirements) printProposal(one)
  if (!run.modelConfigured) process.stdout.write("model not configured: candidates only\n")
  process.stdout.write(
    `${run.candidates.length} candidates, ${run.drafts.length} drafts, ${run.refusals.length} refused, ${run.retirements.length} retirement proposals\n`,
  )
  return 0
}

function printProposal(one: RetirementProposal): void {
  const idle = one.idleDays === null ? "never called" : `${one.idleDays} days idle`
  process.stdout.write(
    `retire?\t${one.name}\t${one.library}\t${one.state}\t${one.reason}\t${one.contribution.toFixed(2)}\t${one.calls} calls\t${one.errors} errors\t${idle}\n`,
  )
}

async function runFind(
  client: FlintClient,
  rest: string[],
  limit: string | undefined,
  asJson: boolean,
): Promise<number> {
  const query = rest.join(" ")
  if (query === "") return usage("`flintd find` needs one line saying what you want the Tool to do.")
  const found = (await client.find(query, limit === undefined ? undefined : Number(limit))) as FindEntry[]
  if (asJson) return write(found as unknown as JsonValue)
  for (const entry of found) {
    process.stdout.write(
      `${entry.name}\t${entry.library}\t${entry.state}\t${entry.score.toFixed(2)}\t${entry.contribution.toFixed(2)}\t${entry.description}\n`,
    )
    for (const sibling of entry.siblings) {
      process.stdout.write(`  sibling\t${sibling.name}\t${sibling.library}\t${sibling.state}\n`)
    }
  }
  if (found.length === 0) process.stdout.write("no Tools\n")
  return 0
}

async function runCall(client: FlintClient, rest: string[]): Promise<number> {
  const [name, source] = rest
  if (name === undefined) return usage("`flintd call` needs the name of a Tool.")
  let args: JsonValue = {}
  if (source !== undefined) {
    try {
      args = JSON.parse(source) as JsonValue
    } catch (cause) {
      return usage(`The arguments are not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  // `fl_<name>` is the spelling every export surface writes, and it names the Tool `<name>` here as it does on MCP.
  const call = await client.callWithId(libraryName(name), args)
  // The id goes to stderr so a pipe carries the result alone, and `flintd report` still has an id to name.
  if (call.id !== null) process.stderr.write(`call ${call.id}\n`)
  return write(call.result)
}

async function runExport(
  client: FlintClient,
  to: string | undefined,
  dryRun: boolean,
  asJson: boolean,
): Promise<number> {
  if (to === undefined) return usage("`flintd export` needs --to with the skills directory to write into.")
  const dir = resolve(process.cwd(), to)
  const report = await exportSkills(client, dir, dryRun).catch((cause: unknown) => {
    if (cause instanceof ToolError) throw cause
    throw new ToolError(
      "invalid_arguments",
      `flintd could not write the skills into ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { dir },
    )
  })
  if (asJson) return write(report as unknown as JsonValue)
  for (const change of report.changes) process.stdout.write(`${change.action}\t${join(dir, change.skill)}\n`)
  const summary = `${report.changes.length} changes, ${report.skills} skills`
  process.stdout.write(dryRun ? `${summary}, nothing written\n` : `${summary} in ${dir}\n`)
  return 0
}

async function runReport(client: FlintClient, rest: string[], note: string | undefined): Promise<number> {
  const [callId, outcome] = rest
  if (callId === undefined || outcome === undefined) {
    return usage("`flintd report` needs the id of a call and an outcome of positive or negative.")
  }
  if (outcome !== "positive" && outcome !== "negative") {
    return usage(`An outcome is positive or negative, and this one is ${JSON.stringify(outcome)}.`)
  }
  return write((await client.report(callId, outcome, note)) as unknown as JsonValue)
}

async function runApprovals(
  client: FlintClient,
  rest: string[],
  values: { json?: boolean; version?: string; note?: string },
): Promise<number> {
  const [action, name] = rest
  const waiting = (await client.approvals()) as ApprovalEntry[]
  if (action === "list") {
    if (values.json === true) return write(waiting as unknown as JsonValue)
    for (const approval of waiting) {
      process.stdout.write(
        `${approval.id}\t${approval.tool}\t${approval.library}\t${approval.status}\t${approval.version ?? "?"}\t${approval.summary}\n`,
      )
    }
    if (waiting.length === 0) process.stdout.write("no Approvals\n")
    return 0
  }
  if (action !== "approve" && action !== "deny") {
    return usage("`flintd approvals` takes list, approve or deny.")
  }
  if (name === undefined) return usage(`\`flintd approvals ${action}\` needs the name of a Tool.`)
  const found = waiting.filter(
    (approval) => approval.tool === name && (values.version === undefined || approval.version === values.version),
  )
  const chosen = found[0]
  if (chosen === undefined || found.length > 1) {
    return usage(
      found.length > 1
        ? `More than one Approval names the Tool ${JSON.stringify(name)}. Name the Version with --version: ${found.map((one) => one.version ?? "?").join(", ")}.`
        : `No Approval names the Tool ${JSON.stringify(name)}. Run \`flintd approvals list\` to see the ones that are waiting.`,
    )
  }
  const decided =
    action === "approve" ? await client.approve(chosen.id, values.note) : await client.deny(chosen.id, values.note)
  return write(decided as unknown as JsonValue)
}

async function runConnect(
  client: FlintClient,
  rest: string[],
  values: { json?: boolean; host?: string[]; header?: string; remove?: string; list?: boolean },
): Promise<number> {
  if (values.list === true) {
    const held = await client.connections.list()
    if (values.json === true) return write(held as unknown as JsonValue)
    for (const connection of held) process.stdout.write(`${connection.name}\t${connection.hosts.join(", ")}\n`)
    if (held.length === 0) process.stdout.write("no Connections\n")
    return 0
  }
  if (values.remove !== undefined) {
    return write((await client.connections.remove(values.remove)) as unknown as JsonValue)
  }
  const [name] = rest
  if (name === undefined || values.header === undefined || values.host === undefined) {
    return usage('`flintd connect` needs a name, at least one --host, and --header "Name: value".')
  }
  const cut = values.header.indexOf(":")
  if (cut < 1) return usage('A --header is written as "Name: value", such as "authorization: Bearer abc123".')
  const header = { name: values.header.slice(0, cut).trim(), value: values.header.slice(cut + 1).trim() }
  const stored = await client.connections.add({ name, hosts: values.host, header })
  // The value never comes back, so what is written here is what every surface shows: the name and the hosts.
  return write(stored as unknown as JsonValue)
}

// The answer comes only when the run ends, so the client waits the run's own bound and a tenth of it more.
async function observeTimeoutMs(): Promise<number> {
  const config = await readConfig(flintdHome()).catch(() => undefined)
  return Math.round((config?.observerTimeoutMs ?? DEFAULT_OBSERVER_TIMEOUT_MS) * 1.1)
}

async function connectClient(
  url: string | undefined,
  given: string | undefined,
  timeoutMs?: number,
): Promise<FlintClient> {
  const home = flintdHome()
  const named = given ?? process.env["FLINTD_TOKEN"]
  const explicit = named === undefined || named === "" ? undefined : named
  const clock = timeoutMs === undefined ? {} : { timeoutMs }
  if (url !== undefined) {
    if (explicit !== undefined) return connect({ url, token: explicit, ...clock })
    if (!loopback(url)) {
      throw new ToolError(
        "invalid_arguments",
        `The daemon at ${url} is not on this machine, and the token in ${home} belongs to the local daemon. Pass --token, or set FLINTD_TOKEN, with the token of that daemon.`,
        { url },
      )
    }
    return connect({ url, token: await readToken(home), ...clock })
  }
  const token = explicit ?? (await readToken(home))
  const { port } = await readConfig(home)
  const running = port === 0 ? await livePort(home) : port
  if (running === undefined) {
    throw new ToolError(
      "invalid_arguments",
      "The config names port 0, so the daemon picks a free port at each start and only a running one has published it. Start `flintd serve`, or pass --url with the address it logged.",
      { port },
    )
  }
  return connect({ url: `http://127.0.0.1:${running}`, token, ...clock })
}

// The local token belongs to the local daemon, so it leaves this machine only when the operator names it.
function loopback(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  if (host === "localhost") return true
  // A hostname is not an address: "127.0.0.1.attacker.example" starts with 127. and belongs to somebody else.
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  const kind = isIP(address)
  if (kind === 4) return address.startsWith("127.")
  return kind === 6 && address === "::1"
}

function remoteOf(url: string | null): string {
  return url === null ? "" : `  origin ${url}`
}

function write(value: JsonValue): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return 0
}

function usage(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}`)
  return 2
}
