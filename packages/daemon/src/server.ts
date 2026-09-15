import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { ToolError } from "@flintd/core"
import type { CallMeta, CallOutcome, Flint, JsonValue, ObservationInput, ToolErrorCode } from "@flintd/core"
import type { ExportStatus } from "./export.ts"
import { mountMcp } from "./mcp.ts"
import type { ClientQuirks, McpSurface } from "./mcp.ts"

const HOST = "127.0.0.1"
const API = "/api/v1"
const MCP = "/mcp"
const MAX_BODY_BYTES = 1_048_576
const DEFAULT_STOP_GRACE_MS = 2000

const STATUS: Record<ToolErrorCode, number> = {
  invalid_name: 400,
  invalid_description: 400,
  invalid_schema: 400,
  invalid_source: 400,
  invalid_arguments: 400,
  invalid_examples: 400,
  invalid_result: 400,
  invalid_manifest: 400,
  awaiting_approval: 403,
  recursive_call: 400,
  example_failed: 400,
  call_failed: 400,
  unserializable_result: 400,
  result_too_large: 400,
  not_found: 404,
  exists: 409,
  duplicate: 409,
  dir_in_use: 409,
  not_implemented: 501,
  unauthorized: 401,
  forbidden: 403,
  method_not_allowed: 405,
  request_too_large: 413,
  worker_unavailable: 503,
  timeout: 504,
  store_error: 500,
  internal_error: 500,
  // A client raises this one when no daemon answered, so reaching this map at all would be a fault of this process.
  transport_failed: 500,
}

export interface DaemonOptions {
  flint: Flint
  token: string
  port: number
  clientQuirks?: ClientQuirks
  // How long close() waits for the calls in flight before it takes their connections away.
  stopGraceMs?: number
  // What each configured SKILL.md export directory holds, so `flintd status` says when one stopped working.
  exports?: () => ExportStatus[]
}

export interface Daemon {
  url: string
  port: number
  mcpUrl: string
  close(): Promise<void>
}

export async function serve(options: DaemonOptions): Promise<Daemon> {
  const server = createServer()
  await listen(server, options.port)
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : options.port
  const url = `http://${HOST}:${port}`
  const origins = new Set([url, `http://localhost:${port}`])
  const mcp = await mountMcp(options.flint, options.clientQuirks)
  server.on("request", (request, response) => {
    answer(options, origins, mcp, request, response).catch(() => response.destroy())
  })
  return {
    url,
    port,
    mcpUrl: `${url}${MCP}`,
    async close(): Promise<void> {
      // The MCP streams go first: a stream nobody ends is not idle, and close() would wait for it.
      await mcp.close()
      server.closeIdleConnections()
      // A call in flight holds its connection and server.close() waits for it, so Ctrl-C would wait the call
      // timeout out, which is five minutes on the container tier. The grace bounds that wait at stopGraceMs.
      const grace = setTimeout(() => server.closeAllConnections(), options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)
      try {
        await new Promise<void>((ok, fail) => {
          server.close((cause) => (cause === undefined ? ok() : fail(cause)))
        })
      } finally {
        clearTimeout(grace)
      }
    },
  }
}

async function answer(
  options: DaemonOptions,
  origins: ReadonlySet<string>,
  mcp: McpSurface,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const origin = request.headers.origin
    if (typeof origin === "string" && !origins.has(origin)) {
      throw new ToolError(
        "forbidden",
        "flintd answers its own origin only, so a page on another origin cannot reach this daemon.",
        { origin },
      )
    }
    if (!authorized(request, options.token)) {
      response.setHeader("WWW-Authenticate", "Bearer")
      throw new ToolError(
        "unauthorized",
        "flintd needs the bearer token that `flintd serve` wrote into the token file of the flintd home directory.",
        {},
      )
    }
    const url = new URL(request.url ?? "/", `http://${HOST}`)
    // The MCP transport writes its own answer, streams included, so it takes the response rather than returning a value.
    if (url.pathname.replace(/\/+$/, "") === MCP) {
      // The body is read here under the same cap as every other route, because a transport that read the stream itself would read any size.
      const body = request.method === "POST" ? await readBody(request) : undefined
      return await mcp.handle(request, response, body)
    }
    send(response, 200, await route(options, request, url))
  } catch (cause) {
    const error = cause instanceof ToolError ? cause : new ToolError("internal_error", "The daemon could not answer.")
    // The refusal can come while the client is still sending, and a connection nobody finishes never lets close() return.
    if (!request.readableEnded) response.setHeader("connection", "close")
    send(response, STATUS[error.code], { error: error.toJSON() })
  }
}

async function route(options: DaemonOptions, request: IncomingMessage, url: URL): Promise<JsonValue> {
  const flint = options.flint
  const method = request.method ?? "GET"
  const path = url.pathname.replace(/\/+$/, "")
  if (!path.startsWith(`${API}/`) && path !== API) throw unknownRoute(method, path)
  const rest = path.slice(API.length)

  if (rest === "/status") {
    return only(method, "GET", async () => ({
      status: { ...(await flint.status()), exports: options.exports?.() ?? [] } as unknown as JsonValue,
    }))
  }
  if (rest === "/tools") return only(method, "GET", async () => ({ tools: (await flint.tools()) as unknown as JsonValue[] }))
  if (rest === "/library") return only(method, "GET", async () => ({ library: (await flint.library()) as unknown as JsonValue[] }))
  if (rest === "/approvals") return only(method, "GET", async () => ({ approvals: (await flint.approvals()) as unknown as JsonValue[] }))
  if (rest === "/connections") {
    // The header value is write-only: it comes in on a POST and leaves flintd only as a header on a Tool's request.
    if (method === "POST") {
      return only(method, "POST", async () => ({
        connection: (await flint.connections.add(await readBody(request))) as unknown as JsonValue,
      }))
    }
    return only(method, "GET", async () => ({ connections: (await flint.connections.list()) as unknown as JsonValue[] }))
  }
  if (rest === "/observations") {
    // The hook binary writes here and the observer of a later ticket reads: no route ever changes or removes one.
    if (method === "POST") {
      return only(method, "POST", async () => ({
        observation: (await flint.observe((await readBody(request)) as unknown as ObservationInput)) as unknown as JsonValue,
      }))
    }
    return only(method, "GET", async () => ({
      observations: (await flint.observations({
        ...(url.searchParams.has("since") ? { since: String(url.searchParams.get("since")) } : {}),
        ...(url.searchParams.has("harness") ? { harness: String(url.searchParams.get("harness")) } : {}),
        ...(url.searchParams.has("limit") ? { limit: count(url.searchParams.get("limit")) as number } : {}),
      })) as unknown as JsonValue[],
    }))
  }
  if (rest === "/observe") {
    // POST runs the Observer, GET lists the retirement proposals. Neither route retires anything.
    if (method === "POST") {
      return only(method, "POST", async () => {
        const body = object(await readBody(request), "The body of an observe")
        return { run: (await flint.observer.run({ dryRun: body["dry_run"] === true })) as unknown as JsonValue }
      })
    }
    return only(method, "GET", async () => ({
      proposals: (await flint.observer.proposals()) as unknown as JsonValue[],
    }))
  }
  if (rest === "/find") {
    return only(method, "GET", async () => ({
      find: (await flint.find(url.searchParams.get("q") ?? "", limit(url))) as unknown as JsonValue[],
    }))
  }
  if (rest === "/call") {
    return only(method, "POST", async () => {
      const body = object(await readBody(request), "The body of a call")
      const call = await flint.callWithId(name(body["name"]), body["args"] ?? {}, callMeta(body["meta"]))
      return { call: { id: call.id, result: call.result } }
    })
  }

  const parts = rest.split("/")
  if (parts[1] === "connections" && parts[2] !== undefined && parts.length === 3) {
    return only(method, "DELETE", async () => ({
      connection: (await flint.connections.remove(segment(parts[2] as string))) as unknown as JsonValue,
    }))
  }
  if (parts[1] === "approvals" && parts[2] !== undefined && parts.length === 4) {
    const decision = parts[3]
    if (decision === "approve" || decision === "deny") {
      return only(method, "POST", async () => {
        const body = object(await readBody(request), "The body of an Approval decision")
        const note = body["note"]
        const id = segment(parts[2] as string)
        const said = note === undefined ? undefined : text(note, "note")
        const approval = decision === "approve" ? await flint.approve(id, said) : await flint.deny(id, said)
        return { approval: approval as unknown as JsonValue }
      })
    }
  }
  if (parts[1] === "calls" && parts[2] !== undefined && parts[3] === "report" && parts.length === 4) {
    return only(method, "POST", async () => {
      const body = object(await readBody(request), "The body of a report")
      const note = body["note"]
      const report = await flint.report(
        segment(parts[2] as string),
        body["outcome"] as CallOutcome,
        note === undefined ? undefined : text(note, "note"),
      )
      return { report: report as unknown as JsonValue }
    })
  }
  if (parts[1] === "tools" && parts[2] !== undefined) {
    const tool = segment(parts[2])
    if (parts.length === 3) {
      return only(method, "GET", async () => ({
        tool: await flint.call("tool_read", {
          name: tool,
          include_source: flag(url, "source"),
          include_examples: flag(url, "examples"),
        }),
      }))
    }
    if (parts.length === 4 && parts[3] === "history") {
      return only(method, "GET", async () => ({
        history: await flint.call("tool_history", {
          name: tool,
          ...(url.searchParams.has("before") ? { before: url.searchParams.get("before") } : {}),
          ...(url.searchParams.has("limit") ? { limit: count(url.searchParams.get("limit")) } : {}),
          include_source: flag(url, "source"),
        }),
      }))
    }
    if (parts.length === 4 && parts[3] === "restore") {
      return only(method, "POST", async () => {
        const body = object(await readBody(request), "The body of a restore")
        return {
          result: await flint.call("tool_update", { name: tool, restore_version: body["version"] }, callMeta(body["meta"])),
        }
      })
    }
    if (parts.length === 4 && parts[3] === "retire") {
      return only(method, "POST", async () => {
        const body = object(await readBody(request), "The body of a retire")
        return { result: await flint.call("tool_retire", { name: tool }, callMeta(body["meta"])) }
      })
    }
  }
  throw unknownRoute(method, path)
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false
  const given = Buffer.from(header.slice("Bearer ".length))
  const wanted = Buffer.from(token)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

async function only<T extends JsonValue>(method: string, allowed: string, run: () => T | Promise<T>): Promise<T> {
  if (method !== allowed && !(allowed === "GET" && method === "HEAD")) {
    throw new ToolError("method_not_allowed", `That path answers ${allowed}, not ${method}.`, { method, allowed })
  }
  return run()
}

async function readBody(request: IncomingMessage): Promise<JsonValue> {
  const type = request.headers["content-type"]
  if (typeof type === "string" && type !== "" && !type.startsWith("application/json")) {
    throw new ToolError("invalid_arguments", "flintd reads JSON only. Send Content-Type: application/json.", { type })
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      throw new ToolError(
        "request_too_large",
        `The request body is larger than ${MAX_BODY_BYTES} bytes. Send less: a reference, a path, or one page of the data.`,
        { maximum: MAX_BODY_BYTES },
      )
    }
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (text === "") return {}
  try {
    return JSON.parse(text) as JsonValue
  } catch (cause) {
    throw new ToolError("invalid_arguments", "The request body is not valid JSON.", {
      reason: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

function object(body: JsonValue, what: string): { [key: string]: JsonValue } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ToolError("invalid_arguments", `${what} must be a JSON object.`, {})
  }
  return body
}

function segment(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new ToolError("invalid_name", `The path holds ${JSON.stringify(part)}, which is not valid percent encoding.`, {
      name: part,
    })
  }
}

function text(value: JsonValue, field: string): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_arguments", `The ${field} must be a string.`, { received: typeof value })
  }
  return value
}

function name(value: JsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_arguments", 'A call needs a "name": the Tool to run.', { received: typeof value })
  }
  return value
}

function callMeta(value: JsonValue | undefined): CallMeta {
  if (value === undefined) return {}
  return object(value, "The call meta") as CallMeta
}

// The meaning of a limit is the Library's to refuse, so a word where a number belongs comes back as NaN and is refused there.
function limit(url: URL): number | undefined {
  const given = url.searchParams.get("limit")
  return given === null ? undefined : Number(given)
}

function flag(url: URL, key: string): boolean {
  const value = url.searchParams.get(key)
  return value === "" || value === "1" || value === "true"
}

function count(value: string | null): JsonValue {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : (value as JsonValue)
}

function unknownRoute(method: string, path: string): ToolError {
  return new ToolError(
    "not_found",
    `flintd has no ${method} ${path}. The REST surface is GET ${API}/tools, GET ${API}/library, GET ${API}/find, POST ${API}/call, POST ${API}/calls/<id>/report, GET ${API}/status, GET ${API}/approvals, POST ${API}/approvals/<id>/approve and deny, ${API}/connections with GET, POST and DELETE ${API}/connections/<name>, ${API}/observations with GET and POST, ${API}/observe with GET and POST, and ${API}/tools/<name> with history, restore and retire.`,
    { method, path },
  )
}

function send(response: ServerResponse, status: number, payload: JsonValue): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8")
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length })
  response.end(body)
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((ok, fail) => {
    server.once("error", fail)
    server.listen(port, HOST, () => {
      server.off("error", fail)
      ok()
    })
  })
}
