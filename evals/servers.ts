import { randomUUID, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { Credentials } from "./model.ts"

const HOST = "127.0.0.1"
const MAX_BODY_BYTES = 8 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 240_000

export interface Usage {
  requests: number
  input: number
  output: number
}

export interface Meter {
  // Already carries the run's secret: `${url}/<lane>` is what a caller points its base URL at.
  url: string
  lane(name: string): Usage
  // Answers this meter forwarded that carried no usage it could read, so an under-count is never silent.
  unreadable(): number
  // Why each of those could not be counted, once per distinct reason.
  reasons(): string[]
  stop(): Promise<void>
}

export interface Fixture {
  url: string
  stop(): Promise<void>
}

export function sum(left: Usage, right: Usage): Usage {
  return {
    requests: left.requests + right.requests,
    input: left.input + right.input,
    output: left.output + right.output,
  }
}

// Every model call of the run goes through here, so the cost in the results file is measured and not guessed.
// The first path segment is a secret this run made, because anything else on this machine could otherwise spend
// the operator's key through a loopback port; the second names the lane, so authoring and the daemon are counted apart.
export async function startMeter(credentials: Credentials): Promise<Meter> {
  const secret = randomUUID()
  const lanes = new Map<string, Usage>()
  const uncounted: string[] = []
  const server = createServer((request, response) => {
    const missed = (why: string): void => {
      uncounted.push(why)
    }
    // The meter runs inside the runner's own process, so a provider that drops a body mid-answer must never reach
    // the event loop as an unhandled rejection: that would end the run with no results file written.
    void forward(request, response, credentials, secret, lanes, missed).catch((cause: unknown) => {
      const why = `the eval meter could not read the provider's answer: ${causeText(cause)}`
      missed(why)
      if (response.headersSent) response.destroy()
      else send(response, 502, { error: why })
    })
  })
  const url = await listen(server)
  return {
    url: `${url}/${secret}`,
    lane(name: string): Usage {
      return lanes.get(name) ?? { requests: 0, input: 0, output: 0 }
    },
    unreadable: () => uncounted.length,
    reasons: () => [...new Set(uncounted)],
    stop: () => close(server),
  }
}

// What the network prompts reach. The Manifest declares 127.0.0.1, so no eval Tool ever leaves this machine.
export async function startFixture(): Promise<Fixture> {
  const server = createServer((request, response) => {
    void answer(request, response)
  })
  return { url: await listen(server), stop: () => close(server) }
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  credentials: Credentials,
  secret: string,
  lanes: Map<string, Usage>,
  missed: (why: string) => void,
): Promise<void> {
  const [, given, lane, ...rest] = (request.url ?? "/").split("/")
  if (given === undefined || !timingSafeMatch(given, secret)) return send(response, 404, { error: "not found" })
  if (lane === undefined || lane === "" || rest.length === 0) return send(response, 404, { error: "no lane in the path" })
  let body: string
  try {
    body = await collect(request)
  } catch (cause) {
    return send(response, 413, { error: causeText(cause) })
  }
  const path = rest.join("/")
  if (credentials.provider === "openai" && path.endsWith("chat/completions")) body = withUsage(body)
  let upstream: Response
  try {
    upstream = await fetch(`${credentials.upstream}/${path}`, {
      method: request.method ?? "POST",
      headers: { ...credentials.headers, "content-type": "application/json" },
      ...(body === "" ? {} : { body }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (cause) {
    // An answer that never arrived may still be spend the provider recorded, so it is uncounted and not silent.
    const why = `the eval meter could not reach the provider: ${causeText(cause)}`
    missed(why)
    return send(response, 502, { error: why })
  }
  const text = await upstream.text()
  if (!tally(lanes, lane, text)) missed(uncountedWhy(lane, path, upstream, text))
  response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" })
  response.end(text)
}

function tally(lanes: Map<string, Usage>, lane: string, text: string): boolean {
  const usage = usageOf(text)
  if (usage === undefined) return false
  const held = lanes.get(lane) ?? { requests: 0, input: 0, output: 0 }
  held.requests += 1
  held.input += whole(usage["prompt_tokens"] ?? usage["input_tokens"])
  held.output += whole(usage["completion_tokens"] ?? usage["output_tokens"])
  lanes.set(lane, held)
  return true
}

// A chat completion that streams carries its usage only when the request asked for it, and an answer the meter
// cannot read makes the run's cost a guess: https://developers.openai.com/api/docs/api-reference/chat/create
function withUsage(body: string): string {
  const parsed = readJson(body)
  if (parsed === undefined || parsed["stream"] !== true) return body
  const options = readObject(parsed["stream_options"]) ?? {}
  return JSON.stringify({ ...parsed, stream_options: { ...options, include_usage: true } })
}

// A whole JSON answer carries usage at the top. A streamed one carries it in its events: OpenAI on the chunk
// before `[DONE]`, Anthropic on message_start and then message_delta, so a later event's fields win.
function usageOf(text: string): Record<string, unknown> | undefined {
  const whole = readJson(text)
  if (whole !== undefined) return usageIn(whole)
  let held: Record<string, unknown> | undefined
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const event = readJson(line.slice("data:".length).trim())
    const usage = event === undefined ? undefined : usageIn(event)
    if (usage !== undefined) held = { ...held, ...usage }
  }
  return held
}

// Everything here is shape and never content: a reason travels into the committed results file, and a provider's
// answer can carry the prompt back. The path is the route, not the body.
function uncountedWhy(lane: string, path: string, answer: Response, text: string): string {
  const type = (answer.headers.get("content-type") ?? "none").split(";")[0]
  return `${lane} lane: ${answer.status} from /${path}, ${type}, ${Buffer.byteLength(text)} bytes, ${shapeOf(text)}`
}

function shapeOf(text: string): string {
  if (text.trim() === "") return "an empty answer"
  const whole = readJson(text)
  if (whole !== undefined) return whole["error"] === undefined ? "JSON with no usage field" : "a provider error object"
  if (text.includes("data:")) return "server-sent events with no usage in any event"
  return "not JSON"
}

function usageIn(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return readObject(event["usage"]) ?? readObject(readObject(event["response"])?.["usage"])
}

function readJson(text: string): Record<string, unknown> | undefined {
  try {
    return readObject(JSON.parse(text))
  } catch {
    return undefined
  }
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function timingSafeMatch(given: string, secret: string): boolean {
  const left = Buffer.from(given)
  const right = Buffer.from(secret)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? "/").split("?")[0]
  if (path === "/status") return send(response, 200, { state: "green", checked: 7 })
  if (path === "/echo") {
    const body = await collect(request).catch(() => "")
    let message: unknown
    try {
      message = (JSON.parse(body) as { message?: unknown }).message
    } catch {
      return send(response, 400, { error: "the body is not JSON" })
    }
    return send(response, 200, { echo: message, received: true })
  }
  send(response, 404, { error: `no such path: ${path}` })
}

async function collect(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength
    if (size > MAX_BODY_BYTES) throw new Error(`a body over ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0
}

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function listen(server: Server): Promise<string> {
  return new Promise((done, fail) => {
    server.once("error", fail)
    server.listen(0, HOST, () => {
      const address = server.address()
      if (address === null || typeof address === "string") return fail(new Error("the server bound no port"))
      done(`http://${HOST}:${address.port}`)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections()
    server.close(() => done())
  })
}
