import { deferredAdvice, granted, grantedRun, liveApproval, plannedApproval, requestApproval } from "./approvals.ts"
import { parseBody } from "./body.ts"
import { BUNDLE, BUNDLE_NODE_ONLY } from "./bundle.ts"
import type { ContainerTier } from "./container-tier.ts"
import { ToolError } from "./errors.ts"
import { proveExamples, readExampleList } from "./gate.ts"
import type { Proving } from "./gate.ts"
import { broken, holder } from "./library.ts"
import type { OpenLibrary } from "./library.ts"
import { NODE_BUILTINS, assertManifest, tierFor } from "./manifest.ts"
import { capFull, capMessage, earned } from "./promotion.ts"
import { redact } from "./redact.ts"
import type { ExecutionLimits } from "./quickjs.ts"
import { assertQuery, reachable } from "./search.ts"
import type { Duplicate, Search } from "./search.ts"
import type { IndexedTool, Store, ToolRecord } from "./store.ts"
import {
  ENFORCED_KEYWORDS,
  assertDescription,
  assertParametersSchema,
  assertResultSchema,
  assertToolName,
  canonicalJson,
  capBytes,
  describeValue,
  isPlainObject,
} from "./validate.ts"
import type {
  CallMeta,
  CallResult,
  Channel,
  Example,
  HeldOut,
  LibraryKind,
  Operation,
  JsonSchema,
  JsonValue,
  Provenance,
  Tool,
  ToolDefinition,
  ToolState,
} from "./types.ts"

export interface MetaContext {
  library: OpenLibrary
  libraries: OpenLibrary[]
  limits: ExecutionLimits
  container: ContainerTier
  modelConfigured: boolean
  // The Channel of a write this turn makes. The Observer sets it; a caller never can.
  channel?: Channel
  activeCap: number
  search: Search
  // tool_run leaves the id of the call it dispatched here, so the caller can report an outcome on it.
  ran?: string | null
  runTool(name: string, args: unknown, meta: CallMeta): Promise<CallResult>
  verify(name: string, version: string): void
}

const ANY: JsonSchema = {}
const IMPORT_ADVICE =
  `\`await import("<name>")\` is the only import form, and it reaches two lists and nothing else: the Bundle, ` +
  `${BUNDLE.join(", ")}; and these pure Node builtins, ${NODE_BUILTINS.join(", ")}. Importing a builtin, or ` +
  `${BUNDLE_NODE_ONLY.join(", ")}, moves the Tool to the Node tier.`
const BODY_ADVICE =
  `The body of \`async function execute(args, ctx)\`, with no function line. Return a JSON value. \`args\` holds exactly ` +
  `the top-level properties of parameters_json. ctx carries \`toolName\`, \`log(message)\`, \`callTool(name, args)\`, and ` +
  `\`fetch(url, init)\`, \`fs.read(path)\`/\`fs.write(path, text)\`/\`fs.list(dir)\` and \`exec(command, options)\` where the ` +
  `Manifest asks for them. \`await ctx.fetch(url, init)\` answers \`{ status, headers, body }\`, not a Response: there is no ` +
  `\`.ok\`, no \`.json()\`, and \`body\` is already parsed JSON when the answer says JSON. ${IMPORT_ADVICE}`
const SCHEMA_FORM = "Send the JSON Schema object itself, or that same object written as a JSON string; both read."
const SCHEMA_KEYWORDS =
  `flintd checks these keywords and no others: ${ENFORCED_KEYWORDS.join(", ")}; "additionalProperties" takes true or false, never a schema.`
const PARAMETERS_ADVICE =
  `${SCHEMA_FORM} The root must be an object schema. ${SCHEMA_KEYWORDS} A pattern is at most 256 characters, belongs on a string, and runs inside the Tool's own tier: one that never finishes costs this call and no other.`
const RESULT_ADVICE =
  `Optional. The JSON Schema for the result. ${SCHEMA_FORM} The root may be any type, or {} for "any JSON value". ${SCHEMA_KEYWORDS} Every Example, every Held-out example and every call is held to it, so declare one only when the shape is fixed.`
const MANIFEST_ADVICE =
  'What the Tool needs to reach, as a JSON string, and empty by default: {"fs": "<one directory in the Library>", "hosts": ["api.example.com"], "connections": ["<name>"], "exec": false}. "exec": true runs the Tool in a container, where ctx.exec(command) runs a command line. Anything but an empty Manifest waits for one human Approval before the Tool can be called, so ask for the least that works.'

const MAX_EXCERPT_BYTES = 4096
const DEFAULT_PAGE = 20

export const META_TOOLS: readonly ToolDefinition[] = [
  {
    name: "tool_create",
    description:
      "Write a new Tool into the Library so the capability outlives this turn. execute_source is the body of `async function execute(args, ctx)`: `args` holds exactly the top-level properties parameters_json declares, and it returns a JSON value. ctx is `{ toolName, log, callTool, fetch, fs: { read, write, list }, exec }`, and `await ctx.fetch(url, init)` answers `{ status, headers, body }`, never a Response. `await import(\"<name>\")` reaches the Bundle, " +
      `${BUNDLE.join(", ")}, and these pure Node builtins, ${NODE_BUILTINS.join(", ")}; a builtin or ${BUNDLE_NODE_ONLY.join(", ")} moves the Tool to the Node tier. ` +
      "Write each Example as exact JSON in the Tool's own nesting: `args` carries the keys parameters_json declares and `expected` is what the Body really returns. All of them run before anything is saved. A Body reaches no file, no host and no command until manifest_json asks and one person approves; an Example that needs what the Manifest asks for is saved as deferred, and the Approval runs it.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Lower-case letters, digits and underscores, starting with a letter, for example \"word_count\".",
        },
        description: {
          type: "string",
          description: "One sentence that tells a model when to call this Tool.",
        },
        parameters_json: {
          description: `The JSON Schema for the arguments. ${PARAMETERS_ADVICE}`,
        },
        execute_source: { type: "string", description: BODY_ADVICE },
        examples: {
          type: "array",
          minItems: 1,
          description: "At least one Example. `args` is an object holding the top-level properties of parameters_json, `expected` is the exact JSON the Body returns, and the two are compared after JSON canonicalization.",
          items: {
            type: "object",
            properties: { args: ANY, expected: ANY },
            required: ["args", "expected"],
            additionalProperties: false,
          },
        },
        result_json: { description: RESULT_ADVICE },
        manifest_json: { type: "string", description: MANIFEST_ADVICE },
      },
      required: ["name", "description", "parameters_json", "execute_source", "examples"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_update",
    description:
      "Change a Tool and save the change as a new Version. Send only the fields you are changing; the rest stay as they are. A change to the Body, the argument schema or the Examples runs every Example again, and nothing is saved unless they all pass. Send restore_version on its own to bring an earlier Version back, which is also how you take a Retired Tool out of retirement.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The Tool to change." },
        description: { type: "string", description: "The new one-sentence description." },
        parameters_json: { description: `The new JSON Schema for the arguments. ${PARAMETERS_ADVICE}` },
        execute_source: { type: "string", description: `The new body, without the function line. ${BODY_ADVICE}` },
        examples: {
          type: "array",
          minItems: 1,
          description: "The new Example list. It replaces the old one, so send every Example you want to keep.",
          items: {
            type: "object",
            properties: { args: ANY, expected: ANY },
            required: ["args", "expected"],
            additionalProperties: false,
          },
        },
        result_json: { description: `The new result schema. ${RESULT_ADVICE}` },
        manifest_json: { type: "string", description: MANIFEST_ADVICE },
        restore_version: {
          type: "string",
          description:
            "The id of the Version to bring back, from tool_history. The other fields are ignored when you send this.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_read",
    description:
      "Read one Tool: its description, its argument schema and its state. Ask for the Body when you are about to change it, and for the Examples when you want to see what it is proved to do.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The Tool to read." },
        include_source: { type: "boolean", description: "Return the Body as well." },
        include_examples: { type: "boolean", description: "Return the Examples as well." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_find",
    description:
      "Search the Library by intent and get the closest Tools with a one-line description of each. Call this before tool_create: the Tool you are about to write may already exist. Near-identical Tools come back as one entry with the others under \"siblings\".",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want the Tool to do, in one line." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description:
            "How many Tools to return. The Library has a cap of its own and answers with the lower of the two; the answer carries the limit it applied.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_run",
    description:
      "Run any Tool in the Library by name. Use this when the Tool you want is not in the tool list you were given, because the list was fixed before the Tool existed.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The Tool to run." },
        args: { type: "object", additionalProperties: true, description: "The arguments, matching that Tool's own schema." },
      },
      required: ["name", "args"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_retire",
    description:
      "Take a Tool out of use when it is wrong or no longer needed. The directory, the Examples and every Version stay in the Library. The answer carries the Version id that undoes the retirement through tool_update.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The Tool to retire." } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_history",
    description:
      "List the Versions of a Tool, newest first, so you can see what changed before it broke. Each entry carries the id you pass to tool_update as restore_version.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The Tool to look at." },
        before: {
          type: "string",
          description: "Return the Versions older than this id. Use the last id of the page you already have.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "How many Versions to return. The default is 20." },
        include_source: { type: "boolean", description: "Return the Body of each Version as well." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
]

export const META_TOOL_NAMES: ReadonlySet<string> = new Set(META_TOOLS.map((tool) => tool.name))

export function metaTool(name: string): ToolDefinition | undefined {
  return META_TOOLS.find((tool) => tool.name === name)
}

export async function callMetaTool(
  context: MetaContext,
  definition: ToolDefinition,
  args: { [key: string]: JsonValue },
  meta: CallMeta,
): Promise<JsonValue> {
  switch (definition.name) {
    case "tool_create":
      return createTool(context, args, meta)
    case "tool_update":
      return updateTool(context, args, meta)
    case "tool_read":
      return readOneTool(context, args, meta)
    case "tool_find":
      return findTools(context, args, meta)
    case "tool_run": {
      const ran = await context.runTool(assertToolName(args["name"]), args["args"], meta)
      context.ran = ran.id
      return ran.result
    }
    case "tool_retire":
      return retireTool(context, args, meta)
    case "tool_history":
      return historyOfTool(context, args, meta)
    default:
      throw new ToolError(
        "not_implemented",
        `${definition.name} is not in this build of flintd. Use tool_create, tool_read and tool_run for now.`,
        { tool: definition.name },
      )
  }
}

async function createTool(
  context: MetaContext,
  args: { [key: string]: JsonValue },
  meta: CallMeta,
): Promise<JsonValue> {
  const name = assertToolName(args["name"])
  if (META_TOOL_NAMES.has(name)) {
    throw new ToolError(
      "invalid_name",
      `The name ${JSON.stringify(name)} belongs to one of flintd's own meta tools. Choose another name.`,
      { name },
    )
  }
  const description = assertDescription(args["description"])
  const parameters = assertParametersSchema(parseSchema(args["parameters_json"], "parameters_json"))
  const declared = resultSchema(args["result_json"])
  const body = parseBody(args["execute_source"], context.limits.maxBodyBytes)
  const examples = readExampleList(args["examples"])
  const manifest = assertManifest(parseManifest(args["manifest_json"]))
  const tier = tierFor(name, manifest, body)

  const tool: Tool = {
    name,
    description,
    parameters,
    ...(declared === undefined ? {} : { result: declared }),
    manifest,
    tier,
    state: "draft",
    needs_review: false,
    provenance: provenanceOf(meta, context.channel),
  }
  // The name is taken inside one turn of the write queue, so two creates of it cannot both read the Library as empty.
  const release = await context.library.queue.serialize(async () => reserveName(context, name))
  let copy: Duplicate | undefined
  let proved: Proved
  let version: string
  try {
    // The check runs before the Examples do: a Tool the Library is going to refuse must not cost a tier run first.
    copy = await context.search.duplicate(
      context.libraries,
      { name, description, parameters, examples },
      metaText(meta.sessionId, "sessionId"),
    )
    if (refuses(copy)) throw duplicated(copy)
    proved = await prove(
      context,
      { name, parameters, result: declared, manifest, tier, session: metaText(meta.sessionId, "sessionId") },
      body,
      examples,
    )
    version = await save(
      context,
      { tool, examples: proved.examples, body, stats: context.library.store.stats(name), heldOut: null },
      "create",
    )
  } finally {
    release()
  }
  context.verify(name, version)
  const result: { [key: string]: JsonValue } = {
    name,
    state: tool.state,
    version,
    tier,
    examples: examples.length,
    library: context.library.kind,
    approval: approvalView(context, tool, body),
  }
  if (proved.deferred.length > 0) result["deferred"] = proved.deferred
  const winner = above(context, name)
  const warnings = [...(proved.advice === null ? [] : [proved.advice]), ...(copy === undefined ? [] : [copyWarning(copy)])]
  if (winner !== undefined) {
    warnings.push(
      `The ${winner.kind} Library also holds a Tool named ${JSON.stringify(name)}, and it wins on a name collision, so a call to ${JSON.stringify(name)} reaches that one. Give this Tool another name, or change the ${winner.kind} one.`,
    )
  }
  if (warnings.length > 0) result["warning"] = warnings.join(" ")
  return result
}

async function updateTool(
  context: MetaContext,
  args: { [key: string]: JsonValue },
  meta: CallMeta,
): Promise<JsonValue> {
  const indexed = resolveTool(context, args["name"])
  const provenance = provenanceOf(meta, context.channel)
  const session = metaText(meta.sessionId, "sessionId")
  if (args["restore_version"] !== undefined) {
    await read(context, async (store) => assertReachable(await store.readTool(indexed.name), session))
    return restoreVersion(context, indexed, args["restore_version"], tenantWide(provenance, indexed.state))
  }
  if (indexed.state === "retired") throw retired(indexed.name, elsewhere(context, indexed.name))

  const held = await read(context, async (store) => ({
    tool: await store.readTool(indexed.name),
    body: await store.readBody(indexed.name),
    examples: await store.readExamples(indexed.name),
    heldOut: await store.readHeldOut(indexed.name),
    dirty: await store.changed(indexed.name),
  }))
  assertReachable(held.tool, session)
  const description = args["description"] === undefined ? held.tool.description : assertDescription(args["description"])
  const parameters =
    args["parameters_json"] === undefined
      ? held.tool.parameters
      : assertParametersSchema(parseSchema(args["parameters_json"], "parameters_json"))
  const declared = args["result_json"] === undefined ? held.tool.result : resultSchema(args["result_json"])
  const body = args["execute_source"] === undefined ? held.body : parseBody(args["execute_source"], context.limits.maxBodyBytes)
  const examples = args["examples"] === undefined ? held.examples : readExampleList(args["examples"])
  const manifest =
    args["manifest_json"] === undefined ? assertManifest(held.tool.manifest) : assertManifest(parseManifest(args["manifest_json"]))
  const tier = tierFor(indexed.name, manifest, body)

  // A new Body is the same Tool getting better; a new schema or a new description is a Tool that may now be a copy.
  const restated = !same(parameters, held.tool.parameters) || description !== held.tool.description
  const copy = restated
    ? await context.search.duplicate(context.libraries, { name: indexed.name, description, parameters, examples }, session)
    : undefined
  if (refuses(copy)) throw duplicated(copy)

  const revised = !same(parameters, held.tool.parameters) || body !== held.body || !same(declared, held.tool.result)
  // A Manifest change is a Version like any other: the Examples run again and the Tool goes back to Draft.
  const rescoped = !same(manifest, held.tool.manifest)
  const proves = revised || rescoped || !same(examples, held.examples) || held.dirty
  if (!proves && description === held.tool.description) {
    throw new ToolError(
      "invalid_arguments",
      `Every field you sent already matches the Tool ${JSON.stringify(indexed.name)}, and a Version records a change. Send the description, the argument schema, the Body or the Examples you want it to have.`,
      { name: indexed.name },
    )
  }
  const proved = proves
    ? await prove(context, { name: indexed.name, parameters, result: declared, manifest, tier, session }, body, examples)
    : { examples, deferred: [], advice: null }

  const tool: Tool = {
    name: indexed.name,
    description,
    parameters,
    ...(declared === undefined ? {} : { result: declared }),
    manifest,
    tier,
    // The evidence goes with the change, so the state goes with the evidence: the Held-out run earns Verified again.
    // A Version this update did not prove keeps the state this Library indexed, never the one tool.json declares.
    state: proves ? "draft" : indexed.state,
    // A new Body or a new schema is the answer to the conflict that asked for a review, so the flag goes with it.
    needs_review: revised ? false : held.tool.needs_review === true,
    provenance: tenantWide(provenance, held.tool.state),
  }
  // A Body or a schema that changed unmakes the Held-out evidence, and the run this schedules is what makes it again.
  const version = await save(
    context,
    { tool, examples: proved.examples, body, stats: context.library.store.stats(indexed.name), heldOut: proves ? null : held.heldOut },
    "update",
    proves ? null : indexed.downgraded,
  )
  if (proves) context.verify(tool.name, version)
  const answer: { [key: string]: JsonValue } = {
    name: tool.name,
    state: tool.state,
    version,
    tier,
    examples: examples.length,
    library: context.library.kind,
    needs_review: tool.needs_review,
    approval: approvalView(context, tool, body),
  }
  if (proved.deferred.length > 0) answer["deferred"] = proved.deferred
  const said = [...(proved.advice === null ? [] : [proved.advice]), ...(copy === undefined ? [] : [copyWarning(copy)])]
  if (said.length > 0) answer["warning"] = said.join(" ")
  return answer
}

async function restoreVersion(
  context: MetaContext,
  indexed: IndexedTool,
  id: JsonValue,
  provenance: Provenance,
): Promise<JsonValue> {
  const name = indexed.name
  const store = context.library.store
  const from = await store.resolveVersion(name, id)
  const past = await store.versionTool(name, from)
  const body = await store.versionBody(name, from)
  const examples = readExampleList(await store.versionExamples(name, from))
  const manifest = assertManifest(past.manifest)
  const restored = past.result === undefined ? undefined : assertResultSchema(past.result)
  const tool: Tool = {
    name,
    description: assertDescription(past.description),
    parameters: assertParametersSchema(past.parameters),
    ...(restored === undefined ? {} : { result: restored }),
    manifest,
    tier: tierFor(name, manifest, body),
    state: "draft",
    // A restore is the review: the person chose the Version that wins, so the Tool no longer waits for one.
    needs_review: false,
    provenance,
  }
  // A Version that was refused as a copy must not come back through a restore.
  const copy = await context.search.duplicate(
    context.libraries,
    { name, description: tool.description, parameters: tool.parameters, examples },
    provenance.session,
  )
  if (refuses(copy)) throw duplicated(copy)
  const proved = await prove(
    context,
    { name, parameters: tool.parameters, result: restored, manifest, tier: tool.tier, session: provenance.session },
    body,
    examples,
  )
  const version = await save(
    context,
    { tool, examples: proved.examples, body, stats: context.library.store.stats(name), heldOut: null },
    "restore",
  )
  context.verify(name, version)
  const answer: { [key: string]: JsonValue } = {
    name,
    state: tool.state,
    version,
    restored_from: from,
    tier: tool.tier,
    examples: examples.length,
    library: context.library.kind,
    needs_review: false,
    approval: approvalView(context, tool, body),
  }
  if (proved.deferred.length > 0) answer["deferred"] = proved.deferred
  const said = [...(proved.advice === null ? [] : [proved.advice]), ...(copy === undefined ? [] : [copyWarning(copy)])]
  if (said.length > 0) answer["warning"] = said.join(" ")
  return answer
}

async function retireTool(
  context: MetaContext,
  args: { [key: string]: JsonValue },
  meta: CallMeta,
): Promise<JsonValue> {
  const indexed = resolveTool(context, args["name"])
  const name = indexed.name
  if (indexed.state === "retired") {
    throw new ToolError(
      "invalid_arguments",
      `The Tool ${JSON.stringify(name)} is already Retired. Bring it back with tool_update and a restore_version from tool_history.`,
      { name },
    )
  }
  const held = await read(context, async (store) => ({
    tool: await store.readTool(name),
    undo: await store.currentVersion(name),
    body: await store.readBody(name),
    examples: readExampleList(await store.readExamples(name)),
    heldOut: await store.readHeldOut(name),
    dirty: await store.changed(name),
  }))
  assertReachable(held.tool, metaText(meta.sessionId, "sessionId"))
  const tool: Tool = {
    name,
    description: held.tool.description,
    parameters: held.tool.parameters,
    ...(held.tool.result === undefined ? {} : { result: held.tool.result }),
    manifest: assertManifest(held.tool.manifest),
    tier: held.tool.tier,
    state: "retired",
    needs_review: held.tool.needs_review === true,
    provenance: provenanceOf(meta, context.channel),
  }
  const examples = held.dirty
    ? (
        await prove(
          context,
          {
            name,
            parameters: tool.parameters,
            result: tool.result,
            manifest: tool.manifest,
            tier: tool.tier,
            session: tool.provenance.session,
          },
          held.body,
          held.examples,
        )
      ).examples
    : held.examples
  const version = await save(
    context,
    { tool, examples, body: held.body, stats: context.library.store.stats(name), heldOut: held.heldOut },
    "retire",
  )
  return { name, state: tool.state, version, restore_version: held.undo, library: context.library.kind }
}

async function historyOfTool(
  context: MetaContext,
  args: { [key: string]: JsonValue },
  meta: CallMeta,
): Promise<JsonValue> {
  const indexed = resolveTool(context, args["name"])
  const name = indexed.name
  const store = context.library.store
  // A Tool whose definition will not read is already broken, and this is the call that finds the Version to restore.
  const current = await read(context, async (one) => one.readTool(name).catch(() => undefined))
  if (current !== undefined) assertReachable(current, metaText(meta.sessionId, "sessionId"))
  const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_PAGE
  const before = args["before"] === undefined ? undefined : await store.resolveVersion(name, args["before"])
  const entries = await store.versions(name, before, before === undefined ? limit : limit + 1)
  const versions: JsonValue[] = []
  for (const entry of entries.filter((candidate) => candidate.id !== before).slice(0, limit)) {
    const past = await store.versionTool(name, entry.id).catch(problem)
    const version: { [key: string]: JsonValue } = {
      id: entry.id,
      operation: entry.operation,
      channel: entry.channel,
      timestamp: entry.timestamp,
      description: past instanceof ToolError || typeof past.description !== "string" ? null : past.description,
      message: entry.subject,
    }
    if (past instanceof ToolError) version["problem"] = past.message
    if (args["include_source"] === true) {
      const source = await store.versionBody(name, entry.id).catch(problem)
      version["source"] = source instanceof ToolError ? null : source
      if (source instanceof ToolError) version["problem"] = source.message
    }
    versions.push(version)
  }
  return { name, versions }
}

async function readOneTool(
  context: MetaContext,
  args: { [key: string]: JsonValue },
  meta: CallMeta,
): Promise<JsonValue> {
  const indexed = resolveTool(context, args["name"])
  const held = await read(context, async (store) => ({
    tool: await store.readTool(indexed.name),
    heldOut: await store.readHeldOut(indexed.name),
    body: await store.readBody(indexed.name),
    examples: await store.readExamples(indexed.name),
    // The index is read inside the same turn as the files, so the state and the evidence never disagree.
    current: store.get(indexed.name) ?? indexed,
  }))
  assertReachable(held.tool, metaText(meta.sessionId, "sessionId"))
  const result: { [key: string]: JsonValue } = {
    name: held.tool.name,
    description: held.tool.description,
    parameters: held.tool.parameters as JsonValue,
    result: (held.tool.result ?? null) as JsonValue,
    manifest: held.tool.manifest as unknown as JsonValue,
    tier: held.tool.tier,
    approval: approvalView(context, held.tool, held.body),
    state: held.current.state,
    downgraded: held.current.downgraded,
    library: context.library.kind,
    needs_review: held.current.needs_review,
    held_out: heldOutView(context, held.tool, held.heldOut, deferredOf(context, held.tool, held.body, held.examples)),
    stats: context.library.store.stats(indexed.name) as unknown as JsonValue,
  }
  const waiting = promotionView(context, indexed)
  if (waiting !== undefined) result["promotion"] = waiting
  const hidden = below(context, indexed.name)
  const winner = above(context, indexed.name)
  if (hidden !== undefined) result["shadows"] = otherTool(hidden, indexed.name)
  if (winner !== undefined) result["shadowed_by"] = otherTool(winner, indexed.name)
  const failed = broken(context.library, indexed.name)
  if (failed !== undefined) result["problem"] = failed.message
  const deferred = deferredOf(context, held.tool, held.body, held.examples)
  if (deferred.length > 0) result["deferred"] = deferred
  if (args["include_source"] === true) result["source"] = held.body
  if (args["include_examples"] === true) {
    result["examples"] = held.examples.map((one, index) =>
      deferred.includes(index) ? one : { args: one.args, expected: one.expected, grade: one.grade },
    ) as unknown as JsonValue
  }
  return result
}

async function findTools(
  context: MetaContext,
  args: { [key: string]: JsonValue },
  meta: CallMeta,
): Promise<JsonValue> {
  const found = await context.search.find(
    context.libraries,
    args["query"],
    args["limit"],
    metaText(meta.sessionId, "sessionId"),
  )
  // The query is echoed as flintd read it, and `limit` as flintd applied it, which is never more than findLimit.
  const asked = typeof args["limit"] === "number" ? args["limit"] : context.search.findLimit
  return {
    query: assertQuery(args["query"]),
    limit: Math.min(asked, context.search.findLimit),
    tools: found as unknown as JsonValue,
  }
}

function duplicated(copy: Duplicate): ToolError {
  return new ToolError(
    "duplicate",
    `The ${copy.library} Library already holds ${JSON.stringify(copy.name)}, ${stateWord(copy.state)} Tool that does this work: ${JSON.stringify(copy.description)} It takes ${canonicalJson(copy.parameters as unknown as JsonValue)}.${copy.judged === null ? "" : ` The model read both and said they are one capability: ${copy.judged}`} The right move is to call it instead of writing a copy; if it is close but not right, change that Tool with tool_update. Nothing was saved.`,
    {
      name: copy.name,
      state: copy.state,
      library: copy.library,
      parameters: copy.parameters as unknown as JsonValue,
      similarity: copy.similarity,
      judged: copy.judged,
    },
  )
}

// A Draft is nobody's proof yet, and a band with no judgment behind it is nobody's answer: both save and both say so.
function copyWarning(copy: Duplicate): string {
  if (copy.warn) {
    return `The ${copy.library} Library already holds ${JSON.stringify(copy.name)}, ${stateWord(copy.state)} Tool that reads much like this one, ${copy.similarity} alike: ${JSON.stringify(copy.description)} flintd could not get a judgment on whether the two are one capability, so it saved this one rather than refuse it. Read that Tool with tool_read, and retire one of the two if they do the same work.`
  }
  return `The ${copy.library} Library already holds a Draft named ${JSON.stringify(copy.name)} that does much the same work: ${JSON.stringify(copy.description)} This one was saved anyway, because a Draft is nobody's proof yet. Retire one of the two once you know which one works.`
}

// A Draft never refuses a save, and neither does a band flintd could not judge.
function refuses(copy: Duplicate | undefined): copy is Duplicate {
  return copy !== undefined && copy.state !== "draft" && !copy.warn
}

function stateWord(state: ToolState): string {
  return state === "active" ? "an Active" : state === "verified" ? "a Verified" : "a Draft"
}

// An Example nothing could run is deferred only while the decision is outstanding: the grant runs every one of them.
function deferredOf(context: MetaContext, tool: Tool, body: string, examples: readonly Example[]): number[] {
  if (granted(context.library.store, tool, body)) return []
  return examples.flatMap((one, index) => (one.status === "deferred" ? [index] : []))
}

function heldOutView(context: MetaContext, tool: Tool, held: HeldOut | null, deferred: readonly number[]): JsonValue {
  if (deferred.length > 0) {
    return {
      status: "unavailable",
      grades: empty(),
      failures: [],
      reason: `unavailable until approved: ${deferred.length === 1 ? `Example ${deferred[0]} is` : `Examples ${deferred.join(", ")} are`} deferred until one person approves the Manifest of ${JSON.stringify(tool.name)}, and flintd writes no Held-out example for a Tool whose own Examples have not all run. Run \`flintd approvals approve ${tool.name}\`.`,
    }
  }
  if (held !== null) {
    const view: { [key: string]: JsonValue } = {
      status: held.status,
      grades: held.grades,
      failures: held.failures as unknown as JsonValue,
    }
    if (held.reason !== null) view["reason"] = held.reason
    return view
  }
  if (context.modelConfigured) return { status: "pending", grades: empty(), failures: [] }
  return {
    status: "unavailable",
    grades: empty(),
    failures: [],
    reason:
      "flintd has no model configured, so it can write no Held-out example and this Tool cannot leave Draft. Set the model provider and key in the flintd config.",
  }
}

function empty(): JsonValue {
  return { exact: 0, assertion: 0 }
}

function promotionView(context: MetaContext, indexed: IndexedTool): JsonValue | undefined {
  if (indexed.state !== "verified" || !earned(context.library, indexed.name)) return undefined
  const full = capFull(context.libraries, context.activeCap)
  if (full === undefined) return undefined
  return { blocked: true, reason: capMessage(indexed.name, full), lowest: full.lowest }
}

// A Tool that left Draft belongs to the Tenant, so a write that takes it back to Draft must not take it into the session that made the write.
function tenantWide(provenance: Provenance, previous: ToolState): Provenance {
  return previous === "draft" ? provenance : { ...provenance, session: null }
}

// A Draft is the work of one session until it is Verified, and a call that names no session reaches every Draft.
export function assertReachable(tool: Tool, session: string | null): void {
  if (reachable({ state: tool.state, session: tool.provenance?.session ?? null }, session)) return
  throw new ToolError(
    "not_found",
    `The Tool ${JSON.stringify(tool.name)} is a Draft of another session, so this session cannot call or read it. A Draft leaves its session when its Held-out examples pass and it becomes Verified.`,
    { name: tool.name, state: "draft" },
  )
}

// The reads of one answer take the write queue together, so no caller ever sees two Versions of the same Tool.
function read<T>(context: MetaContext, action: (store: Store) => Promise<T>): Promise<T> {
  return context.library.queue.serialize(() => action(context.library.store))
}

// The gate runs outside the write queue: proving Examples is the slow part, and it holds no file and no lock.
async function prove(context: MetaContext, proving: Proving, body: string, examples: Example[]): Promise<Proved> {
  const store = context.library.store
  // The row is worked out and not written: a save the gate refuses must leave every decision this Library holds untouched.
  const asked = plannedApproval(store, proving, body, null, proving.session)
  // An Approval nobody has granted yet strips the Manifest for this run, so an Example that needs it is deferred, not refused.
  const waiting = asked !== undefined && asked.status !== "approved"
  const granting = grantedRun(store, proving, body)
  // The engine the run really needs, which is the container only once the Manifest that asks for it is granted.
  if (granting.tier === "container") {
    const refused = context.container.unavailable(proving.name)
    if (refused !== undefined) throw refused
  }
  const proved = await proveExamples(
    context.library.engine,
    context.limits,
    { ...proving, ...granting },
    body,
    examples,
    waiting,
  )
  const deferred = proved.flatMap((one, index) => (one.status === "deferred" ? [index] : []))
  return { examples: proved, deferred, advice: deferred.length === 0 || asked === undefined ? null : deferredAdvice(asked, deferred) }
}

interface Proved {
  examples: Example[]
  deferred: number[]
  advice: string | null
}

// The reservation a create holds, and the refusal a second create of the name reads. Both take one turn of the write queue.
function reserveName(context: MetaContext, name: string): () => void {
  const key = name.toLowerCase()
  const held = context.library.store.get(name)
  if (held !== undefined) throw taken(context, held.name)
  if (context.library.creating.has(key)) throw taken(context, name)
  context.library.creating.add(key)
  return () => context.library.creating.delete(key)
}

function taken(context: MetaContext, name: string): ToolError {
  return new ToolError(
    "exists",
    `The ${context.library.kind} Library already holds a Tool named ${JSON.stringify(name)}. Read it with tool_read and update it, or choose another name.`,
    { name, library: context.library.kind },
  )
}

async function save(
  context: MetaContext,
  record: ToolRecord,
  operation: Operation,
  downgraded: string | null = null,
): Promise<string> {
  return context.library.queue.serialize(async () => {
    const store = context.library.store
    // The Library may have taken the name since the reservation, through a pull or a hand-edited directory, and a create never overwrites.
    if (operation === "create" && store.get(record.tool.name) !== undefined) throw taken(context, record.tool.name)
    const written = await store.write(record, operation)
    store.upsert({ ...record.tool, downgraded })
    store.setDigest(record.tool.name, written.digest, written.version)
    // A Version with a pair this Library has not decided on asks for one; an unchanged Manifest and Body keep their decision.
    requestApproval(store, record.tool, record.body, written.version, record.tool.provenance.session)
    return written.version
  })
}

function approvalView(context: MetaContext, tool: Tool, body: string): JsonValue {
  const approval = liveApproval(context.library.store, tool, body)
  if (approval === undefined) return null
  return {
    id: approval.id,
    status: approval.status,
    summary: approval.summary,
    decided_by: approval.decidedBy,
    decided_at: approval.decidedAt,
    note: approval.note,
  }
}

function parseManifest(value: unknown): JsonValue {
  if (value === undefined) return {}
  if (typeof value !== "string") {
    throw new ToolError("invalid_manifest", "manifest_json must be the Manifest written as a JSON string.", {
      received: typeof value,
    })
  }
  try {
    return JSON.parse(value) as JsonValue
  } catch (cause) {
    throw new ToolError(
      "invalid_manifest",
      `manifest_json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      {},
    )
  }
}

function elsewhere(context: MetaContext, name: string): LibraryKind | undefined {
  return (above(context, name) ?? below(context, name))?.kind
}

function above(context: MetaContext, name: string): OpenLibrary | undefined {
  return holder(context.libraries.slice(0, context.libraries.indexOf(context.library)), name)
}

function below(context: MetaContext, name: string): OpenLibrary | undefined {
  return holder(context.libraries.slice(context.libraries.indexOf(context.library) + 1), name)
}

function otherTool(library: OpenLibrary, name: string): JsonValue {
  return { library: library.kind, description: library.store.get(name)?.description ?? null }
}

export function missing(name: string): ToolError {
  return new ToolError(
    "not_found",
    `There is no Tool named ${JSON.stringify(name)} in the Library. Write it with tool_create.`,
    { name },
  )
}

export function retired(name: string, other?: LibraryKind): ToolError {
  return new ToolError(
    "not_found",
    `The Tool ${JSON.stringify(name)} is Retired, so it cannot be called or changed. Call tool_history to list its Versions, then tool_update with restore_version to bring it back.${elsewhereClause(name, other)}`,
    { name, state: "retired", ...(other === undefined ? {} : { library: other }) },
  )
}

// A Retired or broken Tool still shadows the other Library, so the message has to say where the working Tool is.
export function elsewhereClause(name: string, other: LibraryKind | undefined): string {
  if (other === undefined) return ""
  return ` The ${other} Library holds a Tool named ${JSON.stringify(name)} as well; reach it with meta.library ${JSON.stringify(other)}.`
}

function resolveTool(context: MetaContext, name: JsonValue | undefined): IndexedTool {
  const requested = assertToolName(name)
  if (META_TOOL_NAMES.has(requested)) {
    throw new ToolError(
      "not_found",
      `${requested} is one of flintd's own meta tools, not a Tool in the Library, so it has no entry of its own. Call it directly.`,
      { name: requested },
    )
  }
  const indexed = context.library.store.get(requested)
  if (indexed === undefined) throw missing(requested)
  return indexed
}

// The Channel is the Provenance a reviewer trusts, so no caller writes one: flintd writes the observer, file and flintd Channels itself.
function provenanceOf(meta: CallMeta, channel: Channel | undefined): Provenance {
  const asserted = (meta as { channel?: unknown }).channel
  if (asserted !== undefined) {
    throw new ToolError(
      "invalid_arguments",
      `The call meta carries a channel of ${JSON.stringify(String(asserted))}, and a caller does not choose the Channel. Leave it out: a write a caller makes is the agent Channel.`,
      { channel: String(asserted) },
    )
  }
  return {
    channel: channel ?? "agent",
    session: metaText(meta.sessionId, "sessionId"),
    harness: metaText(meta.harness, "harness"),
    model: metaText(meta.model, "model"),
    excerpt: cap(metaText(meta.excerpt, "excerpt")),
    createdAt: new Date().toISOString(),
  }
}

export function metaText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") {
    throw new ToolError("invalid_arguments", `The call meta field ${field} must be a string.`, { field })
  }
  return value
}

// A Provenance excerpt is a piece of a conversation, and a conversation can quote a credential back.
function cap(excerpt: string | null): string | null {
  return excerpt === null ? null : capBytes(redact(excerpt), MAX_EXCERPT_BYTES)
}

function problem(cause: unknown): ToolError {
  return cause instanceof ToolError
    ? cause
    : new ToolError("store_error", "The Library could not read that Version.", { reason: String(cause) })
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue)
}

function resultSchema(value: unknown): JsonSchema | undefined {
  return value === undefined ? undefined : assertResultSchema(parseSchema(value, "result_json"))
}

// A model that sends the schema itself has said the same thing as one that sends its JSON text, and one that
// wrote that text twice has quoted it once too often. Both read; anything else is refused with the form to send.
function parseSchema(value: unknown, field: string): JsonValue {
  if (isPlainObject(value)) return value
  if (typeof value !== "string") {
    throw new ToolError(
      "invalid_schema",
      `${field} is ${describeValue(value)}. Send the JSON Schema object itself, for example {"type": "object", "properties": {}}, or that object written as a JSON string.`,
      { received: typeof value },
    )
  }
  const parsed = readSchemaText(value, field)
  return typeof parsed === "string" ? readSchemaText(parsed, field) : parsed
}

function readSchemaText(text: string, field: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch (cause) {
    throw new ToolError(
      "invalid_schema",
      `${field} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}. Send the JSON Schema object itself, for example {"type": "string"}, or that object written as a JSON string.`,
      {},
    )
  }
}
