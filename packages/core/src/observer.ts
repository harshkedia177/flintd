import { open } from "node:fs/promises"
import { causeMessage, ToolError } from "./errors.ts"
import { EXPORT_PREFIX } from "./formats.ts"
import { named, winners } from "./library.ts"
import type { OpenLibrary } from "./library.ts"
import { META_TOOL_NAMES } from "./meta-tools.ts"
import { OBSERVATION_CAPS } from "./observations.ts"
import type { ModelAdapter } from "./model.ts"
import { redact } from "./redact.ts"
import { isPlainObject } from "./validate.ts"
import type {
  JsonSchema,
  JsonValue,
  LogEntry,
  ObserverCandidate,
  ObserverRun,
  ObserverStatus,
  ObserverStep,
  RetirementProposal,
} from "./types.ts"

const DAY_MS = 86_400_000
const MIN_PATTERN_STEPS = 2
const MAX_PATTERN_STEPS = 5
const MAX_EXAMPLES = 3
export const DEFAULT_OBSERVER_TIMEOUT_MS = 600_000
const MAX_TRANSCRIPTS = 20
const MAX_TRANSCRIPT_BYTES = 1024 * 1024
const MAX_TRANSCRIPT_DEPTH = 8
const CALL_SCAN = 5000
const OBSERVATION_SCAN = 5000
const PROPOSE_MAX_TOKENS = 8192
// A hook records a session event under the name of the event, and a session is not a step of a pattern.
const SESSION_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStop",
  "on_session_start",
  "on_session_end",
  "command:new",
  "command:reset",
])

const PROPOSE_SYSTEM =
  "You propose one Tool for flintd, a Library of Tools that agents write for themselves. flintd watched a harness repeat the same steps in several sessions, and wants one Tool that does the whole sequence in one call. You are given the name of each step and the names of its arguments, and never an argument value, so the values in your Examples are ones you invent. Answer with this JSON object: {\"name\": \"<lower-case letters, digits and underscores>\", \"description\": \"<one sentence that tells a model when to call it>\", \"parameters\": \"<the JSON Schema for the arguments, written as a JSON string, with an object at the root>\", \"body\": \"<the statements that go inside async function execute(args, ctx), which must return a JSON value>\", \"examples\": [{\"args\": \"<the arguments as a JSON object, written as a JSON string>\", \"expected\": \"<the exact result as a JSON value, written as a JSON string>\"}]}. Give at most 3 Examples, and every one of them must pass exactly: flintd runs each one before it saves anything. The Body reaches no network and no filesystem, so propose only work that is computation on its own arguments."

const PROPOSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    parameters: { type: "string", description: "The JSON Schema for the arguments, written as a JSON string." },
    body: { type: "string", description: "The statements that go inside async function execute(args, ctx)." },
    examples: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          args: { type: "string", description: "The arguments as a JSON object, written as a JSON string." },
          expected: { type: "string", description: "The exact result as a JSON value, written as a JSON string." },
        },
        required: ["args", "expected"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "description", "parameters", "body", "examples"],
  additionalProperties: false,
}

export interface ObserverLimits {
  repeats: number
  windowDays: number
  timeoutMs: number
  // One run asks the model once per candidate, so this is what one run may spend.
  maxCandidates: number
  retireContribution: number
  retireMinCalls: number
  retireIdleDays: number
}

export interface ObserverDeps {
  adapter: ModelAdapter | undefined
  limits: ObserverLimits
  stopGraceMs: number
  libraries(): readonly OpenLibrary[]
  // The harnesses the operator answered yes for, read at every run: consent is a live answer, not a start-up copy.
  consented(): readonly string[]
  create(args: { [key: string]: JsonValue }, provenance: ObserverProvenance): Promise<JsonValue>
  clock(): number
  onLog(entry: LogEntry): void
}

export interface ObserverProvenance {
  session: string
  harness: string | null
  excerpt: string
}

export interface ObserverRunner {
  run(dryRun: boolean): Promise<ObserverRun>
  proposals(): Promise<RetirementProposal[]>
  status(): ObserverStatus
  settle(): Promise<void>
}

interface Step extends ObserverStep {
  at: string
}

interface Use extends Step {
  id: string | null
}

interface Sitting {
  harness: string
  steps: Step[]
}

interface Counted {
  steps: Step[]
  sessions: Set<string>
  harnesses: Set<string>
  first: string
  last: string
}

export function createObserver(deps: ObserverDeps): ObserverRunner {
  // Two slots, because a dry run and a real run are different questions: each joins its own kind and neither
  // joins the other. One slot would hand a `--dry-run` caller a run that spent and wrote.
  const flight = new Map<"dry" | "write", Promise<ObserverRun>>()
  let last: ObserverStatus = { running: false, lastRunAt: null, candidates: 0, drafts: 0, refusals: 0, retirements: 0 }
  let stopper = new AbortController()

  async function transcript(path: string): Promise<Step[] | null> {
    let text: string
    try {
      const handle = await open(path, "r")
      try {
        const buffer = Buffer.allocUnsafe(MAX_TRANSCRIPT_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, MAX_TRANSCRIPT_BYTES, 0)
        text = buffer.toString("utf8", 0, bytesRead)
      } finally {
        await handle.close()
      }
    } catch (cause) {
      deps.onLog({ tool: "flintd", callId: null, message: `the observer could not read a transcript: ${causeMessage(cause)}` })
      return null
    }
    const uses: Use[] = []
    const failed = new Set<string>()
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch {
        continue
      }
      const before = uses.length
      harvest(parsed, uses, failed, 0)
      const stamp = isPlainObject(parsed) && typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : ""
      for (let at = before; at < uses.length; at += 1) (uses[at] as Use).at = stamp
    }
    return uses
      .filter((use) => use.id === null || !failed.has(use.id))
      .map((use) => ({ tool: use.tool, argumentKeys: use.argumentKeys, at: use.at }))
  }

  async function gather(
    since: string,
    signal: AbortSignal,
  ): Promise<{ sittings: Map<string, Sitting>; read: number; skipped: number }> {
    const consented = new Set(deps.consented())
    const sittings = new Map<string, Sitting>()
    const add = (key: string, harness: string, step: Step): void => {
      const held = sittings.get(key) ?? { harness, steps: [] }
      held.steps.push(step)
      sittings.set(key, held)
    }
    // The daemon's own call log is read whatever the operator answered: flintd ran those calls itself.
    for (const library of deps.libraries()) {
      for (const call of library.store.callLog(since, CALL_SCAN)) {
        if (call.session === null || call.errorCode !== null) continue
        add(`call:${call.session}`, call.harness ?? "flintd", { tool: call.name, argumentKeys: [], at: call.at })
      }
    }
    const seen = named(deps.libraries(), "user").store.observations({ since, harness: null, limit: OBSERVATION_SCAN })
    // One transcript is one conversation: the sessions that name the same file are one sitting and one read.
    const transcripts = new Map<string, { key: string; at: string }>()
    const shared = new Map<string, string>()
    for (const one of seen) {
      if (one.session === null || !consented.has(one.harness)) continue
      const key = `${one.harness}:${one.session}`
      if (one.transcriptPath !== null) {
        const held = transcripts.get(one.transcriptPath)
        if (held === undefined) transcripts.set(one.transcriptPath, { key, at: one.at })
        else if (held.key !== key) shared.set(key, held.key)
      }
      if (one.status !== "ok" || SESSION_EVENTS.has(one.tool)) continue
      add(key, one.harness, { tool: one.tool, argumentKeys: one.argumentKeys, at: one.at })
    }
    for (const key of shared.keys()) sittings.delete(key)
    let read = 0
    let skipped = 0
    for (const [path, held] of [...transcripts].slice(0, MAX_TRANSCRIPTS)) {
      if (signal.aborted) break
      const steps = await transcript(path)
      if (steps === null) {
        skipped += 1
        continue
      }
      read += 1
      // The transcript is the fuller record of the same session, so it replaces the hook rows rather than adding to them.
      const sitting = sittings.get(held.key)
      if (sitting !== undefined) sitting.steps = steps.map((step) => ({ ...step, at: step.at === "" ? held.at : step.at }))
    }
    for (const sitting of sittings.values()) sitting.steps.sort((left, right) => left.at.localeCompare(right.at))
    return { sittings, read, skipped }
  }

  function detect(sittings: Map<string, Sitting>): ObserverCandidate[] {
    const counted = new Map<string, Counted>()
    const holds = held(deps.libraries())
    for (const [key, sitting] of sittings) {
      const marked = new Set<string>()
      for (let length = 1; length <= MAX_PATTERN_STEPS; length += 1) {
        for (let at = 0; at + length <= sitting.steps.length; at += 1) {
          const steps = sitting.steps.slice(at, at + length)
          // A single repeated step is a candidate only for a tool flintd does not already hold: the rest is a Tool.
          if (length < MIN_PATTERN_STEPS && flintTool((steps[0] as Step).tool, holds)) continue
          const pattern = signature(steps)
          const held = counted.get(pattern) ?? {
            steps,
            sessions: new Set<string>(),
            harnesses: new Set<string>(),
            first: (steps[0] as Step).at,
            last: (steps[0] as Step).at,
          }
          if (!marked.has(pattern)) {
            held.sessions.add(key)
            marked.add(pattern)
          }
          held.harnesses.add(sitting.harness)
          for (const step of steps) {
            if (step.at < held.first) held.first = step.at
            if (step.at > held.last) held.last = step.at
          }
          counted.set(pattern, held)
        }
      }
    }
    const repeated = [...counted].filter(([, held]) => held.sessions.size >= deps.limits.repeats)
    return repeated
      .filter(([, held]) => !inside(held, repeated))
      .map(([, counted]) => {
        // One redaction covers both: the pattern is built from the steps a reader and the model are given.
        const steps = counted.steps.map((step) => ({
          tool: redact(step.tool),
          argumentKeys: [...step.argumentKeys].sort().map(redact),
        }))
        return {
          pattern: steps.map(one).join(" -> "),
          steps,
          sessions: counted.sessions.size,
          harnesses: [...counted.harnesses].sort().map(redact),
          firstAt: counted.first,
          lastAt: counted.last,
        }
      })
      .sort(
        (left, right) =>
          right.sessions - left.sessions ||
          right.steps.length - left.steps.length ||
          left.pattern.localeCompare(right.pattern),
      )
      .slice(0, deps.limits.maxCandidates)
  }

  function retirements(now: number): RetirementProposal[] {
    const proposals: RetirementProposal[] = []
    for (const { tool, library } of winners(deps.libraries())) {
      if (tool.state !== "active" && tool.state !== "verified") continue
      const idleDays =
        tool.lastCallAt === null ? null : Math.floor((now - Date.parse(tool.lastCallAt)) / DAY_MS)
      const poor = tool.contribution <= deps.limits.retireContribution && tool.calls >= deps.limits.retireMinCalls
      // A Tool that was never called says nothing about how long it has been idle, so only a Tool with a last call does.
      const idle = idleDays !== null && idleDays >= deps.limits.retireIdleDays
      if (!poor && !idle) continue
      proposals.push({
        name: tool.name,
        library: library.kind,
        state: tool.state,
        reason: poor ? "contribution" : "idle",
        calls: tool.calls,
        errors: tool.errors,
        contribution: tool.contribution,
        lastCallAt: tool.lastCallAt,
        idleDays,
      })
    }
    return proposals.sort((left, right) => left.contribution - right.contribution || left.name.localeCompare(right.name))
  }

  async function propose(
    model: ModelAdapter,
    candidate: ObserverCandidate,
    signal: AbortSignal,
  ): Promise<{ [key: string]: JsonValue }> {
    const written = await model.complete({
      system: PROPOSE_SYSTEM,
      messages: [{ role: "user", content: brief(candidate) }],
      maxTokens: PROPOSE_MAX_TOKENS,
      json: PROPOSE_SCHEMA,
      signal,
    })
    const answer = parseAnswer(written)
    const offered = answer["examples"]
    if (!Array.isArray(offered) || offered.length === 0) throw malformed('the answer carries no "examples" array')
    const examples = offered.slice(0, MAX_EXAMPLES).map((one) => {
      if (!isPlainObject(one) || !("args" in one) || !("expected" in one)) {
        throw malformed("an example carries no args and expected")
      }
      return { args: readValue(one["args"]), expected: readValue(one["expected"]) }
    })
    return {
      name: text(answer["name"], "name"),
      description: text(answer["description"], "description"),
      parameters_json: text(answer["parameters"], "parameters"),
      execute_source: text(answer["body"], "body"),
      examples: examples as unknown as JsonValue,
    }
  }

  async function attempt(dryRun: boolean): Promise<ObserverRun> {
    const now = deps.clock()
    const at = new Date(now).toISOString()
    const windowFrom = new Date(now - deps.limits.windowDays * DAY_MS).toISOString()
    // The bound covers the reading as well as the asking: twenty transcripts are the run's time too.
    const deadline = AbortSignal.timeout(deps.limits.timeoutMs)
    const signal = AbortSignal.any([stopper.signal, deadline])
    const gathered = await gather(windowFrom, signal)
    const run: ObserverRun = {
      at,
      dryRun,
      modelConfigured: deps.adapter !== undefined,
      windowFrom,
      candidates: detect(gathered.sittings),
      drafts: [],
      refusals: [],
      retirements: retirements(now),
      transcripts: { read: gathered.read, skipped: gathered.skipped },
    }
    const model = deps.adapter
    if (dryRun || model === undefined) return run
    for (const candidate of run.candidates) {
      if (signal.aborted) break
      let args: { [key: string]: JsonValue }
      try {
        args = await propose(model, candidate, signal)
      } catch (cause) {
        // A run the bound or the stop cut records nothing: the answer it was waiting for never arrived whole.
        if (signal.aborted) break
        run.refusals.push({ pattern: candidate.pattern, name: null, code: "internal_error", reason: causeMessage(cause) })
        continue
      }
      if (signal.aborted) break
      try {
        const made = (await deps.create(args, {
          // The proposal is the work of this run until its Held-out examples pass, like every other Draft.
          session: `observer:${at}`,
          harness: candidate.harnesses.length === 0 ? null : candidate.harnesses.join(", "),
          excerpt: excerpt(candidate, model.model),
        })) as { [key: string]: JsonValue }
        run.drafts.push({
          pattern: candidate.pattern,
          name: String(made["name"]),
          version: String(made["version"]),
          library: made["library"] === "project" ? "project" : "user",
        })
      } catch (cause) {
        const refused = cause instanceof ToolError ? cause : undefined
        run.refusals.push({
          pattern: candidate.pattern,
          name: String(args["name"]),
          code: refused?.code ?? "internal_error",
          reason: redact(refused?.message ?? causeMessage(cause)),
        })
      }
    }
    if (deadline.aborted) {
      deps.onLog({
        tool: "flintd",
        callId: null,
        message: `the observer run stopped at its bound of ${deps.limits.timeoutMs} ms`,
      })
    }
    return run
  }

  return {
    run(dryRun: boolean): Promise<ObserverRun> {
      // Single-flight: two callers that ask the same question while it is being answered get one run and one answer.
      const slot = dryRun ? "dry" : "write"
      const held = flight.get(slot)
      if (held !== undefined) return held
      last = { ...last, running: true }
      const work = attempt(dryRun)
        .then((done) => {
          last = {
            running: false,
            lastRunAt: done.at,
            candidates: done.candidates.length,
            drafts: done.drafts.length,
            refusals: done.refusals.length,
            retirements: done.retirements.length,
          }
          return done
        })
        .finally(() => {
          flight.delete(slot)
          last = { ...last, running: flight.size > 0 }
        })
      flight.set(slot, work)
      return work
    },

    async proposals(): Promise<RetirementProposal[]> {
      return retirements(deps.clock())
    },

    status(): ObserverStatus {
      return { ...last }
    },

    async settle(): Promise<void> {
      stopper.abort()
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.all([...flight.values()]),
        new Promise<void>((wake) => {
          timer = setTimeout(wake, deps.stopGraceMs)
          timer.unref()
        }),
      ]).catch(() => undefined)
      clearTimeout(timer)
      // A later start() observes again, and the run this left behind holds an aborted signal and writes nothing.
      stopper = new AbortController()
      flight.clear()
      last = { ...last, running: false }
    },
  }
}

function flintTool(name: string, holds: ReadonlySet<string>): boolean {
  return holds.has(name.toLowerCase()) || name.startsWith(EXPORT_PREFIX)
}

// Every name this flintd answers to: a repeated call to one of them is a Tool that exists, not a Tool to write.
function held(libraries: readonly OpenLibrary[]): Set<string> {
  const names = new Set([...META_TOOL_NAMES].map((name) => name.toLowerCase()))
  for (const library of libraries) {
    for (const tool of library.store.all()) {
      names.add(tool.name.toLowerCase())
      names.add(`${EXPORT_PREFIX}${tool.name.toLowerCase()}`)
    }
  }
  return names
}

// The whole of what a pattern is: the names of the steps and the names of their arguments, in order. No value.
function signature(steps: readonly Step[]): string {
  return steps.map(one).join(" -> ")
}

function one(step: ObserverStep): string {
  return `${step.tool}(${[...step.argumentKeys].sort().join(", ")})`
}

// A shorter pattern inside a longer one that repeated as often says nothing the longer one does not.
function inside(held: Counted, every: readonly [string, Counted][]): boolean {
  const mine = held.steps.map(one)
  return every.some(([, counted]) => {
    if (counted.steps.length <= mine.length || counted.sessions.size < held.sessions.size) return false
    const theirs = counted.steps.map(one)
    return theirs.some((_, at) => mine.every((step, index) => theirs[at + index] === step))
  })
}

function brief(candidate: ObserverCandidate): string {
  const steps = candidate.steps.map(
    (step, at) => `${at + 1}. ${step.tool} with arguments named ${step.argumentKeys.join(", ") || "(none)"}`,
  )
  return [
    `The harness repeated these steps in ${candidate.sessions} sessions between ${candidate.firstAt} and ${candidate.lastAt}:`,
    ...steps,
    "Propose one Tool that does all of it in one call.",
  ].join("\n")
}

// The Provenance of an observer proposal says what was watched and that no observed value is in the Examples.
function excerpt(candidate: ObserverCandidate, model: string): string {
  return [
    `The observer proposed this Tool from a pattern ${model} synthesized:`,
    candidate.pattern,
    `It ran in ${candidate.sessions} sessions between ${candidate.firstAt} and ${candidate.lastAt}, in ${candidate.harnesses.join(", ")}.`,
    "flintd records the name of a tool and the names of its arguments and never a value, so every value in the Examples is one the model invented.",
  ].join("\n")
}

// A transcript is a file any harness wrote, so what comes out of it is held to the size the hook boundary holds.
function harvest(node: unknown, uses: Use[], failed: Set<string>, depth: number): void {
  if (depth > MAX_TRANSCRIPT_DEPTH) return
  if (Array.isArray(node)) {
    for (const one of node) harvest(one, uses, failed, depth + 1)
    return
  }
  if (!isPlainObject(node)) return
  const kind = node["type"]
  if (kind === "tool_use" && typeof node["name"] === "string") {
    const input = node["input"]
    uses.push({
      id: typeof node["id"] === "string" ? node["id"] : null,
      tool: node["name"].slice(0, OBSERVATION_CAPS.tool),
      argumentKeys: isPlainObject(input)
        ? Object.keys(input)
            .slice(0, OBSERVATION_CAPS.keys)
            .map((key) => key.slice(0, OBSERVATION_CAPS.key))
        : [],
      at: "",
    })
    return
  }
  if (kind === "tool_result") {
    const id = node["tool_use_id"]
    if (node["is_error"] === true && typeof id === "string") failed.add(id)
    return
  }
  for (const one of Object.values(node)) harvest(one, uses, failed, depth + 1)
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw malformed(`the answer carries no ${field}`)
  return value
}

// The schema asks for a JSON string; a model on the prompt-only path often sends the value itself, and both read.
function readValue(written: unknown): JsonValue {
  if (typeof written !== "string") return written as JsonValue
  try {
    return JSON.parse(written) as JsonValue
  } catch {
    return written
  }
}

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
