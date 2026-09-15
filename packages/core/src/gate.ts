import { approvalKey, granted, grantedRun, requestApproval } from "./approvals.ts"
import { ToolError } from "./errors.ts"
import type { Engine } from "./engine.ts"
import { assertManifest, tierFor } from "./manifest.ts"
import type { ExecutionLimits } from "./quickjs.ts"
import type { Store, Written } from "./store.ts"
import {
  assertDescription,
  assertParametersSchema,
  assertResultSchema,
  canonicalJson,
  isPlainObject,
  patternsOf,
  quoteJson,
  validateArguments,
} from "./validate.ts"
import { TOOL_STATES } from "./types.ts"
import type { Example, InvalidTool, JsonSchema, JsonValue, Manifest, Tier, Tool, ToolState, ToolStats } from "./types.ts"

export type GatedOut = Omit<InvalidTool, "library">

// The same five clean calls that earn a place here, read from the stats.json a Version carries.
const EARNED_CALLS = 5

export interface Proving {
  name: string
  parameters: Tool["parameters"]
  result?: JsonSchema | undefined
  manifest: Manifest
  tier: Tier
  session: string | null
}

export function readExampleList(value: unknown): Example[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolError(
      "invalid_examples",
      "A Tool needs at least one Example. Give a list of { args, expected } pairs that show what the Tool returns.",
      {},
    )
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry) || !("args" in entry) || !("expected" in entry)) {
      throw new ToolError("invalid_examples", `Example ${index} must be an object with "args" and "expected".`, { index })
    }
    return { args: entry["args"] as JsonValue, expected: entry["expected"] as JsonValue, grade: "exact" }
  })
}

// `deferrable` is true only while the Tool's own Manifest waits for an Approval, and then an Example that failed for
// the want of what that Manifest asks for is recorded as deferred rather than refusing the save. Every other failure
// still refuses it, and the grant runs every Example again with the Manifest in force.
export async function proveExamples(
  engine: Engine,
  limits: ExecutionLimits,
  proving: Proving,
  body: string,
  examples: Example[],
  deferrable = false,
): Promise<Example[]> {
  const proved: Example[] = []
  for (let index = 0; index < examples.length; index += 1) {
    const example = examples[index] as Example
    const problems = validateArguments(proving.parameters, example.args)
    if (problems.length > 0) {
      throw new ToolError(
        "invalid_examples",
        `Example ${index} carries arguments that the Tool's own schema refuses: ${problems.join(" ")} Nothing was saved.`,
        { index, problems },
      )
    }
    let actual: JsonValue
    try {
      actual = await engine.run({
        toolName: proving.name,
        body,
        args: example.args,
        manifest: proving.manifest,
        tier: proving.tier,
        limits,
        ...patternsOf(proving.parameters, proving.result),
      })
    } catch (cause) {
      if (!(cause instanceof ToolError)) throw cause
      if (deferrable && typeof cause.details["capability"] === "string") {
        proved.push({ args: example.args, expected: example.expected, grade: example.grade, status: "deferred" })
        continue
      }
      throw new ToolError(
        "example_failed",
        `Example ${index} did not produce a result: ${cause.message} Nothing was saved. Fix the Body and send it again.`,
        { index, args: example.args, expected: example.expected, error: cause.toJSON() as unknown as JsonValue },
      )
    }
    if (canonicalJson(actual) !== canonicalJson(example.expected)) {
      throw new ToolError(
        "example_failed",
        `Example ${index} expected ${quoteJson(example.expected)} and the Body returned ${quoteJson(actual)}. Nothing was saved. Fix the Body, or correct the Example, and send it again.`,
        { index, args: example.args, expected: example.expected, actual },
      )
    }
    const broken = proving.result === undefined ? [] : validateArguments(proving.result, actual, "the result")
    if (broken.length > 0) {
      throw new ToolError(
        "invalid_result",
        `Example ${index} returned a result the Tool's own result schema refuses: ${broken.join(" ")} Nothing was saved. Fix the Body, or change result_json to the shape the Tool really returns.`,
        { index, args: example.args, actual, problems: broken },
      )
    }
    proved.push({ args: example.args, expected: example.expected, grade: example.grade })
  }
  return proved
}

export type WhileProving = <T>(action: () => Promise<T>) => Promise<T>

export async function scanLibrary(
  store: Store,
  engine: Engine,
  limits: ExecutionLimits,
  whileProving: WhileProving,
): Promise<GatedOut[]> {
  const invalid: GatedOut[] = []
  const kept = new Set<string>()
  const names = await store.listTools()
  const dirty = names.length === 0 ? new Set<string>() : await store.changedTools()
  const digests = names.length === 0 ? new Map<string, string>() : await store.digests()
  for (const name of names) {
    kept.add(name.toLowerCase())
    const indexed = store.get(name)
    const digest = digests.get(name) ?? ""
    // A stored digest is only ever one that passed the gate, so a match plus a clean directory needs no rerun.
    if (!dirty.has(name) && digest !== "" && indexed?.digest === digest) continue
    try {
      const gated = await gateDirectory(store, name, dirty.has(name), engine, limits, whileProving)
      store.upsert({ ...gated.tool, state: gated.state, downgraded: gated.reason })
      // A Tool this index never held takes the counters the repository committed with its last Version.
      if (indexed === undefined) store.seedCounters(name, await countersOf(store, name))
      const version = gated.written?.version ?? (await store.currentVersion(name))
      store.setDigest(name, gated.written?.digest ?? digest, version)
      // A pair a person wrote by hand is a new request: an Approval granted to another Manifest or Body does not reach it.
      requestApproval(store, gated.tool, gated.body, version, null)
    } catch (cause) {
      if (!(cause instanceof ToolError)) throw cause
      invalid.push({ name, code: cause.code, message: cause.message })
      // The request goes in anyway, or a person has nothing to grant and no way back.
      await requestFromDirectory(store, name)
      const previous = await headDefinition(store, name)
      if (previous !== undefined) store.upsert(previous)
    }
  }
  for (const indexed of store.all()) {
    if (!kept.has(indexed.name.toLowerCase())) store.forget(indexed.name)
  }
  return invalid
}

async function gateDirectory(
  store: Store,
  name: string,
  changed: boolean,
  engine: Engine,
  limits: ExecutionLimits,
  whileProving: WhileProving,
): Promise<{ tool: Tool; body: string; state: ToolState; reason: string | null; written?: Written }> {
  const read = definitionOf(name, await store.readTool(name), changed)
  const body = await store.readBody(name)
  const examples = readExampleList(await store.readExamples(name))
  // The tier follows the Manifest and the Body, so a hand-written tier in tool.json changes nothing.
  const tool: Tool = { ...read, tier: tierFor(name, read.manifest, body) }
  const proved = await proven(store, tool, body)
  const proving: Proving = { ...tool, ...grantedRun(store, tool, body), session: null }
  // A Manifest nobody has granted defers the Examples that need it here too, the way the agent channel defers them.
  const waiting = !granted(store, tool, body)
  const ran = await whileProving(() => proveExamples(engine, limits, proving, body, examples, waiting))
  if (!changed) return { tool, body, ...proved }
  // A hand-edited directory puts the Tool back to Draft, so the Held-out evidence of the Version before it goes with it.
  await store.writeFiles({ tool, examples: ran, body, stats: await countersOf(store, name), heldOut: null })
  const written = await store.commit(name, (await store.known(name)) ? "update" : "create", "file")
  return { tool, body, state: tool.state, reason: null, written }
}

// A Version is a file another Library may have written, so the state it declares is a claim, not evidence (ADR 0001).
async function proven(store: Store, tool: Tool, body: string): Promise<{ state: ToolState; reason: string | null }> {
  let state = tool.state
  let reason: string | null = null
  if (state === "active" && !(await used(store, tool, body))) {
    state = "verified"
    reason =
      "This Version declares Active, and this Library holds no evidence of it: its stats.json counts fewer than the five calls that earn a place, and nobody here has approved its Manifest. It stays Verified until it earns the place on this machine."
  }
  if (state === "verified" && (await store.readHeldOut(tool.name).catch(() => null))?.status !== "passed") {
    state = "draft"
    reason =
      "This Version declares Verified, and it carries no held-out.json that says its Held-out examples passed. It stays a Draft until a Held-out run proves it."
  }
  return { state, reason }
}

// A row is evidence only when it says a person approved this pair; a request waiting for a decision proves nothing.
async function used(store: Store, tool: Tool, body: string): Promise<boolean> {
  if (store.approval(tool.name, approvalKey(tool.manifest, body))?.status === "approved") return true
  const stats = await store.readStats(tool.name).catch(() => undefined)
  return typeof stats?.calls === "number" && stats.calls >= EARNED_CALLS
}

async function requestFromDirectory(store: Store, name: string): Promise<void> {
  try {
    const manifest = assertManifest((await store.readTool(name)).manifest)
    const body = await store.readBody(name)
    requestApproval(store, { name, manifest }, body, await store.currentVersion(name), null)
  } catch {
    // A tool.json that will not parse declares no Manifest to ask about, and the Tool is already listed as invalid.
  }
}

async function headDefinition(store: Store, name: string): Promise<Tool | undefined> {
  try {
    const head = await store.versionTool(name, "HEAD")
    const read = definitionOf(name, head, false)
    return { ...read, tier: tierFor(name, read.manifest, await store.versionBody(name, "HEAD")) }
  } catch {
    return undefined
  }
}

function definitionOf(name: string, raw: Tool, changed: boolean): Omit<Tool, "tier"> {
  if (!isPlainObject(raw)) {
    throw new ToolError("store_error", `The file tool.json of the Tool ${name} is not a JSON object.`, { name })
  }
  if (raw.name !== name) {
    throw new ToolError(
      "invalid_name",
      `The directory tools/${name} holds a tool.json whose name is ${JSON.stringify(raw.name)}. Make them the same.`,
      { name, declared: typeof raw.name === "string" ? raw.name : null },
    )
  }
  return {
    name,
    description: assertDescription(raw.description),
    parameters: assertParametersSchema(raw.parameters),
    ...(raw.result === undefined ? {} : { result: assertResultSchema(raw.result) }),
    manifest: assertManifest(raw.manifest),
    state: stateOf(raw.state, changed),
    needs_review: raw.needs_review === true,
    provenance: {
      channel: "file",
      session: null,
      harness: null,
      model: null,
      excerpt: null,
      createdAt: new Date().toISOString(),
    },
  }
}

function stateOf(raw: ToolState, changed: boolean): ToolState {
  const stored = TOOL_STATES.includes(raw) ? raw : "draft"
  // Verified and Active rest on evidence flintd produced, so a hand-edited directory cannot declare them.
  if (!changed || stored === "retired") return stored
  return "draft"
}

// A file-channel write keeps the counts the Library already committed: they belong to the Tool, not to this edit.
async function countersOf(store: Store, name: string): Promise<ToolStats> {
  const stats = await store.readStats(name).catch((cause: unknown) => {
    if (cause instanceof ToolError && cause.code === "not_found") return blank()
    throw cause
  })
  if (!counter(stats.calls) || !counter(stats.errors)) {
    throw new ToolError(
      "store_error",
      `The file stats.json of the Tool ${name} must hold whole counts of calls and errors, and it holds ${JSON.stringify(stats.calls)} and ${JSON.stringify(stats.errors)}.`,
      { name },
    )
  }
  const tokens = stats.tokens
  return {
    calls: stats.calls,
    errors: stats.errors,
    lastCallAt: typeof stats.lastCallAt === "string" ? stats.lastCallAt : null,
    p50Ms: counter(stats.p50Ms) ? stats.p50Ms : null,
    tokens: {
      input: counter(tokens?.input) ? tokens.input : 0,
      output: counter(tokens?.output) ? tokens.output : 0,
    },
    contribution: typeof stats.contribution === "number" && Number.isFinite(stats.contribution) ? stats.contribution : 0,
  }
}

function blank(): ToolStats {
  return { calls: 0, errors: 0, lastCallAt: null, p50Ms: null, tokens: { input: 0, output: 0 }, contribution: 0 }
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
