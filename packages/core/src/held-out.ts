import { granted, grantedRun } from "./approvals.ts"
import { causeMessage } from "./errors.ts"
import { listManifestRoot } from "./files.ts"
import { pushLibrary } from "./library.ts"
import type { OpenLibrary } from "./library.ts"
import type { ModelAdapter } from "./model.ts"
import type { ExecutionLimits } from "./quickjs.ts"
import { MAX_STORED_BYTES, canonicalJson, capBytes, isPlainObject, patternsOf, validateArguments } from "./validate.ts"
import type {
  Example,
  HeldOut,
  HeldOutExample,
  HeldOutFailure,
  JsonSchema,
  JsonValue,
  LogEntry,
  Tool,
} from "./types.ts"

const MAX_HELD_OUT = 5
const CONTAINER = /^\s*[[{]/
const POSITION = /position (\d+)/
const GENERATE_MAX_TOKENS = 8192
const JUDGE_MAX_TOKENS = 2048

const GENERATE_SYSTEM =
  "You write Held-out examples for flintd, a Library of Tools that agents write for themselves. A Held-out example is an argument set the Tool's author never gave, and passing it is the proof the Tool generalizes. Answer with this JSON object: {\"cases\": [{\"args\": \"<the arguments as a JSON object, written as a JSON string>\", \"confident\": <boolean>, \"expected\": \"<the exact result as a JSON value, written as a JSON string, only when confident is true>\"}]}. Both args and expected are JSON strings, so a result that is itself a piece of text is quoted inside the string. Give at most 5 cases. The Tool's own description is the whole standard, and it is quoted to you below. Set confident to true only when that description determines the exact result for those arguments; when it does not settle what the result must be, set confident to false and a judge decides the result against it. Add no requirement of your own: a behaviour the description does not ask for is not a defect, however you would have written the Tool yourself. Every args value must match the Tool's argument schema and be arguments the description says the Tool accepts. Do not repeat an Example you were given."

const JUDGE_SYSTEM =
  "You judge one result of a Tool in flintd. The Tool's own description is the whole standard, and it is quoted to you below. Answer with this JSON object: {\"plausible\": <boolean>, \"clause\": \"<the words of the description that settle it, copied out of it exactly>\", \"reason\": \"<one sentence>\"}. Say plausible is false only when the result contradicts a clause you can copy out of that description, and copy that clause into \"clause\". Add no requirement of your own: a behaviour the description does not ask for is not a defect, however you would have written the Tool yourself. When no clause of the description settles the case, say plausible is true and leave \"clause\" empty."

const ACCEPTS_SYSTEM =
  "You judge one refusal of a Tool in flintd. The Tool threw instead of producing a result, and the one question is whether its own description says the Tool accepts arguments like the ones below. That description is the whole standard, and it is quoted to you below. Answer with this JSON object: {\"accepted\": <boolean>, \"clause\": \"<the words of the description that say the Tool accepts them, copied out of it exactly>\", \"reason\": \"<one sentence>\"}. Say accepted is true only when a clause you can copy out of that description says the Tool takes arguments like these, and copy that clause into \"clause\". Add no requirement of your own: arguments the description never asked the Tool to take are not arguments it accepts, however you would have written the Tool yourself. When no clause of the description settles it, say accepted is false and leave \"clause\" empty."

// The structured-output subset takes no free-form value, so the arguments and the result travel as JSON strings.
const GENERATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    cases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          args: { type: "string", description: "The arguments as a JSON object, written as a JSON string." },
          confident: { type: "boolean" },
          expected: { type: "string", description: "The exact result as a JSON value, written as a JSON string." },
        },
        required: ["args", "confident"],
        additionalProperties: false,
      },
    },
  },
  required: ["cases"],
  additionalProperties: false,
}

const JUDGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    plausible: { type: "boolean" },
    clause: { type: "string", description: "The words of the description that settle it, copied exactly." },
    reason: { type: "string" },
  },
  required: ["plausible", "clause", "reason"],
  additionalProperties: false,
}

const ACCEPTS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    clause: { type: "string", description: "The words of the description that say so, copied exactly." },
    reason: { type: "string" },
  },
  required: ["accepted", "clause", "reason"],
  additionalProperties: false,
}

export interface HeldOutRunner {
  readonly configured: boolean
  start(library: OpenLibrary, name: string, version: string): void
  sweep(library: OpenLibrary): void
  settle(): Promise<void>
}

interface Run {
  abort: AbortController
  done: Promise<void>
}

interface Held {
  tool: Tool
  body: string
  examples: Example[]
  // The Manifest root as it stands when the cases are written, and null when the Tool declares no filesystem root.
  listing: { root: string; paths: string } | null
}

interface Case {
  args: JsonValue
  expected: JsonValue
  grade: Example["grade"]
}

interface Outcome {
  actual: JsonValue
  reason: string
}

// `timeoutMs` cuts the model calls and the loop but not a Body inside the tier, so a run is this plus at most one call timeout.
export function createHeldOut(
  adapter: ModelAdapter | undefined,
  limits: ExecutionLimits,
  timeoutMs: number,
  concurrency: number,
  stopGraceMs: number,
  onLog?: (entry: LogEntry) => void,
): HeldOutRunner {
  if (adapter === undefined) {
    return { configured: false, start: () => undefined, sweep: () => undefined, settle: async () => undefined }
  }
  const model = adapter
  const runs = new Map<string, Run>()
  let sweeping: Promise<void> = Promise.resolve()
  let stopped = false

  async function generate(held: Held, signal: AbortSignal): Promise<{ cases: Case[]; skipped: string[] }> {
    const written = await model.complete({
      system: GENERATE_SYSTEM,
      messages: [{ role: "user", content: brief(held) }],
      maxTokens: GENERATE_MAX_TOKENS,
      json: GENERATE_SCHEMA,
      signal,
    })
    const answer = parseAnswer(written)
    const offered = answer["cases"]
    if (!Array.isArray(offered)) throw malformed('the answer carries no "cases" array')
    const cases: Case[] = []
    const skipped: string[] = []
    for (const [index, entry] of offered.slice(0, MAX_HELD_OUT).entries()) {
      const read = readCase(entry, index, held.tool.parameters)
      if (typeof read === "string") skipped.push(read)
      else cases.push(read)
    }
    if (cases.length === 0) {
      throw malformed(skipped.length === 0 ? "the answer carries no case at all" : skipped.join(" "))
    }
    return { cases, skipped }
  }

  async function judge(
    tool: Tool,
    args: JsonValue,
    actual: JsonValue,
    signal: AbortSignal,
  ): Promise<{ decided: boolean; failed: boolean; reason: string }> {
    const written = await model.complete({
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: standard(tool, args, actual),
        },
      ],
      maxTokens: JUDGE_MAX_TOKENS,
      json: JUDGE_SCHEMA,
      signal,
    })
    const answer = parseAnswer(written)
    const plausible = answer["plausible"]
    if (typeof plausible !== "boolean") throw malformed('the judgment carries no "plausible" boolean')
    const clause = typeof answer["clause"] === "string" ? answer["clause"].trim() : ""
    const reason =
      typeof answer["reason"] === "string" && answer["reason"] !== ""
        ? answer["reason"]
        : `the model judged the result ${plausible ? "plausible" : "implausible"} for those arguments`
    // A refusal that quotes nothing the Tool's description promises is the judge's own requirement, and it settles nothing.
    if (!plausible && !quotes(tool.description, clause)) {
      return {
        decided: false,
        failed: false,
        reason: `the judgment named no clause of the Tool's description, so this example was not decided: ${reason}`,
      }
    }
    return {
      decided: true,
      failed: !plausible,
      reason: clause === "" ? reason : `${reason} The clause it judged against: ${JSON.stringify(clause)}.`,
    }
  }

  async function accepts(
    tool: Tool,
    args: JsonValue,
    threw: string,
    signal: AbortSignal,
  ): Promise<{ decided: boolean; reason: string }> {
    const written = await model.complete({
      system: ACCEPTS_SYSTEM,
      messages: [{ role: "user", content: refusal(tool, args, threw) }],
      maxTokens: JUDGE_MAX_TOKENS,
      json: ACCEPTS_SCHEMA,
      signal,
    })
    const answer = parseAnswer(written)
    const clause = typeof answer["clause"] === "string" ? answer["clause"].trim() : ""
    const reason =
      typeof answer["reason"] === "string" && answer["reason"] !== ""
        ? answer["reason"]
        : "the model judged the description against those arguments"
    if (answer["accepted"] !== true || !quotes(tool.description, clause)) {
      return {
        decided: false,
        reason: `the Tool's description was not shown to accept those arguments, so this example was not decided: ${reason}`,
      }
    }
    return { decided: true, reason: `${reason} The clause it judged against: ${JSON.stringify(clause)}.` }
  }

  async function produce(library: OpenLibrary, held: Held, signal: AbortSignal): Promise<HeldOut> {
    let offered: { cases: Case[]; skipped: string[] }
    try {
      offered = await generate(held, signal)
    } catch (cause) {
      return { status: "failed", examples: [], grades: count([]), failures: [], reason: causeMessage(cause) }
    }
    const examples: HeldOutExample[] = []
    const failures: HeldOutFailure[] = []
    const notes = [...offered.skipped]
    let every = true
    let undecided = 0
    for (const [index, one] of offered.cases.entries()) {
      if (signal.aborted) {
        every = false
        notes.push(`the run stopped after ${index} of ${offered.cases.length} Held-out examples.`)
        break
      }
      const outcome = await check(library, held, one, signal)
      examples.push({ args: one.args, expected: one.expected, grade: one.grade, judgment: outcome.judgment })
      if (outcome.failure !== null) {
        failures.push({ index, args: one.args, grade: one.grade, expected: one.expected, ...outcome.failure })
      }
      if (!outcome.decided) undecided += 1
    }
    if (undecided > 0) {
      notes.push(`${undecided} of the ${examples.length} Held-out examples were not decided and count as no evidence.`)
    }
    // A loop that stopped early proves nothing, and neither does one every case of which went undecided: a run
    // passes only when it saw every case, decided at least one of them, and found no failure.
    return {
      status: every && failures.length === 0 && examples.length > undecided ? "passed" : "failed",
      examples,
      grades: count(examples),
      failures,
      reason: notes.length === 0 ? null : notes.join(" "),
    }
  }

  async function check(
    library: OpenLibrary,
    held: Held,
    one: Case,
    signal: AbortSignal,
  ): Promise<{ failure: Outcome | null; judgment: string | null; decided: boolean }> {
    let actual: JsonValue
    try {
      actual = await library.engine.run(
        {
          toolName: held.tool.name,
          body: held.body,
          args: one.args,
          ...grantedRun(library.store, held.tool, held.body),
          limits,
          ...patternsOf(held.tool.parameters, held.tool.result),
        },
        // The grant is asked for again at every host call, so an Approval taken back mid-run stops the run.
        { stillApproved: () => granted(library.store, held.tool, held.body) },
      )
    } catch (cause) {
      const threw = `the Tool did not produce a result: ${causeMessage(cause)}`
      // A throw is charged to the Tool only where the judge can quote its description accepting those arguments.
      const verdict = await accepts(held.tool, one.args, causeMessage(cause), signal).catch((broke: unknown) => ({
        decided: false,
        reason: `the judgment of the arguments failed: ${causeMessage(broke)}`,
      }))
      if (!verdict.decided) return { failure: null, judgment: `${threw}, and ${verdict.reason}`, decided: false }
      return { failure: { actual: null, reason: `${threw} ${verdict.reason}` }, judgment: verdict.reason, decided: true }
    }
    const broken = held.tool.result === undefined ? [] : validateArguments(held.tool.result, actual, "the result")
    if (broken.length > 0) {
      const refused = cut(actual, `the result schema of the Tool refuses this result: ${broken.join(" ")}`)
      return { failure: refused, judgment: null, decided: true }
    }
    if (one.grade === "exact") {
      const passed = canonicalJson(actual) === canonicalJson(one.expected)
      const missed = passed ? null : cut(actual, "the result is not the one the Held-out example expects")
      return { failure: missed, judgment: null, decided: true }
    }
    let verdict: { decided: boolean; failed: boolean; reason: string }
    try {
      verdict = await judge(held.tool, one.args, actual, signal)
    } catch (cause) {
      const broke = cut(actual, `the plausibility judgment failed: ${causeMessage(cause)}`)
      return { failure: broke, judgment: null, decided: true }
    }
    // The judgment is kept whichever way it went, so a reader sees why a Tool was verified and not only why it was not.
    return { failure: verdict.failed ? cut(actual, verdict.reason) : null, judgment: verdict.reason, decided: verdict.decided }
  }

  async function attempt(library: OpenLibrary, name: string, version: string, stopper: AbortSignal): Promise<void> {
    // The deadline is the run's own; the stopper is stop() or a newer Version. Only the stopper means "write nothing".
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([stopper, deadline])
    const held = await library.queue.serialize<Held>(async () => {
      const tool = await library.store.readTool(name)
      const root = tool.manifest.fs
      const paths = root === undefined ? null : await listManifestRoot(library.store.dir, root, name)
      return {
        tool,
        body: await library.store.readBody(name),
        examples: await library.store.readExamples(name),
        listing: root === undefined || paths === null ? null : { root, paths },
      }
    })
    // The run waits for the Approval, so the evidence that takes a Tool out of Draft rests on a Body that ran with what it was granted.
    if (!granted(library.store, held.tool, held.body)) return
    if (stopper.aborted || stopped) return
    const outcome = await produce(library, held, signal)
    if (stopper.aborted || stopped) return
    const wrote = await library.queue.serialize(async () => {
      if (stopped || stopper.aborted) return false
      // A newer Version landed while the model was working, and that Version owns its own Held-out run, not this one.
      if ((await library.store.currentVersion(name)) !== version) return false
      // A person edited the directory while the model was working; writing these files back would destroy that edit.
      if (await library.store.changed(name)) return false
      if (library.store.get(name) === undefined) return false
      const tool: Tool = {
        ...held.tool,
        state: outcome.status === "passed" ? "verified" : held.tool.state,
        provenance: {
          channel: "flintd",
          // A run that failed leaves a Draft, and a Draft is the work of one session: only a pass widens its reach.
          session: outcome.status === "passed" ? null : (held.tool.provenance?.session ?? null),
          harness: null,
          model: model.model,
          excerpt: null,
          createdAt: new Date().toISOString(),
        },
      }
      const written = await library.store.write(
        { tool, examples: held.examples, body: held.body, stats: library.store.stats(name), heldOut: outcome },
        "verify",
      )
      library.store.upsert(tool)
      library.store.setDigest(name, written.digest, written.version)
      return true
    })
    if (!wrote) return
    if (deadline.aborted) {
      onLog?.({ tool: name, callId: null, message: `the Held-out run stopped at its bound of ${timeoutMs} ms and stays Draft` })
    }
    void pushLibrary(library)
  }

  function schedule(library: OpenLibrary, name: string, version: string): Run {
    const key = `${library.kind}:${name.toLowerCase()}`
    runs.get(key)?.abort.abort()
    const run: Run = { abort: new AbortController(), done: Promise.resolve() }
    runs.set(key, run)
    run.done = attempt(library, name, version, run.abort.signal)
      .catch((cause: unknown) => {
        onLog?.({ tool: name, callId: null, message: `the Held-out run did not finish: ${causeMessage(cause)}` })
      })
      .finally(() => {
        if (runs.get(key) === run) runs.delete(key)
      })
    return run
  }

  // The Drafts a run never reached: flintd stopped mid-run, or it ran with no model and one was configured later.
  async function waiting(library: OpenLibrary): Promise<string[]> {
    const drafts = library.store.all().filter((tool) => tool.state === "draft")
    if (drafts.length === 0) return []
    const found = await library.queue.serialize(async () => {
      const pending: { name: string; at: string }[] = []
      for (const draft of drafts) {
        if (runs.has(`${library.kind}:${draft.name.toLowerCase()}`)) continue
        if ((await library.store.readHeldOut(draft.name)) !== null) continue
        const tool = await library.store.readTool(draft.name)
        pending.push({ name: draft.name, at: tool.provenance?.createdAt ?? "" })
      }
      return pending
    })
    return found.sort((left, right) => left.at.localeCompare(right.at)).map((one) => one.name)
  }

  // Oldest first, `concurrency` at a time: a Library of Drafts must not send every one of them to the model at once.
  async function sweepLibrary(library: OpenLibrary): Promise<void> {
    const names = await waiting(library)
    let next = 0
    const workers = Array.from({ length: Math.min(concurrency, names.length) }, async () => {
      while (next < names.length && !stopped) {
        const name = names[next] as string
        next += 1
        const version = await library.store.currentVersion(name)
        if (version === null) continue
        await schedule(library, name, version).done
      }
    })
    await Promise.all(workers)
  }

  return {
    configured: true,

    start(library: OpenLibrary, name: string, version: string): void {
      if (stopped) return
      schedule(library, name, version)
    },

    sweep(library: OpenLibrary): void {
      if (stopped) return
      sweeping = sweeping.then(() =>
        sweepLibrary(library).catch((cause: unknown) => {
          onLog?.({ tool: library.kind, callId: null, message: `the Held-out sweep did not finish: ${causeMessage(cause)}` })
        }),
      )
    },

    async settle(): Promise<void> {
      stopped = true
      const pending = [...runs.values()]
      for (const run of pending) run.abort.abort()
      // A Held-out run waits on a model and on a Body, so stop() gives it a bound rather than the call timeout.
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.all([...pending.map((run) => run.done), sweeping]),
        new Promise<void>((wake) => {
          timer = setTimeout(wake, stopGraceMs)
          timer.unref()
        }),
      ])
      clearTimeout(timer)
      // A run this left behind holds an aborted signal and drops out on its own, so the next start() may schedule again.
      runs.clear()
      sweeping = Promise.resolve()
      stopped = false
    },
  }
}

function count(examples: readonly HeldOutExample[]): HeldOut["grades"] {
  return {
    exact: examples.filter((one) => one.grade === "exact").length,
    assertion: examples.filter((one) => one.grade === "assertion").length,
  }
}

// A Body may return up to maxResultBytes, and every failure is committed and read back by a model.
function cut(actual: JsonValue, reason: string): Outcome {
  const written = canonicalJson(actual)
  if (Buffer.byteLength(written, "utf8") <= MAX_STORED_BYTES) return { actual, reason }
  return {
    actual: capBytes(written, MAX_STORED_BYTES),
    reason: `${reason}, and the result was cut to the first ${MAX_STORED_BYTES} bytes of its JSON`,
  }
}

// The result schema is left out: check already enforces it deterministically, and quoting it widened the corpus
// a clause is held to until a judge could clear the guard with a word of JSON Schema.
function standard(tool: Tool, args: JsonValue, actual: JsonValue): string {
  return [
    `Tool: ${tool.name}`,
    `Its description, and this is the whole standard: ${JSON.stringify(tool.description)}`,
    `Arguments: ${canonicalJson(args)}`,
    `Result: ${canonicalJson(actual)}`,
  ].join("\n")
}

// The Body is left out with the result schema: the question is what the description accepts, not how the Tool refused.
function refusal(tool: Tool, args: JsonValue, threw: string): string {
  return [
    `Tool: ${tool.name}`,
    `Its description, and this is the whole standard: ${JSON.stringify(tool.description)}`,
    `Arguments: ${canonicalJson(args)}`,
    `What it threw: ${JSON.stringify(threw)}`,
  ].join("\n")
}

function quotes(description: string, clause: string): boolean {
  if (clause.length < 4) return false
  return words(description).includes(words(clause))
}

// Punctuation and case are the judge's own, so a clause is compared as the words of it and nothing else.
function words(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `
}

function brief(held: Held): string {
  return [
    `Tool: ${held.tool.name}`,
    `Its description, and this is the whole standard: ${JSON.stringify(held.tool.description)}`,
    `Argument schema: ${canonicalJson(held.tool.parameters as JsonValue)}`,
    `Examples its author gave: ${canonicalJson(held.examples as unknown as JsonValue)}`,
    ...(held.listing === null ? [] : [workspace(held.listing)]),
  ].join("\n")
}

// A case that names a file the root does not hold proves nothing about the Tool, so the model is given what is there.
function workspace(listing: { root: string; paths: string }): string {
  const holds =
    listing.paths === ""
      ? "and it is empty."
      : `and it holds these paths, directories written with a trailing "/":\n${listing.paths}`
  return `The Manifest of this Tool declares the filesystem root ${JSON.stringify(listing.root)}, ${holds}\nEvery path in an args value must be one of those paths, an argument that names a directory must be one of the paths written with a trailing "/", and a Tool that writes a file must write it inside a directory that is in that list. You cannot see what a file holds, so set confident to false whenever the result depends on the contents of one.`
}

function readCase(entry: unknown, index: number, parameters: JsonSchema): Case | string {
  if (!isPlainObject(entry) || !("args" in entry)) return `case ${index} carries no "args" and was left out.`
  const confident = entry["confident"]
  if (typeof confident !== "boolean") return `case ${index} carries no "confident" boolean and was left out.`
  if (confident && !("expected" in entry)) {
    return `case ${index} is confident and carries no "expected", and was left out.`
  }
  const args = readValue(entry["args"])
  if (!isPlainObject(args)) return `case ${index} carries arguments that are not a JSON object, and was left out.`
  // Arguments the Tool's own schema refuses prove nothing about the Tool, so the case never reaches it.
  const refused = refuses(parameters, args)
  if (refused.length > 0) {
    return `case ${index} carries arguments the Tool's own schema refuses, and was left out: ${refused.join(" ")}`
  }
  const expected = confident ? readValue(entry["expected"]) : null
  if (Buffer.byteLength(canonicalJson(args), "utf8") + Buffer.byteLength(canonicalJson(expected), "utf8") > MAX_STORED_BYTES) {
    return `case ${index} is larger than ${MAX_STORED_BYTES} bytes and was left out.`
  }
  return { args, expected, grade: confident ? "exact" : "assertion" }
}

function refuses(parameters: JsonSchema, args: JsonValue): string[] {
  try {
    return validateArguments(parameters, args)
  } catch (cause) {
    return [causeMessage(cause)]
  }
}

// The schema asks for a JSON string; a model on the prompt-only path often sends the value itself, and both read.
function readValue(written: unknown): JsonValue {
  if (typeof written !== "string") return written as JsonValue
  try {
    return JSON.parse(written) as JsonValue
  } catch (cause) {
    return firstValue(written, cause) ?? written
  }
}

// A model that writes an array or an object into a JSON string repeats the closing brackets of the answer inside
// it, so the value ends where the parser says the document ended. Text that starts no container stays that text.
function firstValue(written: string, cause: unknown): JsonValue | undefined {
  if (!CONTAINER.test(written)) return undefined
  const ended = POSITION.exec(cause instanceof Error ? cause.message : "")
  if (ended === null) return undefined
  try {
    return JSON.parse(written.slice(0, Number(ended[1]))) as JsonValue
  } catch {
    return undefined
  }
}

// A model that was asked for JSON still fences it often enough that the fence is worth taking off before the parse.
function parseAnswer(written: string): { [key: string]: JsonValue } {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(written)
  const text = fenced?.[1] ?? written
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (cause) {
    throw malformed(`the answer is not JSON: ${causeMessage(cause)}`)
  }
  if (!isPlainObject(parsed)) throw malformed("the answer is not a JSON object")
  return parsed
}

function malformed(what: string): Error {
  return new Error(`the model answered in a shape flintd does not read: ${what}`)
}
