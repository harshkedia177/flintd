import assert from "node:assert/strict"
import test from "node:test"
import { callFrom } from "../src/index.ts"
import { creation, refusal } from "./support.ts"
import type { Mode } from "./support.ts"
import type { ApprovalEntry, FlintClient } from "../src/index.ts"

export function behaviour(mode: Mode): void {
  const withClient = async (run: (client: FlintClient) => Promise<void>): Promise<void> => {
    const session = await mode.open()
    try {
      await run(session.client)
    } finally {
      await session.close()
    }
  }

  test(`${mode.name}: tools() lists the seven meta tools with their schemas`, async () => {
    await withClient(async (client) => {
      const tools = await (client.tools())
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["tool_create", "tool_update", "tool_read", "tool_find", "tool_run", "tool_retire", "tool_history"],
      )
      assert.equal(tools[0]?.parameters.type, "object")
    })
  })

  test(`${mode.name}: a Connection is stored by name and host, and its value never comes back`, async () => {
    await withClient(async (client) => {
      const upstream = { name: "upstream", hosts: ["api.example.com"] }
      const stored = await client.connections.add({ ...upstream, header: { name: "x-api-key", value: "not-a-real-credential-9f3c2b7a1d" } })
      assert.deepEqual(stored, upstream)
      assert.deepEqual(await (client.connections.list()), [upstream])
      assert.deepEqual(await client.connections.remove("upstream"), upstream)
      assert.deepEqual(await (client.connections.list()), [])
    })
  })

  test(`${mode.name}: a created Tool is callable and counted in status and library`, async () => {
    await withClient(async (client) => {
      const created = (await client.call("tool_create", creation(), { harness: "gate-test" })) as { state: string }
      assert.equal(created.state, "draft")
      assert.deepEqual(await client.call("word_count", { text: "one two three" }), { count: 3 })
      const status = await (client.status())
      assert.equal(status.running, true)
      assert.equal(status.tools, 1)
      const library = await (client.library())
      assert.equal(library[0]?.name, "word_count")
      assert.equal(library[0]?.calls, 1)
    })
  })

  test(`${mode.name}: a call carries an id, and an outcome report on it moves the Contribution`, async () => {
    await withClient(async (client) => {
      await client.call("tool_create", creation())
      const call = await client.callWithId(
        "word_count",
        { text: "one two" },
        { sessionId: "alpha", tokens: { input: 40, output: 4 } },
      )
      assert.deepEqual(call.result, { count: 2 })
      assert.equal(typeof call.id, "string")
      assert.equal((await (client.library()))[0]?.contribution, 1)

      const report = await client.report(call.id as string, "negative", "it answered the wrong question")
      assert.equal(report.tool, "word_count")
      assert.equal(report.outcome, "negative")
      assert.equal(report.contribution, -1)
      assert.equal((await (client.library()))[0]?.contribution, -1)
      assert.equal((await refusal(() => client.report("no-such-call", "positive"))).code, "not_found")
    })
  })

  test(`${mode.name}: find answers the same entries in both modes`, async () => {
    await withClient(async (client) => {
      await client.call("tool_create", creation())
      await client.call("tool_create", creation({ name: "letter_count", description: "Return how many letters a string holds." }))
      const found = await client.find("count the words in a sentence")
      assert.deepEqual(
        found.map((one) => one.name),
        ["word_count"],
      )
      assert.equal(found[0]?.description, "Count the words in a piece of text.")
      assert.ok((found[0]?.score ?? 0) > 0 && (found[0]?.score ?? 0) <= 1)
      assert.deepEqual(found[0]?.siblings, [])
      assert.equal((await client.find("count the words in a sentence", 1)).length, 1)
      assert.equal((await refusal(() => client.find(""))).code, "invalid_arguments")
    })
  })

  test(`${mode.name}: a refusal arrives as a ToolError with the same code and details`, async () => {
    await withClient(async (client) => {
      const missing = await refusal(() => client.call("nothing_here", {}))
      assert.equal(missing.code, "not_found")
      assert.equal(missing.details["name"], "nothing_here")

      await client.call("tool_create", creation())
      const wrong = await refusal(() => client.call("word_count", { text: 7 }))
      assert.equal(wrong.code, "invalid_arguments")
      assert.deepEqual(wrong.details["tool"], "word_count")

      const twice = await refusal(() => client.call("tool_create", creation()))
      assert.equal(twice.code, "exists")
    })
  })

  // The embedded Library raises the request as soon as the Version lands; a remote client learns of it from the
  // refusal the daemon sends back. Both hand the same request to the same callback, and approve(id) decides it.
  test(`${mode.name}: onApproval hands over the request a Manifest raised, and approve() decides it`, async () => {
    await withClient(async (client) => {
      const seen: ApprovalEntry[] = []
      const off = client.onApproval((request) => seen.push(request))
      try {
        await client.call("tool_create", creation({ manifest_json: JSON.stringify({ fs: "workspace" }) }))
        const refused = await refusal(() => client.call("word_count", { text: "one two" }))
        assert.equal(refused.code, "awaiting_approval")
        assert.equal(seen.length, 1)
        assert.equal(seen[0]?.tool, "word_count")
        assert.match(seen[0]?.summary ?? "", /read and write files under "workspace"/)
        const decided = await client.approve(seen[0]?.id ?? "")
        assert.equal(decided.status, "approved")
        assert.deepEqual(await client.call("word_count", { text: "one two" }), { count: 2 })
      } finally {
        off()
      }
    })
  })

  test(`${mode.name}: a retired Tool cannot be called and its Versions stay`, async () => {
    await withClient(async (client) => {
      await client.call("tool_create", creation())
      const retired = (await client.call("tool_retire", { name: "word_count" })) as { restore_version: string }
      const gone = await refusal(() => client.call("word_count", { text: "x" }))
      assert.equal(gone.code, "not_found")
      const history = (await client.call("tool_history", { name: "word_count" })) as { versions: unknown[] }
      assert.equal(history.versions.length, 2)
      await client.call("tool_update", { name: "word_count", restore_version: retired.restore_version })
      assert.deepEqual(await client.call("word_count", { text: "one two" }), { count: 2 })
    })
  })

  // Both clients hand the same list to the same emitter, and both run a provider's own tool-call block the same way.
  test(`${mode.name}: tools(format) and callFrom answer a provider's own shapes`, async () => {
    await withClient(async (client) => {
      await client.call("tool_create", creation())
      const anthropic = await client.tools("anthropic")
      assert.deepEqual(anthropic[0], {
        name: "tool_create",
        description: (await client.tools())[0]?.description,
        input_schema: (await client.tools())[0]?.parameters,
      })
      assert.equal((await client.tools("openai"))[0]?.type, "function")

      const ran = await callFrom(client, "anthropic", {
        type: "tool_use",
        id: "toolu_01",
        name: "fl_word_count",
        input: { text: "one two" },
      })
      assert.deepEqual(ran, { type: "tool_result", tool_use_id: "toolu_01", content: '{"count":2}' })

      const refused = await callFrom(client, "anthropic", {
        type: "tool_use",
        id: "toolu_02",
        name: "fl_word_count",
        input: { text: 7 },
      })
      assert.equal(refused.is_error, true)
      assert.match(refused.content, /"code":"invalid_arguments"/)
    })
  })
}
