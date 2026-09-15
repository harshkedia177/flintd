import assert from "node:assert/strict"
import test from "node:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { fakeModel } from "../../core/test/fake-model.ts"
import { creation, daemon } from "./support.ts"
import type { ApprovalEntry } from "../src/index.ts"

const CASES = [{ args: { text: "one two" }, confident: true, expected: { count: 2 } }]
const MANIFEST = JSON.stringify({ hosts: ["api.example.com"] })

// A Tool that reaches a host is the case the annotations exist for, and the one a stale Manifest map gets wrong.
test("tools(\"mcp\") is the list the daemon's own surface answers, annotations included", async () => {
  const running = await daemon({ model: fakeModel({ cases: CASES }) })
  const client = new Client({ name: "gate-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } })
  try {
    await running.client.call("tool_create", creation({ manifest_json: MANIFEST }))
    const waiting = (await running.client.approvals()).find((one: ApprovalEntry) => one.tool === "word_count")
    assert.equal((await running.client.approve(waiting?.id ?? "")).status, "approved")
    await verified(running)
    for (const [at, sessionId] of ["one", "one", "one", "one", "two"].entries()) {
      await running.client.call("word_count", { text: `call number ${at}` }, { sessionId })
    }

    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${running.token}` } },
      }),
    )
    const listed = (await client.listTools()).tools
    const mine = await running.client.tools("mcp")

    assert.equal(mine.at(-1)?.name, "fl_word_count")
    assert.deepEqual(mine.at(-1)?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
    assert.deepEqual(JSON.parse(JSON.stringify(mine)), listed)
  } finally {
    await client.close().catch(() => undefined)
    await running.close()
  }
})

async function verified(running: { client: { library(): Promise<{ name: string; state: string }[]> } }): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    if ((await running.client.library()).some((one) => one.name === "word_count" && one.state === "verified")) return
    if (Date.now() > deadline) throw new Error("the Held-out run never verified word_count")
    await new Promise((wake) => setTimeout(wake, 10))
  }
}
