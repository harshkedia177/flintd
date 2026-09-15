import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { Tool } from "@modelcontextprotocol/client"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { settings } from "./settings.ts"

const VERSION = "0.1.0"

// The part of pi's ExtensionContext this extension reads. Narrower than the real one, so pi's own type still fits.
interface Session {
  hasUI: boolean
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void }
  sessionManager: { getSessionId(): string }
}

interface Answer {
  content: { type: "text"; text: string }[]
  details: unknown
}

export default function flintd(pi: ExtensionAPI): void {
  let live: Client | undefined
  const stop = async (): Promise<void> => {
    const held = live
    live = undefined
    await held?.close()
  }
  pi.on("session_start", async (_event, ctx: Session) => {
    await stop()
    try {
      live = await connect(pi, ctx)
    } catch (raised) {
      say(ctx, `flintd is not connected: ${reason(raised)}`)
    }
  })
  pi.on("session_shutdown", stop)
}

async function connect(pi: ExtensionAPI, ctx: Session): Promise<Client> {
  const { url, token } = await settings()
  // The names this connection registered, which is what tells a Tool that left the list from one nobody registered.
  const known = new Set<string>()
  const client = new Client(
    { name: "pi", version: VERSION },
    {
      // The subscription stream that carries list_changed is a 2026-07-28 surface, and the client default is legacy.
      versionNegotiation: { mode: "auto" },
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (tools === null) say(ctx, `flintd did not refresh its tool list: ${reason(error)}`)
            else register(pi, known, client, url, tools)
          },
        },
      },
    },
  )
  // The daemon reads the session off the header, and a call that names a session is what earns a Tool its promotion.
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { authorization: `Bearer ${token}`, "x-flintd-session": ctx.sessionManager.getSessionId() },
    },
  })
  await client.connect(transport)
  try {
    register(pi, known, client, url, (await client.listTools()).tools)
  } catch (raised) {
    // The connection is open and subscribed by now, so a failure here has to close it or the stream outlives pi.
    await client.close()
    throw raised
  }
  return client
}

function register(pi: ExtensionAPI, known: Set<string>, client: Client, url: string, tools: Tool[]): void {
  const names = tools.map((tool) => tool.name)
  const added = names.filter((name) => !known.has(name))
  for (const tool of tools) {
    known.add(tool.name)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema,
      execute: (_id, params, signal) => run(client, url, tool.name, params, signal),
    })
  }
  // pi has no way to unregister a tool, so a Tool that left the list leaves the active set instead. Only a name this
  // connection has not registered before is switched on, so a tool the operator turned off stays off.
  const gone = [...known].filter((name) => !names.includes(name))
  const active = pi.getActiveTools().filter((name) => !gone.includes(name))
  pi.setActiveTools([...new Set([...active, ...added])])
}

async function run(
  client: Client,
  url: string,
  name: string,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<Answer> {
  const asked = { name, arguments: params as Record<string, unknown> }
  const result = await client
    .callTool(asked, signal === undefined ? {} : { signal })
    .catch((raised: unknown) => {
      throw new Error(`transport_failed: the flintd daemon at ${url} did not answer. ${reason(raised)}`)
    })
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("")
  // Throwing is the only thing that marks a pi tool result an error, and the text is the daemon's own refusal.
  if (result.isError === true) throw new Error(text)
  return { content: [{ type: "text", text }], details: result.structuredContent ?? {} }
}

function say(ctx: Session, said: string): void {
  if (ctx.hasUI) ctx.ui.notify(said, "warning")
  else process.stderr.write(`${said}\n`)
}

function reason(raised: unknown): string {
  return raised instanceof Error ? raised.message : String(raised)
}
