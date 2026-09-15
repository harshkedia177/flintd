import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { HarnessOutcome } from "./harness/index.ts"
import type { PromptOutcome } from "./held-out.ts"
import { costOf } from "./model.ts"
import type { Price } from "./model.ts"
import type { ObserverOutcome } from "./observer.ts"
import { isResults } from "./results.ts"
import type { Results } from "./results.ts"
import { sum } from "./servers.ts"
import type { Meter, Usage } from "./servers.ts"

export const HELD_OUT_THRESHOLD = 0.9

// What `stopped` carries between the saves, so a file the run was killed beside never reads as a finished run.
export const UNFINISHED = "the run had not finished when this file was written"

const EMPTY: Usage = { requests: 0, input: 0, output: 0 }

// Everything a results file is made of, read afresh at each save, so a save is whatever the run has reached by then.
export interface RunState {
  startedAt: Date
  suite: string
  treeHash: string | null
  provider: string
  model: string
  price: Price | null
  estimate: { inputTokens: number; outputTokens: number; usd: number | null }
  budget: number
  meter: Meter | undefined
  heldOut: PromptOutcome[]
  harness: HarnessOutcome[]
  observer: ObserverOutcome | null
  observerPlanned: boolean
  daemonHomeUntouched: boolean
  // Absolute paths under these are rewritten before a save: a results file is committed, and the machine that
  // produced it is nobody's business.
  roots: { label: string; path: string }[]
}

export function buildResults(state: RunState, stopped: string | null): Results {
  return redact(built(state, stopped), state.roots) as Results
}

function built(state: RunState, stopped: string | null): Results {
  const author = state.meter?.lane("author") ?? EMPTY
  const daemon = state.meter?.lane("daemon") ?? EMPTY
  const harnessUsage = state.meter?.lane("harness") ?? EMPTY
  const total = sum(author, sum(daemon, harnessUsage))
  const ran = state.heldOut.filter((one) => !one.skipped)
  const passed = ran.filter((one) => one.pass)
  const rate = ran.length === 0 ? null : passed.length / ran.length
  const repaired = ran.filter((one) => one.repair !== null)
  const firstPass = passed.filter((one) => one.repair === null)
  const harnessRan = state.harness.filter((one) => one.status !== "skipped")
  const thresholds = thresholdsOf(state, rate, harnessRan)
  const finishedAt = new Date()
  return {
    startedAt: state.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - state.startedAt.getTime(),
    suite: state.suite,
    flintd: { treeHash: state.treeHash, node: process.version },
    model: { provider: state.provider, id: state.model, price: state.price },
    estimate: state.estimate,
    usage: {
      author,
      daemon,
      harness: harnessUsage,
      total,
      unreadable: state.meter?.unreadable() ?? 0,
      uncounted: state.meter?.reasons() ?? [],
    },
    cost: {
      author: costOf(state.model, author.input, author.output),
      daemon: costOf(state.model, daemon.input, daemon.output),
      harness: costOf(state.model, harnessUsage.input, harnessUsage.output),
      total: costOf(state.model, total.input, total.output),
      cap: state.budget,
    },
    heldOut: {
      ran: ran.length,
      passed: passed.length,
      firstPass: firstPass.length,
      repaired: repaired.length,
      skipped: state.heldOut.length - ran.length,
      rate,
      firstPassRate: ran.length === 0 ? null : firstPass.length / ran.length,
      threshold: HELD_OUT_THRESHOLD,
      prompts: state.heldOut,
    },
    harness: {
      pass: state.harness.filter((one) => one.status === "pass").length,
      handshake: state.harness.filter((one) => one.status === "handshake").length,
      fail: state.harness.filter((one) => one.status === "fail").length,
      skipped: state.harness.filter((one) => one.status === "skipped").length,
      daemonHomeUntouched: state.daemonHomeUntouched,
      harnesses: state.harness,
    },
    observer: state.observer ?? {
      status: "skipped",
      reason: state.observerPlanned
        ? "the run stopped before the Observer finished"
        : `the suite ${state.suite} does not run the Observer`,
    },
    stopped,
    thresholds,
    ok: stopped === null && thresholds.every((one) => one.ok),
  }
}

// A results file is committed, so a path that names the machine it ran on is rewritten to the root it sat under.
// Longest path first, so a nested root wins over the one that contains it.
function redact<T>(value: T, roots: readonly { label: string; path: string }[]): T {
  const ordered = [...roots].filter((one) => one.path !== "").sort((a, b) => b.path.length - a.path.length)
  const walk = (held: unknown): unknown => {
    if (typeof held === "string") {
      return ordered.reduce((text, one) => text.replaceAll(one.path, `<${one.label}>`), held)
    }
    if (Array.isArray(held)) return held.map(walk)
    if (held !== null && typeof held === "object") {
      return Object.fromEntries(Object.entries(held).map(([key, one]) => [key, walk(one)]))
    }
    return held
  }
  return walk(value) as T
}

function thresholdsOf(state: RunState, rate: number | null, harnessRan: HarnessOutcome[]): Results["thresholds"] {
  return [
    ...(rate === null
      ? []
      : [{ name: "held-out pass rate", value: rate, threshold: HELD_OUT_THRESHOLD, ok: rate >= HELD_OUT_THRESHOLD }]),
    ...(harnessRan.length === 0
      ? []
      : [
          {
            name: "installed harnesses that reach the daemon",
            value: harnessRan.filter((one) => one.status !== "fail").length / harnessRan.length,
            threshold: 1,
            ok: harnessRan.every((one) => one.status !== "fail"),
          },
          {
            name: "the harness suite leaves the daemon's own config alone",
            value: state.daemonHomeUntouched ? 1 : 0,
            threshold: 1,
            ok: state.daemonHomeUntouched,
          },
        ]),
    ...(state.observer === null
      ? []
      : [
          {
            name: "the Observer writes a Draft in the observer Channel",
            value: state.observer.status === "pass" ? 1 : 0,
            threshold: 1,
            ok: state.observer.status === "pass",
          },
        ]),
  ]
}

export interface RunRecord {
  // The run's own account of itself, as far as it has got. Every save goes to the one file the run opened with.
  save(stopped: string | null): Promise<Results>
  // Hands the signals back to Node, for the path where the run reaches its own end.
  release(): void
}

export async function startRecord(
  file: string,
  state: () => RunState,
  cleanup: () => Promise<void>,
): Promise<RunRecord> {
  await mkdir(dirname(file), { recursive: true })
  const part = `${file}.part`
  let queue: Promise<unknown> = Promise.resolve()
  const save = (stopped: string | null): Promise<Results> => {
    const results = buildResults(state(), stopped)
    if (!isResults(results)) throw new Error("the runner built a result this lane's own schema does not read")
    const text = `${JSON.stringify(results, null, 2)}\n`
    // Written beside the file and renamed over it: a kill during a save must never leave half a record behind.
    const done = queue.then(async () => {
      await writeFile(part, text)
      await rename(part, file)
      return results
    })
    // One save at a time, and one that failed never blocks the next: the last save is the one that has to land.
    queue = done.catch(() => undefined)
    return done
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    void (async () => {
      process.stderr.write(`\nstopped by ${signal}: saving what the run has, then removing the eval home and the daemon it holds\n`)
      await save(`stopped by ${signal}`).catch((cause: unknown) => {
        process.stderr.write(`the results file could not be saved: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      })
      await cleanup()
      process.exit(130)
    })()
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  return {
    save,
    release: (): void => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    },
  }
}
