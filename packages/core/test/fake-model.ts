import type { ModelAdapter, ModelRequest } from "../src/model.ts"
import type { JsonSchema, JsonValue } from "../src/types.ts"

export interface FakeCase {
  args: JsonValue
  confident: boolean
  expected?: JsonValue
}

export interface FakeModelOptions {
  cases?: FakeCase[]
  plausible?: boolean
  reason?: string
  // What the judgment quotes out of the Tool's description or result schema. Absent is a judgment that quotes nothing.
  clause?: string
  // Whether the description is judged to accept the arguments of a case the Tool threw on.
  accepted?: boolean
  // The raw answer to one prompt kind, for the tests that drive malformed model output.
  generated?: string
  judged?: string
  // Held by the fake until the test resolves it or the run is cancelled, so a test can keep a run in flight.
  pause?: Promise<void>
  // Present makes the fake an embedding-capable adapter, which is how flintd decides to run a vector search.
  embedding?: boolean
  // One word read as another before it is hashed, so a test can write a paraphrase no lexical search would match.
  synonyms?: Record<string, string>
  embedError?: string
  // A provider whose first embedding takes this long and ignores the abort signal, which is what a cold start
  // looks like. The wait starts when the embedding is asked for, not when the fake is made.
  embedPauseMs?: number
  // The duplicate judgment, keyed on the name of the Tool the agent wants to write. The default is "different".
  judgments?: Record<string, boolean>
  // The Tool the fake proposes for every observer candidate, and the raw answer for a malformed one.
  proposal?: FakeProposal
  proposed?: string
}

export interface FakeProposal {
  name: string
  description: string
  parameters: JsonValue
  body: string
  examples: { args: JsonValue; expected: JsonValue }[]
}

export interface FakeModel extends ModelAdapter {
  readonly prompts: {
    kind: "held-out" | "plausibility" | "acceptance" | "duplicate" | "proposal"
    system: string
    user: string
    json: boolean
  }[]
  readonly schemas: (JsonSchema | undefined)[]
  readonly inFlight: { now: number; peak: number }
  readonly embedded: string[][]
}

// The one test double flintd has. It lives in test support and no product file may import it.
export function fakeModel(options: FakeModelOptions = {}): FakeModel {
  const prompts: FakeModel["prompts"] = []
  const schemas: FakeModel["schemas"] = []
  const inFlight = { now: 0, peak: 0 }
  const embedded: string[][] = []
  const model: FakeModel = {
    provider: "anthropic",
    model: "fake-model",
    prompts,
    schemas,
    inFlight,
    embedded,
    async complete(request: ModelRequest): Promise<string> {
      const kind = kindOf(request.system)
      if (kind === undefined) {
        throw new Error(`the fake model was given a prompt kind it does not know: ${request.system.slice(0, 40)}`)
      }
      prompts.push({
        kind,
        system: request.system,
        user: request.messages.map((message) => message.content).join("\n"),
        json: request.json !== undefined,
      })
      schemas.push(request.json)
      inFlight.now += 1
      inFlight.peak = Math.max(inFlight.peak, inFlight.now)
      try {
        if (options.pause !== undefined) await halt(options.pause, request.signal)
        if (kind === "duplicate") {
          const written = request.messages.map((message) => message.content).join("\n")
          const named = Object.keys(options.judgments ?? {}).find((name) => written.includes(`Name: ${name}\n`))
          const same = named !== undefined && (options.judgments ?? {})[named] === true
          return JSON.stringify({ same, reason: same ? "both answer the same question" : "they do different work" })
        }
        if (kind === "proposal") {
          if (options.proposed !== undefined) return options.proposed
          const one = options.proposal
          if (one === undefined) throw new Error("the fake model was asked for a proposal and holds none")
          return JSON.stringify({
            name: one.name,
            description: one.description,
            parameters: JSON.stringify(one.parameters),
            body: one.body,
            examples: one.examples.map((example) => ({
              args: JSON.stringify(example.args),
              expected: JSON.stringify(example.expected),
            })),
          })
        }
        if (kind === "acceptance") {
          return JSON.stringify({
            accepted: options.accepted === true,
            ...(options.clause === undefined ? {} : { clause: options.clause }),
            reason: options.reason ?? "the description settles nothing about those arguments",
          })
        }
        if (kind === "plausibility") {
          return (
            options.judged ??
            JSON.stringify({
              plausible: options.plausible !== false,
              ...(options.clause === undefined ? {} : { clause: options.clause }),
              reason: options.reason ?? "the result matches what the Tool promises",
            })
          )
        }
        return options.generated ?? JSON.stringify({ cases: (options.cases ?? []).map(wire) })
      } finally {
        inFlight.now -= 1
      }
    },
  }
  if (options.embedding !== true) return model
  model.embed = async (texts: string[], signal?: AbortSignal): Promise<number[][]> => {
    embedded.push(texts)
    if (signal?.aborted === true) throw new Error("the embedding was cancelled")
    if (options.embedPauseMs !== undefined && embedded.length === 1) {
      await new Promise<void>((wake) => setTimeout(wake, options.embedPauseMs))
    }
    if (options.embedError !== undefined) throw new Error(options.embedError)
    return texts.map((text) => hashed(text, options.synonyms ?? {}))
  }
  return model
}

// The fake reads the prompt the way a provider would, so no product constant is exported for a test to import.
function kindOf(system: string): FakeModel["prompts"][number]["kind"] | undefined {
  if (system.startsWith("You write Held-out examples")) return "held-out"
  if (system.startsWith("You judge one result of a Tool")) return "plausibility"
  if (system.startsWith("You judge one refusal of a Tool")) return "acceptance"
  if (system.startsWith("You decide whether two Tools")) return "duplicate"
  if (system.startsWith("You propose one Tool")) return "proposal"
  return undefined
}

const DIMENSIONS = 64

// A stand-in for a real embedding: every word lands in one bucket, so a cosine measures how much two texts share.
function hashed(text: string, synonyms: Record<string, string>): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0)
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const word = synonyms[raw] ?? raw
    const at = bucket(word)
    vector[at] = (vector[at] as number) + 1
  }
  return vector
}

function bucket(word: string): number {
  let hash = 2166136261
  for (let at = 0; at < word.length; at += 1) hash = Math.imul(hash ^ word.charCodeAt(at), 16777619)
  return Math.abs(hash) % DIMENSIONS
}

// The schema asks for the arguments and the result as JSON strings, so the fake answers in that shape too.
function wire(one: FakeCase): Record<string, unknown> {
  return {
    args: JSON.stringify(one.args),
    confident: one.confident,
    ...(one.expected === undefined ? {} : { expected: JSON.stringify(one.expected) }),
  }
}

// A real adapter hands the signal to fetch, so the fake has to end its own wait on an abort the same way.
async function halt(pause: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined || signal.aborted) return
  await Promise.race([
    pause,
    new Promise<void>((wake) => signal.addEventListener("abort", () => wake(), { once: true })),
  ])
}
