import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { approvalKey, assertApproved, granted } from "./approvals.ts"
import { assertBundle } from "./bundle.ts"
import { flintdHome, openConnections } from "./connections.ts"
import type { ConnectionStore } from "./connections.ts"
import { assertContainerEngine, assertContainerImage, createContainerTier } from "./container-tier.ts"
import { ToolError, causeMessage } from "./errors.ts"
import { formatTools } from "./formats.ts"
import { WARM_NODE_RUNNERS } from "./engine.ts"
import type { CallChain, EngineOptions } from "./engine.ts"
import { proveExamples } from "./gate.ts"
import { createHeldOut } from "./held-out.ts"
import { createModelAdapter, isModelAdapter } from "./model.ts"
import type { ModelAdapter } from "./model.ts"
import {
  broken,
  callable,
  holder,
  named,
  openLibrary,
  pushLibrary,
  pushSettled,
  review,
  summary,
  whileProving,
  winners,
} from "./library.ts"
import type { Closable, LibraryPlan, OpenLibrary } from "./library.ts"
import {
  META_TOOLS,
  META_TOOL_NAMES,
  assertReachable,
  callMetaTool,
  elsewhereClause,
  metaText,
  metaTool,
  missing,
  retired,
} from "./meta-tools.ts"
import type { MetaContext } from "./meta-tools.ts"
import {
  DEFAULT_ACTIVE_CAP,
  DEFAULT_ACTIVE_LIST_LIMIT,
  actives,
  capFull,
  capMessage,
  earned,
  promote,
} from "./promotion.ts"
import { assertTier } from "./manifest.ts"
import { assertObservation, assertObservationQuery } from "./observations.ts"
import { DEFAULT_OBSERVER_TIMEOUT_MS, createObserver } from "./observer.ts"
import type { ExecutionLimits } from "./quickjs.ts"
import {
  DEFAULT_DUPLICATE_BAND,
  DEFAULT_DUPLICATE_COSINE,
  DEFAULT_DUPLICATE_COSINE_BAND,
  DEFAULT_DUPLICATE_JACCARD,
  DEFAULT_DUPLICATE_MAX_JUDGMENTS,
  DEFAULT_FIND_LIMIT,
  DEFAULT_SEARCH_COSINE,
  DEFAULT_SIBLING_COSINE,
  DEFAULT_SIBLING_JACCARD,
  DEFAULT_STOP_GRACE_MS,
  createSearch,
} from "./search.ts"
import { forgetSecret, redact, rememberSecret } from "./redact.ts"
import { assertToolName, capBytes, isPlainObject, patternsOf, validateArguments } from "./validate.ts"
import type {
  Approval,
  ApprovalDecision,
  ApprovalEntry,
  ApprovalStatus,
  CallMeta,
  CallOutcome,
  CallReport,
  CallResult,
  Channel,
  Connections,
  FindEntry,
  Flint,
  FlintOptions,
  FlintStatus,
  JsonSchema,
  JsonValue,
  LibraryEntry,
  LibraryKind,
  LogEntry,
  Manifest,
  ModelStatus,
  Observation,
  ObservationInput,
  ObservationQuery,
  Observer,
  ObserverRun,
  RetirementProposal,
  Tool,
  ToolDefinition,
  ToolErrorCode,
  ToolFormat,
  ToolFormats,
} from "./types.ts"

const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ARGS_BYTES = 1_000_000
const DEFAULT_MAX_RESULT_BYTES = 1_000_000
const DEFAULT_MAX_BODY_BYTES = 256 * 1024
const DEFAULT_MAX_FETCH_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_CALL_DEPTH = 8
const DEFAULT_MAX_LOG_LINES = 200
const DEFAULT_MAX_LOG_BYTES = 1024
const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const CONNECTIONS_FILE = "connections.json"
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_EXEC_BYTES = 1024 * 1024
// A container starts a whole Node runtime and then runs commands in it, so the tier's own clock is minutes.
const DEFAULT_CONTAINER_TIMEOUT_MS = 300_000
const TERMINATE_GRACE_MS = 500
const DEFAULT_SYNC_TIMEOUT_MS = 10_000
const DEFAULT_MODEL_TIMEOUT_MS = 60_000
const DEFAULT_HELD_OUT_TIMEOUT_MS = 300_000
const DEFAULT_HELD_OUT_CONCURRENCY = 2
const DEFAULT_OBSERVER_REPEATS = 3
const DEFAULT_OBSERVER_WINDOW_DAYS = 7
const DEFAULT_OBSERVER_MAX_CANDIDATES = 5
const DEFAULT_RETIRE_CONTRIBUTION = -0.1
const DEFAULT_RETIRE_MIN_CALLS = 100
const DEFAULT_RETIRE_IDLE_DAYS = 30
const MAX_NOTE_BYTES = 1024
const OUTCOMES: readonly CallOutcome[] = ["positive", "negative"]
const LIBRARY_KINDS: readonly LibraryKind[] = ["user", "project"]
const WRITING_META_TOOLS = new Set(["tool_create", "tool_update", "tool_retire"])

export { ToolError } from "./errors.ts"
export { flintdHome } from "./connections.ts"
export { createModelAdapter } from "./model.ts"
export { DEFAULT_OBSERVER_TIMEOUT_MS } from "./observer.ts"
export type { ModelAdapter, ModelMessage, ModelRequest } from "./model.ts"
export { manifestHash } from "./manifest.ts"
export { META_TOOL_NAMES } from "./meta-tools.ts"
export { isToolName } from "./validate.ts"
export { EXPORT_PREFIX, callFrom, exportName, formatTools, libraryName } from "./formats.ts"
export { TEACHING_SKILL, renderSkill, renderTeachingSkill, skillName } from "./skill.ts"
export { CONTAINER_ENGINES, OBSERVATION_STATUSES, TOOL_ERROR_CODES, TOOL_STATES } from "./types.ts"
export type * from "./types.ts"

export function createFlint(options: FlintOptions): Flint {
  const plans = plan(options, limit("syncTimeoutMs", options.syncTimeoutMs, DEFAULT_SYNC_TIMEOUT_MS))
  const timeoutMs = limit("callTimeoutMs", options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS)
  const limits: ExecutionLimits = {
    timeoutMs,
    // The tier stops a Body at the call timeout on its own; this is when the main thread gives up on the Worker itself.
    terminateAfterMs: limit("terminateAfterMs", options.terminateAfterMs, timeoutMs + TERMINATE_GRACE_MS),
    maxArgsBytes: limit("maxArgsBytes", options.maxArgsBytes, DEFAULT_MAX_ARGS_BYTES),
    maxResultBytes: limit("maxResultBytes", options.maxResultBytes, DEFAULT_MAX_RESULT_BYTES),
    maxBodyBytes: limit("maxBodyBytes", options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    maxFetchBytes: limit("maxFetchBytes", options.maxFetchBytes, DEFAULT_MAX_FETCH_BYTES),
    fetchTimeoutMs: limit("fetchTimeoutMs", options.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS),
    maxLogLines: limit("maxLogLines", options.maxLogLines, DEFAULT_MAX_LOG_LINES),
    maxLogBytes: limit("maxLogBytes", options.maxLogBytes, DEFAULT_MAX_LOG_BYTES),
    memoryLimitBytes: limit("memoryLimitBytes", options.memoryLimitBytes, DEFAULT_MEMORY_LIMIT_BYTES),
    maxExecBytes: limit("maxExecBytes", options.maxExecBytes, DEFAULT_MAX_EXEC_BYTES),
  }

  const container = createContainerTier({
    engine: assertContainerEngine(options.containerEngine),
    image: assertContainerImage(options.containerImage),
    timeoutMs: limit("containerTimeoutMs", options.containerTimeoutMs, DEFAULT_CONTAINER_TIMEOUT_MS),
  })

  const maxCallDepth = limit("maxCallDepth", options.maxCallDepth, DEFAULT_MAX_CALL_DEPTH)
  const clock = assertClock(options.clock)

  // Every line flintd writes leaves through this one, so no credential reaches a log whatever wrote it.
  function onLog(entry: LogEntry): void {
    options.onLog?.({ tool: entry.tool, callId: entry.callId, message: redact(entry.message) })
  }

  const adapter: ModelAdapter | undefined =
    options.model === undefined
      ? undefined
      : isModelAdapter(options.model)
        ? options.model
        : createModelAdapter(options.model, limit("modelTimeoutMs", options.modelTimeoutMs, DEFAULT_MODEL_TIMEOUT_MS))
  const activeCap = limit("activeCap", options.activeCap, DEFAULT_ACTIVE_CAP)
  const activeListLimit = limit("activeListLimit", options.activeListLimit, DEFAULT_ACTIVE_LIST_LIMIT)
  const stopGraceMs = limit("stopGraceMs", options.stopGraceMs, DEFAULT_STOP_GRACE_MS)
  const search = createSearch(
    {
      findLimit: limit("findLimit", options.findLimit, DEFAULT_FIND_LIMIT),
      duplicateJaccard: fraction("duplicateThreshold", options.duplicateThreshold, DEFAULT_DUPLICATE_JACCARD),
      duplicateBand: fraction("duplicateBand", options.duplicateBand, DEFAULT_DUPLICATE_BAND),
      duplicateCosine: fraction("duplicateCosine", options.duplicateCosine, DEFAULT_DUPLICATE_COSINE),
      duplicateCosineBand: fraction("duplicateCosineBand", options.duplicateCosineBand, DEFAULT_DUPLICATE_COSINE_BAND),
      duplicateMaxJudgments: limit("duplicateMaxJudgments", options.duplicateMaxJudgments, DEFAULT_DUPLICATE_MAX_JUDGMENTS),
      siblingJaccard: fraction("siblingThreshold", options.siblingThreshold, DEFAULT_SIBLING_JACCARD),
      siblingCosine: fraction("siblingCosine", options.siblingCosine, DEFAULT_SIBLING_COSINE),
      searchCosine: fraction("searchCosine", options.searchCosine, DEFAULT_SEARCH_COSINE),
      stopGraceMs,
    },
    adapter,
    onLog,
  )
  const heldOut = createHeldOut(
    adapter,
    limits,
    limit("heldOutTimeoutMs", options.heldOutTimeoutMs, DEFAULT_HELD_OUT_TIMEOUT_MS),
    limit("heldOutConcurrency", options.heldOutConcurrency, DEFAULT_HELD_OUT_CONCURRENCY),
    stopGraceMs,
    onLog,
  )

  const observer = createObserver({
    adapter,
    limits: {
      repeats: limit("observerRepeats", options.observerRepeats, DEFAULT_OBSERVER_REPEATS),
      windowDays: limit("observerWindowDays", options.observerWindowDays, DEFAULT_OBSERVER_WINDOW_DAYS),
      timeoutMs: limit("observerTimeoutMs", options.observerTimeoutMs, DEFAULT_OBSERVER_TIMEOUT_MS),
      maxCandidates: limit("observerMaxCandidates", options.observerMaxCandidates, DEFAULT_OBSERVER_MAX_CANDIDATES),
      retireContribution: score("retireContribution", options.retireContribution, DEFAULT_RETIRE_CONTRIBUTION),
      retireMinCalls: limit("retireMinCalls", options.retireMinCalls, DEFAULT_RETIRE_MIN_CALLS),
      retireIdleDays: limit("retireIdleDays", options.retireIdleDays, DEFAULT_RETIRE_IDLE_DAYS),
    },
    stopGraceMs,
    libraries: () => libraries,
    // Consent is read at every run, so an operator who turns transcripts off is obeyed at the next one.
    consented: () => assertHarnessNames(options.transcriptHarnesses),
    // A proposal is a create like any other: the same gate, the same duplicate refusal, one Channel apart.
    create: (args, provenance) =>
      invoke(
        "tool_create",
        args,
        {
          sessionId: provenance.session,
          excerpt: provenance.excerpt,
          ...(provenance.harness === null ? {} : { harness: provenance.harness }),
          ...(adapter === undefined ? {} : { model: adapter.model }),
        },
        "observer",
      ).then((done) => done.result),
    clock,
    onLog,
  })

  // createModelAdapter remembers the key it is given, so a stop has to put it down again the way a Connection does.
  const modelKey = options.model === undefined || isModelAdapter(options.model) ? undefined : options.model.apiKey
  let holdsModelKey = modelKey !== undefined

  const connectionsFile = options.connectionsFile ?? join(flintdHome(), CONNECTIONS_FILE)
  let connections: ConnectionStore | undefined
  function heldConnections(): Connections {
    if (connections === undefined) {
      throw new ToolError("internal_error", "flintd is not started. Call start() before connections.list().")
    }
    return connections
  }
  const engineOptions: Omit<EngineOptions, "libraryDir"> = {
    container,
    // 0 is a fresh child for every call: the strictest setting the Node tier has, and the slowest.
    warmNodeRunners: limit("warmNodeRunners", options.warmNodeRunners, WARM_NODE_RUNNERS, 0),
    connections: () => connections?.all() ?? [],
    // A Body composes through the same door a caller uses: validation, Approval, tier, stats and a call record.
    callTool: async (argument, from, expiresAt) => {
      const asked = callToolArgument(argument)
      const meta: CallMeta = {}
      if (from.session !== null) meta.sessionId = from.session
      if (from.harness !== null) meta.harness = from.harness
      return (await runTool(asked.name, asked.args, meta, { chain: from, expiresAt })).result
    },
    onLog,
  }
  // One process asks about one pending Approval once, so a write that touches a Tool never asks the same question twice.
  const asked = new Set<string>()
  let open: Closable[] = []
  let libraries: OpenLibrary[] = []
  let opening: Promise<void> | undefined
  let stopping = false
  // A write in flight at stop() is finished, because half a write is worth nothing; a call is cut and refused.
  const writing = new Set<Promise<unknown>>()
  const calling = new Set<Promise<unknown>>()

  const watchers = new Set<() => void>()
  const waiting = new Set<(request: ApprovalEntry) => void>()
  let listed = ""

  function tracked<T>(held: Set<Promise<unknown>>, work: Promise<T>): Promise<T> {
    const done = work.then(
      () => undefined,
      () => undefined,
    )
    held.add(done)
    void done.then(() => {
      held.delete(done)
      if (held === writing) announce()
    })
    return work
  }

  // The model-facing list is the whole of what a watcher can see, so its own text decides whether it changed.
  function announce(): void {
    if (watchers.size === 0 || libraries.length === 0 || stopping) return
    const now = JSON.stringify(toolList())
    if (now === listed) return
    listed = now
    for (const watcher of watchers) {
      try {
        watcher()
      } catch (cause) {
        onLog({ tool: "flintd", callId: null, message: `a tool list watcher threw: ${causeMessage(cause)}` })
      }
    }
  }

  function toolList(): ToolDefinition[] {
    return [
      ...META_TOOLS.map((tool) => ({ ...tool })),
      ...actives(libraries)
        .slice(0, activeListLimit)
        .map(({ tool }) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.result === undefined ? {} : { result: tool.result }),
        })),
    ]
  }

  async function quiet(held: Set<Promise<unknown>>): Promise<void> {
    while (held.size > 0) await Promise.all([...held])
  }

  function started(): void {
    if (libraries.length === 0 || stopping) {
      throw new ToolError("internal_error", "flintd is not started. Call start() before tools() or call().")
    }
  }

  function pick(name: string | undefined, meta: CallMeta): OpenLibrary {
    if (meta.library !== undefined) return named(libraries, assertLibraryKind(meta.library))
    return (name === undefined ? undefined : holder(libraries, name)) ?? (libraries[0] as OpenLibrary)
  }

  // A called Tool runs inside the caller's clock: what is left of it is the whole of the callee's own timeout.
  function nestedLimits(requested: string, from: Nested): ExecutionLimits {
    const left = from.expiresAt - Date.now()
    if (left <= 0) {
      throw new ToolError(
        "timeout",
        `${[...from.chain.names, requested].join(" -> ")} ran out of time before ${requested} could start. Give the Tool that started the chain more time, or call fewer Tools from it.`,
        { tool: requested, chain: [...from.chain.names, requested] },
      )
    }
    return { ...limits, timeoutMs: left, terminateAfterMs: left + TERMINATE_GRACE_MS }
  }

  async function runTool(name: unknown, args: unknown, meta: CallMeta, from?: Nested): Promise<CallResult> {
    started()
    const requested = assertToolName(name)
    if (META_TOOL_NAMES.has(requested)) {
      throw new ToolError(
        "not_found",
        `${requested} is one of flintd's own meta tools. Call it directly rather than through tool_run.`,
        { name: requested },
      )
    }
    if (from !== undefined) assertComposable(requested, from.chain, maxCallDepth)
    const bounds = from === undefined ? limits : nestedLimits(requested, from)
    const library = pick(requested, meta)
    const other = holder(
      libraries.filter((one) => one !== library),
      requested,
    )?.kind
    const unusable = broken(library, requested)
    if (unusable !== undefined) {
      throw new ToolError(
        unusable.code,
        `${unusable.message} The directory tools/${unusable.name} does not match a Version, so the Tool cannot run. Fix the files, or call tool_history and bring an earlier Version back with tool_update.${elsewhereClause(unusable.name, other)}`,
        { name: unusable.name, library: library.kind },
      )
    }
    const indexed = library.store.get(requested)
    if (indexed === undefined) throw missing(requested)
    if (indexed.state === "retired") throw retired(indexed.name, other)
    const caller = callerOf(meta)
    const read = async (): Promise<{ tool: Tool; body: string }> => {
      const tool = await library.store.readTool(indexed.name)
      assertReachable(tool, caller.session)
      const problems = validateArguments(tool.parameters, args)
      if (problems.length > 0) throw invalidArguments(indexed.name, problems)
      const body = await library.store.readBody(indexed.name)
      assertApproved(library.store, tool, body)
      return { tool, body }
    }
    // A turn that is proving Examples runs a Body and writes nothing until it settles, so a Tool that turn called reads the Library without a turn of its own.
    const held = library.proving > 0 ? await read() : await library.queue.serialize(read)
    const id = randomUUID()
    const began = clock()
    try {
      const result = await library.engine.run(
        {
          toolName: indexed.name,
          body: held.body,
          args: args as JsonValue,
          manifest: held.tool.manifest,
          tier: assertTier(held.tool.tier, indexed.name),
          limits: bounds,
          ...patternsOf(held.tool.parameters, held.tool.result),
        },
        {
          // The Body runs with the Manifest a person approved, so a decision taken back mid-call stops the next host call.
          stillApproved: () => granted(library.store, held.tool, held.body),
          chain: {
            callId: id,
            names: [...(from?.chain.names ?? []), indexed.name],
            depth: from === undefined ? 0 : from.chain.depth + 1,
            session: caller.session,
            harness: caller.harness,
          },
        },
      )
      assertResult(indexed.name, held.tool.result, result)
      record(library, id, indexed.name, indexed.version, caller, began, null, from?.chain.callId ?? null)
      await advance(library, indexed.name)
      return { id, result }
    } catch (cause) {
      record(library, id, indexed.name, indexed.version, caller, began, codeOf(cause), from?.chain.callId ?? null)
      // The call a harness most wants to report on is the one that failed, so the refusal carries its id.
      throw cause instanceof ToolError ? new ToolError(cause.code, cause.message, { ...cause.details, callId: id }) : cause
    }
  }

  function record(
    library: OpenLibrary,
    id: string,
    name: string,
    version: string | null,
    caller: Caller,
    began: number,
    errorCode: ToolErrorCode | null,
    parentCallId: string | null,
  ): void {
    try {
      library.store.recordCall({
        id,
        name,
        version,
        session: caller.session,
        harness: caller.harness,
        durationMs: clock() - began,
        errorCode,
        parentCallId,
        inputTokens: caller.tokens.input,
        outputTokens: caller.tokens.output,
        at: new Date(clock()).toISOString(),
      })
    } catch (cause) {
      // An index that refuses the record must not take the result of a call that worked away from the caller.
      onLog({ tool: name, callId: id, message: `the call was not recorded: ${causeMessage(cause)}` })
    }
    // A call moves the Contribution, which is the order of the list, so a call can push a Tool over the list limit.
    announce()
  }

  // What `earned` counts buys a place in the default list; the cap decides whether there is one to take.
  async function advance(library: OpenLibrary, name: string): Promise<void> {
    if (library.store.get(name)?.state !== "verified" || !earned(library, name)) return
    const done = await tracked(writing, promote(libraries, library, name, activeCap)).catch((cause: unknown) => {
      onLog({ tool: name, callId: null, message: `the promotion to Active did not finish: ${causeMessage(cause)}` })
      return "unchanged" as const
    })
    const full = done === "blocked" ? capFull(libraries, activeCap) : undefined
    if (full !== undefined) onLog({ tool: name, callId: null, message: capMessage(name, full) })
  }

  async function invoke(name: string, args: unknown, meta: CallMeta, channel?: Channel): Promise<CallResult> {
    started()
    const definition = metaTool(name)
    if (definition === undefined) return tracked(calling, runTool(name, args, meta))
    const problems = validateArguments(definition.parameters, args)
    if (problems.length > 0) throw invalidArguments(definition.name, problems)
    const written = (args as { name?: unknown }).name
    const library = pick(
      definition.name === "tool_create" || typeof written !== "string" ? undefined : written,
      meta,
    )
    const context: MetaContext = {
      library,
      libraries,
      limits,
      container,
      modelConfigured: heldOut.configured,
      ...(channel === undefined ? {} : { channel }),
      activeCap,
      search,
      runTool,
      verify: (written, version) => heldOut.start(library, written, version),
    }
    const writes = WRITING_META_TOOLS.has(definition.name)
    const result = await tracked(
      writes ? writing : calling,
      callMetaTool(context, definition, args as { [key: string]: JsonValue }, meta),
    )
    if (writes) {
      library.invalid = library.invalid.filter((entry) => entry.name !== written)
      search.refresh(library)
      askApprovals(library)
      // The push runs beside the queue, never in it: a remote that hangs must not hold up the next call for a Body.
      void pushLibrary(library)
    }
    return { id: context.ran ?? null, result }
  }

  function entries(): ApprovalEntry[] {
    return libraries.flatMap((library) =>
      library.store.approvals().map((approval) => ({ ...approval, library: library.kind })),
    )
  }

  function findApproval(id: string): { library: OpenLibrary; approval: Approval } {
    for (const library of libraries) {
      const approval = library.store.approvalById(id)
      if (approval !== undefined) return { library, approval }
    }
    throw new ToolError(
      "not_found",
      `This flintd holds no Approval with the id ${JSON.stringify(id)}. Call approvals() to list the ones that are waiting.`,
      { id },
    )
  }

  // The grant and the run that earns it are one turn of the write queue, so no call is served by a Body nothing proved with what it was granted.
  async function settle(
    library: OpenLibrary,
    id: string,
    status: ApprovalStatus,
    note: string | null,
  ): Promise<{ decided: Approval; failed: string | null }> {
    const store = library.store
    const approval = store.approvalById(id)
    if (approval === undefined) throw new ToolError("not_found", `The Approval ${JSON.stringify(id)} is gone.`, { id })
    // A second approve on a granted Manifest reruns nothing: it is the decision that grants which has to prove.
    const granting = status === "approved" && approval.status !== "approved"
    const indexed = granting ? store.get(approval.tool) : undefined
    if (indexed !== undefined) {
      const tool = await store.readTool(approval.tool)
      const body = await store.readBody(approval.tool)
      const examples = await store.readExamples(approval.tool)
      const version = await store.currentVersion(approval.tool)
      // The decision is about the pair a person read. A Body swapped since then would run here with the Manifest in force.
      const declared = approvalKey(tool.manifest, body)
      if (declared.manifestHash !== approval.manifestHash || declared.bodyDigest !== approval.bodyDigest) {
        throw new ToolError(
          "not_found",
          `The Tool ${JSON.stringify(approval.tool)} changed since this Approval was raised, so flintd ran nothing for it. Call approvals() and decide the one it asks for now.`,
          { id, tool: approval.tool },
        )
      }
      try {
        await whileProving(library, () =>
          proveExamples(
            library.engine,
            limits,
            {
              name: approval.tool,
              parameters: tool.parameters,
              ...(tool.result === undefined ? {} : { result: tool.result }),
              manifest: tool.manifest,
              tier: tool.tier,
              session: null,
            },
            body,
            examples,
          ),
        )
      } catch (cause) {
        const reason = causeMessage(cause)
        return { decided: store.decideApproval(id, "pending", "flintd", reason) ?? approval, failed: reason }
      }
      const decided = store.decideApproval(id, status, "operator", note)
      // The evidence that takes a Tool out of Draft now rests on a Body that ran with what it was granted.
      if (version !== null) heldOut.start(library, approval.tool, version)
      return { decided: decided ?? approval, failed: null }
    }
    return { decided: store.decideApproval(id, status, "operator", note) ?? approval, failed: null }
  }

  // An Approval is the human path to Active, so granting one takes a Verified Tool the rest of the way.
  async function decide(id: string, status: ApprovalStatus, note: string | undefined): Promise<ApprovalDecision> {
    started()
    const { library } = findApproval(assertApprovalId(id))
    const written = note === undefined ? null : capBytes(assertNote(note), MAX_NOTE_BYTES)
    asked.add(id)
    const { decided, failed } = await tracked(writing, library.queue.serialize(() => settle(library, id, status, written)))
    if (failed !== null) {
      return {
        ...decided,
        library: library.kind,
        promotion: "unchanged",
        message: `The Examples of ${JSON.stringify(decided.tool)} did not pass with the Manifest granted, so the grant is not in force: ${failed}`,
      }
    }
    if (status !== "approved" || library.store.get(decided.tool)?.state !== "verified") {
      return { ...decided, library: library.kind, promotion: "unchanged", message: null }
    }
    const promotion = await tracked(writing, promote(libraries, library, decided.tool, activeCap))
    const full = promotion === "blocked" ? capFull(libraries, activeCap) : undefined
    return {
      ...decided,
      library: library.kind,
      promotion,
      message: full === undefined ? null : capMessage(decided.tool, full),
    }
  }

  // The channel is asked once per Approval and never waited on: a person decides in their own time, and until they do, every call to the Tool is refused.
  function askApprovals(library: OpenLibrary): void {
    const ask = options.onApproval
    if (ask === undefined && waiting.size === 0) return
    for (const approval of library.store.approvals()) {
      if (approval.status !== "pending" || asked.has(approval.id)) continue
      asked.add(approval.id)
      const request: ApprovalEntry = { ...approval, library: library.kind }
      for (const watcher of waiting) {
        try {
          watcher(request)
        } catch (cause) {
          onLog({ tool: approval.tool, callId: null, message: `an Approval watcher threw: ${causeMessage(cause)}` })
        }
      }
      if (ask === undefined) continue
      void tracked(writing, answer(ask, request)).catch((cause: unknown) => {
        onLog({ tool: approval.tool, callId: null, message: `the Approval channel did not answer: ${causeMessage(cause)}` })
      })
    }
  }

  async function answer(
    ask: NonNullable<FlintOptions["onApproval"]>,
    request: ApprovalEntry,
  ): Promise<void> {
    const said = await ask(request)
    if (said === "approve" || said === "deny") await decide(request.id, said === "approve" ? "approved" : "denied", undefined)
  }

  async function openAll(): Promise<void> {
    // The adapter remembered the key when it was built; this puts it back after a stop, so the two stay in step.
    if (modelKey !== undefined && !holdsModelKey) {
      rememberSecret(modelKey)
      holdsModelKey = true
    }
    // The engine is a fact about the machine, so it is looked for once and every Library then knows what it has.
    await container.detect()
    connections = await openConnections(connectionsFile, options.connections ?? [])
    // The Libraries open together: each one may wait on its own remote, and one dead remote must not pay for the other.
    const settledOpens = await Promise.allSettled(plans.map((one) => openLibrary(one, engineOptions, limits)))
    const opened = settledOpens.flatMap((one) => (one.status === "fulfilled" ? [one.value] : []))
    const failed = settledOpens.find((one) => one.status === "rejected")
    if (failed !== undefined) {
      for (const one of opened) await one.close()
      throw failed.reason
    }
    open = opened
    libraries = opened.map((one) => one.library)
  }

  function tools(): Promise<ToolDefinition[]>
  function tools<F extends ToolFormat>(format: F): Promise<ToolFormats[F]>
  async function tools(format?: ToolFormat): Promise<unknown> {
    started()
    const list = toolList()
    if (format === undefined) return list
    // The MCP shape reads a Tool's Manifest for its annotations, and a Manifest nobody read would read as read-only.
    if (format === "mcp") return formatTools(list, "mcp", manifests())
    return formatTools(list, format)
  }

  function manifests(): ReadonlyMap<string, Manifest> {
    return new Map(actives(libraries).map(({ tool }) => [tool.name, tool.manifest]))
  }

  return {
    async start(): Promise<void> {
      if (libraries.length > 0) return
      assertBundle()
      opening ??= openAll().finally(() => {
        opening = undefined
      })
      await opening
      // The file-channel gate has run by now, so every Draft that still waits for a Held-out run is one this finds.
      for (const library of libraries) {
        const moved = library.store.movedIndex
        if (moved !== null) {
          onLog({
            tool: "flintd",
            callId: null,
            message: `the ${library.kind} Library index did not open and was moved to ${moved}; flintd rebuilt it from the Library and from the Approvals it recorded`,
          })
        }
        heldOut.sweep(library)
        search.refresh(library)
        askApprovals(library)
      }
    },

    async stop(): Promise<void> {
      stopping = true
      // A stage that throws must not leave the Flint wedged mid-stop, so every later stage runs and the state is put back whatever happened.
      let failure: unknown
      const stage = async (work: () => Promise<void>): Promise<void> => {
        try {
          await work()
        } catch (cause) {
          failure ??= cause
        }
      }
      // The Observer goes first: it holds the model and it writes through the same queue everything below waits for.
      await stage(() => observer.settle())
      await stage(() => quiet(writing))
      // The Held-out runs come next: they hold the write queue and the executor, and both close below them.
      await stage(() => heldOut.settle())
      await stage(() => search.settle())
      // Then the executors: a Body still running settles at once, and its call still records on an open index.
      await stage(async () => void (await Promise.all(libraries.map((one) => one.engine.close()))))
      await stage(() => quiet(calling))
      await stage(async () => void (await Promise.all(libraries.map((one) => one.queue.settled()))))
      // The pushes drain together: two remotes that hang must cost one sync timeout, not two.
      await stage(async () => void (await Promise.all(libraries.map(pushSettled))))
      for (const one of open) await stage(() => one.close())
      connections?.close()
      connections = undefined
      if (modelKey !== undefined && holdsModelKey) {
        forgetSecret(modelKey)
        holdsModelKey = false
      }
      open = []
      libraries = []
      stopping = false
      if (failure !== undefined) throw failure
    },

    async status(): Promise<FlintStatus> {
      const visible = callable(libraries)
      return {
        running: libraries.length > 0 && !stopping,
        dir: libraries[0]?.store.dir ?? (plans[0] as LibraryPlan).dir,
        tools: visible.length,
        retired: winners(libraries).length - visible.length,
        active: actives(libraries).length,
        activeCap,
        invalid: libraries.flatMap((library) => library.invalid.map((entry) => ({ ...entry }))),
        review: review(libraries),
        model: modelStatus(adapter),
        tiers: { container: container.status() },
        libraries: libraries.map((library) => {
          const moved = library.store.movedIndex
          return moved === null ? summary(library) : { ...summary(library), movedIndex: moved }
        }),
        observer: observer.status(),
      }
    },

    async library(): Promise<LibraryEntry[]> {
      started()
      // The live rows only, so a decision about a Manifest and a Body the Tool no longer carries never reads as its own.
      const decided = new Map(entries().map((approval) => [`${approval.library}:${approval.tool.toLowerCase()}`, approval.status]))
      return winners(libraries).map(({ tool, library }) => ({
        name: tool.name,
        description: tool.description,
        state: tool.state,
        downgraded: tool.downgraded,
        calls: tool.calls,
        errors: tool.errors,
        lastCallAt: tool.lastCallAt,
        contribution: tool.contribution,
        library: library.kind,
        needs_review: tool.needs_review,
        tier: tool.tier,
        manifest: { ...tool.manifest },
        approval: decided.get(`${library.kind}:${tool.name.toLowerCase()}`) ?? null,
      }))
    },

    tools,

    onChange(watcher: () => void): () => void {
      if (watchers.size === 0 && libraries.length > 0 && !stopping) listed = JSON.stringify(toolList())
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },

    onApproval(watcher: (request: ApprovalEntry) => void): () => void {
      waiting.add(watcher)
      for (const library of libraries) askApprovals(library)
      return () => waiting.delete(watcher)
    },

    async find(query: string, limit?: number): Promise<FindEntry[]> {
      started()
      return search.find(libraries, query, limit, null)
    },

    async call(name: string, args: unknown, meta: CallMeta = {}): Promise<JsonValue> {
      return (await invoke(name, args, meta)).result
    },

    async callWithId(name: string, args: unknown, meta: CallMeta = {}): Promise<CallResult> {
      return invoke(name, args, meta)
    },

    async report(callId: string, outcome: CallOutcome, note?: string): Promise<CallReport> {
      started()
      const id = assertCallId(callId)
      const chosen = assertOutcome(outcome)
      const written = note === undefined ? null : capBytes(assertNote(note), MAX_NOTE_BYTES)
      for (const library of libraries) {
        const done = library.store.reportOutcome(id, chosen, written)
        if (done === undefined) continue
        announce()
        return { id, tool: done.name, library: library.kind, outcome: chosen, contribution: done.contribution }
      }
      throw new ToolError(
        "not_found",
        `This flintd holds no call with the id ${JSON.stringify(id)}. Report the id that came back with the call.`,
        { id },
      )
    },

    async approvals(): Promise<ApprovalEntry[]> {
      started()
      return entries()
    },

    // Every Observation of this Tenant lands in the user Library's index: a harness tool call belongs to no Library.
    async observe(input: ObservationInput): Promise<Observation> {
      started()
      const observation = assertObservation(input, new Date(clock()).toISOString())
      named(libraries, "user").store.recordObservation(observation)
      return observation
    },

    async observations(query?: ObservationQuery): Promise<Observation[]> {
      started()
      return named(libraries, "user").store.observations(assertObservationQuery(query ?? {}))
    },

    observer: {
      async run(asked?: { dryRun?: boolean }): Promise<ObserverRun> {
        started()
        return observer.run(asked?.dryRun === true)
      },
      async proposals(): Promise<RetirementProposal[]> {
        started()
        return observer.proposals()
      },
    } satisfies Observer,

    async approve(id: string, note?: string): Promise<ApprovalDecision> {
      return decide(id, "approved", note)
    },

    async deny(id: string, note?: string): Promise<ApprovalDecision> {
      return decide(id, "denied", note)
    },

    connections: {
      list: async () => heldConnections().list(),
      add: (connection) => heldConnections().add(connection),
      remove: (name) => heldConnections().remove(name),
    },
  }
}

function assertApprovalId(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > 100) {
    throw new ToolError("invalid_arguments", "An Approval decision needs the id of the Approval to decide.", {
      received: typeof value,
    })
  }
  return value
}

interface Caller {
  session: string | null
  harness: string | null
  tokens: { input: number | null; output: number | null }
}

// One call a Body asked for: the chain that reached the caller, and the end of the caller's own clock.
interface Nested {
  chain: CallChain
  expiresAt: number
}

// Both refusals name the chain, because the fix is always to the Tool that started it.
function assertComposable(requested: string, chain: CallChain, maxDepth: number): void {
  const named = [...chain.names, requested].join(" -> ")
  if (chain.names.some((one) => one.toLowerCase() === requested.toLowerCase())) {
    throw new ToolError(
      "recursive_call",
      `The Tool chain ${named} calls ${requested} again, and a Tool may appear once in a chain. Take the ctx.callTool out of the loop, or do the repeated work inside one Body.`,
      { chain: [...chain.names, requested], tool: requested },
    )
  }
  const reached = chain.names.length + 1
  if (reached > maxDepth) {
    throw new ToolError(
      "recursive_call",
      `The Tool chain ${named} is ${reached} Tools long and the limit is ${maxDepth}. Call fewer Tools from a Body, or do the work of the last few in one Tool.`,
      { chain: [...chain.names, requested], length: reached, maximum: maxDepth },
    )
  }
}

function callToolArgument(argument: JsonValue): { name: JsonValue; args: JsonValue } {
  if (!isPlainObject(argument)) {
    throw new ToolError(
      "invalid_arguments",
      'ctx.callTool takes the name of a Tool and its arguments: await ctx.callTool("other_tool", { ... }).',
      {},
    )
  }
  return { name: argument["name"] ?? null, args: argument["args"] ?? null }
}

function callerOf(meta: CallMeta): Caller {
  return {
    session: metaText(meta.sessionId, "sessionId"),
    harness: metaText(meta.harness, "harness"),
    tokens: { input: tokenCount(meta.tokens?.input, "input"), output: tokenCount(meta.tokens?.output, "output") },
  }
}

function tokenCount(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ToolError(
      "invalid_arguments",
      `The call meta field tokens.${field} must be a whole number of tokens, or be left out.`,
      { field },
    )
  }
  return value as number
}

function codeOf(cause: unknown): ToolErrorCode {
  return cause instanceof ToolError ? cause.code : "internal_error"
}

function assertCallId(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > 100) {
    throw new ToolError("invalid_arguments", "A report needs the call id that came back with the call.", {
      received: typeof value,
    })
  }
  return value
}

function assertOutcome(value: unknown): CallOutcome {
  if (!OUTCOMES.includes(value as CallOutcome)) {
    throw new ToolError(
      "invalid_arguments",
      `An outcome report is ${JSON.stringify("positive")} or ${JSON.stringify("negative")}, and this one is ${JSON.stringify(String(value))}.`,
      { outcome: String(value) },
    )
  }
  return value as CallOutcome
}

function assertNote(value: unknown): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_arguments", "The note of an outcome report must be a string.", { received: typeof value })
  }
  return value
}

// The key is never part of it: status() is read by the CLI, the REST surface and every client.
function modelStatus(adapter: ModelAdapter | undefined): ModelStatus {
  if (adapter === undefined) return { configured: false }
  return { configured: true, provider: adapter.provider, model: adapter.model }
}

function plan(options: FlintOptions, syncTimeoutMs: number): LibraryPlan[] {
  if (options.dir !== undefined && options.userDir !== undefined) {
    throw new ToolError("internal_error", "createFlint takes `dir` or `userDir`, not both. They name the same Library.")
  }
  const user = options.userDir ?? options.dir
  if (typeof user !== "string" || user.length === 0) {
    throw new ToolError("internal_error", "createFlint needs a `userDir`: the directory that holds the user Library.")
  }
  const plans: LibraryPlan[] = [{ kind: "user", dir: resolve(user), remote: options.userRemote, syncTimeoutMs }]
  if (options.projectDir === undefined) return plans
  if (typeof options.projectDir !== "string" || options.projectDir.length === 0) {
    throw new ToolError("internal_error", "`projectDir` is the directory that holds the project Library.")
  }
  const project = resolve(options.projectDir)
  if (project === plans[0]?.dir) {
    throw new ToolError("internal_error", "`projectDir` and `userDir` name one directory, and a Library holds one Tenant.")
  }
  // Precedence order: the project Library answers first, so its Tool shadows a user Tool of the same name.
  return [{ kind: "project", dir: project, remote: options.projectRemote, syncTimeoutMs }, ...plans]
}

function assertLibraryKind(value: unknown): LibraryKind {
  if (!LIBRARY_KINDS.includes(value as LibraryKind)) {
    throw new ToolError(
      "invalid_arguments",
      `The call meta carries a library of ${JSON.stringify(value)}. A Library is "user" or "project".`,
      { library: String(value) },
    )
  }
  return value as LibraryKind
}

// The call ledger reads the clock here and nowhere else, so a test can spread calls over calendar days.
function assertClock(given: (() => number) | undefined): () => number {
  if (given === undefined) return Date.now
  if (typeof given !== "function") {
    throw new ToolError("internal_error", "createFlint needs a function that answers milliseconds for `clock`.", {
      option: "clock",
    })
  }
  return given
}

function limit(option: string, given: number | undefined, fallback: number, least = 1): number {
  if (given === undefined) return fallback
  if (!Number.isSafeInteger(given) || given < least) {
    throw new ToolError("internal_error", `createFlint needs a whole number of at least ${least} for \`${option}\`.`, {
      option,
    })
  }
  return given
}

// A Contribution runs from -1 to 1, so the threshold that earns a retirement proposal is a number and not a fraction.
function score(option: string, given: number | undefined, fallback: number): number {
  if (given === undefined) return fallback
  if (typeof given !== "number" || !Number.isFinite(given) || given < -1 || given > 1) {
    throw new ToolError("internal_error", `createFlint needs a Contribution between -1 and 1 for \`${option}\`.`, {
      option,
    })
  }
  return given
}

function assertHarnessNames(option: FlintOptions["transcriptHarnesses"]): string[] {
  const given = typeof option === "function" ? option() : option
  if (given === undefined) return []
  if (!Array.isArray(given) || given.some((one) => typeof one !== "string" || one.trim() === "")) {
    throw new ToolError(
      "internal_error",
      "createFlint needs a list of harness names for `transcriptHarnesses`: the ones the operator said yes to.",
      { option: "transcriptHarnesses" },
    )
  }
  return given.map((one) => one.trim())
}

function fraction(option: string, given: number | undefined, fallback: number): number {
  if (given === undefined) return fallback
  if (typeof given !== "number" || !Number.isFinite(given) || given <= 0 || given > 1) {
    throw new ToolError("internal_error", `createFlint needs a similarity above 0 and at most 1 for \`${option}\`.`, {
      option,
    })
  }
  return given
}

// A Body that drifts off the result schema its own Tool declares is a refusal the model can act on, not a result the caller has to notice.
function assertResult(name: string, schema: JsonSchema | undefined, result: JsonValue): void {
  if (schema === undefined) return
  const problems = validateArguments(schema, result, "the result")
  if (problems.length === 0) return
  throw new ToolError(
    "invalid_result",
    `The Tool ${JSON.stringify(name)} returned a result its own result schema refuses: ${problems.join(" ")} Fix the Body with tool_update, or change result_json to the shape it really returns.`,
    { tool: name, problems },
  )
}

function invalidArguments(name: string, problems: string[]): ToolError {
  return new ToolError("invalid_arguments", `The arguments for ${name} do not match its schema: ${problems.join(" ")}`, {
    tool: name,
    problems,
  })
}
