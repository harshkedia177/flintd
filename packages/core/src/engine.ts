import { randomUUID, timingSafeEqual } from "node:crypto"
import { Worker } from "node:worker_threads"
import type { ContainerTier } from "./container-tier.ts"
import { ToolError, causeMessage, tooLarge } from "./errors.ts"
import { fileCall } from "./files.ts"
import type { FileCall } from "./files.ts"
import { startNodeRunner } from "./node-tier.ts"
import { fetchCall } from "./proxy.ts"
import { redact } from "./redact.ts"
import { capBytes } from "./validate.ts"
import type { ExecutionLimits } from "./quickjs.ts"
import type { Connection, JsonValue, LogEntry, Manifest, Patterns, Tier, ToolErrorCode } from "./types.ts"

const RUNNER_START_TIMEOUT_MS = 10_000
// A warm Node tier child is per Tool, and every session that calls that Tool shares it, so whatever one call leaves
// behind is what the next session's call can reach. The default keeps none: a fresh child per call costs about 54 ms
// against 0.6 ms and carries nothing. An operator who wants the latency back asks for it by name.
export const WARM_NODE_RUNNERS = 0
// The Node tier loads a Body from a data: URL, so a stack trace carries its whole source base64-encoded, where redaction cannot read it.
const BODY_URL = /data:text\/javascript;base64,[A-Za-z0-9+/=]+/g
const FILE_CALLS: readonly HostCallName[] = ["fs.read", "fs.write", "fs.list"]

// A Body runs inside a tier, so any other code it puts on the wire is one it is forging, and it comes back as what it is: a call that failed.
const TIER_ERROR_CODES: readonly ToolErrorCode[] = [
  "call_failed",
  "timeout",
  "invalid_arguments",
  "invalid_result",
  "unserializable_result",
  "result_too_large",
  "worker_unavailable",
  "internal_error",
]

// What a tier found it could not put back. A Body can write a frame of its own, so the wire carries one of these and
// the line the operator reads is built here: a Body may name one of three, and never a line of its own writing.
export type RetireReason = "frozen_or_sealed" | "non_configurable" | "computed_import"

const RETIRED_BECAUSE: Record<RetireReason, string> = {
  frozen_or_sealed: "froze or sealed an object",
  non_configurable: "added a property no later call can delete",
  computed_import: "imported a package under a specifier it computed",
}

export type HostCallName = "log" | "fetch" | "callTool" | "exec" | FileCall

export type HostCall = (name: HostCallName, argument: JsonValue) => Promise<JsonValue>

export interface ToolCall {
  toolName: string
  body: string
  args: JsonValue
  manifest: Manifest
  tier: Tier
  limits: ExecutionLimits
  // A `pattern` is a model's own regex, so it is compiled in the tier, which terminateAfterMs bounds, and never here.
  patterns?: Patterns
}

export interface ExecuteRequest extends ToolCall {
  id: number
  // The tier echoes this on every frame it sends, so a frame that names a call proves it is the call flintd dispatched.
  token: string
}

// A nested `ctx.callTool` runs for the caller's own session, because one agent turn made the whole chain.
export interface CallChain {
  callId: string | null
  names: readonly string[]
  depth: number
  session: string | null
  harness: string | null
}

export interface RunOptions {
  // `stillApproved` is asked again at every network call, so an Approval a person takes back stops a call in flight.
  stillApproved?(): boolean
  chain?: CallChain
}

export type CallToolHandler = (argument: JsonValue, from: CallChain, expiresAt: number) => Promise<JsonValue>

export interface SerializedError {
  code: ToolErrorCode
  message: string
  details: Record<string, JsonValue>
}

export type WorkerMessage =
  | { type: "ready" }
  | { type: "unavailable"; error: SerializedError }
  // `retire` is the tier saying it could not put back what the Body changed, so the child answers this call and no
  // other, and names what it found so the operator's log says why a Tool went back to a cold start.
  | { type: "result"; id: number; token: string; value: JsonValue; retire?: RetireReason }
  | { type: "failure"; id: number; token: string; error: SerializedError; retire?: RetireReason }
  | { type: "host"; id: number; token: string; call: number; name: HostCallName; argument: JsonValue }

export type WorkerCommand =
  | { type: "execute"; request: ExecuteRequest }
  | { type: "host-result"; call: number; value: JsonValue }
  | { type: "host-failure"; call: number; code: ToolErrorCode; message: string }

export interface Runner {
  ref(): void
  unref(): void
  send(command: WorkerCommand): void
  terminate(): Promise<void>
}

export interface RunnerHooks {
  message(message: WorkerMessage): void
  error(cause: unknown): void
  exit(): void
}

export interface Engine {
  run(call: ToolCall, options?: RunOptions): Promise<JsonValue>
  close(): Promise<void>
}

export interface EngineOptions {
  libraryDir: string
  container: ContainerTier
  warmNodeRunners: number
  connections(): readonly Connection[]
  callTool: CallToolHandler
  onLog?(entry: LogEntry): void
}

type Outcome = { value: JsonValue } | { error: ToolError }

interface Pending {
  request: ExecuteRequest
  stillApproved: (() => boolean) | undefined
  chain: CallChain
  // The lane serialises this call against its siblings; the runner is the thread or process it runs in.
  lane: string
  runner: string
  expiresAt: number
  deadline: NodeJS.Timeout | undefined
  // The Manifest field a host call was refused for, so a save that is waiting for an Approval can tell that failure from a broken Body.
  capabilityOff: string | null
  logged: number
  log(entry: LogEntry): void
  settle(outcome: Outcome): void
}

interface Lane {
  queue: Pending[]
  current: Pending | undefined
}

// One pool per Library, so a slow Body in one never holds up a call in the other.
export async function loadEngine(options: EngineOptions): Promise<Engine> {
  return createPool(options)
}

// A Node tier child serves one Tool of one Library, so the Tool names it and the Manifest root it was started with follows; a container serves one call, so the call id names it.
function runnerKey(request: ExecuteRequest, depth: number): string {
  if (request.tier === "container") return `container#${request.id}`
  const tier = request.tier === "node" ? `node:${request.toolName}:${request.manifest.fs ?? ""}` : request.tier
  return depth === 0 ? tier : `${tier}#${depth}`
}

// Depth 0 is one lane for the whole pool; deeper calls queue per runner, so a call waits only for a sibling that cannot be waiting for it.
function laneKey(request: ExecuteRequest, depth: number): string {
  return depth === 0 ? "" : runnerKey(request, depth)
}

function createPool(engine: EngineOptions): Engine {
  const { libraryDir, connections, callTool, container, warmNodeRunners } = engine
  const lanes = new Map<string, Lane>()
  const active = new Map<number, Pending>()
  let closed = false
  const runners = new Map<string, Runner>()
  const starting = new Map<string, Promise<Runner>>()
  const forged = new Set<string>()
  // The Tool a runner was started for, so a frame it drops with nothing in flight still says where it came from.
  const serves = new Map<string, string>()
  let nextId = 1

  function lane(key: string): Lane {
    const held = lanes.get(key)
    if (held !== undefined) return held
    const made: Lane = { queue: [], current: undefined }
    lanes.set(key, made)
    return made
  }

  function pump(key: string): void {
    const waiting = lane(key)
    if (waiting.current !== undefined) return
    const pending = waiting.queue.shift()
    if (pending === undefined) {
      // A nested lane keeps its runner for the whole chain: a Body that calls two Tools in a row must not pay for a runner twice.
      if (empty("")) retireNested()
      idle()
      return
    }
    waiting.current = pending
    active.set(pending.request.id, pending)
    void dispatch(pending)
  }

  function empty(key: string): boolean {
    const waiting = lanes.get(key)
    return waiting === undefined || (waiting.current === undefined && waiting.queue.length === 0)
  }

  function retireNested(): void {
    for (const key of [...lanes.keys()]) {
      if (key === "" || !empty(key)) continue
      lanes.delete(key)
      retire(key)
    }
  }

  function retire(key: string): void {
    const running = runners.get(key)
    if (running === undefined) return
    runners.delete(key)
    forged.delete(key)
    serves.delete(key)
    void running.terminate()
  }

  function idle(): void {
    for (const waiting of lanes.values()) {
      if (waiting.current !== undefined || waiting.queue.length > 0) return
    }
    const warm = [...runners.keys()].filter((key) => key.startsWith("node:"))
    for (const key of warm.slice(0, Math.max(0, warm.length - warmNodeRunners))) retire(key)
    for (const runner of runners.values()) runner.unref()
  }

  async function dispatch(pending: Pending): Promise<void> {
    let running: Runner
    try {
      running = await acquire(pending.runner, pending)
    } catch (cause) {
      if (lane(pending.lane).current === pending) finish(pending, { error: cause as ToolError })
      return
    }
    if (lane(pending.lane).current !== pending) {
      // A container serves one call and this one is over, so the container that arrived late is taken away here rather than left running with nothing to do.
      if (pending.request.tier === "container") retire(pending.runner)
      idle()
      return
    }
    pending.expiresAt = Date.now() + pending.request.limits.timeoutMs
    pending.deadline = setTimeout(() => expire(pending), pending.request.limits.terminateAfterMs)
    serves.set(pending.runner, pending.request.toolName)
    // The cap on drop lines is one for each request a runner is handed, so a drop never silences the drop after it.
    forged.delete(pending.runner)
    running.ref()
    try {
      running.send({ type: "execute", request: pending.request })
    } catch (cause) {
      // A channel that refuses the request settles the call. Throwing here would leave the pool mid-dispatch and
      // take the process with it, because nothing awaits this.
      retire(pending.runner)
      finish(pending, {
        error: new ToolError(
          "internal_error",
          `flintd could not hand ${pending.request.toolName} to its tier: ${causeMessage(cause)}`,
          { tool: pending.request.toolName },
        ),
      })
    }
  }

  async function acquire(key: string, pending: Pending | undefined): Promise<Runner> {
    const held = runners.get(key)
    if (held !== undefined) {
      // Least recently used first, which is the order the trim at idle reads.
      runners.delete(key)
      runners.set(key, held)
      return held
    }
    let launch = starting.get(key)
    if (launch === undefined) {
      launch = start(key, pending)
      starting.set(key, launch)
    }
    try {
      const runner = await launch
      runners.set(key, runner)
      return runner
    } finally {
      starting.delete(key)
    }
  }

  function finish(pending: Pending, given: Outcome): void {
    const outcome = capabilityOff(pending, given)
    if (pending.deadline !== undefined) clearTimeout(pending.deadline)
    pending.deadline = undefined
    active.delete(pending.request.id)
    const waiting = lane(pending.lane)
    if (waiting.current === pending) waiting.current = undefined
    // A container that has served one call never serves another: one call, one container, however it ended. A Node
    // tier child is the same thing when the operator asks for no warm child at all.
    if (pending.request.tier === "container" || (pending.request.tier === "node" && warmNodeRunners === 0)) {
      retire(pending.runner)
    }
    pending.settle(outcome)
    pump(pending.lane)
  }

  function expire(pending: Pending): void {
    retire(pending.runner)
    if (lane(pending.lane).current !== pending) return
    finish(pending, {
      error: new ToolError(
        "timeout",
        `${pending.request.toolName} did not answer within ${pending.request.limits.timeoutMs} ms and the executor was restarted. Make the Body do less work, or split it across more than one Tool.`,
        { tool: pending.request.toolName, timeoutMs: pending.request.limits.timeoutMs },
      ),
    })
  }

  function drop(key: string, started: Runner, error: ToolError): void {
    if (runners.get(key) !== started) return
    runners.delete(key)
    for (const pending of [...active.values()]) {
      if (pending.runner === key) finish(pending, { error })
    }
  }

  function hosted(key: string, running: Runner, message: Extract<WorkerMessage, { type: "host" }>): void {
    const pending = active.get(message.id)
    if (pending === undefined) {
      running.send({ type: "host-failure", call: message.call, code: "call_failed", message: "flintd stopped the call" })
      return
    }
    if (!owns(pending, key, message.token)) {
      dropForged(key)
      return
    }
    void answerHost(pending, message).then(
      (value) => reply(running, pending, { type: "host-result", call: message.call, value }),
      (cause: unknown) => {
        if (cause instanceof ToolError && typeof cause.details["capability"] === "string") {
          pending.capabilityOff ??= cause.details["capability"]
        }
        reply(running, pending, {
          type: "host-failure",
          call: message.call,
          code: cause instanceof ToolError ? cause.code : "call_failed",
          message: causeMessage(cause),
        })
      },
    )
  }

  // The answer to a host call reaches the runner only while the request that raised it is still in flight.
  function reply(running: Runner, pending: Pending, command: WorkerCommand): void {
    if (active.get(pending.request.id) !== pending) return
    running.send(command)
  }

  async function answerHost(pending: Pending, message: Extract<WorkerMessage, { type: "host" }>): Promise<JsonValue> {
    const { limits } = pending.request
    if (message.name === "log") {
      // The cut comes after the redaction, so a credential that straddles it leaves no half behind.
      pending.log({
        tool: pending.request.toolName,
        callId: pending.chain.callId,
        message: capBytes(redact(sourceless(String(message.argument))), limits.maxLogBytes),
      })
      return null
    }
    if (message.name === "fetch") {
      return fetchCall(pending.request, message.argument, {
        connections: connections(),
        stillApproved: pending.stillApproved,
        expiresAt: pending.expiresAt,
      })
    }
    if (message.name === "callTool") return callTool(message.argument, pending.chain, pending.expiresAt)
    // Only the container tier answers `exec`, and it answers it inside the container. Every other tier arrives here.
    if (message.name === "exec") {
      throw new ToolError(
        "call_failed",
        `${pending.request.toolName} called ctx.exec, and a command runs only in the container tier. Ask for it with "exec": true in the Manifest, and have one person approve that Manifest.`,
        { tool: pending.request.toolName, tier: pending.request.tier, capability: "exec" },
      )
    }
    // The channel is the lock, not the `ctx` a tier builds: a Body that reaches the channel directly still gets here.
    if (!FILE_CALLS.includes(message.name)) {
      throw new ToolError("call_failed", `${String(message.name)} is not a host call this build of flintd serves.`)
    }
    return fileCall(libraryDir, pending.request, message.name, message.argument)
  }

  async function start(key: string, pending: Pending | undefined): Promise<Runner> {
    const hooks: RunnerHooks = {
      message: (message) => {
        if (message.type === "host") {
          const running = runners.get(key)
          if (running !== undefined) hosted(key, running, message)
          return
        }
        if (!("id" in message)) return
        const waiting = active.get(message.id)
        if (waiting === undefined) return
        // A Body can write a frame of its own onto the channel, so a runner settles the call it was handed and no other.
        if (!owns(waiting, key, message.token)) {
          dropForged(key)
          return
        }
        // Before the answer settles, because settling is what hands the next queued call to this runner. One line for
        // the retire a Body caused, and none for the ordinary eviction of a warm child, which goes through idle().
        if (message.retire !== undefined) {
          retired(waiting, message.retire)
          retire(key)
        }
        finish(waiting, message.type === "result" ? answered(waiting, message.value) : { error: revive(message.error) })
      },
      error: (cause) => started.then((runner) => drop(key, runner, unavailable(causeMessage(cause))), () => undefined),
      exit: () => started.then((runner) => drop(key, runner, unavailable("the executor stopped")), () => undefined),
    }
    // Every pending on one runner key carries one Manifest root, because the root is part of the key.
    const write = (message: string): void => log(key, pending, message)
    let started: Promise<Runner>
    if (key.startsWith("node:")) {
      started =
        pending === undefined
          ? Promise.reject(unavailable("a Node tier runner starts for a call, and this one has none"))
          : startNodeRunner(libraryDir, pending.request.manifest.fs ?? "", pending.request.limits, hooks, write)
    } else if (key.startsWith("container")) {
      started =
        pending === undefined
          ? Promise.reject(unavailable("a container runs one call, and this one has none"))
          : container.start(libraryDir, pending.request, hooks, write)
    } else {
      started = startWorker(hooks)
    }
    return started
  }

  // One line, whatever the sweep found and however many objects it found it on. A reason this build does not hold is
  // a Body's own forgery, and it still says the child went, because the frame came from that Body's own child.
  function retired(pending: Pending, reason: RetireReason): void {
    const because = Object.hasOwn(RETIRED_BECAUSE, reason) ? RETIRED_BECAUSE[reason] : "changed what its tier could not put back"
    // Past the per-call line cap, the way a dropped frame is: a Body that logs its own limit first must not be able
    // to bury the line that says its child went. One retire is one call, so this can write one line a call at most.
    logged?.({
      tool: pending.request.toolName,
      callId: pending.chain.callId,
      message: `${pending.request.toolName}: the Body ${because}, and its child is retired.`,
    })
  }

  // One line per frame would let a Body that forges in a loop fill the log, so the line belongs to the runner and the
  // Tool it serves rather than to a call, and a frame that arrives with nothing in flight is written all the same.
  function dropForged(key: string): void {
    if (forged.has(key)) return
    forged.add(key)
    const inFlight = [...active.values()].find((one) => one.runner === key)
    logged?.({
      tool: inFlight?.request.toolName ?? serves.get(key) ?? key,
      callId: inFlight?.chain.callId ?? null,
      message: "A frame from this tier named a call it was not handed, and flintd dropped it.",
    })
  }

  function log(key: string, pending: Pending | undefined, message: string): void {
    const waiting = [...active.values()].find((one) => one.runner === key) ?? pending
    if (waiting === undefined) return
    waiting.log({
      tool: waiting.request.toolName,
      callId: waiting.chain.callId,
      message: capBytes(sourceless(message), waiting.request.limits.maxLogBytes),
    })
  }

  // A container is slower to start and slower to work than a VM, so the tier carries a timeout of its own.
  function bounded(call: ToolCall, depth: number): ExecutionLimits {
    if (call.tier !== "container") return call.limits
    const timeoutMs = depth === 0 ? container.timeoutMs : Math.min(container.timeoutMs, call.limits.timeoutMs)
    const grace = call.limits.terminateAfterMs - call.limits.timeoutMs
    return { ...call.limits, timeoutMs, terminateAfterMs: timeoutMs + grace }
  }

  const logged = engine.onLog
  // The QuickJS tier boots beside the Library it serves, so the first Body waits on nothing.
  void acquire("quickjs", undefined).then(idle, () => undefined)
  return {
    run(call, given) {
      if (closed) return Promise.reject(stopped())
      const refused = call.tier === "container" ? container.unavailable(call.toolName) : undefined
      if (refused !== undefined) return Promise.reject(refused)
      const chain = given?.chain ?? {
        callId: null,
        names: [call.toolName],
        depth: 0,
        session: null,
        harness: null,
      }
      const request: ExecuteRequest = { id: nextId++, token: randomUUID(), ...call, limits: bounded(call, chain.depth) }
      return new Promise<JsonValue>((resolve, reject) => {
        const pending: Pending = {
          request,
          stillApproved: given?.stillApproved,
          chain,
          lane: laneKey(request, chain.depth),
          runner: runnerKey(request, chain.depth),
          expiresAt: Date.now() + request.limits.timeoutMs,
          deadline: undefined,
          capabilityOff: null,
          logged: 0,
          log: (entry) => {
            pending.logged += 1
            const cap = call.limits.maxLogLines
            if (pending.logged > cap + 1) return
            if (pending.logged > cap) {
              logged?.({
                tool: entry.tool,
                callId: entry.callId,
                message: `log limit reached: ${cap} lines. The rest of this call's log lines are dropped; log less, or log once at the end.`,
              })
              return
            }
            logged?.(entry)
          },
          settle: (outcome) => ("value" in outcome ? resolve(outcome.value) : reject(outcome.error)),
        }
        lane(pending.lane).queue.push(pending)
        pump(pending.lane)
      })
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      const abandoned: Pending[] = []
      for (const waiting of lanes.values()) {
        abandoned.push(...waiting.queue.splice(0))
        const inFlight = waiting.current
        if (inFlight === undefined) continue
        waiting.current = undefined
        active.delete(inFlight.request.id)
        if (inFlight.deadline !== undefined) clearTimeout(inFlight.deadline)
        // The runner that would have answered is about to go, so the call it holds is settled here or never.
        abandoned.push(inFlight)
      }
      for (const [key, runner] of [...runners]) {
        runners.delete(key)
        await runner.terminate()
      }
      for (const pending of abandoned) pending.settle({ error: stopped() })
    },
  }
}

async function startWorker(hooks: RunnerHooks): Promise<Runner> {
  // The Worker carries no environment: a credential in the parent process must never be readable beside a Body.
  const started = new Worker(new URL("./engine-worker.ts", import.meta.url), { env: {} })
  try {
    await awaitReady((onMessage, onError) => {
      started.on("message", onMessage)
      started.on("error", onError)
      return () => {
        started.off("message", onMessage)
        started.off("error", onError)
      }
    })
  } catch (cause) {
    void started.terminate()
    throw cause
  }
  started.on("message", hooks.message)
  started.on("error", hooks.error)
  started.on("exit", hooks.exit)
  return {
    ref: () => started.ref(),
    unref: () => started.unref(),
    send: (command) => started.postMessage(command),
    terminate: async () => {
      await started.terminate()
    },
  }
}

// Both tiers say "ready" or "unavailable" before they take a request, and both are given the same bound to say it.
export function awaitReady(
  subscribe: (onMessage: (message: WorkerMessage) => void, onError: (cause: unknown) => void) => () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(unavailable(`the executor did not start within ${RUNNER_START_TIMEOUT_MS} ms`))
    }, RUNNER_START_TIMEOUT_MS)
    const stop = subscribe(
      (message) => {
        if (message.type === "ready") settle()
        else if (message.type === "unavailable") settle(revive(message.error))
      },
      (cause) => settle(unavailable(causeMessage(cause))),
    )
    function settle(outcome?: ToolError): void {
      clearTimeout(timer)
      stop()
      if (outcome === undefined) resolve()
      else reject(outcome)
    }
  })
}

// A Body that swallows the refusal and fails another way still failed for the want of that capability, so the mark travels with the call, not with the throw.
function capabilityOff(pending: Pending, outcome: Outcome): Outcome {
  if (!("error" in outcome) || pending.capabilityOff === null) return outcome
  const { error } = outcome
  return { error: new ToolError(error.code, error.message, { ...error.details, capability: pending.capabilityOff }) }
}

// A frame that reached the channel another way is bounded here too, so no route around a tier is a route around the limit.
function answered(pending: Pending, value: JsonValue): Outcome {
  const { toolName, limits } = pending.request
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8")
  } catch (cause) {
    return { error: new ToolError("unserializable_result", `${toolName} answered with a value flintd could not measure: ${causeMessage(cause)}`, { tool: toolName }) }
  }
  return bytes > limits.maxResultBytes ? { error: tooLarge(toolName, bytes, limits.maxResultBytes) } : { value }
}

function owns(pending: Pending, key: string, token: unknown): boolean {
  return pending.runner === key && sameToken(pending.request.token, token)
}

// A forged token is compared to the end, so the frame a Body is allowed to retry tells it nothing about the one it missed.
function sameToken(held: string, given: unknown): boolean {
  if (typeof given !== "string") return false
  const mine = Buffer.from(held, "utf8")
  const theirs = Buffer.from(given, "utf8")
  return mine.byteLength === theirs.byteLength && timingSafeEqual(mine, theirs)
}

function stopped(): ToolError {
  return unavailable("flintd is stopped, so no Tool can run")
}

export function unavailable(reason: string): ToolError {
  return new ToolError("worker_unavailable", `The flintd executor is not available: ${reason}.`, { reason })
}

function sourceless(message: string): string {
  return message.replace(BODY_URL, "<the Tool's own Body>")
}

export function revive(error: SerializedError): ToolError {
  const code = TIER_ERROR_CODES.includes(error.code) ? error.code : "call_failed"
  return new ToolError(code, error.message, error.details)
}
