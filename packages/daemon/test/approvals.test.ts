import assert from "node:assert/strict"
import test from "node:test"
import type { JsonValue } from "@flintd/core"
import { createFlint as connect } from "@flintd/sdk"
import { ask, called, creation, withDaemon } from "./support.ts"
import type { Running } from "./support.ts"

const SCOPED = JSON.stringify({ fs: "workspace" })

async function waiting(running: Running): Promise<{ id: string; tool: string; status: string; summary: string }[]> {
  const answer = await ask(running, "GET", "/api/v1/approvals")
  assert.equal(answer.status, 200)
  return answer.body["approvals"] as unknown as { id: string; tool: string; status: string; summary: string }[]
}

test("a Tool with a Manifest is 403 awaiting_approval until the Approval route grants it", async () => {
  await withDaemon(async (running) => {
    const created = await ask(running, "POST", "/api/v1/call", {
      body: { name: "tool_create", args: creation({ manifest_json: SCOPED }) },
    })
    assert.equal(created.status, 200)
    assert.equal(((called(created) as Record<string, JsonValue>)["approval"] as { status: string }).status, "pending")

    const refused = await ask(running, "POST", "/api/v1/call", {
      body: { name: "word_count", args: { text: "one two" } },
    })
    assert.equal(refused.status, 403)
    assert.equal((refused.body["error"] as { code: string }).code, "awaiting_approval")

    const pending = await waiting(running)
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.tool, "word_count")
    assert.match(pending[0]?.summary ?? "", /read and write files under "workspace"/)

    const granted = await ask(running, "POST", `/api/v1/approvals/${pending[0]?.id ?? ""}/approve`, {
      body: { note: "the workspace is its own" },
    })
    assert.equal(granted.status, 200)
    assert.equal((granted.body["approval"] as { status: string }).status, "approved")

    const ran = await ask(running, "POST", "/api/v1/call", { body: { name: "word_count", args: { text: "one two" } } })
    assert.deepEqual(called(ran), { count: 2 })
  })
})

test("the remote client lists and denies an Approval, and the Library entry shows the tier and the decision", async () => {
  await withDaemon(async (running) => {
    const client = connect({ url: running.url, token: running.token })
    await client.call("tool_create", creation({ manifest_json: SCOPED }))
    const pending = await (client.approvals())
    assert.equal(pending[0]?.status, "pending")

    const denied = await client.deny(pending[0]?.id ?? "", "too much")
    assert.equal(denied.status, "denied")
    assert.equal(denied.promotion, "unchanged")

    const library = await (client.library())
    assert.equal(library[0]?.tier, "quickjs")
    assert.equal(library[0]?.approval, "denied")
  })
})

test("an unknown Approval id is 404, and a decision flintd does not serve is 404", async () => {
  await withDaemon(async (running) => {
    const missing = await ask(running, "POST", "/api/v1/approvals/not-an-id/approve", { body: {} })
    assert.equal(missing.status, 404)
    assert.equal((missing.body["error"] as { code: string }).code, "not_found")
    const unknown = await ask(running, "POST", "/api/v1/approvals/not-an-id/maybe", { body: {} })
    assert.equal(unknown.status, 404)
  })
})
