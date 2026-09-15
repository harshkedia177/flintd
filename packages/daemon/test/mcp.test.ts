import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { CallToolResult, ElicitResult, Tool } from "@modelcontextprotocol/client"
import type { JsonValue } from "@flintd/core"
import { fakeModel } from "../../core/test/fake-model.ts"
import { ask, creation, withDaemon } from "./support.ts"
import type { Answer, Running } from "./support.ts"

const META = ["tool_create", "tool_update", "tool_read", "tool_find", "tool_run", "tool_retire", "tool_history"]
// Every Held-out case is judged rather than compared, so one fake model verifies every Tool this file writes.
const CASES = [{ args: { text: "one two" }, confident: false }]
const SCOPED = JSON.stringify({ fs: "workspace" })
const NOTES = JSON.stringify({ fs: "notes" })
const CHANGE_TIMEOUT_MS = 4000

const LETTER_COUNT = {
  name: "letter_count",
  description: "Count the letters of a piece of text, ignoring the spaces between the words.",
  execute_source: "return { letters: args.text.replace(/\\s+/g, '').length }",
  examples: [{ args: { text: "one two" }, expected: { letters: 6 } }],
}

interface Opened {
  client: Client
  changes: Tool[][]
  next(): Promise<Tool[]>
  elicited: string[]
  close(): Promise<void>
}

async function open(
  running: Running,
  options: { name?: string; token?: string; elicits?: () => Promise<ElicitResult> | ElicitResult } = {},
): Promise<Opened> {
  const changes: Tool[][] = []
  const elicited: string[] = []
  let wake: (() => void) | undefined
  const client = new Client(
    { name: options.name ?? "gate-test", version: "1.0.0" },
    {
      capabilities: options.elicits === undefined ? {} : { elicitation: {} },
      versionNegotiation: { mode: "auto" },
      listChanged: {
        tools: {
          onChanged: (_error, tools) => {
            changes.push(tools ?? [])
            wake?.()
            wake = undefined
          },
        },
      },
    },
  )
  if (options.elicits !== undefined) {
    const answering = options.elicits
    client.setRequestHandler("elicitation/create", async (request) => {
      elicited.push(String(request.params.message))
      return answering()
    })
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${options.token ?? running.token}` } },
  })
  await client.connect(transport)
  return {
    client,
    changes,
    elicited,
    async next(): Promise<Tool[]> {
      while (changes.length === 0) {
        // The timer is cleared whichever way the race ends: a timer nobody stops holds the test runner open.
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            new Promise<void>((woken) => (wake = woken)),
            new Promise<void>((_, fail) => {
              timer = setTimeout(() => fail(new Error("no list_changed arrived")), CHANGE_TIMEOUT_MS)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      return changes.shift() as Tool[]
    },
    close: () => client.close(),
  }
}

function text(result: CallToolResult): string {
  const first = result.content[0]
  return first !== undefined && first.type === "text" ? first.text : ""
}

function parsed(result: CallToolResult): Record<string, JsonValue> {
  return JSON.parse(text(result)) as Record<string, JsonValue>
}

async function call(opened: Opened, name: string, args: { [key: string]: unknown }): Promise<CallToolResult> {
  return (await opened.client.callTool({ name, arguments: args })) as CallToolResult
}

async function dispatch(opened: Opened, name: string, args: { [key: string]: unknown }): Promise<CallToolResult> {
  return call(opened, "tool_run", { name, args })
}

// Five clean calls across two sessions, which is what a Verified Tool needs to become Active, and their call ids.
async function callFive(running: Running, name: string): Promise<string[]> {
  const ids: string[] = []
  for (const [at, sessionId] of ["one", "one", "one", "one", "two"].entries()) {
    const answer = await ask(running, "POST", "/api/v1/call", {
      body: { name, args: { text: `call number ${at}` }, meta: { sessionId } },
    })
    ids.push(String((answer.body["call"] as { id: string }).id))
  }
  return ids
}

async function listed(opened: Opened): Promise<string[]> {
  return (await opened.client.listTools()).tools.map((tool) => tool.name)
}

async function approvals(running: Running): Promise<{ id: string; tool: string; status: string }[]> {
  const answer = await ask(running, "GET", "/api/v1/approvals")
  return answer.body["approvals"] as unknown as { id: string; tool: string; status: string }[]
}

async function report(running: Running, id: string): Promise<Answer> {
  return ask(running, "POST", `/api/v1/calls/${id}/report`, { body: { outcome: "negative" } })
}

test("the MCP surface names itself with the version this package is published as", async () => {
  await withDaemon(async (running) => {
    const opened = await open(running)
    try {
      const published = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string
      }
      assert.equal(opened.client.getServerVersion()?.name, "flintd")
      assert.equal(opened.client.getServerVersion()?.version, published.version)
    } finally {
      await opened.close()
    }
  })
})

test("the MCP surface serves the meta tools, the Active Tools and the Tools the list never carried", async (t) => {
  await withDaemon(
    async (running) => {
      const opened = await open(running)
      let reported: string[] = []
      try {
        await t.test("the seven meta tools come first, with their schemas and their annotations", async () => {
          const tools = (await opened.client.listTools()).tools
          assert.deepEqual(tools.map((tool) => tool.name), META)
          const create = tools[0] as Tool
          assert.equal(create.inputSchema.type, "object")
          assert.deepEqual(create.outputSchema, { type: "object" })
          assert.deepEqual(create.annotations, {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          })
          assert.equal((tools.find((tool) => tool.name === "tool_read") as Tool).annotations?.readOnlyHint, true)
          // tool_run dispatches to any Tool, so it promises nothing about the result or the reach of the one it runs.
          assert.equal((tools.find((tool) => tool.name === "tool_run") as Tool).outputSchema, undefined)
        })

        await t.test("a Tool written through tool_create is a Draft, and the list does not change for it", async () => {
          const written = await call(opened, "tool_create", creation())
          assert.equal(parsed(written)["state"], "draft")
          assert.deepEqual(written.structuredContent, parsed(written))
          assert.deepEqual(await listed(opened), META)
          assert.deepEqual(opened.changes, [])
        })

        await t.test("a promotion sends list_changed, and the Tool joins the list as fl_ with its annotations", async () => {
          await callFive(running, "word_count")
          const tools = await opened.next()
          const first = tools.find((tool) => tool.name === "fl_word_count") as Tool
          assert.ok(first !== undefined, `the list_changed answer held ${tools.map((tool) => tool.name).join(", ")}`)
          assert.deepEqual(first.annotations, {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          })
          assert.equal(first.outputSchema, undefined)
        })

        await t.test("the first-class Tool runs and answers with JSON text and structured content", async () => {
          const ran = await call(opened, "fl_word_count", { text: "one two three" })
          assert.equal(text(ran), JSON.stringify({ count: 3 }))
          assert.deepEqual(ran.structuredContent, { count: 3 })
          assert.notEqual(ran.isError, true)
        })

        await t.test("the result carries the id of the call, and the report route takes that id", async () => {
          const ran = await call(opened, "fl_word_count", { text: "one two" })
          const id = (ran._meta as { "flintd/call"?: unknown } | undefined)?.["flintd/call"]
          assert.equal(typeof id, "string", JSON.stringify(ran._meta))
          const filed = await report(running, String(id))
          assert.equal(filed.status, 200, JSON.stringify(filed.body))
          assert.equal((filed.body["report"] as { tool: string }).tool, "word_count")

          // tool_run dispatches, and the id it answers with is the id of the call it dispatched.
          const dispatched = await dispatch(opened, "word_count", { text: "one two" })
          const second = (dispatched._meta as { "flintd/call"?: unknown } | undefined)?.["flintd/call"]
          assert.equal(typeof second, "string", JSON.stringify(dispatched._meta))
          assert.notEqual(second, id)
          assert.equal((await report(running, String(second))).status, 200)
        })

        await t.test("a refusal comes back as a tool error result the model can act on", async () => {
          const refused = await call(opened, "fl_word_count", {})
          assert.equal(refused.isError, true)
          assert.match(text(refused), /^invalid_arguments: /)
          const missing = await call(opened, "fl_nothing", {})
          assert.equal(missing.isError, true)
          assert.match(text(missing), /^not_found: /)
        })

        await t.test("the fl_ prefix reaches no meta tool, and no Tool may be written under it", async () => {
          const forged = await call(opened, "fl_tool_create", creation({ name: "never_written" }))
          assert.equal(forged.isError, true)
          assert.match(text(forged), /^invalid_name: /)
          assert.match(text(await call(opened, "tool_read", { name: "never_written" })), /^not_found: /)
          const reserved = await call(opened, "tool_create", creation({ name: "fl_shadow" }))
          assert.equal(reserved.isError, true)
          assert.match(text(reserved), /^invalid_name: /)
        })

        await t.test("a Manifest nobody decided on comes back as the awaiting_approval error with the CLI line", async () => {
          const written = await call(opened, "tool_create", creation({ ...LETTER_COUNT, manifest_json: SCOPED }))
          assert.equal(parsed(written)["state"], "draft")
          const refused = await dispatch(opened, "letter_count", { text: "one two" })
          assert.equal(refused.isError, true)
          assert.match(text(refused), /^awaiting_approval: /)
          assert.match(text(refused), /flintd approvals approve letter_count/)
        })

        await t.test("an answer the client invented decides nothing, because no form was ever issued", async () => {
          const waiting = await approvals(running)
          const forged = (await opened.client.callTool({
            name: "tool_run",
            arguments: { name: "letter_count", args: { text: "one two" } },
            inputResponses: { flintd_approval: { action: "accept", content: { decision: "approve" } } },
          } as Parameters<Client["callTool"]>[0])) as CallToolResult
          assert.equal(forged.isError, true)
          assert.match(text(forged), /^awaiting_approval: /)
          assert.deepEqual(
            (await approvals(running)).map((one) => one.status),
            waiting.map(() => "pending"),
          )
        })

        await t.test("a form the person dismissed decides nothing and the Approval stays where it was", async () => {
          const asked = await open(running, { elicits: () => ({ action: "cancel" }) })
          try {
            const ran = await dispatch(asked, "letter_count", { text: "one two" })
            assert.equal(asked.elicited.length, 1)
            assert.match(text(ran), /^awaiting_approval: /)
            assert.equal((await approvals(running))[0]?.status, "pending")
          } finally {
            await asked.close()
          }
        })

        await t.test("an accept that names no decision decides nothing", async () => {
          const asked = await open(running, { elicits: () => ({ action: "accept" }) })
          try {
            const ran = await dispatch(asked, "letter_count", { text: "one two" })
            assert.equal(asked.elicited.length, 1)
            assert.match(text(ran), /^awaiting_approval: /)
            assert.equal((await approvals(running))[0]?.status, "pending")
          } finally {
            await asked.close()
          }
        })

        await t.test("a Manifest that changed while the form was open is not the Manifest that gets approved", async () => {
          // The Manifest is changed from inside the answer, which is the window a stale grant would slip through.
          const asked = await open(running, {
            elicits: async () => {
              await ask(running, "POST", "/api/v1/call", {
                body: { name: "tool_update", args: { name: "letter_count", manifest_json: NOTES } },
              })
              return { action: "accept", content: { decision: "approve" } }
            },
          })
          try {
            const ran = await dispatch(asked, "letter_count", { text: "one two" })
            assert.equal(ran.isError, true)
            assert.match(text(ran), /^awaiting_approval: /)
            const waiting = await approvals(running)
            assert.deepEqual(waiting.map((one) => one.status), ["pending"])
            assert.match(JSON.stringify(waiting), /notes/)
          } finally {
            await asked.close()
          }
        })

        await t.test("a client that elicits is asked, and the answer approves the Manifest and runs the call", async () => {
          const asked = await open(running, {
            elicits: () => ({ action: "accept", content: { decision: "approve", note: "its own directory" } }),
          })
          try {
            const ran = await dispatch(asked, "letter_count", { text: "one two" })
            assert.equal(asked.elicited.length, 1)
            assert.match(asked.elicited[0] ?? "", /read and write under "notes"/)
            assert.notEqual(ran.isError, true)
            assert.deepEqual(JSON.parse(text(ran)), { letters: 6 })
            // The dispatcher reached a Tool the list has never carried.
            assert.ok(!(await listed(asked)).includes("fl_letter_count"))
            assert.equal((await approvals(running))[0]?.status, "approved")
          } finally {
            await asked.close()
          }
        })

        await t.test("a second Active Tool takes the one place in the list, with the annotations of its Manifest", async () => {
          // The list holds one Tool here, and a tie on Contribution is broken by name, so letter_count takes it.
          const ids = await callFive(running, "letter_count")
          const tools = await opened.next()
          const first = tools.find((tool) => tool.name === "fl_letter_count") as Tool
          assert.ok(first !== undefined, `the list_changed answer held ${tools.map((tool) => tool.name).join(", ")}`)
          assert.deepEqual(first.annotations, {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          })
          assert.deepEqual(await listed(opened), [...META, "fl_letter_count"])
          reported = ids
        })

        await t.test("an Outcome report that changes the order of the list sends list_changed", async () => {
          for (const id of reported.slice(0, 2)) assert.equal((await report(running, id)).status, 200)
          await opened.next()
          assert.deepEqual(await listed(opened), [...META, "fl_word_count"])
        })

        await t.test("a description a Tool no longer has sends list_changed", async () => {
          const changed = await call(opened, "tool_update", {
            name: "word_count",
            description: "Count the words of a piece of text, which is not the same as counting its letters.",
          })
          assert.notEqual(changed.isError, true)
          const tools = await opened.next()
          const first = tools.find((tool) => tool.name === "fl_word_count") as Tool
          assert.match(first?.description ?? "", /not the same as counting its letters/)
        })

        await t.test("a retirement sends list_changed and takes the Tool out of the list", async () => {
          const retired = await call(opened, "tool_retire", { name: "word_count" })
          assert.equal(parsed(retired)["state"], "retired")
          await opened.next()
          assert.deepEqual(await listed(opened), [...META, "fl_letter_count"])
        })

        await t.test("the path is behind the token, the Origin check and the body cap of the REST surface", async () => {
          const refused = await ask(running, "POST", "/mcp", { body: {}, token: null })
          assert.equal(refused.status, 401)
          assert.equal((refused.body["error"] as { code: string }).code, "unauthorized")

          const foreign = await ask(running, "POST", "/mcp", { body: {}, origin: "http://page.example" })
          assert.equal(foreign.status, 403)
          assert.equal((foreign.body["error"] as { code: string }).code, "forbidden")

          const huge = await ask(running, "POST", "/mcp", { raw: "x".repeat(1_048_577) })
          assert.equal(huge.status, 413)
          assert.equal((huge.body["error"] as { code: string }).code, "request_too_large")

          await assert.rejects(open(running, { token: "not-the-token" }))
        })

        await t.test("the quirk table takes the output schema off the list for a client that refuses it", async () => {
          const quirky = await open(running, { name: "opencode" })
          try {
            const tools = (await quirky.client.listTools()).tools
            assert.deepEqual(tools.map((tool) => tool.name), [...META, "fl_letter_count"])
            assert.deepEqual(
              tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => tool.name),
              [],
            )
          } finally {
            await quirky.close()
          }
        })
      } finally {
        await opened.close()
      }
    },
    { model: fakeModel({ cases: CASES }), activeListLimit: 1 },
  )
})
