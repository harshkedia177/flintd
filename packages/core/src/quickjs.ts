import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten"
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSWASMModule } from "quickjs-emscripten"
import { BUNDLE, BUNDLE_NODE_ONLY, bundleText } from "./bundle.ts"
import { ToolError, causeMessage, tooLarge } from "./errors.ts"
import { isPlainObject } from "./validate.ts"
import type { ExecuteRequest, HostCall, HostCallName } from "./engine.ts"
import type { JsonValue, ToolErrorCode } from "./types.ts"

const MAX_STACK_BYTES = 512 * 1024
const HOST_CALL = "__flintd_host"
const SLEEP_CALL = "__flintd_sleep"
const CLEAR_CALL = "__flintd_clear"
const TIMER_ID = "__flintd_timer"
const INTERVAL_ADVICE =
  "setInterval is not available in a Body: a call ends, and a repeating timer has nothing to repeat into. Use setTimeout inside a loop and return when the work is done."

export interface ExecutionLimits {
  timeoutMs: number
  terminateAfterMs: number
  maxArgsBytes: number
  maxResultBytes: number
  maxBodyBytes: number
  maxFetchBytes: number
  fetchTimeoutMs: number
  maxLogLines: number
  maxLogBytes: number
  memoryLimitBytes: number
  maxExecBytes: number
}

export interface Executor {
  run(request: ExecuteRequest, host: HostCall): Promise<JsonValue>
}

interface Suspended {
  context: QuickJSContext
  open: Set<QuickJSDeferredPromise>
  // An entry takes itself out the moment it settles, so the drive loop below can resume on the first one to answer rather than on the slowest.
  waiting: Set<Promise<void>>
  timers: Map<number, () => void>
  closed: boolean
}

export async function loadQuickJS(): Promise<Executor> {
  let wasm: QuickJSWASMModule
  try {
    wasm = await getQuickJS()
  } catch (cause) {
    throw new ToolError("worker_unavailable", "The QuickJS tier did not start, so no Tool can run.", {
      reason: causeMessage(cause),
    })
  }
  return { run: (request, host) => run(wasm, request, host) }
}

async function run(wasm: QuickJSWASMModule, request: ExecuteRequest, host: HostCall): Promise<JsonValue> {
  const { toolName, limits } = request
  const serialized = serialize(toolName, request.args, limits.maxArgsBytes)
  const deadline = Date.now() + limits.timeoutMs
  const runtime = wasm.newRuntime()
  try {
    runtime.setMemoryLimit(limits.memoryLimitBytes)
    runtime.setMaxStackSize(MAX_STACK_BYTES)
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline))
    runtime.setModuleLoader(bundleModule)
    const context = runtime.newContext()
    const suspended: Suspended = { context, open: new Set(), waiting: new Set(), timers: new Map(), closed: false }
    try {
      offerHost(suspended, host)
      offerTimers(suspended, deadline)
      const evaluated = context.evalCode(
        callScript(request, serialized),
        `flintd:${toolName}`,
      )
      if (evaluated.error !== undefined) {
        const failure = context.dump(evaluated.error)
        evaluated.error.dispose()
        throw translate(failure, toolName, deadline, limits)
      }
      const promise = evaluated.value
      if (promise === undefined) {
        throw new ToolError("internal_error", `The QuickJS tier returned no result for ${toolName}.`, { tool: toolName })
      }
      try {
        for (;;) {
          const jobs = runtime.executePendingJobs()
          if (jobs.error !== undefined) {
            const failure = context.dump(jobs.error)
            jobs.error.dispose()
            throw translate(failure, toolName, deadline, limits)
          }
          const state = context.getPromiseState(promise)
          if (state.type === "fulfilled") {
            const outcome = context.dump(state.value) as unknown
            state.value.dispose()
            return decode(outcome, toolName, limits)
          }
          if (state.type === "rejected") {
            const failure = context.dump(state.error)
            state.error.dispose()
            throw translate(failure, toolName, deadline, limits)
          }
          const left = deadline - Date.now()
          if (suspended.waiting.size === 0 || left <= 0) throw unfinished(toolName, limits)
          await settle(suspended.waiting, left)
        }
      } finally {
        promise.dispose()
      }
    } finally {
      suspended.closed = true
      for (const cancel of suspended.timers.values()) cancel()
      for (const deferred of suspended.open) deferred.dispose()
      context.dispose()
    }
  } finally {
    runtime.dispose()
  }
}

// A name outside the Bundle never gets here, because the save gate refused it; a Node-only package runs on the Node tier.
function bundleModule(requested: string): string | { error: Error } {
  if (!BUNDLE.includes(requested)) {
    return { error: new Error(`flintd does not ship ${JSON.stringify(requested)}, so no Body may import it.`) }
  }
  if (BUNDLE_NODE_ONLY.includes(requested)) {
    return { error: new Error(`${requested} runs on the Node tier only, and this Tool was saved for the QuickJS tier.`) }
  }
  try {
    return bundleText(requested)
  } catch (cause) {
    return { error: new Error(`The Bundle file for ${requested} is missing: run \`pnpm build\` (${causeMessage(cause)}).`) }
  }
}

// It leaves the set the moment it settles, so a wait that is already done can never wake the loop again and a wait that never settles can never hold it.
function waitOn(suspended: Suspended, start: (settled: () => void) => void): void {
  let release = (): void => undefined
  const wait = new Promise<void>((done) => {
    release = done
  })
  suspended.waiting.add(wait)
  start(() => {
    suspended.waiting.delete(wait)
    release()
  })
}

// It is the Worker's own timer, so the drive loop awaits it the way it awaits a host call.
function offerTimers(suspended: Suspended, deadline: number): void {
  const { context } = suspended
  // The id is the host's own count, so a Body that calls these directly cannot reuse one id for two timers.
  let nextTimer = 1
  const sleep = context.newFunction(SLEEP_CALL, (msHandle) => {
    const token = nextTimer++
    const asked = msHandle === undefined ? 0 : context.getNumber(msHandle)
    const within = Number.isFinite(asked) ? Math.max(0, asked) : 0
    const deferred = context.newPromise()
    suspended.open.add(deferred)
    waitOn(suspended, (settled) => {
      const timer =
        within > deadline - Date.now()
          ? undefined
          : setTimeout(() => {
              suspended.timers.delete(token)
              answer(suspended, deferred, undefined, null)
              settled()
            }, within)
      suspended.timers.set(token, () => {
        if (timer !== undefined) clearTimeout(timer)
        settled()
      })
    })
    const id = context.newNumber(token)
    context.setProp(deferred.handle, TIMER_ID, id)
    id.dispose()
    return deferred.handle
  })
  context.setProp(context.global, SLEEP_CALL, sleep)
  sleep.dispose()
  const clear = context.newFunction(CLEAR_CALL, (tokenHandle) => {
    if (tokenHandle === undefined) return context.undefined
    const token = context.getNumber(tokenHandle)
    const cancel = suspended.timers.get(token)
    suspended.timers.delete(token)
    cancel?.()
    return context.undefined
  })
  context.setProp(context.global, CLEAR_CALL, clear)
  clear.dispose()
}

// A host call suspends the Body on a QuickJS promise the main thread settles, so one Body can await the host many times.
function offerHost(suspended: Suspended, host: HostCall): void {
  const { context } = suspended
  const call = context.newFunction(HOST_CALL, (nameHandle, argumentHandle) => {
    // A Body can name this function; it cannot make flintd read a handle that was never passed.
    const name = (nameHandle === undefined ? "" : context.getString(nameHandle)) as HostCallName
    const text = argumentHandle === undefined ? "null" : context.getString(argumentHandle)
    const deferred = context.newPromise()
    suspended.open.add(deferred)
    let argument: JsonValue
    try {
      argument = JSON.parse(text) as JsonValue
    } catch (cause) {
      answer(suspended, deferred, refusal(cause), null)
      return deferred.handle
    }
    waitOn(suspended, (settled) => {
      void host(name, argument).then(
        (value) => {
          answer(suspended, deferred, undefined, value)
          settled()
        },
        (cause: unknown) => {
          answer(suspended, deferred, refusal(cause), null)
          settled()
        },
      )
    })
    return deferred.handle
  })
  context.setProp(context.global, HOST_CALL, call)
  call.dispose()
}

// The code travels with the message, so a Body that catches a refusal from ctx.callTool or ctx.fetch can read why.
function refusal(cause: unknown): { code: ToolErrorCode; message: string } {
  return { code: cause instanceof ToolError ? cause.code : "call_failed", message: causeMessage(cause) }
}

function answer(
  suspended: Suspended,
  deferred: QuickJSDeferredPromise,
  failure: { code: ToolErrorCode; message: string } | undefined,
  value: JsonValue,
): void {
  if (suspended.closed) return
  suspended.open.delete(deferred)
  if (failure === undefined) {
    const answered = suspended.context.newString(JSON.stringify(value ?? null))
    deferred.resolve(answered)
    answered.dispose()
  } else {
    const thrown = suspended.context.newError(failure.message)
    const code = suspended.context.newString(failure.code)
    suspended.context.setProp(thrown, "code", code)
    code.dispose()
    deferred.reject(thrown)
    thrown.dispose()
  }
  deferred.dispose()
}

function settle(waiting: Set<Promise<void>>, withinMs: number): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, withinMs)
    void Promise.race(waiting).then(() => {
      clearTimeout(timer)
      done()
    })
  })
}

function serialize(toolName: string, args: JsonValue, maximum: number): string {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(args)
  } catch (cause) {
    throw new ToolError("invalid_arguments", `The arguments for ${toolName} must be JSON: ${causeMessage(cause)}.`, {
      tool: toolName,
    })
  }
  if (serialized === undefined) {
    throw new ToolError("invalid_arguments", `The arguments for ${toolName} must be JSON.`, { tool: toolName })
  }
  const size = Buffer.byteLength(serialized, "utf8")
  if (size > maximum) {
    throw new ToolError(
      "invalid_arguments",
      `The arguments for ${toolName} are ${size} bytes and the limit is ${maximum}. Send less: a reference, a path, or one page of the data.`,
      { tool: toolName, size, maximum },
    )
  }
  return serialized
}

// The Body is nested inside this function, so anything this function can name the Body can name too.
function callScript(request: ExecuteRequest, serialized: string): string {
  const { toolName, body } = request
  const maxResultBytes = request.limits.maxResultBytes
  return `(function () {
  "use strict";
  var __args = JSON.parse(${literal(serialized)});
  var __patterns = JSON.parse(${literal(JSON.stringify(request.patterns ?? null))});
  // A model wrote these regexes. They run here, where the runtime's interrupt handler stops one that never finishes.
  function __pattern(schema, value, at) {
    if (schema === null || typeof schema !== "object") return null;
    if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
      return { at: at, pattern: schema.pattern };
    }
    if (schema.properties && value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (var key in schema.properties) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        var member = __pattern(schema.properties[key], value[key], at === "" ? key : at + "." + key);
        if (member !== null) return member;
      }
    }
    if (schema.items && Array.isArray(value)) {
      for (var index = 0; index < value.length; index++) {
        var entry = __pattern(schema.items, value[index], at + "[" + index + "]");
        if (entry !== null) return entry;
      }
    }
    return null;
  }
  function __refuse(schema, value, code, subject) {
    if (__patterns === null || !schema) return null;
    var bad = __pattern(schema, value, "");
    if (bad === null) return null;
    var where = bad.at === "" ? subject : JSON.stringify(bad.at);
    return { refusal: { code: code, message: ${literal(toolName)} + ": " + where + " must match the pattern " + JSON.stringify(bad.pattern) + "." } };
  }
  var __host = globalThis.${HOST_CALL};
  delete globalThis.${HOST_CALL};
  function __call(name, argument) {
    return __host(name, JSON.stringify(argument === undefined ? null : argument)).then(function (json) {
      return JSON.parse(json);
    });
  }
  var __sleep = globalThis.${SLEEP_CALL};
  var __unsleep = globalThis.${CLEAR_CALL};
  delete globalThis.${SLEEP_CALL};
  delete globalThis.${CLEAR_CALL};
  var __timers = Object.create(null);
  function setTimeout(run, ms) {
    var rest = Array.prototype.slice.call(arguments, 2);
    var waited = __sleep(Number(ms) || 0);
    var id = waited.${TIMER_ID};
    __timers[id] = true;
    waited.then(function () {
      if (__timers[id] === undefined) return;
      delete __timers[id];
      run.apply(null, rest);
    });
    return id;
  }
  function clearTimeout(id) {
    if (id === undefined || __timers[id] === undefined) return;
    delete __timers[id];
    __unsleep(id);
  }
  function setInterval() { throw new Error(${literal(INTERVAL_ADVICE)}); }
  function clearInterval() {}
  var __ctx = Object.freeze({
    toolName: JSON.parse(${literal(JSON.stringify(toolName))}),
    log: function (message) { return __call("log", String(message)).then(function () {}); },
    fs: Object.freeze({
      read: function (path) { return __call("fs.read", String(path)); },
      write: function (path, text) { return __call("fs.write", { path: String(path), text: String(text) }); },
      list: function (path) { return __call("fs.list", String(path)); },
    }),
    fetch: function (url, init) { return __call("fetch", { url: String(url), init: init === undefined ? null : init }); },
    callTool: function (name, args) { return __call("callTool", { name: String(name), args: args === undefined ? null : args }); },
    exec: function (command, options) { return __call("exec", { command: String(command), options: options === undefined ? null : options }); },
  });
  async function execute(args, ctx) {${body}}
  var __bad = __patterns === null ? null : __refuse(__patterns.args, __args, "invalid_arguments", "the arguments");
  if (__bad !== null) return Promise.resolve(__bad);
  return Promise.resolve()
    .then(function () { return execute(__args, __ctx); })
    .then(function (value) {
      var refused = __patterns === null ? null : __refuse(__patterns.result, value, "invalid_result", "the result");
      if (refused !== null) return refused;
      var json;
      try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { return { unserializable: true }; }
      if (json === undefined) return { unserializable: true };
      if (json.length > ${maxResultBytes}) return { size: json.length };
      return { size: json.length, json: json };
    });
})()`
}

function literal(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

const PRELUDE_CODES: readonly ToolErrorCode[] = ["invalid_arguments", "invalid_result"]

function decode(outcome: unknown, toolName: string, limits: ExecutionLimits): JsonValue {
  if (!isPlainObject(outcome)) {
    throw new ToolError("internal_error", `The QuickJS tier returned no result for ${toolName}.`, { tool: toolName })
  }
  const refusal = outcome["refusal"]
  if (isPlainObject(refusal)) {
    const code = refusal["code"]
    if (!PRELUDE_CODES.includes(code as ToolErrorCode) || typeof refusal["message"] !== "string") {
      throw new ToolError("internal_error", `The QuickJS tier returned no result for ${toolName}.`, { tool: toolName })
    }
    throw new ToolError(code as ToolErrorCode, refusal["message"], { tool: toolName })
  }
  if (outcome["unserializable"] === true) {
    throw new ToolError(
      "unserializable_result",
      `${toolName} returned a value that is not JSON. Return an object, an array, a string, a number, a boolean or null.`,
      { tool: toolName },
    )
  }
  const size = outcome["size"]
  if (typeof size !== "number") {
    throw new ToolError("internal_error", `The QuickJS tier returned no result for ${toolName}.`, { tool: toolName })
  }
  const json = outcome["json"]
  if (typeof json !== "string") throw tooLarge(toolName, size, limits.maxResultBytes)
  const bytes = Buffer.byteLength(json, "utf8")
  if (bytes > limits.maxResultBytes) throw tooLarge(toolName, bytes, limits.maxResultBytes)
  return JSON.parse(json) as JsonValue
}

function unfinished(toolName: string, limits: ExecutionLimits): ToolError {
  return new ToolError(
    "timeout",
    `${toolName} did not finish within ${limits.timeoutMs} ms. Make the Body do less work, and make sure every promise it awaits settles.`,
    { tool: toolName, timeoutMs: limits.timeoutMs },
  )
}

function translate(failure: unknown, toolName: string, deadline: number, limits: ExecutionLimits): ToolError {
  const thrown = describeFailure(failure)
  // A Body can throw an Error that looks interrupted, so trust the clock, not the message.
  if (thrown.name === "InternalError" && thrown.message === "interrupted" && Date.now() >= deadline) {
    return new ToolError(
      "timeout",
      `${toolName} ran longer than ${limits.timeoutMs} ms and was stopped. Make the Body do less work, or split it across more than one Tool.`,
      { tool: toolName, timeoutMs: limits.timeoutMs },
    )
  }
  if (thrown.name === "InternalError" && thrown.message === "out of memory") {
    return new ToolError(
      "call_failed",
      `${toolName} asked for more than ${limits.memoryLimitBytes} bytes of memory. Hold less data at once.`,
      { tool: toolName, error: thrown.message },
    )
  }
  return new ToolError("call_failed", `${toolName} threw: ${thrown.message}`, { tool: toolName, error: thrown.message })
}

function describeFailure(failure: unknown): { name: string; message: string } {
  if (isPlainObject(failure) && typeof failure["message"] === "string") {
    const name = failure["name"]
    return { name: typeof name === "string" ? name : "Error", message: failure["message"] }
  }
  if (typeof failure === "string") return { name: "Error", message: failure }
  return { name: "Error", message: JSON.stringify(failure) ?? String(failure) }
}
