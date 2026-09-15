import type { HarnessOutcome } from "./harness/smoke.ts"
import type { PromptOutcome } from "./held-out.ts"
import type { Usage } from "./servers.ts"

export interface Threshold {
  name: string
  value: number
  threshold: number
  ok: boolean
}

export interface Results {
  startedAt: string
  finishedAt: string
  durationMs: number
  suite: string
  flintd: { treeHash: string | null; node: string }
  model: { provider: string; id: string; price: { input: number; output: number } | null }
  estimate: { inputTokens: number; outputTokens: number; usd: number | null }
  usage: { author: Usage; daemon: Usage; harness: Usage; total: Usage; unreadable: number; uncounted?: string[] }
  cost: { author: number | null; daemon: number | null; harness: number | null; total: number | null; cap: number }
  heldOut: {
    ran: number
    passed: number
    // The prompts that passed with no repair, and the prompts flintd refused once and then took.
    firstPass: number
    repaired: number
    skipped: number
    rate: number | null
    firstPassRate: number | null
    threshold: number
    prompts: PromptOutcome[]
  }
  harness: {
    pass: number
    handshake: number
    fail: number
    skipped: number
    daemonHomeUntouched: boolean
    harnesses: HarnessOutcome[]
  }
  observer: { status: string; reason: string | null }
  // Why this file is not the account of a finished run, or null. The runner saves as the run goes, so a file it
  // was killed beside carries the word for that, and one a signal ended carries the signal. Never a pass.
  stopped: string | null
  thresholds: Threshold[]
  ok: boolean
}

// The shape of every file under evals/results. The runner checks what it built against this before it writes,
// so a committed result is never a shape a later reader has to guess at.
export function isResults(value: unknown): value is Results {
  if (!isRecord(value)) return false
  const usage = (one: unknown): boolean =>
    isRecord(one) && whole(one["requests"]) && whole(one["input"]) && whole(one["output"])
  const usages = value["usage"]
  const cost = value["cost"]
  const held = value["heldOut"]
  const harness = value["harness"]
  return (
    typeof value["startedAt"] === "string" &&
    typeof value["finishedAt"] === "string" &&
    whole(value["durationMs"]) &&
    typeof value["suite"] === "string" &&
    isRecord(value["flintd"]) &&
    isRecord(value["model"]) &&
    isRecord(value["estimate"]) &&
    isRecord(usages) &&
    usage(usages["author"]) &&
    usage(usages["daemon"]) &&
    usage(usages["harness"]) &&
    usage(usages["total"]) &&
    whole(usages["unreadable"]) &&
    // Optional: a results file written before round 3 carries the count and not the reasons, and still reads.
    (usages["uncounted"] === undefined ||
      (Array.isArray(usages["uncounted"]) && usages["uncounted"].every((one) => typeof one === "string"))) &&
    isRecord(cost) &&
    money(cost["total"]) &&
    typeof cost["cap"] === "number" &&
    isRecord(held) &&
    whole(held["ran"]) &&
    whole(held["passed"]) &&
    whole(held["skipped"]) &&
    // Optional: a results file written before the repair round carries neither count nor rate, and still reads.
    (held["firstPass"] === undefined || whole(held["firstPass"])) &&
    (held["repaired"] === undefined || whole(held["repaired"])) &&
    (held["firstPassRate"] === undefined || held["firstPassRate"] === null || typeof held["firstPassRate"] === "number") &&
    (held["rate"] === null || typeof held["rate"] === "number") &&
    typeof held["threshold"] === "number" &&
    Array.isArray(held["prompts"]) &&
    held["prompts"].every(isPromptOutcome) &&
    isRecord(harness) &&
    whole(harness["pass"]) &&
    whole(harness["handshake"]) &&
    whole(harness["fail"]) &&
    whole(harness["skipped"]) &&
    typeof harness["daemonHomeUntouched"] === "boolean" &&
    Array.isArray(harness["harnesses"]) &&
    harness["harnesses"].every(isHarnessOutcome) &&
    isRecord(value["observer"]) &&
    (value["stopped"] === null || typeof value["stopped"] === "string") &&
    Array.isArray(value["thresholds"]) &&
    value["thresholds"].every(isThreshold) &&
    typeof value["ok"] === "boolean"
  )
}

function isPromptOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value["id"] === "string" &&
    typeof value["kind"] === "string" &&
    (value["tool"] === null || typeof value["tool"] === "string") &&
    typeof value["created"] === "boolean" &&
    typeof value["verified"] === "boolean" &&
    typeof value["pass"] === "boolean" &&
    typeof value["skipped"] === "boolean" &&
    (value["reason"] === null || typeof value["reason"] === "string") &&
    Array.isArray(value["failures"]) &&
    // A result written before the runner recorded refused arguments carries no "sent", and it still reads.
    (value["sent"] === undefined || value["sent"] === null || typeof value["sent"] === "string") &&
    (value["repair"] === undefined || value["repair"] === null || isRepair(value["repair"])) &&
    whole(value["durationMs"])
  )
}

function isRepair(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["refusal"] === "string" &&
    (value["second"] === null || typeof value["second"] === "string")
  )
}

function isHarnessOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value["harness"] === "string" &&
    ["pass", "handshake", "fail", "skipped"].includes(String(value["status"])) &&
    typeof value["reason"] === "string" &&
    Array.isArray(value["steps"]) &&
    whole(value["durationMs"])
  )
}

function isThreshold(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["value"] === "number" &&
    typeof value["threshold"] === "number" &&
    typeof value["ok"] === "boolean"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function whole(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function money(value: unknown): boolean {
  return value === null || typeof value === "number"
}
