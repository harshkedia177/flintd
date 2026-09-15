import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import type { Flint, JsonValue, ToolStats } from "../src/index.ts"
import { BRITTLE_SOURCE, creation, refusal, sharedLibrary } from "./support.ts"

const ready = sharedLibrary()

type Read = Record<string, JsonValue>

function statsOf(read: Read): ToolStats {
  return read["stats"] as unknown as ToolStats
}

async function read(flint: Flint, name: string, meta = {}): Promise<Read> {
  return (await flint.call("tool_read", { name }, meta)) as Read
}

async function stored(dir: string, name: string): Promise<ToolStats> {
  return JSON.parse(await readFile(join(dir, "tools", name, "stats.json"), "utf8")) as ToolStats
}

test("every call is recorded with its session, harness and tokens, and stats.json catches up on the next write", async () => {
  await ready(async (flint, dir) => {
    await flint.call("tool_create", creation({ name: "counted_tool", execute_source: BRITTLE_SOURCE }))
    await flint.call(
      "counted_tool",
      { text: "one two" },
      { sessionId: "alpha", harness: "gate-test", tokens: { input: 120, output: 8 } },
    )
    await refusal(() => flint.call("counted_tool", { text: "boom" }, { sessionId: "alpha" }))

    const live = statsOf(await read(flint, "counted_tool"))
    assert.equal(live.calls, 2)
    assert.equal(live.errors, 1)
    assert.deepEqual(live.tokens, { input: 120, output: 8 })
    assert.equal(live.contribution, 0)
    assert.ok(typeof live.p50Ms === "number" && live.p50Ms >= 0, JSON.stringify(live))
    assert.ok(typeof live.lastCallAt === "string")

    // The counters live in the index; the file catches up with the next Version, so git shows them as of that Version.
    assert.deepEqual(await stored(dir, "counted_tool"), {
      calls: 0,
      errors: 0,
      lastCallAt: null,
      p50Ms: null,
      tokens: { input: 0, output: 0 },
      contribution: 0,
    })
    await flint.call("tool_update", { name: "counted_tool", description: "Count the words of a text." })
    const written = await stored(dir, "counted_tool")
    assert.equal(written.calls, 2)
    assert.equal(written.errors, 1)
    assert.deepEqual(written.tokens, { input: 120, output: 8 })
    assert.equal(written.contribution, 0)

    assert.equal((await refusal(() => flint.call("counted_tool", { text: "x" }, { tokens: { input: -1 } }))).code, "invalid_arguments")
  })
})

test("Contribution counts a failure against a success, and a second report on one call replaces the first", async () => {
  await ready(async (flint) => {
    await flint.call("tool_create", creation({ name: "scored_tool", execute_source: BRITTLE_SOURCE }))
    const first = await flint.callWithId("scored_tool", { text: "one two" })
    assert.deepEqual(first.result, { count: 2 })
    assert.ok(typeof first.id === "string")
    await flint.call("scored_tool", { text: "one two three" })
    await flint.call("scored_tool", { text: "four" })
    // The call a harness most wants to report on is the one that failed, so the refusal carries its id.
    const failure = await refusal(() => flint.call("scored_tool", { text: "boom" }))
    assert.equal(failure.code, "call_failed")
    const failedId = String(failure.details["callId"])
    assert.match(failedId, /^[0-9a-f-]{36}$/)

    const contribution = async (): Promise<number> => statsOf(await read(flint, "scored_tool")).contribution
    // Three successes and one failure: (3 - 1) / 4.
    assert.equal(await contribution(), 0.5)

    const negative = await flint.report(first.id as string, "negative", "it answered the wrong question")
    assert.equal(negative.tool, "scored_tool")
    assert.equal(negative.library, "user")
    assert.equal(negative.contribution, 0)
    assert.equal(await contribution(), 0)

    // The same call, reported again: the second report replaces the first rather than counting twice.
    assert.equal((await flint.report(first.id as string, "positive")).contribution, 0.5)
    assert.equal(await contribution(), 0.5)

    assert.equal((await flint.report(failedId, "positive")).contribution, 1)
    assert.equal((await refusal(() => flint.report("no-such-call", "positive"))).code, "not_found")
    assert.equal(
      (await refusal(() => flint.report(first.id as string, "helpful" as "positive"))).code,
      "invalid_arguments",
    )
  })
})

test("a Draft answers the session that made it, and a call that names no session, and no other", async () => {
  await ready(async (flint) => {
    await flint.call("tool_create", creation({ name: "mine_only" }), { sessionId: "alpha" })
    await flint.call("tool_create", creation({ name: "no_session" }))

    assert.deepEqual(await flint.call("mine_only", { text: "one two" }, { sessionId: "alpha" }), { count: 2 })
    assert.equal((await read(flint, "mine_only", { sessionId: "alpha" }))["state"], "draft")
    assert.deepEqual(await flint.call("mine_only", { text: "one two" }), { count: 2 })
    assert.equal((await read(flint, "mine_only"))["state"], "draft")

    const called = await refusal(() => flint.call("mine_only", { text: "one two" }, { sessionId: "beta" }))
    assert.equal(called.code, "not_found")
    assert.match(called.message, /Draft of another session/)
    assert.equal((await refusal(() => flint.call("tool_run", { name: "mine_only", args: { text: "x" } }, { sessionId: "beta" }))).code, "not_found")

    // Every meta tool that reads or writes the Draft answers another session the same way, the Body included.
    const beta = { sessionId: "beta" }
    for (const [tool, args] of [
      ["tool_read", { name: "mine_only", include_source: true }],
      ["tool_history", { name: "mine_only", include_source: true }],
      ["tool_update", { name: "mine_only", description: "Mine, from another session." }],
      ["tool_retire", { name: "mine_only" }],
    ] as [string, { [key: string]: JsonValue }][]) {
      const refused = await refusal(() => flint.call(tool, args, beta))
      assert.equal(refused.code, "not_found", tool)
      assert.match(refused.message, /Draft of another session/, tool)
    }
    assert.equal((await read(flint, "mine_only", { sessionId: "alpha" }))["state"], "draft")

    // A Draft that carries no session of its own belongs to the Tenant, and every session reaches it.
    assert.deepEqual(await flint.call("no_session", { text: "one two" }, { sessionId: "beta" }), { count: 2 })
    assert.deepEqual((await flint.tools()).map((tool) => tool.name).slice(7), [])
  })
})

test("an update that changes the Body clears the flag that asked for a review", async () => {
  await ready(async (flint, dir) => {
    await flint.call("tool_create", creation({ name: "review_me" }))
    const path = join(dir, "tools", "review_me", "tool.json")
    const held = JSON.parse(await readFile(path, "utf8")) as Record<string, JsonValue>
    await writeFile(path, JSON.stringify({ ...held, needs_review: true }, null, 2))

    const updated = (await flint.call("tool_update", {
      name: "review_me",
      execute_source: "return { count: args.text.split(' ').filter(Boolean).length }",
      examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
    })) as Read
    assert.equal(updated["needs_review"], false)
    assert.equal((await read(flint, "review_me"))["needs_review"], false)
    assert.deepEqual((await flint.status()).review, [])
    const saved = JSON.parse(await readFile(path, "utf8")) as { needs_review: boolean }
    assert.equal(saved.needs_review, false)
  })
})
