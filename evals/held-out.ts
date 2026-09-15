import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { ToolError } from "@flintd/core"
import type { Flint, JsonSchema, JsonValue, ModelAdapter, ToolDefinition } from "@flintd/core"

const AUTHOR_MAX_TOKENS = 12_000
const HELD_OUT_POLL_MS = 2_000
const HELD_OUT_WAIT_MS = 600_000
const MAX_SENT_BYTES = 4096

const FRAMING = `You write one Tool for flintd, a Library of Tools that agents write for themselves. The definition of flintd's own \`tool_create\` follows this instruction, and it is the whole contract your Tool is held to.

Answer with one JSON object and nothing else. It holds exactly these seven keys, and every value is a string:

{"name": "...", "description": "...", "parameters_json": "...", "execute_source": "...", "examples_json": "...", "manifest_json": "...", "result_json": "..."}

- name, description, parameters_json and execute_source are the arguments of tool_create, as it describes them.
- examples_json is the "examples" argument written as a JSON string: an array of at least two {"args": <object>, "expected": <the exact result>}. flintd runs every one before it saves anything, and one that does not match exactly refuses the whole Tool, so give only Examples you have worked out by hand.
- manifest_json is "{}" when the Tool needs nothing outside itself, and otherwise exactly the Manifest the task asks for.
- result_json is "" unless the task fixes the shape of the result.

When the Manifest is not empty, write Examples that really use what it asks for: flintd asks one person to approve the Manifest and then runs those Examples again, and an Example that avoids the capability proves nothing.
Note that \`setTimeout\` is a plain name and never a field of ctx, and that the Body is the inside of the function, with no function line of its own.`

const AUTHOR_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    parameters_json: { type: "string" },
    execute_source: { type: "string" },
    examples_json: { type: "string" },
    manifest_json: { type: "string" },
    result_json: { type: "string" },
  },
  required: ["name", "description", "parameters_json", "execute_source", "examples_json", "manifest_json", "result_json"],
  additionalProperties: false,
} as const

// The fixture tree of the Manifest root, seeded before the suite runs and quoted byte for byte by every fs prompt:
// an Example and a Held-out case for a Tool that reads a file are both written by a model that sees only the prompt.
export const SEEDS: Record<string, string> = {
  "README.md": "# workspace\nthe second line\nthe third line\n",
  "notes.txt": "the first line\nthe second line\nthe third line\n",
  "log.txt": "the first entry\n",
  "data.csv": "name,age\nada,36\ngrace,45\n",
  "hash.txt": "the line only this file holds\n",
  "notes/a.txt": "alpha\nbeta\n",
}

// The one file the suite appends to, so no other prompt may fix an answer that depends on what it holds.
export const APPENDED = "log.txt"

export interface Prompt {
  id: string
  kind: string
  prompt: string
  probe: Record<string, JsonValue>
  // What the finished Tool must answer for `probe`, when the prompt fixes it. The call proves nothing without one.
  expect?: JsonValue
  requires?: string
  requiresDocker?: boolean
}

export interface Repair {
  // The refusal that earned the repair: flintd's own words, sent back with the original prompt and nothing else.
  refusal: string
  // What ended the second attempt, or null when it went through.
  second: string | null
}

export interface PromptOutcome {
  id: string
  kind: string
  tool: string | null
  created: boolean
  approved: boolean
  heldOut: string | null
  verified: boolean
  called: boolean
  pass: boolean
  skipped: boolean
  reason: string | null
  // What the Held-out run refused, so a reader can tell a Tool that did not generalize from a flintd defect.
  failures: JsonValue[]
  // The arguments of the last write flintd refused, so the next reader sees the shape rather than deriving it.
  sent: string | null
  // The one repair a refusal earned, or null when flintd refused nothing.
  repair: Repair | null
  durationMs: number
}

export interface HeldOutOptions {
  flint: Flint
  adapter: ModelAdapter
  prompts: Prompt[]
  fixture: string
  docker: boolean
  // The measured spend so far, as a sentence, when it has crossed the cap. Checked before each prompt is authored.
  overBudget: () => string | null
  say: (line: string) => void
  // Everything decided so far, after each prompt, so a run that is killed still leaves the prompts it finished.
  onPrompt: (outcomes: PromptOutcome[]) => Promise<void>
}

const PROMPTS_FILE = join(dirname(fileURLToPath(import.meta.url)), "prompts.json")

export async function readPrompts(): Promise<Prompt[]> {
  const parsed = JSON.parse(await readFile(PROMPTS_FILE, "utf8")) as unknown
  if (!Array.isArray(parsed) || !parsed.every(isPrompt)) throw new Error(`${PROMPTS_FILE} is not a list of prompts`)
  const ids = new Set(parsed.map((one) => one.id))
  if (ids.size !== parsed.length) throw new Error(`${PROMPTS_FILE} holds two prompts with one id`)
  for (const one of parsed) {
    if (one.requires !== undefined && !ids.has(one.requires)) {
      throw new Error(`the prompt ${one.id} requires ${one.requires}, which is not in ${PROMPTS_FILE}`)
    }
  }
  return parsed
}

export function isPrompt(value: unknown): value is Prompt {
  if (typeof value !== "object" || value === null) return false
  const one = value as Record<string, unknown>
  return (
    typeof one["id"] === "string" &&
    typeof one["kind"] === "string" &&
    typeof one["prompt"] === "string" &&
    typeof one["probe"] === "object" &&
    one["probe"] !== null &&
    !Array.isArray(one["probe"]) &&
    (one["requires"] === undefined || typeof one["requires"] === "string") &&
    (one["requiresDocker"] === undefined || typeof one["requiresDocker"] === "boolean")
  )
}

// One prompt at a time: a composition prompt names the Tool an earlier prompt wrote, and a Held-out run is the slow part anyway.
export async function runHeldOut(options: HeldOutOptions): Promise<PromptOutcome[]> {
  const definition = await toolCreateDefinition(options.flint)
  const system = `${FRAMING}\n\n${JSON.stringify(definition, null, 2)}`
  const written = new Map<string, string>()
  const outcomes: PromptOutcome[] = []
  for (const prompt of options.prompts) {
    const outcome = await onePrompt(options, prompt, system, written)
    if (outcome.tool !== null && outcome.verified) written.set(prompt.id, outcome.tool)
    options.say(
      `  ${outcome.pass ? "pass" : outcome.skipped ? "skip" : "FAIL"}  ${prompt.id.padEnd(20)}` +
        `${outcome.tool ?? "-"}${outcome.reason === null ? "" : `  ${outcome.reason}`}`,
    )
    outcomes.push(outcome)
    await options.onPrompt(outcomes)
  }
  return outcomes
}

async function onePrompt(
  options: HeldOutOptions,
  prompt: Prompt,
  system: string,
  written: Map<string, string>,
): Promise<PromptOutcome> {
  const started = Date.now()
  const blank: PromptOutcome = {
    id: prompt.id,
    kind: prompt.kind,
    tool: null,
    created: false,
    approved: false,
    heldOut: null,
    verified: false,
    called: false,
    pass: false,
    skipped: false,
    reason: null,
    failures: [],
    sent: null,
    repair: null,
    durationMs: 0,
  }
  const done = (extra: Partial<PromptOutcome>): PromptOutcome => ({ ...blank, ...extra, durationMs: Date.now() - started })

  const over = options.overBudget()
  if (over !== null) return done({ skipped: true, reason: over })
  if (prompt.requiresDocker === true && !options.docker) {
    return done({ skipped: true, reason: "no OCI engine on this machine, so the container tier cannot run" })
  }
  const dependency = prompt.requires === undefined ? null : written.get(prompt.requires)
  if (prompt.requires !== undefined && dependency === undefined) {
    return done({ skipped: true, reason: `the Tool of the prompt ${prompt.requires} was never verified` })
  }
  const text = prompt.prompt
    .replaceAll("{{fixture}}", options.fixture)
    .replaceAll("{{requires}}", dependency ?? "")

  let args: Record<string, JsonValue>
  try {
    args = await author(options.adapter, system, text)
  } catch (cause) {
    return done({ reason: `authoring: ${message(cause)}` })
  }
  let name = String(args["name"])

  let saved = await attempt(options.flint, args, null)
  let repair: Repair | null = null
  // A refusal is flintd saying what to fix with nothing saved, which is the one turn a real agent takes again.
  // It gets exactly one, on flintd's own words: no hint, no rephrasing, nothing the runner wrote.
  if (saved.refused && options.overBudget() === null) {
    const refusal = saved.reason as string
    const existing = saved.created ? name : null
    let again: Record<string, JsonValue> | null = null
    try {
      again = await author(options.adapter, system, `${text}\n\n${refusal}`)
    } catch (cause) {
      repair = { refusal, second: `authoring: ${message(cause)}` }
    }
    if (again !== null) {
      args = again
      if (existing === null) name = String(args["name"])
      const second = await attempt(options.flint, args, existing)
      repair = { refusal, second: second.reason }
      saved = { ...second, created: second.created || saved.created }
    }
  }
  if (saved.reason !== null) {
    return done({ tool: name, created: saved.created, approved: saved.approved, reason: saved.reason, sent: sent(args), repair })
  }

  const heldOut = await settled(options.flint, name)
  const verified = heldOut.status === "passed"
  let called = false
  let reason = verified ? null : heldOutReason(heldOut)
  try {
    const answer = await options.flint.call(name, prompt.probe)
    // A call that only did not throw proves little, so a prompt that fixes its answer is held to it.
    called = prompt.expect === undefined || canonical(answer) === canonical(prompt.expect)
    if (!called) reason = reason ?? `the call answered ${canonical(answer).slice(0, 200)}, and the prompt fixes ${canonical(prompt.expect as JsonValue)}`
  } catch (cause) {
    reason = reason ?? `the call failed: ${message(cause)}`
  }
  return done({
    tool: name,
    created: true,
    approved: saved.approved,
    heldOut: heldOut.status,
    verified,
    called,
    pass: verified,
    reason,
    failures: heldOut.failures,
    repair,
  })
}

interface Attempt {
  created: boolean
  approved: boolean
  // What ended the attempt, or null when the Tool is saved and its grant is in force.
  reason: string | null
  // Set when that reason is flintd refusing a write it did not save, which is the only outcome a repair answers.
  refused: boolean
}

// One write and the Approval a Manifest raises. `existing` names the Tool a refused first attempt left behind,
// which a repair changes rather than writes again.
async function attempt(flint: Flint, args: Record<string, JsonValue>, existing: string | null): Promise<Attempt> {
  const write = existing === null ? "tool_create" : "tool_update"
  try {
    await flint.call(write, existing === null ? args : { ...args, name: existing })
  } catch (cause) {
    return { created: existing !== null, approved: false, reason: `${write}: ${message(cause)}`, refused: true }
  }
  // An Example a pending Manifest kept from running is deferred; the grant runs every Example again with it in force.
  let granted: { asked: boolean; refused: string | null }
  try {
    granted = await approve(flint, existing ?? String(args["name"]))
  } catch (cause) {
    return { created: true, approved: false, reason: `approval: ${message(cause)}`, refused: false }
  }
  if (granted.refused !== null) return { created: true, approved: false, reason: `approval: ${granted.refused}`, refused: true }
  return { created: true, approved: granted.asked, reason: null, refused: false }
}

async function author(adapter: ModelAdapter, system: string, prompt: string): Promise<Record<string, JsonValue>> {
  const written = await adapter.complete({
    system,
    messages: [{ role: "user", content: prompt }],
    maxTokens: AUTHOR_MAX_TOKENS,
    json: AUTHOR_SCHEMA as unknown as JsonSchema,
  })
  const answer = JSON.parse(strip(written)) as Record<string, unknown>
  const examples = JSON.parse(String(answer["examples_json"])) as JsonValue
  if (!Array.isArray(examples) || examples.length === 0) throw new Error("examples_json is not a non-empty array")
  const args: Record<string, JsonValue> = {
    name: String(answer["name"]),
    description: String(answer["description"]),
    parameters_json: String(answer["parameters_json"]),
    execute_source: String(answer["execute_source"]),
    examples,
  }
  const manifest = String(answer["manifest_json"] ?? "")
  const result = String(answer["result_json"] ?? "")
  if (manifest !== "" && manifest !== "{}") args["manifest_json"] = manifest
  if (result !== "") args["result_json"] = result
  return args
}

// A model that has been told to answer with JSON still fences it now and then, and a fence is not the model failing the task.
function strip(written: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(written)
  return fenced === null ? written : (fenced[1] as string)
}

// The arguments the authoring model wrote, cut to 4 KB the way a Provenance excerpt is. The cut is on a byte and
// not on a character, so a character it lands inside comes back as U+FFFD; this is a reading, never evidence.
// It carries no credential: the runner sends the model its own prompt and nothing of the environment it runs in.
function sent(args: Record<string, JsonValue>): string {
  return Buffer.from(JSON.stringify(args), "utf8").subarray(0, MAX_SENT_BYTES).toString("utf8")
}

// The runner is the operator of this daemon, so it answers the Approval a Manifest raises, the way a person would.
// The grant runs every deferred Example again before it writes "approved", so a decision that comes back pending is
// the Examples failing with the Manifest in force. That is this prompt's verdict, not something to wait out.
async function approve(flint: Flint, name: string): Promise<{ asked: boolean; refused: string | null }> {
  const waiting = (await flint.approvals()).filter((one) => one.tool === name && one.status === "pending")
  let refused: string | null = null
  for (const one of waiting) {
    const decided = await flint.approve(one.id, "approved by the evals lane")
    if (decided.status !== "approved") {
      refused ??= decided.message ?? `the Approval of ${name} came back ${decided.status}`
    }
  }
  return { asked: waiting.length > 0, refused }
}

async function settled(flint: Flint, name: string): Promise<{ status: string; reason: string | null; failures: JsonValue[] }> {
  const deadline = Date.now() + HELD_OUT_WAIT_MS
  for (;;) {
    const read = (await flint.call("tool_read", { name })) as { held_out?: Record<string, unknown> }
    const held = read.held_out ?? {}
    const status = String(held["status"] ?? "unavailable")
    if (status !== "pending") {
      return {
        status,
        reason: typeof held["reason"] === "string" ? held["reason"] : null,
        failures: Array.isArray(held["failures"]) ? (held["failures"] as JsonValue[]) : [],
      }
    }
    if (Date.now() > deadline) return { status: "pending", reason: `no Held-out answer within ${HELD_OUT_WAIT_MS} ms`, failures: [] }
    await delay(HELD_OUT_POLL_MS)
  }
}

function heldOutReason(held: { status: string; reason: string | null; failures: JsonValue[] }): string {
  const first = held.failures[0] as { reason?: unknown; expected?: unknown; actual?: unknown } | undefined
  const said = first === undefined ? held.reason : String(first.reason ?? "")
  return `held-out ${held.status}${said === null || said === "" ? "" : `: ${said}`}`
}

async function toolCreateDefinition(flint: Flint): Promise<ToolDefinition> {
  const tools = (await flint.tools()) as ToolDefinition[]
  const found = tools.find((one) => one.name === "tool_create")
  if (found === undefined) throw new Error("the daemon's tool list holds no tool_create")
  return found
}

function message(cause: unknown): string {
  if (cause instanceof ToolError) return `${cause.code}: ${cause.message}`
  return cause instanceof Error ? cause.message : String(cause)
}

// Key order is the model's choice and never the Tool's meaning, so the two answers are compared sorted.
function canonical(value: unknown): string {
  const sort = (one: unknown): unknown => {
    if (Array.isArray(one)) return one.map(sort)
    if (typeof one !== "object" || one === null) return one
    return Object.fromEntries(Object.keys(one as object).sort().map((key) => [key, sort((one as Record<string, unknown>)[key])]))
  }
  return JSON.stringify(sort(value))
}
