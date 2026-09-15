import { spawn } from "node:child_process"
import type { ExecuteRequest, HostCallName, RetireReason, SerializedError, WorkerCommand, WorkerMessage } from "./engine.ts"
import type { JsonSchema, JsonValue, ToolErrorCode } from "./types.ts"

// A Body can reach anything it can name. It can never name this, so it can never put a lifecycle code on the wire.
const FLINTD_ERROR = Symbol("flintd.error")

interface Allowed {
  tier: "node" | "container"
  builtins: string[]
  bundle: Record<string, string>
}

const ALLOWED = JSON.parse(process.argv[2] ?? '{"tier":"node","builtins":[],"bundle":{}}') as Allowed
// A container has none, so its channel is stdout, one JSON frame per line, and the Body's own console.log is moved to stderr below.
const CONTAINED = ALLOWED.tier === "container"
const BODY_PREFIX = "data:text/javascript;base64,"
const INTERVAL_ADVICE =
  "setInterval is not available in a Body: a call ends, and a repeating timer has nothing to repeat into. Use setTimeout inside a loop and return when the work is done."
const SHELL = "/bin/sh"
const CHANNEL_ADVICE = "The channel between flintd and this tier is not part of what a Body may reach."
const IMPORT_CALL = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g
// The intrinsics a Body can name. Each one is swept with its prototype chain and the chain of its `prototype`, which
// is how %TypedArray% and %TypedArray%.prototype are reached without being named.
const INTRINSICS = [
  "Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Promise", "Map", "Set",
  "WeakMap", "WeakSet", "RegExp", "Date", "JSON", "Math", "Error", "EvalError", "RangeError", "ReferenceError",
  "SyntaxError", "TypeError", "URIError", "AggregateError", "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Proxy", "Reflect", "Intl", "Iterator",
]

interface Body {
  execute(args: JsonValue, ctx: unknown): Promise<unknown>
  meta: object
}

interface Answer {
  ok(value: JsonValue): void
  fail(code: ToolErrorCode, message: string): void
}

interface Snapshot {
  keys: Map<string | symbol, PropertyDescriptor>
  extensible: boolean
}

type Answered = Extract<WorkerMessage, { type: "result" | "failure" }>
type Listener = (...given: unknown[]) => void

const answers = new Map<number, Answer>()
const live = new Set<NodeJS.Timeout>()
const immediates = new Set<NodeJS.Immediate>()
// A command is not a timer: when the call settles it is killed outright rather than left to a timer that has been swept.
const commands = new Set<ReturnType<typeof spawn>>()
// Every way a Body has of asking for a callback, taken before `capTimers` puts the held ones in their place.
const wait = globalThis.setTimeout
const stopWaiting = globalThis.clearTimeout
const soon = globalThis.setImmediate
const stopSoon = globalThis.clearImmediate
const microtask = globalThis.queueMicrotask
const tick = process.nextTick.bind(process)
const frame = process.stdout.write.bind(process.stdout)
const post = process.send?.bind(process)
// Taken before the seal, because the seal is what stops a Body reaching it, and the sweep below has to re-register.
// All four are taken here rather than named at the end of a call: they resolve through the prototype of `process`,
// which a Body can write to, and an end-of-call sweep that runs a Body's own function is no sweep at all.
const attach = process.on.bind(process)
const detach = process.removeListener.bind(process)
const attachedTo = process.eventNames.bind(process)
// `rawListeners`, so a listener the harness added with `once` goes back as the wrapper that still removes itself.
const listenersOf = process.rawListeners.bind(process)
// Every listener `process` carried before any Body could reach it, and what the end of a call puts back. An array
// and not a map, because the walk that reads it back runs after the Body and takes its index rather than an iterator.
const LISTENERS: { name: string | symbol; held: readonly Listener[] }[] = []
// Everything the sweep runs, held before any Body ran. A Body can write over any of these by name, and a sweep that
// runs a Body's own function is no sweep at all; for the same reason the sweep walks an array by index and never
// through an iterator, which is an object a Body reaches as readily as it reaches `Reflect`.
const ownKeys = Reflect.ownKeys
const describe = Reflect.getOwnPropertyDescriptor
const define = Reflect.defineProperty
const erase = Reflect.deleteProperty
const parentOf = Reflect.getPrototypeOf
const isOpen = Object.isExtensible
const sameValue = Object.is
const baseOf = WeakMap.prototype.get
const eachKey = Map.prototype.forEach
const holdsKey = Map.prototype.has
const eachHeld = Set.prototype.forEach
const emptyOut = Set.prototype.clear
const emptyMap = Map.prototype.clear
const countOf = (Object.getOwnPropertyDescriptor(Set.prototype, "size") as PropertyDescriptor).get as () => number
// Every object a Body may write over, as it was before any Body ran, and the order the sweep walks them in. None of
// this is the default answer: a fresh child per call is, and a sweep is what the warm path has instead.
const BASE = new WeakMap<object, Snapshot>()
const SWEPT: object[] = []
let based = false
// What the resolve hook has handed on, and what of it the sweep holds a baseline for. A Body that names its import
// with anything but a literal is the one case where the two differ, and the child is retired rather than swept.
const IMPORTED = new Set<string>()
const BASELINED = new Set<string>()
let nextCall = 1
// One runner takes one request at a time, so the call in flight owns this. It is what bounds a command.
let deadline = 0
let inFlight: number | null = null

if (CONTAINED) process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write

const ready = await lockDown()
if (ready === null) {
  listen()
  sealChannel()
  holdListeners()
  send({ type: "ready" })
} else {
  send({ type: "unavailable", error: { code: "worker_unavailable", message: ready, details: {} } })
}

function listen(): void {
  if (!CONTAINED) {
    attach("message", onFrame)
    return
  }
  let held = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    held += chunk
    for (let cut = held.indexOf("\n"); cut >= 0; cut = held.indexOf("\n")) {
      const line = held.slice(0, cut)
      held = held.slice(cut + 1)
      if (line !== "") receive(JSON.parse(line) as WorkerCommand)
    }
  })
}

// The harness has its listener and its writer by now, and neither is the Body's: one that reads the channel reads
// another call's frames, and one that writes it speaks for another Tool. `process.channel` stays because Node's own
// reader of the channel reads it, and the object it holds answers `ref`, `unref` and `fd` and no frame at all.
function sealChannel(): void {
  const held = process as unknown as Record<string, unknown>
  const refuse = (): never => {
    throw new Error(CHANNEL_ADVICE)
  }
  for (const name of ["on", "once", "addListener", "prependListener", "prependOnceListener"]) {
    const add = (held[name] as (event: string, listener: unknown) => unknown).bind(process)
    seal(name, (event: string, listener: unknown) => (event === "message" ? refuse() : add(event, listener)))
  }
  for (const name of ["send", "disconnect"]) seal(name, refuse)
}

function holdListeners(): void {
  const names = attachedTo()
  for (let at = 0; at < names.length; at += 1) {
    const name = names[at] as string
    LISTENERS.push({ name, held: listenersOf(name) as Listener[] })
  }
}

// A Body reaches EventEmitter.prototype whatever the seal holds, so what it attached ends with its own call, and
// `"message"` is not the only event it can attach to: the whole map goes back the way it was. Only the difference is
// written, because the IPC channel counts its own `"message"` listeners and refuses to read once the count reaches 0.
function restoreListeners(): void {
  const names = attachedTo()
  for (let at = 0; at < names.length; at += 1) {
    const name = names[at] as string
    const now = listenersOf(name) as Listener[]
    for (let one = 0; one < now.length; one += 1) {
      const listener = now[one] as Listener
      if (!snapshotHolds(name, listener)) detach(name, listener)
    }
  }
  for (let at = 0; at < LISTENERS.length; at += 1) {
    const one = LISTENERS[at] as { name: string | symbol; held: readonly Listener[] }
    const now = listenersOf(one.name as string) as Listener[]
    for (let held = 0; held < one.held.length; held += 1) {
      const listener = one.held[held] as Listener
      if (!carries(now, listener)) attach(one.name, listener)
    }
  }
}

function snapshotHolds(name: string | symbol, listener: Listener): boolean {
  for (let at = 0; at < LISTENERS.length; at += 1) {
    const one = LISTENERS[at] as { name: string | symbol; held: readonly Listener[] }
    if (one.name === name && carries(one.held, listener)) return true
  }
  return false
}

function carries(held: readonly Listener[], listener: Listener): boolean {
  for (let at = 0; at < held.length; at += 1) if (held[at] === listener) return true
  return false
}

function seal(name: string, value: unknown): void {
  Object.defineProperty(process, name, { value, writable: false, configurable: false })
}

function onFrame(command: WorkerCommand): void {
  receive(command)
}

function receive(command: WorkerCommand): void {
  if (command.type === "execute") {
    // One runner is handed one request at a time, so a second execute is not the harness's: it is a frame a Body wrote.
    if (inFlight !== null) return
    inFlight = command.request.id
    void execute(command.request)
    return
  }
  const waiting = answers.get(command.call)
  if (waiting === undefined) return
  answers.delete(command.call)
  if (command.type === "host-result") waiting.ok(command.value)
  else waiting.fail(command.code, command.message)
}

// The import allowlist is a save-time check over the Body's AST, and a Body is a real module that can ask for more than its source shows.
async function lockDown(): Promise<string | null> {
  const loader = (await import("node:module")) as { registerHooks?: (hooks: unknown) => void }
  if (typeof loader.registerHooks !== "function") {
    return `the Node tier needs module.registerHooks, and ${process.version} does not have it`
  }
  const held = process as unknown as Record<string, unknown>
  for (const name of ["getBuiltinModule", "binding", "_linkedBinding", "dlopen"]) delete held[name]
  // Below Node 25 the permission model cannot refuse a socket, so the network client a Body could name is taken away instead.
  const reachable = globalThis as unknown as Record<string, unknown>
  // Read before the delete: Node's `fetch` is a lazy getter, and the undici it loads puts two non-configurable
  // symbols on `globalThis`. Loading it here puts them there before the baseline, where they belong to nobody.
  void reachable["fetch"]
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) delete reachable[name]
  capTimers()
  loader.registerHooks({
    resolve(specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown): unknown {
      // A Bundle package resolves to the one file `pnpm build` wrote for it, never to anything under node_modules.
      // An own-property check, not a lookup: "constructor" and "__proto__" are on every object, and neither is a Bundle name.
      const bundled = Object.hasOwn(ALLOWED.bundle, specifier) ? ALLOWED.bundle[specifier] : undefined
      if (bundled !== undefined) {
        IMPORTED.add(bundled)
        return next(bundled, context)
      }
      if (specifier.startsWith(BODY_PREFIX)) return next(specifier, context)
      if (ALLOWED.builtins.includes(specifier)) {
        IMPORTED.add(specifier)
        return next(specifier, context)
      }
      throw Object.assign(new Error(`flintd does not ship ${JSON.stringify(specifier)}, so no Body may import it.`), {
        [FLINTD_ERROR]: { code: "call_failed", message: `flintd does not ship ${JSON.stringify(specifier)}, so no Body may import it.`, details: {} },
      })
    },
  })
  return null
}

function baseline(target: object): void {
  if (BASE.has(target)) return
  const keys = new Map<string | symbol, PropertyDescriptor>()
  const found = ownKeys(target)
  for (let at = 0; at < found.length; at += 1) {
    const key = found[at] as string | symbol
    const held = describe(target, key)
    if (held !== undefined) keys.set(key, held)
  }
  BASE.set(target, { keys, extensible: isOpen(target) })
  SWEPT.push(target)
}

// The child stays warm for the next call of its Tool, so what one Body writes to these is what the next one would
// read. Taken at the first request and not at startup, because reading a global is what makes Node define the one it
// holds lazily, and what that load puts on `globalThis` beside it can be non-configurable and is nobody's write.
function baselineChild(): void {
  if (based) return
  based = true
  for (const key of ownKeys(globalThis)) void reachable(key)
  baselineChain(globalThis)
  // One level in from every global and up every prototype chain, so a write to `process`, to `console` or to the
  // `EventEmitter.prototype` that `process` is built on is one the sweep undoes. Replacing `emit` there is how a
  // Body would read the next call's own execute frame, its arguments and its token.
  for (const key of ownKeys(globalThis)) baselineChain(reachable(key))
  // Two levels in, and named because it is the one such object a Body could hand a secret to its next caller through.
  baseline(process.env)
  for (const name of INTRINSICS) baselineIntrinsic(reachable(name))
  for (const held of unnamed()) baselineIntrinsic(held)
}

function baselineIntrinsic(held: unknown): void {
  if (!isObject(held)) return
  baselineChain(held)
  baselineChain(describe(held, "prototype")?.value)
}

// A name cannot reach these: an iterator prototype and the generator prototypes have no global name, and a walk from
// `globalThis` never arrives at one, so only the value an expression yields names them. Each carries its own chain
// and the chain of its `prototype`, which is how %GeneratorPrototype% and %AsyncGeneratorPrototype% are reached.
function unnamed(): unknown[] {
  return [
    parentOf([][Symbol.iterator]()),
    parentOf(""[Symbol.iterator]()),
    parentOf(new Map()[Symbol.iterator]()),
    parentOf(new Set()[Symbol.iterator]()),
    parentOf(new Uint8Array()[Symbol.iterator]()),
    parentOf(/(?:)/g[Symbol.matchAll]("")),
    parentOf(function* () {}),
    parentOf(async function () {}),
    parentOf(async function* () {}),
  ]
}

function reachable(key: string | symbol): unknown {
  return (globalThis as Record<string | symbol, unknown>)[key]
}

function baselineChain(value: unknown): void {
  for (let held = value; isObject(held); held = parentOf(held)) baseline(held)
}

// A Body's source is wrapped in a function, so every import it makes is a dynamic one that runs while the Body runs,
// and a baseline taken after that would hold what the Body wrote. These are the ones its own source names, imported
// and baselined before it runs. One it computes instead is not here, and the sweep retires the child over it.
async function baselineImports(body: string): Promise<void> {
  for (const found of body.matchAll(IMPORT_CALL)) {
    const specifier = found[1] ?? ""
    const bundled = Object.hasOwn(ALLOWED.bundle, specifier) ? ALLOWED.bundle[specifier] : undefined
    if (bundled === undefined && !ALLOWED.builtins.includes(specifier)) continue
    const resolved = bundled ?? specifier
    if (BASELINED.has(resolved)) continue
    BASELINED.add(resolved)
    // A namespace is not extensible and every export of it is non-configurable, so nothing can be added to it or
    // written over it. One level in, the exported objects, is where a Body's write lands and what the sweep holds.
    const namespace = (await import(specifier)) as object
    for (const key of ownKeys(namespace)) {
      const exported = describe(namespace, key)?.value as unknown
      // The export itself and its chain, and never its `prototype`: a package writes to its own class prototypes
      // after it is imported — zod installs 90 methods on `ZodString.prototype` at the first `z.string()` — and a
      // sweep that took those back would leave the next call with a package that no longer works.
      baselineChain(exported)
    }
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

// null when the target is what it was before the Body ran. A key the Body added goes and a key it wrote over comes
// back; a reason is a delete or a define the Body made impossible, and a call that ends with one takes the child.
function restore(target: object): RetireReason | null {
  const first = baseOf.call(BASE, target) as Snapshot | undefined
  if (first === undefined) return null
  let found: RetireReason | null = isOpen(target) === first.extensible ? null : "frozen_or_sealed"
  const now = ownKeys(target)
  for (let at = 0; at < now.length; at += 1) {
    const key = now[at] as string | symbol
    if (!holdsKey.call(first.keys, key) && !erase(target, key)) found ??= "non_configurable"
  }
  eachKey.call(first.keys, (was: PropertyDescriptor, key: string | symbol) => {
    const carries = describe(target, key)
    if (carries !== undefined && same(carries, was)) return
    if (!define(target, key, was)) found ??= "frozen_or_sealed"
  })
  return found
}

// `Object.is`, so a NaN the baseline holds is not written back on every call.
function same(now: PropertyDescriptor, held: PropertyDescriptor): boolean {
  return (
    sameValue(now.value, held.value) &&
    now.get === held.get &&
    now.set === held.set &&
    now.writable === held.writable &&
    now.enumerable === held.enumerable &&
    now.configurable === held.configurable
  )
}

// The first reason the walk finds, so one call is one reason and one line however many objects the Body changed.
function sweep(): RetireReason | null {
  let found: RetireReason | null = null
  // Every target is restored, and `??=` alone would stop at the first one that could not be: it never calls the rest.
  for (let at = 0; at < SWEPT.length; at += 1) {
    const one = restore(SWEPT[at] as object)
    found ??= one
  }
  return found ?? (countOf.call(IMPORTED) === countOf.call(BASELINED) ? null : "computed_import")
}

// Every callback a Body asks for is held here and cleared when the call settles, so none fires into a call that is over.
function capTimers(): void {
  globalThis.setTimeout = ((run: Listener, ms?: number, ...rest: unknown[]) => {
    const timer = wait(held(run, rest, () => live.delete(timer)), Math.max(0, Number(ms) || 0))
    live.add(timer)
    return timer
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((timer: NodeJS.Timeout) => {
    live.delete(timer)
    stopWaiting(timer)
  }) as typeof globalThis.clearTimeout
  globalThis.setImmediate = ((run: Listener, ...rest: unknown[]) => {
    const handle = soon(held(run, rest, () => immediates.delete(handle)))
    immediates.add(handle)
    return handle
  }) as typeof globalThis.setImmediate
  globalThis.clearImmediate = ((handle: NodeJS.Immediate) => {
    immediates.delete(handle)
    stopSoon(handle)
  }) as typeof globalThis.clearImmediate
  globalThis.queueMicrotask = ((run: Listener) => microtask(held(run, []))) as typeof globalThis.queueMicrotask
  process.nextTick = ((run: Listener, ...rest: unknown[]) => tick(held(run, rest))) as typeof process.nextTick
  globalThis.setInterval = (() => {
    throw new Error(INTERVAL_ADVICE)
  }) as typeof globalThis.setInterval
  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval
}

// A callback belongs to the call that asked for it. One that arrives after that call settled is dropped rather than
// run, because a callback that rearms itself outlives every clear, and a clear is all the end of a call can do.
function held(run: Listener, rest: unknown[], forget?: () => void): () => void {
  const call = inFlight
  return () => {
    forget?.()
    if (call !== null && call !== inFlight) return
    try {
      run(...rest)
    } catch {
      // A Body's callback is not the child's business. The QuickJS tier drops a throw here and so does this.
    }
  }
}

async function execute(request: ExecuteRequest): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  let outcome: Answered
  let retire: RetireReason | null = null
  try {
    baselineChild()
    deadline = Date.now() + request.limits.timeoutMs
    // The timer is armed before anything of this request runs, so the load and both `pattern` walks are inside it too.
    const value = await Promise.race([
      answer(request),
      new Promise<never>((_, fail) => {
        timer = wait(() => fail(failure("timeout", timedOut(request))), request.limits.timeoutMs)
      }),
    ])
    outcome = { type: "result", id: request.id, token: request.token, value: decode(request, value) }
  } catch (cause) {
    outcome = { type: "failure", id: request.id, token: request.token, error: serialize(request, cause) }
  } finally {
    if (timer !== undefined) stopWaiting(timer)
    eachHeld.call(live, (one: NodeJS.Timeout) => stopWaiting(one))
    emptyOut.call(live)
    eachHeld.call(immediates, (one: NodeJS.Immediate) => stopSoon(one))
    emptyOut.call(immediates)
    // Whatever a command started dies with the container when the pool retires it; this is what makes that the backstop rather than the only stop.
    eachHeld.call(commands, (running: ReturnType<typeof spawn>) => killTree(running))
    emptyOut.call(commands)
    // The answer to a host call of a finished request never arrives, so nothing may wait for it.
    emptyMap.call(answers)
    retire = sweep()
    // After the sweep: a Body that wrote over an iterator prototype is undone by then, and a walk of the listener
    // map before that would read an empty one and put the harness's own listener on twice.
    restoreListeners()
    inFlight = null
  }
  // The answer goes after the sweep, so the next request the harness sends can never reach a half-swept child.
  send(retire === null ? outcome : { ...outcome, retire })
}

// The load, both `pattern` walks and the Body, in one promise, so one timer bounds every part of the request.
async function answer(request: ExecuteRequest): Promise<unknown> {
  const module = (await load(request)) as Body
  await baselineImports(request.body)
  baseline(module.execute)
  baseline(module.meta)
  refusePattern(request, request.patterns?.args, request.args, "invalid_arguments", "the arguments")
  const value = await module.execute(request.args, context(request))
  refusePattern(request, request.patterns?.result, value, "invalid_result", "the result")
  return value
}

// A model wrote these regexes, so they run here. This process holds one request, and the pool restarts it if a
// regex takes the event loop with it, so the bound on a walk that never returns is terminateAfterMs, not this timer.
function refusePattern(
  request: ExecuteRequest,
  schema: JsonSchema | undefined,
  value: unknown,
  code: ToolErrorCode,
  subject: string,
): void {
  if (schema === undefined) return
  const bad = firstPattern(schema, value, "")
  if (bad === null) return
  const where = bad.at === "" ? subject : JSON.stringify(bad.at)
  throw failure(code, `${request.toolName}: ${where} must match the pattern ${JSON.stringify(bad.pattern)}.`)
}

function firstPattern(schema: JsonSchema, value: unknown, at: string): { at: string; pattern: string } | null {
  if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    return { at, pattern: schema.pattern }
  }
  if (schema.properties !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, member] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) continue
      const found = firstPattern(member, (value as Record<string, unknown>)[key], at === "" ? key : `${at}.${key}`)
      if (found !== null) return found
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = firstPattern(schema.items, value[index], `${at}[${index}]`)
      if (found !== null) return found
    }
  }
  return null
}

// The Body becomes a module, so its imports resolve the way the Bundle check read them.
function load(request: ExecuteRequest): Promise<unknown> {
  // `import.meta` and `execute` are the two module-level objects a Body can name and write to, and the export is what lets the call sweep them.
  const source = `export async function execute(args, ctx) {${request.body}\n}\nexport const meta = import.meta`
  return import(`${BODY_PREFIX}${Buffer.from(source, "utf8").toString("base64")}`)
}

function context(request: ExecuteRequest): unknown {
  return Object.freeze({
    toolName: request.toolName,
    log: async (message: unknown): Promise<void> => {
      await host(request, "log", String(message))
    },
    // The Manifest decides what these answer, and it decides it on the main thread, not here.
    fs: Object.freeze({
      read: (path: unknown) => host(request, "fs.read", String(path)),
      write: (path: unknown, text: unknown) => host(request, "fs.write", { path: String(path), text: String(text) }),
      list: (path: unknown) => host(request, "fs.list", String(path)),
    }),
    fetch: (url: unknown, init: unknown) =>
      host(request, "fetch", { url: String(url), init: (init === undefined ? null : init) as JsonValue }),
    callTool: (name: unknown, args: unknown) =>
      host(request, "callTool", { name: String(name), args: (args === undefined ? null : args) as JsonValue }),
    // A command runs inside the container and never on the host, so the container tier answers this itself.
    exec: (command: unknown, options: unknown) =>
      CONTAINED
        ? runCommand(request, command, options)
        : host(request, "exec", { command: String(command), options: (options === undefined ? null : options) as JsonValue }),
  })
}

async function runCommand(request: ExecuteRequest, written: unknown, given: unknown): Promise<JsonValue> {
  if (request.manifest.exec !== true) {
    throw failure("call_failed", `${request.toolName} called ctx.exec, and its Manifest does not ask for "exec".`)
  }
  const command = String(written ?? "")
  if (command.trim() === "") {
    throw failure(
      "invalid_arguments",
      `${request.toolName} called ctx.exec without a command. Pass the command line as a string, for example ctx.exec("ls -la").`,
    )
  }
  const options = (given ?? {}) as { cwd?: unknown; timeoutMs?: unknown; env?: unknown }
  const left = deadline - Date.now()
  if (left <= 0) throw failure("timeout", `${request.toolName} ran out of time before ctx.exec could start.`)
  const asked = Number(options.timeoutMs)
  const withinMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked, left) : left
  const cap = request.limits.maxExecBytes
  const began = Date.now()
  // The cwd is the container's own path, and the container is the boundary: nothing it can reach is outside it.
  const child = spawn(SHELL, ["-c", command], {
    cwd: options.cwd === undefined ? undefined : String(options.cwd),
    env: commandEnvironment(options.env),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const out = collector(cap)
  const err = collector(cap)
  child.stdout.on("data", (chunk: Buffer) => out.add(chunk))
  child.stderr.on("data", (chunk: Buffer) => err.add(chunk))
  commands.add(child)
  return new Promise<JsonValue>((done, fail) => {
    const timer = wait(() => killTree(child), withinMs)
    child.on("error", (cause: Error) => {
      commands.delete(child)
      stopWaiting(timer)
      fail(failure("call_failed", `${request.toolName} could not run the command: ${cause.message}`))
    })
    child.on("close", (code: number | null, signal: string | null) => {
      commands.delete(child)
      stopWaiting(timer)
      done({
        ok: code === 0,
        code,
        signal,
        stdout: out.read(),
        stderr: err.read(),
        durationMs: Date.now() - began,
      })
    })
  })
}

// The container's own environment, which is the image's and never the host's, plus what the Body asked for.
function commandEnvironment(given: unknown): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  if (given === null || typeof given !== "object") return environment
  for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
    if (name.includes("=") || name.includes("\0")) continue
    environment[name] = String(value)
  }
  return environment
}

function collector(cap: number): { add(chunk: Buffer): void; read(): string } {
  const held: Buffer[] = []
  let bytes = 0
  let cut = false
  return {
    add(chunk: Buffer): void {
      if (cut) return
      if (bytes + chunk.length <= cap) {
        held.push(chunk)
        bytes += chunk.length
        return
      }
      held.push(chunk.subarray(0, cap - bytes))
      cut = true
    },
    read: () => `${Buffer.concat(held).toString("utf8")}${cut ? `\n[cut at ${cap} bytes]` : ""}`,
  }
}

// The command is its own process group, so the signal reaches whatever it started as well as the shell itself.
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

function host(request: ExecuteRequest, name: HostCallName, argument: JsonValue): Promise<JsonValue> {
  return new Promise<JsonValue>((ok, fail) => {
    const call = nextCall++
    // The code travels with the message so a Body can read why a host call was refused.
    answers.set(call, { ok, fail: (code, message) => fail(Object.assign(new Error(message), { code })) })
    send({ type: "host", id: request.id, token: request.token, call, name, argument })
  })
}

function decode(request: ExecuteRequest, value: unknown): JsonValue {
  let json: string | undefined
  try {
    json = JSON.stringify(value === undefined ? null : value)
  } catch {
    json = undefined
  }
  if (json === undefined) {
    throw failure(
      "unserializable_result",
      `${request.toolName} returned a value that is not JSON. Return an object, an array, a string, a number, a boolean or null.`,
    )
  }
  const bytes = Buffer.byteLength(json, "utf8")
  if (bytes > request.limits.maxResultBytes) {
    throw failure(
      "result_too_large",
      `${request.toolName} returned about ${bytes} bytes and the limit is ${request.limits.maxResultBytes}. Return less: a summary, a count, or the first page of the data, and add an argument that selects the part the caller needs.`,
    )
  }
  return JSON.parse(json) as JsonValue
}

function timedOut(request: ExecuteRequest): string {
  return `${request.toolName} did not finish within ${request.limits.timeoutMs} ms. Make the Body do less work, and make sure every promise it awaits settles.`
}

function failure(code: SerializedError["code"], message: string): Error {
  return Object.assign(new Error(message), { [FLINTD_ERROR]: { code, message, details: {} } })
}

function serialize(request: ExecuteRequest, cause: unknown): SerializedError {
  const carried = (cause as Record<symbol, SerializedError | undefined>)[FLINTD_ERROR]
  if (carried !== undefined) return carried
  const message = cause instanceof Error ? cause.message : String(cause)
  return { code: "call_failed", message: `${request.toolName} threw: ${message}`, details: { tool: request.toolName } }
}

function send(message: WorkerMessage): void {
  if (CONTAINED) frame(`${JSON.stringify(message)}\n`)
  else post?.(message)
}
