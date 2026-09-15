import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { createFlint } from "../src/index.ts"
import type { Flint, JsonValue } from "../src/index.ts"
import { fakeModel } from "./fake-model.ts"
import { BRITTLE_SOURCE, creation, refusal, sharedLibrary, temporaryLibrary, verified, waitFor } from "./support.ts"

const CASES = [{ args: { text: "one two" }, confident: true, expected: { count: 2 } }]

const OTHER_BODY = {
  execute_source: "return { count: args.text.split(' ').filter(Boolean).length }",
  examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
}

const CAP_MESSAGES: string[] = []

const shared = sharedLibrary(
  async (flint) => {
    await flint.call("tool_create", creation({ name: "best_tool" }))
    await flint.call("tool_create", creation({ name: "worse_tool", execute_source: BRITTLE_SOURCE }))
    await verified(flint, "best_tool", "worse_tool")
  },
  {
    model: fakeModel({ cases: CASES }),
    activeCap: 1,
    activeListLimit: 1,
    onLog: (entry) => CAP_MESSAGES.push(entry.message),
  },
)

async function clean(flint: Flint, name: string, sessions: string[]): Promise<void> {
  for (const [at, sessionId] of sessions.entries()) {
    await flint.call(name, { text: `call number ${at}` }, { sessionId })
  }
}

async function stateOf(flint: Flint, name: string): Promise<string | undefined> {
  return (await flint.library()).find((one) => one.name === name)?.state
}

async function read(flint: Flint, name: string): Promise<Record<string, JsonValue>> {
  return (await flint.call("tool_read", { name })) as Record<string, JsonValue>
}

test("five clean calls across two sessions make a Verified Tool Active, and the default list carries it", async () => {
  await shared(async (flint) => {
    assert.deepEqual(
      (await flint.tools()).map((tool) => tool.name),
      ["tool_create", "tool_update", "tool_read", "tool_find", "tool_run", "tool_retire", "tool_history"],
    )

    // Five clean calls, and every one of them from one session: the Tool stays Verified.
    await clean(flint, "worse_tool", ["one", "one", "one", "one", "one"])
    assert.equal(await stateOf(flint, "worse_tool"), "verified")

    await clean(flint, "best_tool", ["one", "one", "one", "one", "two"])
    assert.equal(await stateOf(flint, "best_tool"), "active")
    assert.equal((await flint.status()).active, 1)

    // The promotion is a Version of its own, written by flintd and not by the agent that made the call.
    const history = (await flint.call("tool_history", { name: "best_tool" })) as {
      versions: { operation: string; channel: string }[]
    }
    assert.deepEqual(
      history.versions.map((one) => `${one.operation}:${one.channel}`),
      ["activate:flintd", "verify:flintd", "create:agent"],
    )

    // A Draft and a Verified Tool stay out of the default list; only the Active Tool joins the meta tools.
    assert.deepEqual(
      (await flint.tools()).slice(7).map((tool) => tool.name),
      ["best_tool"],
    )
    assert.deepEqual((await flint.tools())[7]?.parameters.required, ["text"])
    assert.equal((await flint.tools())[7]?.description, "Count the words in a piece of text.")
  })
})

test("a full Active cap blocks the promotion, names the lowest-contribution Active Tool, and leaves it Verified", async () => {
  await shared(async (flint) => {
    assert.equal((await flint.status()).activeCap, 1)
    // The preconditions this test needs, whatever ran before it: one Active Tool, and one that earns a place.
    await clean(flint, "best_tool", ["one", "one", "one", "one", "two"])
    assert.equal(await stateOf(flint, "best_tool"), "active")
    await clean(flint, "worse_tool", ["one", "one", "one", "one", "two"])

    assert.equal(await stateOf(flint, "worse_tool"), "verified")
    assert.equal((await flint.status()).active, 1)
    // Nothing is retired to make room: that is a person's decision, never flintd's.
    assert.equal((await flint.status()).retired, 0)

    const reason =
      'The Tool "worse_tool" earned promotion, and the Active cap of 1 Tools is full, so it stays Verified.' +
      ' The lowest-contribution Active Tool is "best_tool"; retire it with tool_retire to make room.'
    assert.deepEqual((await read(flint, "worse_tool"))["promotion"], {
      blocked: true,
      reason,
      lowest: "best_tool",
    })
    assert.ok(CAP_MESSAGES.includes(reason), CAP_MESSAGES.join("\n"))
  })
})

test("a Tool whose new Body fails its Held-out examples is never promoted on the calls the old Body earned", async () => {
  await shared(async (flint) => {
    // The Held-out example the fake writes expects { count: 2 } for "one two", and this Body answers 99.
    const updated = (await flint.call("tool_update", {
      name: "worse_tool",
      execute_source: "return { count: 99 }",
      examples: [{ args: { text: "one two three" }, expected: { count: 99 } }],
    })) as Record<string, JsonValue>
    assert.equal(updated["state"], "draft")

    await waitFor(
      async () => ((await read(flint, "worse_tool"))["held_out"] as { status: string }).status === "failed",
      "the Held-out run of the new Body never failed",
    )
    assert.equal(await stateOf(flint, "worse_tool"), "draft")

    // The sixth clean call: the Tool has long since earned five across two sessions, and it still stays a Draft.
    assert.deepEqual(await flint.call("worse_tool", { text: "one two" }, { sessionId: "two" }), { count: 99 })
    assert.equal(await stateOf(flint, "worse_tool"), "draft")
    assert.equal((await flint.status()).active, 1)
    assert.equal((await refusal(() => flint.call("no_such_tool", {}))).code, "not_found")
  })
})

test("an edit to a Tool that is not a Draft leaves it open to every session, not owned by the editor", async () => {
  const dir = await temporaryLibrary()
  try {
    const first = createFlint({ dir, model: fakeModel({ cases: CASES }) })
    await first.start()
    await first.call("tool_create", creation({ name: "shared_tool" }), { sessionId: "alice" })
    await verified(first, "shared_tool")
    await clean(first, "shared_tool", ["alice", "alice", "alice", "alice", "bob"])
    assert.equal(await stateOf(first, "shared_tool"), "active")
    await first.stop()

    // No model here, so no Held-out run rewrites the provenance this test is about.
    const second = createFlint({ dir })
    await second.start()
    try {
      assert.equal(await stateOf(second, "shared_tool"), "active")
      await second.call("tool_update", { name: "shared_tool", ...OTHER_BODY }, { sessionId: "carol" })
      // Carol's edit takes the Tool out of the default list. It does not take it out of the Tenant.
      assert.equal(await stateOf(second, "shared_tool"), "draft")
      assert.deepEqual(await second.call("shared_tool", { text: "one two" }, { sessionId: "alice" }), { count: 2 })
      assert.deepEqual(await second.call("shared_tool", { text: "one two" }, { sessionId: "bob" }), { count: 2 })
      assert.equal((await read(second, "shared_tool"))["state"], "draft")
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("a new Tool that takes back the name of a deleted one earns Active from its own calls alone", async () => {
  const dir = await temporaryLibrary()
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.call("tool_create", creation({ name: "ghost_tool" }))
    await clean(first, "ghost_tool", ["one", "one", "one", "one", "two"])
    await first.stop()
    // A person deletes the Tool directory between runs, and the next start forgets the Tool.
    await rm(join(dir, "tools", "ghost_tool"), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

    const second = createFlint({ dir, model: fakeModel({ cases: CASES }) })
    await second.start()
    try {
      assert.equal((await second.status()).tools, 0)
      await second.call("tool_create", creation({ name: "ghost_tool" }))
      await verified(second, "ghost_tool")
      await second.call("ghost_tool", { text: "one two" }, { sessionId: "three" })
      assert.equal(await stateOf(second, "ghost_tool"), "verified")
      assert.equal((await second.status()).active, 0)
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
