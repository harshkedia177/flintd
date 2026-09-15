import type { Flint } from "@flintd/core"

const SESSIONS = 3
const CHANNEL = "observer"

// A pattern is counted by the number of distinct sessions it ran in, so three sessions of the same two steps is
// the smallest corpus that reaches the default observerRepeats of 3.
const PATTERN = [
  { tool: "Read", argumentKeys: ["file_path"] },
  { tool: "Edit", argumentKeys: ["file_path", "new_string", "old_string"] },
]

export interface ObserverOutcome {
  status: "pass" | "fail"
  candidates: number
  drafts: string[]
  refusals: string[]
  channel: string | null
  reason: string | null
  durationMs: number
}

// Three sessions of one repeated pattern, one Observer run, and one Draft that flintd wrote in the observer Channel.
export async function runObserver(flint: Flint): Promise<ObserverOutcome> {
  const started = Date.now()
  const done = (extra: Partial<ObserverOutcome>): ObserverOutcome => ({
    status: "fail",
    candidates: 0,
    drafts: [],
    refusals: [],
    channel: null,
    reason: null,
    durationMs: Date.now() - started,
    ...extra,
  })

  for (let session = 0; session < SESSIONS; session += 1) {
    for (const step of PATTERN) {
      await flint.observe({
        harness: "claude-code",
        session: `eval-session-${session}`,
        tool: step.tool,
        argumentKeys: step.argumentKeys,
        status: "ok",
      })
    }
  }

  const run = await flint.observer.run({ dryRun: false })
  const drafts = run.drafts.map((one) => one.name)
  const refusals = run.refusals.map((one) => `${one.name ?? one.pattern}: ${one.code} ${one.reason}`)
  const first = drafts[0]
  if (first === undefined) {
    return done({
      candidates: run.candidates.length,
      refusals,
      reason:
        run.candidates.length === 0
          ? "the Observer found no candidate in three sessions of one repeated pattern"
          : `the Observer proposed nothing that was saved: ${refusals.join("; ")}`,
    })
  }
  const channel = await channelOf(flint, first)
  return done({
    status: channel === CHANNEL ? "pass" : "fail",
    candidates: run.candidates.length,
    drafts,
    refusals,
    channel,
    reason: channel === CHANNEL ? null : `the Draft ${first} carries the Channel ${JSON.stringify(channel)}`,
  })
}

async function channelOf(flint: Flint, name: string): Promise<string | null> {
  const history = (await flint.call("tool_history", { name, limit: 1 })) as { versions?: { channel?: unknown }[] }
  const first = history.versions?.[0]
  return first === undefined || typeof first.channel !== "string" ? null : first.channel
}
