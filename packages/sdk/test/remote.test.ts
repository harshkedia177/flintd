import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import type { AddressInfo } from "node:net"
import { ToolError, createFlint } from "../src/index.ts"
import { behaviour } from "./behaviour.ts"
import { creation, remote } from "./support.ts"

behaviour({ name: "remote", open: remote })

// A client that is taken apart must work like one that is not: no method may lean on `this`.
test("a remote client still calls and reports when its methods are destructured", async () => {
  const session = await remote()
  try {
    const { call, callWithId, report } = session.client
    await call("tool_create", creation())
    const ran = await callWithId("word_count", { text: "one two" })
    assert.deepEqual(ran.result, { count: 2 })
    assert.deepEqual(await call("word_count", { text: "one two three" }), { count: 3 })
    assert.equal((await report(ran.id as string, "negative")).tool, "word_count")
  } finally {
    await session.close()
  }
})

test("the factory refuses a remote client without a url or a token", () => {
  assert.throws(() => createFlint({ url: "", token: "x" }), ToolError)
  assert.throws(() => createFlint({ url: "http://127.0.0.1:1", token: "" }), ToolError)
})

// transport_failed is the one code no daemon sends, so a caller tells "no daemon" from "a Tool refused" by the code.
test("a daemon that is not there is transport_failed, and so is a client that gave up waiting", async () => {
  const client = createFlint({ url: "http://127.0.0.1:1", token: "any", timeoutMs: 1000 })
  await assert.rejects(client.start(), (cause: unknown) => {
    assert.ok(cause instanceof ToolError)
    assert.equal(cause.code, "transport_failed")
    assert.equal(cause.details["url"], "http://127.0.0.1:1")
    assert.match(String(cause.details["reason"]), /.+/)
    assert.match(cause.message, /did not answer/)
    return true
  })

  const silent = createServer(() => undefined)
  await new Promise<void>((ready) => silent.listen(0, "127.0.0.1", ready))
  const port = (silent.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  try {
    const waiting = createFlint({ url, token: "any", timeoutMs: 50 })
    await assert.rejects(waiting.status(), (cause: unknown) => {
      assert.ok(cause instanceof ToolError)
      assert.equal(cause.code, "transport_failed")
      assert.deepEqual(cause.details, { url, timeout: 50 })
      return true
    })
  } finally {
    silent.closeAllConnections()
    await new Promise<void>((closed) => silent.close(() => closed()))
  }
})

// announce() is a courtesy to the watchers; the finding was that it threw away a call the daemon had already run.
test("a watcher and a tool list that cannot be read never take the result of a call that worked", async () => {
  const seen: string[] = []
  const answers: Record<string, string> = {
    "POST /api/v1/call": '{"call":{"id":"c-1","result":{"count":2}}}',
    "POST /api/v1/calls/c-1/report": '{"report":{"tool":"word_count","outcome":"negative"}}',
    "POST /api/v1/approvals/a-1/approve": '{"approval":{"id":"a-1","status":"approved"}}',
  }
  // Everything the client asks for answers, except the list every announce() re-reads.
  const daemon = createServer((request, response) => {
    const route = `${request.method} ${request.url}`
    seen.push(route)
    request.resume()
    const body = answers[route]
    response.writeHead(body === undefined ? 500 : 200, { "content-type": "application/json" })
    response.end(body ?? '{"error":{"code":"store_error","message":"the index is gone"}}\n')
  })
  await new Promise<void>((ready) => daemon.listen(0, "127.0.0.1", ready))
  const port = (daemon.address() as AddressInfo).port
  try {
    const client = createFlint({ url: `http://127.0.0.1:${port}`, token: "any", timeoutMs: 1000 })
    let changes = 0
    client.onChange(() => {
      changes += 1
    })
    const ran = await client.callWithId("word_count", { text: "one two" })
    assert.deepEqual(ran, { id: "c-1", result: { count: 2 } })
    assert.equal((await client.report("c-1", "negative")).tool, "word_count")
    assert.equal((await client.approve("a-1")).status, "approved")
    // The list was asked for on each of the three, refused each time, and no watcher was told a lie.
    assert.equal(seen.filter((one) => one === "GET /api/v1/tools").length, 3)
    assert.equal(changes, 0)
  } finally {
    daemon.closeAllConnections()
    await new Promise<void>((closed) => daemon.close(() => closed()))
  }
})
