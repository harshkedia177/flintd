import { ToolError, causeMessage } from "./errors.ts"
import { callable } from "./library.ts"
import type { OpenLibrary, Winner } from "./library.ts"
import type { ModelAdapter } from "./model.ts"
import type { IndexedTool } from "./store.ts"
import { canonicalJson, capBytes } from "./validate.ts"
import type { Example, FindEntry, JsonSchema, JsonValue, LibraryKind, LogEntry, ToolState } from "./types.ts"

export const DEFAULT_FIND_LIMIT = 5
export const DEFAULT_DUPLICATE_JACCARD = 0.9
export const DEFAULT_DUPLICATE_BAND = 0.5
export const DEFAULT_DUPLICATE_COSINE = 0.9
export const DEFAULT_DUPLICATE_COSINE_BAND = 0.8
export const DEFAULT_SIBLING_JACCARD = 0.6
export const DEFAULT_SIBLING_COSINE = 0.92
export const DEFAULT_SEARCH_COSINE = 0.5
export const DEFAULT_DUPLICATE_MAX_JUDGMENTS = 3
export const DEFAULT_STOP_GRACE_MS = 2000

const K1 = 1.2
const B = 0.75
const RRF_K = 60
const CANDIDATES = 20
// A document that matched a tenth of what the query asks for is a result; one that brushed a word of it is not.
const MIN_MATCH = 0.1
const MAX_QUERY_BYTES = 2000
const EMBED_BATCH = 32
// A search never waits out a pass over a whole Library; a create waits longer, because it already pays a gate run.
const PASS_WAIT_MS = 250
const CREATE_WAIT_MS = 1000
const JUDGE_MAX_TOKENS = 2048
const SUMMARY_LENGTH = 120
const SCHEMA_DEPTH = 4
const STATE_RANK: Record<ToolState, number> = { active: 3, verified: 2, draft: 1, retired: 0 }
const REFUSES_THEN_WARNS: readonly (readonly ToolState[])[] = [["verified", "active"], ["draft"]]
// A word is a run of letters or digits, cut again at a lower-to-upper boundary, so word_count and wordCount agree.
const TOKEN = /\p{Lu}+(?!\p{Ll})|\p{Lu}?[\p{Ll}\p{N}]+|[\p{L}\p{N}]+/gu

// The closed-class words of English. A document frequency cannot stand in for this list: in a Library of two Tools
// the word both of them are about is in every document, and dropping it leaves the query nothing to match on.
const GRAMMAR = new Set(
  ("a about all am an and another any are as at be because been being both but can could did do does doing done" +
    " each either every for from had has have he her hers him his how i if in into is it its just many may me might" +
    " more most much must my no nor not of on once only or other our own she should so some such than that the their" +
    " them then there these they this those through to too was we were what when where whether which while who whom" +
    " whose why will with would you your").split(" "),
)

const DUPLICATE_SYSTEM =
  "You decide whether two Tools of flintd, a Library of Tools that agents write for themselves, are the same capability. Two Tools are the same capability when an agent that has one has no reason to write the other: the same work, on the same kind of input, for the same kind of answer. Two Tools are different when one does something the other cannot, even when they share most of their words: a SHA-512 digest is not a SHA-256 digest, and counting distinct words is not counting words. Answer with this JSON object: {\"same\": <boolean>, \"reason\": \"<one sentence>\"}."

const DUPLICATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: { same: { type: "boolean" }, reason: { type: "string" } },
  required: ["same", "reason"],
  additionalProperties: false,
}

export interface SearchLimits {
  findLimit: number
  duplicateJaccard: number
  duplicateBand: number
  duplicateCosine: number
  duplicateCosineBand: number
  siblingJaccard: number
  siblingCosine: number
  searchCosine: number
  duplicateMaxJudgments: number
  stopGraceMs: number
}

export interface Proposal {
  name: string
  description: string
  parameters: JsonSchema
  examples: readonly Example[]
}

export interface Duplicate {
  name: string
  description: string
  parameters: JsonSchema
  state: ToolState
  library: LibraryKind
  similarity: number
  judged: string | null
  // The band with no judgment behind it: the two are alike, nothing could say whether they are one capability, and a guess either way is worse than saying so.
  warn: boolean
}

export interface Search {
  readonly findLimit: number
  find(libraries: readonly OpenLibrary[], query: unknown, limit: unknown, session: string | null): Promise<FindEntry[]>
  duplicate(
    libraries: readonly OpenLibrary[],
    proposal: Proposal,
    session: string | null,
  ): Promise<Duplicate | undefined>
  refresh(library: OpenLibrary): void
  settle(): Promise<void>
}

function tokenize(text: string): string[] {
  return (text.match(TOKEN) ?? []).map((word) => word.toLowerCase())
}

// A query of grammar alone ("the a of") separates no Tool from another and asks for nothing.
function content(words: readonly string[]): string[] {
  return words.filter((word) => !GRAMMAR.has(word))
}

// What BM25 reads: the name, the description and every argument name and argument description of the schema.
function searchText(tool: Pick<IndexedTool, "name" | "description" | "parameters">): string[] {
  return [...tokenize(tool.name), ...tokenize(tool.description), ...schemaWords(tool.parameters, true, 0)]
}

// What a duplicate is judged on, and the text an embedding is made from: the name, the description, the argument names.
function identityText(tool: Pick<IndexedTool, "name" | "description" | "parameters">): string[] {
  return [...tokenize(tool.name), ...tokenize(tool.description), ...schemaWords(tool.parameters, false, 0)]
}

// The argument names are here because two inverse Tools share every other word: csv_to_json takes a CSV and json_to_csv takes rows.
// The grammar is not: two agents describing one capability differ in their phrasing long before they differ in their work.
function siblingText(tool: Pick<IndexedTool, "name" | "description" | "parameters">): Set<string> {
  return new Set(content(identityText(tool)))
}

// The schema arrives from an agent, so the walk is bounded rather than trusting the nesting it declares.
function schemaWords(schema: JsonSchema, descriptions: boolean, depth: number): string[] {
  if (depth >= SCHEMA_DEPTH) return []
  const words: string[] = []
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    words.push(...tokenize(name))
    if (descriptions && typeof property.description === "string") words.push(...tokenize(property.description))
    words.push(...schemaWords(property, descriptions, depth + 1))
  }
  if (schema.items !== undefined) words.push(...schemaWords(schema.items, descriptions, depth + 1))
  return words
}

// BM25, divided by the score a document of average length holding each query term once would earn, so the answer is the share of the query a document matched.
function bm25(documents: readonly (readonly string[])[], query: readonly string[]): number[] {
  const total = documents.length
  if (total === 0) return []
  const average = documents.reduce((sum, one) => sum + one.length, 0) / total
  const frequencies = documents.map(counts)
  const weights = new Map<string, number>()
  let ideal = 0
  for (const term of new Set(query)) {
    const holding = frequencies.reduce((sum, one) => sum + (one.has(term) ? 1 : 0), 0)
    const weight = Math.log(1 + (total - holding + 0.5) / (holding + 0.5))
    weights.set(term, weight)
    ideal += weight
  }
  if (ideal === 0) return documents.map(() => 0)
  return frequencies.map((held, at) => {
    const length = documents[at]?.length ?? 0
    let score = 0
    for (const [term, weight] of weights) {
      const seen = held.get(term) ?? 0
      if (seen === 0) continue
      const norm = average === 0 ? 1 : 1 - B + (B * length) / average
      score += weight * ((seen * (K1 + 1)) / (seen + K1 * norm))
    }
    return score / ideal
  })
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftSize = 0
  let rightSize = 0
  for (let at = 0; at < left.length; at += 1) {
    const one = left[at] as number
    const other = right[at] as number
    dot += one * other
    leftSize += one * one
    rightSize += other * other
  }
  const size = Math.sqrt(leftSize) * Math.sqrt(rightSize)
  return size === 0 ? 0 : dot / size
}

function counts(document: readonly string[]): Map<string, number> {
  const held = new Map<string, number>()
  for (const word of document) held.set(word, (held.get(word) ?? 0) + 1)
  return held
}

interface Ranked {
  key: string
  winner: Winner
  score: number
}

interface Judgment {
  verdict: "same" | "different" | "unavailable"
  reason?: string
}

interface Closeness {
  winner: Winner
  similarity: number
  certain: boolean
  banded: boolean
}

export function createSearch(
  limits: SearchLimits,
  adapter: ModelAdapter | undefined,
  onLog?: (entry: LogEntry) => void,
): Search {
  const embed = adapter?.embed?.bind(adapter)
  const judgeWith = adapter
  // The embedding is remade when the text it was made from changes, and a new embedding model remakes every one.
  const stamp = (tool: Pick<IndexedTool, "name" | "description" | "parameters">): string =>
    `${adapter?.model ?? ""}\n${identityText(tool).join(" ")}`
  let passes: Promise<void> = Promise.resolve()
  let stopper = new AbortController()
  // A pass that outlives the stop() that abandoned it writes nothing, and a later start() is a later generation.
  let generation = 0
  // The vector of the proposal a duplicate check just made, so the pass that follows the save does not make it again.
  let spare: { stamp: string; vector: Float32Array } | undefined

  function stored(libraries: readonly OpenLibrary[]): Map<string, Float32Array> {
    const found = new Map<string, Float32Array>()
    if (embed === undefined) return found
    for (const library of libraries) {
      const current = new Map(library.store.all().map((tool) => [tool.name.toLowerCase(), stamp(tool)]))
      for (const one of library.store.embeddings()) {
        const key = one.name.toLowerCase()
        if (current.get(key) === one.stamp) found.set(`${library.kind}:${key}`, one.vector)
      }
    }
    return found
  }

  // A failed embedding is a degraded search, never a failed search, so it is logged and the caller gets lexical alone.
  async function embedOne(text: string, what: string): Promise<Float32Array | undefined> {
    if (embed === undefined) return undefined
    try {
      const vector = (await embed([text], stopper.signal))[0]
      return vector === undefined ? undefined : Float32Array.from(vector)
    } catch (cause) {
      onLog?.({ tool: what, callId: null, message: `the text was not embedded, so the search is lexical: ${causeMessage(cause)}` })
      return undefined
    }
  }

  async function refreshLibrary(library: OpenLibrary, mine: number): Promise<void> {
    if (embed === undefined || mine !== generation) return
    const held = new Map(library.store.embeddings().map((one) => [one.name.toLowerCase(), one.stamp]))
    const stale = library.store.all().filter((tool) => held.get(tool.name.toLowerCase()) !== stamp(tool))
    // The duplicate check just embedded the Tool being saved, and that text is this Tool's text.
    const needed = stale.filter((tool) => stamp(tool) !== spare?.stamp)
    const made = new Map<string, Float32Array>()
    for (let at = 0; at < needed.length; at += EMBED_BATCH) {
      if (mine !== generation) return
      const batch = needed.slice(at, at + EMBED_BATCH)
      const vectors = await embed(batch.map((tool) => identityText(tool).join(" ")), stopper.signal)
      for (const [index, tool] of batch.entries()) {
        const vector = vectors[index]
        if (vector !== undefined) made.set(tool.name.toLowerCase(), Float32Array.from(vector))
      }
    }
    for (const tool of stale) {
      if (mine !== generation) return
      const key = stamp(tool)
      const vector = key === spare?.stamp ? spare.vector : made.get(tool.name.toLowerCase())
      if (vector !== undefined) library.store.setEmbedding(tool.name, key, vector)
    }
    spare = undefined
  }

  // Whatever vectors a pass has already written, without waiting out a pass over a whole Library on a slow provider.
  async function ready(bound: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      passes,
      new Promise<void>((wake) => {
        timer = setTimeout(wake, bound)
      }),
    ])
    clearTimeout(timer)
  }

  async function find(
    libraries: readonly OpenLibrary[],
    query: unknown,
    limit: unknown,
    session: string | null,
  ): Promise<FindEntry[]> {
    const asked = assertQuery(query)
    const wanted = Math.min(assertLimit(limit) ?? limits.findLimit, limits.findLimit)
    const corpus = callable(libraries).filter(({ tool }) => reachable(tool, session))
    const words = content(tokenize(asked))
    if (corpus.length === 0 || words.length === 0) return []
    const keys = corpus.map(({ tool, library }) => `${library.kind}:${tool.name.toLowerCase()}`)
    const lexical = bm25(
      corpus.map(({ tool }) => searchText(tool)),
      words,
    )
    const orders = [rank(corpus, keys, lexical, MIN_MATCH)]
    await ready(PASS_WAIT_MS)
    const vectors = stored(libraries)
    const asVector = vectors.size === 0 ? undefined : await embedOne(asked, "tool_find")
    if (asVector !== undefined) {
      const close = keys.map((key) => {
        const held = vectors.get(key)
        return held === undefined ? 0 : cosine(asVector, held)
      })
      // The cosine list carries its own floor: without one, every Tool has some cosine and a junk query answers five.
      const near = rank(corpus, keys, close, limits.searchCosine)
      if (near.length > 0) orders.push(near)
    }
    // One retriever means one scale: the share of the query each Tool matched is the honest number to report.
    const alone = orders.length === 1
    return group(alone ? (orders[0] as Ranked[]) : fuse(orders), vectors, limits, wanted, alone)
  }

  async function closeness(
    libraries: readonly OpenLibrary[],
    held: readonly Winner[],
    proposal: Proposal,
  ): Promise<Closeness[]> {
    const wanted = new Set(identityText(proposal))
    await ready(CREATE_WAIT_MS)
    const vectors = stored(libraries)
    const asVector = vectors.size === 0 ? undefined : await embedOne(identityText(proposal).join(" "), proposal.name)
    if (asVector !== undefined) spare = { stamp: stamp(proposal), vector: asVector }
    return held.map((winner) => {
      const lexical = jaccard(wanted, new Set(identityText(winner.tool)))
      const vector = vectors.get(`${winner.library.kind}:${winner.tool.name.toLowerCase()}`)
      const close = asVector === undefined || vector === undefined ? 0 : cosine(asVector, vector)
      return {
        winner,
        similarity: Math.max(lexical, close),
        certain: lexical >= limits.duplicateJaccard || close >= limits.duplicateCosine,
        banded: lexical >= limits.duplicateBand || close >= limits.duplicateCosineBand,
      }
    })
  }

  // The model is asked only about the band: below it two Tools are not alike enough to argue over, and above it no answer would change the refusal.
  async function judge(proposal: Proposal, against: Winner, library: OpenLibrary): Promise<Judgment> {
    if (judgeWith === undefined) return { verdict: "unavailable" }
    try {
      const examples = await library.queue.serialize(() => library.store.readExamples(against.tool.name))
      const written = await judgeWith.complete({
        system: DUPLICATE_SYSTEM,
        messages: [{ role: "user", content: compare(proposal, against.tool, examples) }],
        maxTokens: JUDGE_MAX_TOKENS,
        json: DUPLICATE_SCHEMA,
        signal: stopper.signal,
      })
      const answer = JSON.parse(unfence(written)) as { same?: unknown; reason?: unknown }
      if (answer.same !== true) return { verdict: "different" }
      const reason = typeof answer.reason === "string" && answer.reason !== "" ? answer.reason : undefined
      return { verdict: "same", reason: reason ?? "the model judged the two Tools the same capability" }
    } catch (cause) {
      // A judgment flintd could not get is not a refusal, and it is not silence either: the caller warns.
      onLog?.({ tool: proposal.name, callId: null, message: `the duplicate judgment did not finish, so the save went through with a warning: ${causeMessage(cause)}` })
      return { verdict: "unavailable" }
    }
  }

  function warned(one: Closeness): Duplicate {
    return {
      name: one.winner.tool.name,
      description: one.winner.tool.description,
      parameters: one.winner.tool.parameters,
      state: one.winner.tool.state,
      library: one.winner.library.kind,
      similarity: round(one.similarity),
      judged: null,
      warn: true,
    }
  }

  async function duplicate(
    libraries: readonly OpenLibrary[],
    proposal: Proposal,
    session: string | null,
  ): Promise<Duplicate | undefined> {
    const mine = proposal.name.toLowerCase()
    const held = callable(libraries).filter(({ tool }) => tool.name.toLowerCase() !== mine && reachable(tool, session))
    if (held.length === 0) return undefined
    const scored = await closeness(libraries, held, proposal)
    // One create asks the model at most this many times, whatever a Library of any size holds inside the band.
    let budget = limits.duplicateMaxJudgments
    // A Verified or Active Tool refuses the save, so it is looked for first; a Draft only ever warns.
    for (const states of REFUSES_THEN_WARNS) {
      const group = scored
        .filter((one) => states.includes(one.winner.tool.state) && one.banded)
        .sort((left, right) => right.similarity - left.similarity)
      for (const candidate of group) {
        if (candidate.certain) return { ...warned(candidate), warn: false }
        if (budget === 0) return warned(candidate)
        budget -= 1
        const judged = await judge(proposal, candidate.winner, candidate.winner.library)
        if (judged.verdict === "different") continue
        return { ...warned(candidate), judged: judged.reason ?? null, warn: judged.verdict === "unavailable" }
      }
    }
    return undefined
  }

  return {
    findLimit: limits.findLimit,
    find,
    duplicate,

    // The pass never blocks a write: it takes no queue, and a Version written while it runs is embedded by the next one.
    refresh(library: OpenLibrary): void {
      if (embed === undefined) return
      const mine = generation
      passes = passes.then(() =>
        refreshLibrary(library, mine).catch((cause: unknown) => {
          if (mine !== generation) return
          onLog?.({ tool: library.kind, callId: null, message: `the Tool embeddings were not made: ${causeMessage(cause)}` })
        }),
      )
    },

    async settle(): Promise<void> {
      // The generation moves first, so a pass that wakes after the grace writes nothing and logs nothing.
      generation += 1
      stopper.abort()
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        passes,
        new Promise<void>((wake) => {
          timer = setTimeout(wake, limits.stopGraceMs)
        }),
      ])
      clearTimeout(timer)
      passes = Promise.resolve()
      stopper = new AbortController()
      spare = undefined
    },
  }
}

// A Draft belongs to the session that wrote it, and a caller that names no session reaches every Draft of the Tenant.
export function reachable(tool: Pick<IndexedTool, "state" | "session">, session: string | null): boolean {
  return tool.state !== "draft" || tool.session === null || session === null || tool.session === session
}

function compare(proposal: Proposal, against: Pick<IndexedTool, "name" | "description" | "parameters">, examples: readonly Example[]): string {
  return [
    "The Tool the agent wants to write:",
    describe(proposal.name, proposal.description, proposal.parameters, proposal.examples),
    "",
    "The Tool the Library already holds:",
    describe(against.name, against.description, against.parameters, examples),
  ].join("\n")
}

function describe(name: string, description: string, parameters: JsonSchema, examples: readonly Example[]): string {
  return [
    `Name: ${name}`,
    `What it does: ${description}`,
    `Argument schema: ${canonicalJson(parameters as unknown as JsonValue)}`,
    `Examples: ${canonicalJson(examples.slice(0, 3) as unknown as JsonValue)}`,
  ].join("\n")
}

// A model that was asked for JSON still fences it often enough that the fence is worth taking off before the parse.
function unfence(written: string): string {
  return /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(written)?.[1] ?? written
}

function rank(corpus: readonly Winner[], keys: readonly string[], scores: readonly number[], floor: number): Ranked[] {
  return corpus
    .map((winner, at) => ({ key: keys[at] as string, winner, score: scores[at] ?? 0 }))
    .filter((one) => one.score > floor)
    .sort((left, right) => right.score - left.score || left.winner.tool.name.localeCompare(right.winner.tool.name))
    .slice(0, CANDIDATES)
}

// Reciprocal rank fusion: each retriever votes by position, so a BM25 share and a cosine never share a scale.
function fuse(orders: readonly Ranked[][]): Ranked[] {
  const fused = new Map<string, Ranked>()
  for (const order of orders) {
    for (const [at, one] of order.entries()) {
      const held = fused.get(one.key) ?? { key: one.key, winner: one.winner, score: 0 }
      held.score += 1 / (RRF_K + at + 1)
      fused.set(one.key, held)
    }
  }
  return [...fused.values()].sort(
    (left, right) => right.score - left.score || left.winner.tool.name.localeCompare(right.winner.tool.name),
  )
}

interface Group {
  members: Ranked[]
  words: Set<string>
  vector: Float32Array | undefined
  score: number
}

// One capability, one result: a group never offers two Tools as separate answers without naming them as siblings.
function group(
  ranked: readonly Ranked[],
  vectors: ReadonlyMap<string, Float32Array>,
  limits: SearchLimits,
  wanted: number,
  share: boolean,
): FindEntry[] {
  const groups: Group[] = []
  for (const one of ranked) {
    const words = siblingText(one.winner.tool)
    const vector = vectors.get(one.key)
    const held = groups.find((candidate) => alike(candidate, words, vector, limits))
    if (held === undefined) groups.push({ members: [one], words, vector, score: one.score })
    else held.members.push(one)
  }
  const best = groups[0]?.score ?? 1
  return groups.slice(0, wanted).map((one) => entry(one, share ? 1 : best === 0 ? 1 : best))
}

function alike(held: Group, words: Set<string>, vector: Float32Array | undefined, limits: SearchLimits): boolean {
  if (jaccard(held.words, words) >= limits.siblingJaccard) return true
  if (held.vector === undefined || vector === undefined) return false
  return cosine(held.vector, vector) >= limits.siblingCosine
}

function entry(held: Group, divisor: number): FindEntry {
  // The query chose the representative: the member this search ranked highest.
  const ordered = [...held.members].sort(
    (left, right) =>
      right.score - left.score ||
      right.winner.tool.contribution - left.winner.tool.contribution ||
      STATE_RANK[right.winner.tool.state] - STATE_RANK[left.winner.tool.state],
  )
  const first = ordered[0] as Ranked
  return {
    name: first.winner.tool.name,
    description: summary(first.winner.tool.description),
    state: first.winner.tool.state,
    contribution: first.winner.tool.contribution,
    library: first.winner.library.kind,
    score: round(Math.min(first.score / divisor, 1)),
    siblings: ordered.slice(1).map((one) => ({
      name: one.winner.tool.name,
      state: one.winner.tool.state,
      library: one.winner.library.kind,
    })),
  }
}

function summary(description: string): string {
  const stop = /[.!?](\s|$)/.exec(description)
  const first = (stop === null ? description : description.slice(0, stop.index + 1)).trim()
  return first.length <= SUMMARY_LENGTH ? first : `${first.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…`
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

// The query reaches the model and the embedding endpoint, so it is capped like every other text that arrives from outside.
export function assertQuery(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError("invalid_arguments", "A search needs a `query`: one line saying what you want the Tool to do.", {
      received: typeof value,
    })
  }
  return capBytes(value, MAX_QUERY_BYTES)
}

function assertLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ToolError("invalid_arguments", "The `limit` of a search must be a whole number of results, or be left out.", {
      received: String(value),
    })
  }
  return value as number
}
