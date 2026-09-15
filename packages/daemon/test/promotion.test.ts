import assert from "node:assert/strict"
import test from "node:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { CallToolResult, Tool } from "@modelcontextprotocol/client"
import { fakeModel } from "../../core/test/fake-model.ts"
import { ask, creation, withDaemon } from "./support.ts"
import type { Running } from "./support.ts"

const CASES = [{ args: { text: "one two" }, confident: false }]
const DAY_MS = 24 * 60 * 60 * 1000
const FIRST_DAY = Date.UTC(2026, 0, 1, 9)
const SHAPE = JSON.stringify({
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
  additionalProperties: false,
})

async function open(running: Running, session?: string, harness = "gate-test"): Promise<Client> {
  const client = new Client({ name: harness, version: "1.0.0" }, { versionNegotiation: { mode: "auto" } })
  const headers: Record<string, string> = { authorization: `Bearer ${running.token}` }
  if (session !== undefined) headers["x-flintd-session"] = session
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), { requestInit: { headers } }))
  return client
}

async function five(client: Client, name: string, between?: () => void): Promise<void> {
  for (let at = 0; at < 5; at += 1) {
    if (at === 3 && between !== undefined) between()
    const ran = (await client.callTool({ name, arguments: { text: `call number ${at}` } })) as CallToolResult
    assert.notEqual(ran.isError, true, JSON.stringify(ran.content))
  }
}

async function state(running: Running, name: string): Promise<string | undefined> {
  const answer = await ask(running, "GET", "/api/v1/library")
  const library = answer.body["library"] as unknown as { name: string; state: string }[]
  return library.find((one) => one.name === name)?.state
}

async function verified(running: Running, names: string[]): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    const held = await Promise.all(names.map((name) => state(running, name)))
    if (held.every((one) => one === "verified")) return
    if (Date.now() > deadline) throw new Error(`the Held-out runs never verified ${names.join(", ")}: ${held.join(", ")}`)
    await new Promise((wake) => setTimeout(wake, 10))
  }
}

test("what an MCP call has to spread across before it earns a place in the default list", async (t) => {
  let now = FIRST_DAY
  await withDaemon(
    async (running) => {
      const client = await open(running)
      try {
        for (const name of ["one_day_tool", "day_tool", "session_tool", "harness_tool"]) {
          const written = (await client.callTool({
            name: "tool_create",
            arguments: { ...creation({ name }), ...(name === "day_tool" ? { result_json: SHAPE } : {}) },
          })) as CallToolResult
          assert.notEqual(written.isError, true, JSON.stringify(written.content))
        }
        await verified(running, ["one_day_tool", "day_tool", "session_tool", "harness_tool"])

        await t.test("five calls with no session, on one day, from one harness stay Verified", async () => {
          await five(client, "fl_one_day_tool")
          assert.equal(await state(running, "one_day_tool"), "verified")
        })

        await t.test("the same five calls spanning two calendar days earn Active", async () => {
          await five(client, "fl_day_tool", () => {
            now += DAY_MS
          })
          assert.equal(await state(running, "day_tool"), "active")
        })

        await t.test("five calls that name two sessions in the X-Flintd-Session header earn Active", async () => {
          const first = await open(running, "s-one")
          const second = await open(running, "s-two")
          try {
            for (let at = 0; at < 4; at += 1) {
              await first.callTool({ name: "fl_session_tool", arguments: { text: `call ${at}` } })
            }
            await second.callTool({ name: "fl_session_tool", arguments: { text: "the fifth" } })
          } finally {
            await first.close()
            await second.close()
          }
          assert.equal(await state(running, "session_tool"), "active")
        })

        await t.test("a Tool that declares hosts reaches the list with openWorldHint set", async () => {
          const written = (await client.callTool({
            name: "tool_create",
            arguments: { ...creation({ name: "hosts_tool" }), manifest_json: JSON.stringify({ hosts: ["api.example.com"] }) },
          })) as CallToolResult
          assert.notEqual(written.isError, true, JSON.stringify(written.content))
          const pending = (await ask(running, "GET", "/api/v1/approvals")).body["approvals"] as unknown as {
            id: string
            tool: string
          }[]
          const id = pending.find((one) => one.tool === "hosts_tool")?.id ?? ""
          assert.equal((await ask(running, "POST", `/api/v1/approvals/${id}/approve`, { body: {} })).status, 200)
          await verified(running, ["hosts_tool"])
          await five(client, "fl_hosts_tool", () => {
            now += DAY_MS
          })
          assert.equal(await state(running, "hosts_tool"), "active")
          const listed = (await client.listTools()).tools.find((one) => one.name === "fl_hosts_tool") as Tool
          assert.deepEqual(listed.annotations, {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          })
        })

        await t.test("a first-class Tool carries its own result schema as the output schema", async () => {
          const listed = (await client.listTools()).tools
          const shaped = listed.find((one) => one.name === "fl_day_tool") as Tool
          assert.deepEqual(shaped.outputSchema, {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
            additionalProperties: false,
          })
          // A Tool that declares none carries none, and neither does one whose result schema names another root.
          assert.equal((listed.find((one) => one.name === "fl_session_tool") as Tool).outputSchema, undefined)
          const ran = (await client.callTool({
            name: "fl_day_tool",
            arguments: { text: "one two" },
          })) as CallToolResult
          assert.deepEqual(ran.structuredContent, { count: 2 })
        })

        await t.test("five calls that two harnesses made earn Active as well", async () => {
          for (let at = 0; at < 4; at += 1) {
            await client.callTool({ name: "fl_harness_tool", arguments: { text: `call ${at}` } })
          }
          const other = await open(running, undefined, "other-harness")
          try {
            await other.callTool({ name: "fl_harness_tool", arguments: { text: "the fifth" } })
          } finally {
            await other.close()
          }
          assert.equal(await state(running, "harness_tool"), "active")
        })
      } finally {
        await client.close()
      }
    },
    { model: fakeModel({ cases: CASES }), clock: () => now },
  )
})
