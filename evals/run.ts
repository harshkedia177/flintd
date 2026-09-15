import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"
import { createModelAdapter } from "@flintd/core"
import { createFlint } from "@flintd/sdk"
import type { Flint } from "@flintd/core"
import { freePort, startDaemon } from "./daemon.ts"
import type { EvalDaemon } from "./daemon.ts"
import { SEEDS, readPrompts, runHeldOut } from "./held-out.ts"
import type { PromptOutcome } from "./held-out.ts"
import { runHarnesses } from "./harness/index.ts"
import type { HarnessOutcome } from "./harness/index.ts"
import { costOf, defaultModel, priceOf, providerFrom, readCredentials, resolveModel, usd } from "./model.ts"
import { runObserver } from "./observer.ts"
import type { ObserverOutcome } from "./observer.ts"
import { UNFINISHED, startRecord } from "./record.ts"
import type { RunState } from "./record.ts"
import type { Results } from "./results.ts"
import { startFixture, startMeter, sum } from "./servers.ts"
import type { Fixture, Meter } from "./servers.ts"

const exec = promisify(execFile)
const SUITES = ["held-out", "harness", "observer", "all"] as const
const DEFAULT_MAX_USD = 2

// One prompt costs the runner one authoring call, a second one where flintd refuses it, and the daemon one
// Held-out generation plus up to five judgments.
// The 2026-09-14 run measured 1343 in and 3086 out per prompt; these carry headroom for a run where every Tool
// reaches its Held-out run rather than being refused before it. See evals/README.md.
const ESTIMATE_PER_PROMPT = { input: 3_000, output: 8_000 }

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      suite: { type: "string", default: "all" },
      "dry-run": { type: "boolean", default: false },
      model: { type: "string" },
    },
  })
  const suite = values.suite as (typeof SUITES)[number]
  if (!SUITES.includes(suite)) {
    process.stderr.write(`--suite is one of ${SUITES.join(", ")}, and it is ${JSON.stringify(values.suite)}.\n`)
    return 2
  }
  const wants = (name: string): boolean => suite === "all" || suite === name

  const prompts = await readPrompts()
  const docker = await dockerAvailable()
  const provider = providerFrom(process.env["EVAL_PROVIDER"])
  const planned = wants("held-out") ? prompts.filter((one) => one.requiresDocker !== true || docker) : []
  const estimate = {
    inputTokens: planned.length * ESTIMATE_PER_PROMPT.input,
    outputTokens: planned.length * ESTIMATE_PER_PROMPT.output,
  }
  // The model id is settled from the flags and the table before anything reads the key, so a dry run spends nothing.
  const wanted = values.model ?? process.env["EVAL_MODEL"] ?? defaultModel(provider)
  const estimated = costOf(wanted, estimate.inputTokens, estimate.outputTokens)
  const budget = Number(process.env["EVAL_MAX_USD"] ?? DEFAULT_MAX_USD)
  if (!Number.isFinite(budget) || budget <= 0) {
    process.stderr.write(`EVAL_MAX_USD is a positive number of dollars, and it is ${JSON.stringify(process.env["EVAL_MAX_USD"])}.\n`)
    return 2
  }
  const price = priceOf(wanted)

  process.stdout.write(`flintd evals — ${provider}/${wanted}, suite ${suite}\n`)
  process.stdout.write(
    `  price     ${price === null ? "not in the table of evals/model.ts" : `$${price.input}/M in, $${price.output}/M out`}\n`,
  )
  process.stdout.write(
    `  estimate  ${planned.length} prompts, ~${estimate.inputTokens} in + ~${estimate.outputTokens} out = ${usd(estimated)} (cap ${usd(budget)})\n`,
  )
  process.stdout.write(`  docker    ${docker ? "present, so the container prompt runs" : "absent, so the container prompt is skipped"}\n`)
  if (estimated !== null && estimated > budget) {
    process.stderr.write(`The estimate is over the cap. Raise EVAL_MAX_USD or run one suite at a time.\n`)
    return 1
  }
  // An unpriced model cannot be capped, so it is refused rather than run with a cap that can never bite.
  if (price === null && process.env["EVAL_ALLOW_UNPRICED"] !== "1") {
    process.stderr.write(
      `${wanted} is not in the price table of evals/model.ts, so this run could not be held to EVAL_MAX_USD.\n` +
        `Add its row with the provider's pricing page and the date, or set EVAL_ALLOW_UNPRICED=1 to run it uncapped.\n`,
    )
    return 2
  }
  if (values["dry-run"] === true) {
    process.stdout.write(`  dry run   no key was read, no provider was called, and no daemon was started\n`)
    return 0
  }

  const credentials = await readCredentials(provider)
  const model = await resolveModel(credentials, values.model)

  const startedAt = new Date()
  // Taken once, before anything runs: every save of the results carries the tree the run actually measured.
  const tree = await treeHash()
  let dir: string | undefined
  // Codex refuses to create its helper binaries under a CODEX_HOME in the OS temp directory, so the harness homes
  // live beside this lane instead. Removed with everything else at the end of the run.
  let harnessDir: string | undefined
  let meter: Meter | undefined
  let fixture: Fixture | undefined
  let daemon: EvalDaemon | undefined
  let heldOut: PromptOutcome[] = []
  let harness: HarnessOutcome[] = []
  let observer: ObserverOutcome | null = null
  let daemonHomeUntouched = true
  let broke: unknown

  // Everything this run starts is stopped here, on every path: the temp home carries the operator's key.
  const cleanup = async (): Promise<void> => {
    await daemon?.stop().catch(() => undefined)
    await fixture?.stop().catch(() => undefined)
    await meter?.stop().catch(() => undefined)
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    if (harnessDir !== undefined) await rm(harnessDir, { recursive: true, force: true })
  }
  const state = (): RunState => ({
    startedAt,
    suite,
    treeHash: tree,
    provider,
    model,
    price,
    estimate: { ...estimate, usd: estimated },
    budget,
    meter,
    heldOut,
    harness,
    observer,
    observerPlanned: wants("observer"),
    daemonHomeUntouched,
    roots: [
      { label: "harness-dir", path: harnessDir ?? "" },
      { label: "flintd-home", path: dir ?? "" },
      { label: "repo", path: root },
    ],
  })
  const file = join(here, "results", `${startedAt.toISOString().replaceAll(":", "-")}.json`)
  const record = await startRecord(file, state, cleanup)

  try {
    dir = await mkdtemp(join(tmpdir(), "flintd-eval-"))
    harnessDir = await mkdtemp(join(here, ".tmp-harness-"))
    meter = await startMeter(credentials)
    fixture = await startFixture()
    daemon = await startDaemon({
      root,
      home: join(dir, "home"),
      port: await freePort(),
      provider,
      apiKey: credentials.apiKey,
      model,
      baseUrl: `${meter.url}/daemon`,
      seeds: SEEDS,
    })
    // An Observer run holds its request open for one model call per candidate, and the daemon bounds it at ten minutes.
    const flint = createFlint({ url: daemon.url, token: daemon.token, timeoutMs: 660_000 })
    const counted = meter
    const overBudget = (): string | null => {
      const held = sum(counted.lane("author"), sum(counted.lane("daemon"), counted.lane("harness")))
      const spent = costOf(model, held.input, held.output)
      return spent !== null && spent > budget
        ? `the run had spent ${usd(spent)} against the EVAL_MAX_USD cap of ${usd(budget)}`
        : null
    }

    if (wants("held-out")) {
      process.stdout.write(`\nheld-out suite (${planned.length} prompts)\n`)
      heldOut = await runHeldOut({
        flint,
        adapter: createModelAdapter({ provider, apiKey: credentials.apiKey, model, baseUrl: `${meter.url}/author` }, 180_000),
        prompts: planned,
        fixture: fixture.url,
        docker,
        overBudget,
        say: (line) => process.stdout.write(`${line}\n`),
        onPrompt: async (outcomes) => {
          heldOut = outcomes
          await keep(record.save(UNFINISHED))
        },
      })
    }
    // The Observer runs before the harness suite: a smoke that misconfigured a harness must not be able to
    // explain away an observer failure, and the two then never share anything but the daemon.
    if (wants("observer")) {
      process.stdout.write(`\nobserver suite\n`)
      const over = overBudget()
      observer =
        over === null
          ? await runObserver(flint)
          : { status: "fail", candidates: 0, drafts: [], refusals: [], channel: null, reason: over, durationMs: 0 }
      process.stdout.write(
        `  ${observer.status === "pass" ? "pass" : "FAIL"}  ${observer.candidates} candidates, ` +
          `drafts ${observer.drafts.join(", ") || "none"}${observer.reason === null ? "" : `  ${observer.reason}`}\n`,
      )
      await keep(record.save(UNFINISHED))
    }
    if (wants("harness")) {
      process.stdout.write(`\nharness suite\n`)
      const before = await daemon.config()
      // The Tool a harness is told to call, with the arguments the held-out suite already called it with.
      const seed = heldOut.find((one) => one.verified && one.called)
      const seeded = seed?.tool ?? null
      const seededArgs = planned.find((one) => one.id === seed?.id)?.probe ?? {}
      harness = await runHarnesses({
        root,
        url: daemon.url,
        port: daemon.port,
        token: daemon.token,
        dir: harnessDir,
        seededTool: seeded,
        seededArgs,
        provider,
        meterBase: `${meter.url}/harness`,
        apiKey: credentials.apiKey,
        model,
        calls: () => callsOf(flint, seeded),
        overBudget,
        say: (line) => process.stdout.write(`${line}\n`),
        onHarness: async (outcomes) => {
          harness = outcomes
          await keep(record.save(UNFINISHED))
        },
      })
      daemonHomeUntouched = (await daemon.config()) === before
      process.stdout.write(
        `  ${daemonHomeUntouched ? "ok  " : "FAIL"} the daemon's own config.json is unchanged by the harness suite\n`,
      )
    }
  } catch (cause) {
    // The daemon is a child process, so what it said before it died is the only account of why the suite stopped.
    broke = cause
    process.stderr.write(`\nthe run stopped: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    const said = daemon?.errors().trim() ?? ""
    process.stderr.write(said === "" ? "the daemon wrote nothing to stderr\n" : `the daemon said:\n${said}\n`)
  } finally {
    record.release()
    await cleanup()
  }

  const results = await record.save(broke === undefined ? null : broke instanceof Error ? broke.message : String(broke))
  process.stdout.write(summary(results, file, meter?.reasons() ?? []))
  return results.ok ? 0 : 1
}

// A mid-run save that fails must not end a run that is spending real money: the next one is the one that has to land.
async function keep(saving: Promise<unknown>): Promise<void> {
  await saving.catch((cause: unknown) => {
    process.stderr.write(`the results file could not be saved: ${cause instanceof Error ? cause.message : String(cause)}\n`)
  })
}

function summary(results: Results, file: string, uncounted: readonly string[]): string {
  const lines = [
    "",
    "summary",
    `  held-out    ${results.heldOut.passed}/${results.heldOut.ran} passed` +
      `${results.heldOut.rate === null ? "" : ` (${(results.heldOut.rate * 100).toFixed(1)}%, threshold ${(results.heldOut.threshold * 100).toFixed(0)}%)`}` +
      `, ${results.heldOut.skipped} skipped`,
    `  first pass  ${results.heldOut.firstPass}/${results.heldOut.ran} passed with no repair` +
      `${results.heldOut.firstPassRate === null ? "" : ` (${(results.heldOut.firstPassRate * 100).toFixed(1)}%)`}` +
      `, and flintd refused ${results.heldOut.repaired} that got one repair each`,
    `  harness     ${results.harness.pass} pass, ${results.harness.handshake} handshake, ${results.harness.fail} fail, ${results.harness.skipped} skipped`,
    `  observer    ${results.observer.status}${results.observer.reason === null ? "" : `: ${results.observer.reason}`}`,
    ...(results.stopped === null ? [] : [`  STOPPED     ${results.stopped}`]),
    `  tokens      ${results.usage.total.input} in, ${results.usage.total.output} out over ${results.usage.total.requests} model calls`,
    ...(results.usage.unreadable === 0
      ? []
      : [
          `  UNCOUNTED   ${results.usage.unreadable} provider answers carried no usage the meter could read, so the cost is a floor`,
          ...(results.usage.uncounted ?? []).map((why) => `              ${why}`),
          ...uncounted.map((why) => `              ${why}`),
        ]),
    `  cost        ${usd(results.cost.total)} of a ${usd(results.cost.cap)} cap (authoring ${usd(results.cost.author)}, daemon ${usd(results.cost.daemon)}, harness ${usd(results.cost.harness)})`,
    `  duration    ${(results.durationMs / 1000).toFixed(1)} s`,
    `  results     ${file}`,
    "",
  ]
  for (const one of results.thresholds) {
    lines.push(`  ${one.ok ? "ok  " : "FAIL"} ${one.name}: ${(one.value * 100).toFixed(1)}% against ${(one.threshold * 100).toFixed(0)}%`)
  }
  return `${lines.join("\n")}\n`
}

// The daemon's own count of calls against one Tool, which is the only account of a harness call the harness did not write.
async function callsOf(flint: Flint, name: string | null): Promise<number> {
  if (name === null) return 0
  const read = (await flint.call("tool_read", { name }).catch(() => ({}))) as { stats?: { calls?: unknown } }
  return typeof read.stats?.calls === "number" ? read.stats.calls : 0
}

async function dockerAvailable(): Promise<boolean> {
  return exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 }).then(
    () => true,
    () => false,
  )
}

// A tree hash of the working tree, taken through a temporary index so the repository's own index is untouched.
// It writes the blobs of every tracked and untracked file into the object store, which the next commit would write anyway.
async function treeHash(): Promise<string | null> {
  const index = join(tmpdir(), `flintd-eval-index-${process.pid}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  try {
    await exec("git", ["-C", root, "add", "-A"], { env, timeout: 120_000 })
    const written = await exec("git", ["-C", root, "write-tree"], { env, timeout: 120_000 })
    return written.stdout.trim()
  } catch {
    return null
  } finally {
    await rm(index, { force: true })
  }
}

process.exitCode = await main(process.argv.slice(2))
