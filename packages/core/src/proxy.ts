import { CONTROL, HEADER_NAME, connectionFor, declaredConnections, missingConnections } from "./connections.ts"
import { ToolError, causeMessage } from "./errors.ts"
import { redact } from "./redact.ts"
import { isPlainObject } from "./validate.ts"
import type { ExecuteRequest } from "./engine.ts"
import type { Connection, JsonValue } from "./types.ts"

const MAX_REDIRECTS = 3
const MAX_HEADERS = 20
const MAX_HEADER_LENGTH = 2048
const MAX_URL_LENGTH = 2048
const METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
// A response header flintd does not name here never reaches a Body: a Set-Cookie or a rewritten credential is not what a Tool asked for.
const ANSWERED_HEADERS: readonly string[] = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "location",
  "retry-after",
]
// A Body sets none of these: three are the connection's own, one names the host, and the last three are credentials flintd attaches itself.
const NEVER_SENT: readonly string[] = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "cookie",
  "proxy-authorization",
]

export interface ProxyOptions {
  connections: readonly Connection[]
  stillApproved: (() => boolean) | undefined
  expiresAt: number
}

interface Ask {
  method: string
  headers: Map<string, string>
  body: string | undefined
}

interface Attempt {
  toolName: string
  target: URL
  signal: AbortSignal
  withinMs: number
  maximum: number
}

// It runs on the main thread, in every tier, because the thing a Body must never hold is the credential it uses (ADR 0002).
export async function fetchCall(request: ExecuteRequest, argument: JsonValue, options: ProxyOptions): Promise<JsonValue> {
  const { toolName, manifest, limits } = request
  const declared = declaredConnections(options.connections, manifest.connections ?? [])
  const ask = askOf(toolName, argument)
  let target = urlOf(toolName, argument)
  const withinMs = Math.min(limits.fetchTimeoutMs, options.expiresAt - Date.now())
  if (withinMs <= 0) throw timedOut(toolName, target.hostname, limits.fetchTimeoutMs)
  const signal = AbortSignal.timeout(withinMs)
  for (let hop = 0; ; hop += 1) {
    // Every hop asks again, so a redirect chain cannot outlive the decision that let the first hop go.
    if (options.stillApproved !== undefined && !options.stillApproved()) {
      throw refuse(
        `The Approval that let ${toolName} reach the network is no longer in force, so flintd stopped this request. Ask for the Manifest to be approved again.`,
      )
    }
    const attempt: Attempt = { toolName, target, signal, withinMs, maximum: limits.maxFetchBytes }
    const applied = allow(request, declared, options.connections, target)
    const response = await send(attempt, ask, headersFor(ask, declared, applied))
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null
    if (location === null) return await answer(attempt, response)
    void response.body?.cancel().catch(() => undefined)
    if (hop === MAX_REDIRECTS) {
      throw refuse(`${target.href} redirected ${toolName} more than ${MAX_REDIRECTS} times. Call the final URL itself.`)
    }
    // The next turn checks the new host the same way, so a redirect reaches only a declared host and one host's Connection never travels to another.
    target = redirectTo(toolName, target, location)
    if (response.status === 303 || (ask.method !== "GET" && ask.method !== "HEAD" && response.status < 307)) {
      ask.method = "GET"
      ask.body = undefined
    }
  }
}

// No wildcard, no suffix match, and no allowance for a loopback or a private address: a Tool reaches 127.0.0.1 only where 127.0.0.1 is written down.
function allow(
  request: ExecuteRequest,
  declared: readonly Connection[],
  connections: readonly Connection[],
  target: URL,
): Connection | undefined {
  const { toolName, manifest } = request
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw refuse(
      `${toolName} asked for ${JSON.stringify(target.protocol.replace(":", ""))}, and flintd carries http and https only. Use an https URL.`,
    )
  }
  const hostname = target.hostname.toLowerCase()
  const applied = connectionFor(connections, manifest.connections ?? [], hostname)
  if (applied !== undefined) return applied
  if ((manifest.hosts ?? []).includes(hostname)) return undefined
  // A Manifest hostname carries no brackets, so the advice must not ask for "[::1]": a model told to declare it would be refused forever.
  if (hostname.startsWith("[")) {
    throw refuse(
      `${toolName} tried to reach the IPv6 address ${hostname}, and a Manifest declares hostnames, not IPv6 literals. Use the hostname that answers at that address, or an IPv4 address, and declare that in "hosts".`,
    )
  }
  throw refuse(
    `${toolName} tried to reach ${hostname}, and its Manifest does not declare it. Add ${JSON.stringify(hostname)} to "hosts" with tool_update, or name a Connection in "connections" whose hosts carry it, and have the new Manifest approved.${missing(manifest.connections ?? [], connections)}${held(declared)}`,
    "hosts",
  )
}

// The Body's headers, then flintd's: what a Body set can never be what a Connection sends.
function headersFor(ask: Ask, declared: readonly Connection[], applied: Connection | undefined): Headers {
  const headers = new Headers()
  const stripped = new Set([...NEVER_SENT, ...declared.map((one) => one.header.name)])
  for (const [name, value] of ask.headers) {
    if (!stripped.has(name)) headers.set(name, value)
  }
  if (applied !== undefined) headers.set(applied.header.name, applied.header.value)
  return headers
}

async function send(attempt: Attempt, ask: Ask, headers: Headers): Promise<Response> {
  try {
    return await fetch(attempt.target, {
      method: ask.method,
      headers,
      redirect: "manual",
      signal: attempt.signal,
      ...(ask.body === undefined ? {} : { body: ask.body }),
    })
  } catch (cause) {
    if (attempt.signal.aborted) throw timedOut(attempt.toolName, attempt.target.hostname, attempt.withinMs)
    throw refuse(`${attempt.toolName} could not reach ${attempt.target.hostname}: ${causeMessage(cause)}.`)
  }
}

async function answer(attempt: Attempt, response: Response): Promise<JsonValue> {
  const body = await read(attempt, response)
  const headers: { [key: string]: JsonValue } = {}
  for (const name of ANSWERED_HEADERS) {
    const value = response.headers.get(name)
    // An upstream reflects a request header into an ETag or a Location as readily as into a body.
    if (value !== null) headers[name] = redact(value)
  }
  return { status: response.status, headers, body: parse(response.headers.get("content-type"), body) }
}

async function read(attempt: Attempt, response: Response): Promise<string> {
  const stream = response.body
  if (stream === null) return ""
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      size += (chunk as Uint8Array).byteLength
      if (size > attempt.maximum) {
        await stream.cancel().catch(() => undefined)
        throw tooLarge(attempt.toolName, attempt.target.hostname, attempt.maximum)
      }
      chunks.push(Buffer.from(chunk as Uint8Array))
    }
  } catch (cause) {
    if (cause instanceof ToolError) throw cause
    // An upstream that sends its headers and then stalls times out here rather than in the send above.
    if (attempt.signal.aborted) throw timedOut(attempt.toolName, attempt.target.hostname, attempt.withinMs)
    throw refuse(`${attempt.toolName} could not read the answer from ${attempt.target.hostname}: ${causeMessage(cause)}.`)
  }
  // An upstream that quotes the credential back would hand a Body what the Proxy exists to keep from it.
  return redact(Buffer.concat(chunks).toString("utf8"))
}

function parse(contentType: string | null, body: string): JsonValue {
  if (contentType === null || !/\bjson\b/i.test(contentType)) return body
  try {
    return JSON.parse(body) as JsonValue
  } catch {
    // A host that promises JSON and sends something else still owes the Body an answer it can look at.
    return body
  }
}

function redirectTo(toolName: string, target: URL, location: string): URL {
  try {
    return new URL(location, target)
  } catch {
    throw refuse(`${target.hostname} redirected ${toolName} to ${JSON.stringify(location.slice(0, 200))}, which is not a URL.`)
  }
}

function urlOf(toolName: string, argument: JsonValue): URL {
  const written = isPlainObject(argument) ? argument["url"] : undefined
  if (typeof written !== "string" || written === "" || written.length > MAX_URL_LENGTH) {
    throw refuse(`${toolName} called ctx.fetch without a URL. Call it as ctx.fetch(url, init).`)
  }
  try {
    return new URL(written)
  } catch {
    throw refuse(
      `${toolName} called ctx.fetch with ${JSON.stringify(written.slice(0, 200))}, which is not an absolute URL. Write the whole URL, starting with https://.`,
    )
  }
}

function askOf(toolName: string, argument: JsonValue): Ask {
  const init = isPlainObject(argument) ? argument["init"] : undefined
  if (init === undefined || init === null) return { method: "GET", headers: new Map(), body: undefined }
  if (!isPlainObject(init)) {
    throw refuse(`${toolName} called ctx.fetch with something that is not a request. Call it as ctx.fetch(url, { method, headers, body }).`)
  }
  const method = init["method"] === undefined ? "GET" : String(init["method"]).toUpperCase()
  if (!METHODS.includes(method)) {
    throw refuse(`${toolName} asked for the method ${JSON.stringify(method)}. flintd sends ${METHODS.join(", ")}.`)
  }
  const body = init["body"]
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw refuse(`${toolName} passed a body that is not text. Pass a string, such as JSON.stringify(payload).`)
  }
  if (body !== undefined && body !== null && (method === "GET" || method === "HEAD")) {
    throw refuse(`${toolName} passed a body with a ${method}. Use POST, PUT or PATCH to send one.`)
  }
  return {
    method,
    headers: headerMap(toolName, init["headers"]),
    body: typeof body === "string" ? body : undefined,
  }
}

function headerMap(toolName: string, value: JsonValue | undefined): Map<string, string> {
  const headers = new Map<string, string>()
  if (value === undefined || value === null) return headers
  if (!isPlainObject(value)) {
    throw refuse(`${toolName} passed headers that are not an object. Pass { "accept": "application/json" }.`)
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_HEADERS) {
    throw refuse(`${toolName} passed ${entries.length} headers and the limit is ${MAX_HEADERS}.`)
  }
  for (const [name, held] of entries) {
    if (typeof held !== "string" || held.length > MAX_HEADER_LENGTH) {
      throw refuse(`The header ${JSON.stringify(name)} of ${toolName} must be a string of at most ${MAX_HEADER_LENGTH} characters.`)
    }
    if (!HEADER_NAME.test(name)) {
      throw refuse(
        `${toolName} passed the header name ${JSON.stringify(name.slice(0, 80))}, which is not an HTTP header name. Use a name such as "accept" or "x-api-key": letters, digits and the punctuation an HTTP header allows, with no space.`,
      )
    }
    // A carriage return in a value would let one header become two on the wire.
    if (CONTROL.test(held)) {
      throw refuse(
        `${toolName} passed a header value for ${JSON.stringify(name)} that holds a control character. Take the line break out of the value.`,
      )
    }
    headers.set(name.toLowerCase(), held)
  }
  return headers
}

function held(declared: readonly Connection[]): string {
  if (declared.length === 0) return ""
  return ` The Connections this Manifest names reach: ${declared.map((one) => `${one.name} (${one.hosts.join(", ")})`).join("; ")}.`
}

// Only the operator can put a missing Connection right, so the refusal says so rather than advise adding the host.
function missing(names: readonly string[], connections: readonly Connection[]): string {
  const absent = missingConnections(connections, names)
  if (absent.length === 0) return ""
  return ` The Manifest names the Connection ${absent.map((one) => JSON.stringify(one)).join(", ")}, and this flintd holds none by that name: ask the operator to run \`flintd connect\`, or take the name out of the Manifest.`
}

function timedOut(toolName: string, hostname: string, withinMs: number): ToolError {
  return refuse(
    `${hostname} did not answer ${toolName} within ${withinMs} ms. Ask for less at a time, or call the Tool again.`,
  )
}

function tooLarge(toolName: string, hostname: string, maximum: number): ToolError {
  return refuse(
    `${hostname} sent ${toolName} more than ${maximum} bytes. Ask for one page of the data, or for a narrower query.`,
  )
}

// Every refusal reaches the Body as the message of a thrown Error, so the message is the whole answer: it names the host and what to change.
// `capability` marks the one refusal a Manifest waiting for its Approval causes, so a save can defer that Example.
function refuse(message: string, capability?: string): ToolError {
  return new ToolError("call_failed", message, capability === undefined ? {} : { capability })
}
