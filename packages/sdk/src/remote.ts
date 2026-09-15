import { TOOL_ERROR_CODES, ToolError, formatTools } from "@flintd/core"
import type {
  ApprovalDecision,
  ApprovalEntry,
  CallMeta,
  CallOutcome,
  CallReport,
  CallResult,
  ConnectionSummary,
  FindEntry,
  Flint,
  FlintStatus,
  JsonValue,
  LibraryEntry,
  Observation,
  ObservationInput,
  ObservationQuery,
  ObserverRun,
  RetirementProposal,
  ToolDefinition,
  ToolErrorCode,
  ToolFormat,
  ToolFormats,
} from "@flintd/core"

const DEFAULT_TIMEOUT_MS = 35_000
const API = "/api/v1"

export interface RemoteOptions {
  url: string
  token: string
  timeoutMs?: number
}

// The remote client is a Flint and nothing beside it, so the two shapes cannot drift apart again.
export type FlintClient = Flint

export function createRemoteFlint(options: RemoteOptions): Flint {
  if (typeof options.url !== "string" || options.url === "") {
    throw new ToolError("internal_error", "createFlint needs a `url`: the address the daemon logged when it started.")
  }
  if (typeof options.token !== "string" || options.token === "") {
    throw new ToolError("internal_error", "createFlint needs a `token`: the one in the token file of the flintd home.")
  }
  const base = options.url.replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function request(path: string, body?: JsonValue, verb?: string): Promise<JsonValue> {
    const headers: Record<string, string> = { authorization: `Bearer ${options.token}`, accept: "application/json" }
    if (body !== undefined) headers["content-type"] = "application/json"
    let response: Response
    try {
      response = await fetch(`${base}${API}${path}`, {
        method: verb ?? (body === undefined ? "GET" : "POST"),
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (cause) {
      throw unreachable(base, cause, timeoutMs)
    }
    const text = await response.text().catch(() => "")
    let payload: JsonValue
    try {
      payload = JSON.parse(text) as JsonValue
    } catch {
      throw new ToolError("internal_error", `The daemon at ${base} answered with something that is not JSON.`, {
        status: response.status,
      })
    }
    if (!response.ok) throw revive(payload, response.status, base)
    return payload
  }

  const watchers = new Set<() => void>()
  const waiting = new Set<(request: ApprovalEntry) => void>()
  let listed = ""

  // A daemon pushes nothing over REST, so a client tells its watchers only about the changes it caused itself.
  async function announce(): Promise<void> {
    if (watchers.size === 0) return
    // A list this client could not read again leaves a watcher waiting; it never turns a call that worked into a refusal.
    const now = await fetched()
      .then((list) => JSON.stringify(list))
      .catch(() => undefined)
    if (now === undefined || now === listed) return
    listed = now
    for (const watcher of watchers) watcher()
  }

  async function fetched(): Promise<ToolDefinition[]> {
    return ((await request("/tools")) as { tools: unknown }).tools as ToolDefinition[]
  }

  async function held(): Promise<LibraryEntry[]> {
    return ((await request("/library")) as { library: unknown }).library as LibraryEntry[]
  }

  function tools(): Promise<ToolDefinition[]>
  function tools<F extends ToolFormat>(format: F): Promise<ToolFormats[F]>
  async function tools(format?: ToolFormat): Promise<unknown> {
    const list = await fetched()
    if (format === undefined) return list
    // The MCP shape reads a Tool's Manifest for its annotations, which is the one format that costs a second request.
    if (format === "mcp") return formatTools(list, "mcp", new Map((await held()).map((one) => [one.name, one.manifest])))
    return formatTools(list, format)
  }

  async function approvals(): Promise<ApprovalEntry[]> {
    return ((await request("/approvals")) as { approvals: unknown }).approvals as ApprovalEntry[]
  }

  // The refusal names the Approval the call waits on, which is when a developer wants to be asked; the watcher decides it with approve(id).
  async function raised(cause: unknown): Promise<void> {
    if (waiting.size === 0 || !(cause instanceof ToolError) || cause.code !== "awaiting_approval") return
    const id = String(cause.details["approval"] ?? "")
    const held = (await approvals().catch(() => [])).find((one) => one.id === id)
    if (held === undefined) return
    for (const watcher of waiting) watcher(held)
  }

  async function decided(id: string, decision: "approve" | "deny", note?: string): Promise<ApprovalDecision> {
    const answer = (await request(`/approvals/${encodeURIComponent(id)}/${decision}`, {
      ...(note === undefined ? {} : { note }),
    })) as { approval?: unknown }
    await announce()
    return answer.approval as ApprovalDecision
  }

  async function callWithId(name: string, args: unknown, meta: CallMeta = {}): Promise<CallResult> {
    let answer: { call?: unknown }
    try {
      answer = (await request("/call", { name, args: args as JsonValue, meta: meta as JsonValue })) as { call?: unknown }
    } catch (cause) {
      await raised(cause)
      throw cause
    }
    await announce()
    return answer.call as CallResult
  }

  return {
    async start(): Promise<void> {
      await request("/status")
    },

    async stop(): Promise<void> {
      // A remote daemon belongs to whoever started it, so a client never stops it.
    },

    async status(): Promise<FlintStatus> {
      return ((await request("/status")) as { status: unknown }).status as FlintStatus
    },

    library: held,

    tools,

    onChange(watcher: () => void): () => void {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },

    onApproval(watcher: (request: ApprovalEntry) => void): () => void {
      waiting.add(watcher)
      return () => waiting.delete(watcher)
    },

    async find(query: string, limit?: number): Promise<FindEntry[]> {
      const asked = new URLSearchParams({ q: query, ...(limit === undefined ? {} : { limit: String(limit) }) })
      return ((await request(`/find?${asked.toString()}`)) as { find: unknown }).find as FindEntry[]
    },

    // Never through `this`: a client that is destructured must behave the same as one that is not.
    async call(name: string, args: unknown, meta: CallMeta = {}): Promise<JsonValue> {
      return (await callWithId(name, args, meta)).result
    },

    callWithId,

    approvals,

    async observations(query: ObservationQuery = {}): Promise<Observation[]> {
      const search = new URLSearchParams()
      if (query.since !== undefined) search.set("since", query.since)
      if (query.harness !== undefined) search.set("harness", query.harness)
      if (query.limit !== undefined) search.set("limit", String(query.limit))
      const path = search.size === 0 ? "/observations" : `/observations?${search.toString()}`
      return ((await request(path)) as { observations: unknown }).observations as Observation[]
    },

    async observe(observation: ObservationInput): Promise<Observation> {
      return ((await request("/observations", observation as unknown as JsonValue)) as { observation: unknown })
        .observation as Observation
    },

    observer: {
      async run(asked: { dryRun?: boolean } = {}): Promise<ObserverRun> {
        return ((await request("/observe", { dry_run: asked.dryRun === true })) as { run: unknown }).run as ObserverRun
      },
      async proposals(): Promise<RetirementProposal[]> {
        return ((await request("/observe")) as { proposals: unknown }).proposals as RetirementProposal[]
      },
    },

    async approve(id: string, note?: string): Promise<ApprovalDecision> {
      return decided(id, "approve", note)
    },

    async deny(id: string, note?: string): Promise<ApprovalDecision> {
      return decided(id, "deny", note)
    },

    // The header value travels one way: it is written here and never read back.
    connections: {
      async list(): Promise<ConnectionSummary[]> {
        return ((await request("/connections")) as { connections: unknown }).connections as ConnectionSummary[]
      },
      async add(connection: unknown): Promise<ConnectionSummary> {
        const answer = (await request("/connections", connection as JsonValue)) as { connection?: unknown }
        return answer.connection as ConnectionSummary
      },
      async remove(name: string): Promise<ConnectionSummary> {
        const answer = (await request(`/connections/${encodeURIComponent(name)}`, undefined, "DELETE")) as {
          connection?: unknown
        }
        return answer.connection as ConnectionSummary
      },
    },

    async report(callId: string, outcome: CallOutcome, note?: string): Promise<CallReport> {
      const answer = (await request(`/calls/${encodeURIComponent(callId)}/report`, {
        outcome,
        ...(note === undefined ? {} : { note }),
      })) as { report?: unknown }
      await announce()
      return answer.report as CallReport
    },
  }
}

function revive(payload: JsonValue, status: number, base: string): ToolError {
  const error = (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
  if (error === undefined || typeof error.code !== "string" || typeof error.message !== "string") {
    return new ToolError("internal_error", `The daemon at ${base} refused the call with status ${status}.`, { status })
  }
  const details = error.details
  const code = (TOOL_ERROR_CODES as readonly string[]).includes(error.code)
    ? (error.code as ToolErrorCode)
    : "internal_error"
  return new ToolError(
    code,
    error.message,
    typeof details === "object" && details !== null && !Array.isArray(details)
      ? (details as Record<string, JsonValue>)
      : {},
  )
}

function unreachable(base: string, cause: unknown, timeoutMs: number): ToolError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return new ToolError("transport_failed", `The daemon at ${base} did not answer within ${timeoutMs} ms.`, {
      url: base,
      timeout: timeoutMs,
    })
  }
  return new ToolError(
    "transport_failed",
    `The daemon at ${base} did not answer: ${reason}. Start it with \`flintd serve\`, or point the client at the URL it logged.`,
    { url: base, reason },
  )
}
