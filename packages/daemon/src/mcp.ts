import { randomBytes } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { CallToolResult, InputRequiredResult, Server, ServerContext, Tool as McpTool } from "@modelcontextprotocol/server"
import { ToolError, formatTools, libraryName, manifestHash } from "@flintd/core"
import type { CallMeta, CallResult, Flint, Manifest } from "@flintd/core"
import { VERSION } from "./version.ts"

// The list changes only when a Tool is written, so a client may hold it for a minute and still see a promotion.
const LIST_TTL_MS = 60_000
const APPROVAL_KEY = "flintd_approval"
// A person reading a Manifest and deciding takes minutes, and a form nobody answered in ten is one to ask again.
const STATE_TTL_SECONDS = 600
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
const CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
// The revision has no session of its own, so a harness that can set a header names its session here.
const SESSION_HEADER = "x-flintd-session"
// The `_meta` key the id of the call rides out on, so an MCP client can file POST /api/v1/calls/<id>/report on it.
const CALL_KEY = "flintd/call"
const MAX_SESSION_LENGTH = 128
const PRINTABLE = /^[\x20-\x7e]+$/

export interface ClientQuirk {
  omitOutputSchema?: boolean
}

export type ClientQuirks = Readonly<Record<string, ClientQuirk>>

// Keyed by the client's own `clientInfo.name`. opencode refuses a tool that carries an output schema.
export const CLIENT_QUIRKS: ClientQuirks = {
  opencode: { omitOutputSchema: true },
}

type Sdk = typeof import("@modelcontextprotocol/server")
type Codec = import("@modelcontextprotocol/server").RequestStateCodec<Pending>

// What flintd sealed into the form it issued: the Approval the person was asked about, and the Manifest they read.
interface Pending {
  approval: string
  manifest: string
}

export interface McpSurface {
  handle(request: IncomingMessage, response: ServerResponse, body?: unknown): Promise<void>
  close(): Promise<void>
}

// The operator's table is written over the built-in one, so a client can gain a quirk or lose one flintd ships with.
export async function mountMcp(flint: Flint, quirks?: ClientQuirks): Promise<McpSurface> {
  const [sdk, { toNodeHandler }] = await Promise.all([
    import("@modelcontextprotocol/server"),
    import("@modelcontextprotocol/node"),
  ])
  const table = { ...CLIENT_QUIRKS, ...quirks }
  // The key lives as long as the daemon, which is long enough: one process serves every round of one form.
  const codec = sdk.createRequestStateCodec<Pending>({
    key: randomBytes(32),
    ttlSeconds: STATE_TTL_SECONDS,
    bind: (context) => context.mcpReq.method,
  })
  const handler = sdk.createMcpHandler(() => build(flint, table, sdk, codec))
  const node = toNodeHandler(handler)
  const off = flint.onChange(() => handler.notify.toolsChanged())
  return {
    handle: (request, response, body) => node(request as Parameters<typeof node>[0], response, body),
    async close(): Promise<void> {
      off()
      await handler.close()
    },
  }
}

function build(flint: Flint, quirks: ClientQuirks, sdk: Sdk, codec: Codec): Server {
  const server = new sdk.Server(
    { name: "flintd", version: VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      cacheHints: { "tools/list": { ttlMs: LIST_TTL_MS, cacheScope: "private" } },
      // A state that does not verify never reaches a handler: the seam answers the client and stops there.
      requestState: { verify: (state, context) => codec.verify(state, context) },
      instructions:
        "flintd holds a Library of Tools an agent writes for itself. The seven tool_* meta tools write, read, search and run them; the fl_ tools are the Active Tools of this Library. A Tool that is not in this list is still reachable with tool_find and tool_run.",
    },
  )
  server.setRequestHandler("tools/list", async (_request, context) => ({ tools: await list(flint, quirks, named(context)) }))
  server.setRequestHandler("tools/call", (request, context) => run(flint, request.params, context, sdk, codec))
  return server
}

async function list(flint: Flint, quirks: ClientQuirks, client: string | undefined): Promise<McpTool[]> {
  const manifests = new Map((await flint.library()).map((entry) => [entry.name, entry.manifest]))
  // One shaping for this surface and for the SDK's `mcp` format, so the two lists cannot say different things. The
  // SDK's own tool type is inferred from a zod schema that spells a JSON Schema out as a JSON value tree.
  const shaped = formatTools(await flint.tools(), "mcp", manifests) as unknown as McpTool[]
  const quirk = client === undefined ? undefined : quirks[client.toLowerCase()]
  if (quirk?.omitOutputSchema !== true) return shaped
  return shaped.map(({ outputSchema, ...tool }) => tool)
}

async function run(
  flint: Flint,
  params: { name: string; arguments?: { [key: string]: unknown } | undefined },
  context: ServerContext,
  sdk: Sdk,
  codec: Codec,
): Promise<CallToolResult | InputRequiredResult> {
  const name = libraryName(params.name)
  const args = params.arguments ?? {}
  const meta = callMeta(named(context), session(context))
  const answered = sdk.inputResponse(context.mcpReq.inputResponses, APPROVAL_KEY)
  try {
    return answer(await flint.callWithId(name, args, meta))
  } catch (cause) {
    const error = toolError(cause)
    if (error.code !== "awaiting_approval") return failure(error)
    if (answered.kind === "elicit") {
      return decided(flint, error, answered, context.mcpReq.requestState<Pending>(), { name, args, meta }, context)
    }
    return elicits(context) ? ask(error, sdk, codec, context) : failure(error)
  }
}

// The decision the person gave, recorded through the same path the CLI uses, and the call run again after it.
async function decided(
  flint: Flint,
  error: ToolError,
  answered: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> },
  state: Pending | undefined,
  call: { name: string; args: { [key: string]: unknown }; meta: CallMeta },
  context: ServerContext,
): Promise<CallToolResult> {
  const details = error.details as { approval?: unknown; manifest?: unknown }
  const id = String(details.approval ?? "")
  // The sealed state is the proof that this client was asked, about this Approval, about the Manifest it read.
  if (!elicits(context) || state?.approval !== id || state.manifest !== hashOf(details.manifest)) return failure(error)
  // A form nobody filled in decides nothing: a dismissal leaves the Approval where it was, waiting for a person.
  if (answered.action !== "accept") return failure(error)
  const decision = answered.content?.["decision"]
  if (decision !== "approve" && decision !== "deny") return failure(error)
  const note = typeof answered.content?.["note"] === "string" ? (answered.content["note"] as string) : undefined
  try {
    const said = decision === "approve" ? await flint.approve(id, note) : await flint.deny(id, note)
    // A grant the Examples did not survive is no grant; a grant the Active cap blocked is one, and the Body runs.
    if (said.message !== null && said.promotion !== "blocked") {
      return failure(new ToolError("awaiting_approval", said.message, error.details))
    }
    const ran = answer(await flint.callWithId(call.name, call.args, call.meta))
    if (said.promotion !== "blocked" || said.message === null) return ran
    return { ...ran, content: [...ran.content, { type: "text", text: said.message }] }
  } catch (cause) {
    return failure(toolError(cause))
  }
}

function hashOf(manifest: unknown): string {
  return manifestHash((typeof manifest === "object" && manifest !== null ? manifest : {}) as Manifest)
}

async function ask(error: ToolError, sdk: Sdk, codec: Codec, context: ServerContext): Promise<InputRequiredResult> {
  const details = error.details as { name?: unknown; approval?: unknown; manifest?: unknown; summary?: unknown }
  const tool = String(details.name ?? "")
  const state = await codec.mint({ approval: String(details.approval ?? ""), manifest: hashOf(details.manifest) }, context)
  return sdk.inputRequired({
    requestState: state,
    inputRequests: {
      [APPROVAL_KEY]: sdk.inputRequired.elicit({
        mode: "form",
        message: `The Tool ${JSON.stringify(tool)} asks for what its Manifest declares, and flintd runs no Body with it until one person approves it.\n\n${manifestLines(details.manifest)}\nIn one sentence: it asks to ${String(details.summary ?? "")}.`,
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              title: "Decision",
              description: `Approve or deny what the Manifest of ${JSON.stringify(tool)} asks for.`,
              enum: ["approve", "deny"],
            },
            note: { type: "string", title: "Note", description: "One line that says why. It is kept with the decision." },
          },
          required: ["decision"],
        },
      }),
    },
  })
}

function manifestLines(value: unknown): string {
  const manifest = (typeof value === "object" && value !== null ? value : {}) as Manifest
  const lines: string[] = []
  if (manifest.fs !== undefined) lines.push(`Files: read and write under ${JSON.stringify(manifest.fs)}, and nowhere else.`)
  if ((manifest.hosts?.length ?? 0) > 0) {
    lines.push(`Network: ${(manifest.hosts ?? []).join(", ")} — every port of a declared host, and no other host.`)
  }
  if ((manifest.connections?.length ?? 0) > 0) {
    lines.push(`Connections: ${(manifest.connections ?? []).join(", ")} — the stored credential is attached by flintd and the Body never sees it.`)
  }
  if (manifest.exec === true) {
    lines.push("Commands: run a command line inside a container. This is the strongest grant flintd has: it is a shell, bounded by the container and by the Manifest root.")
  }
  return lines.length === 0 ? "It asks for nothing.\n" : `${lines.join("\n")}\n`
}

function elicits(context: ServerContext): boolean {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined
  const capabilities = envelope?.[CLIENT_CAPABILITIES]
  if (typeof capabilities !== "object" || capabilities === null) return false
  const elicitation = (capabilities as { elicitation?: unknown }).elicitation
  if (typeof elicitation !== "object" || elicitation === null) return false
  // An empty object is form mode, so only a client that declares url alone cannot be asked this question.
  const modes = elicitation as { form?: unknown; url?: unknown }
  return modes.form !== undefined || modes.url === undefined
}

function named(context: ServerContext): string | undefined {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined
  const info = envelope?.[CLIENT_INFO]
  if (typeof info !== "object" || info === null) return undefined
  const name = (info as { name?: unknown }).name
  return typeof name === "string" && name !== "" ? name : undefined
}

// The surface the call came in on, who spoke it, and the session the harness named if it named one.
function callMeta(client: string | undefined, sessionId: string | undefined): CallMeta {
  return {
    harness: client === undefined ? "mcp" : `mcp ${client}`,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

// A header a harness writes, so it is bounded and printable before it reaches a Provenance or a commit subject.
function session(context: ServerContext): string | undefined {
  const given = context.http?.req?.headers.get(SESSION_HEADER)
  if (given === null || given === undefined) return undefined
  const written = given.trim()
  if (written === "" || written.length > MAX_SESSION_LENGTH || !PRINTABLE.test(written)) return undefined
  return written
}

function answer(call: CallResult): CallToolResult {
  const result = call.result
  const structured = typeof result === "object" && result !== null && !Array.isArray(result) ? result : undefined
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(call.id === null ? {} : { _meta: { [CALL_KEY]: call.id } }),
  }
}

function failure(error: ToolError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${error.code}: ${error.message}` }] }
}

function toolError(cause: unknown): ToolError {
  return cause instanceof ToolError ? cause : new ToolError("internal_error", "The daemon could not answer.")
}
