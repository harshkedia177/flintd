import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import test, { describe } from "node:test"
import { createFlint } from "../src/index.ts"
import type { LogEntry } from "../src/index.ts"
import { creation, refusal, temporaryLibrary, withFlint, withLibraries, withOpenFlint } from "./support.ts"

describe("The executor", () => {
  const LOOPING = {
    name: "loop_forever",
    description: "Loop until the call timeout when asked to, and answer at once otherwise.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { forever: { type: "boolean" } },
      required: ["forever"],
      additionalProperties: false,
    }),
    execute_source: "if (args.forever) { for (;;) {} }\nreturn { ok: true }",
    examples: [{ args: { forever: false }, expected: { ok: true } }],
  }

  const BUSY = {
    name: "busy_work",
    description: "Hold the tier for a fixed time when asked to, and answer at once otherwise.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { ms: { type: "integer" } },
      required: ["ms"],
      additionalProperties: false,
    }),
    execute_source: "const until = Date.now() + args.ms\nwhile (Date.now() < until) {}\nreturn { ok: true }",
    examples: [{ args: { ms: 0 }, expected: { ok: true } }],
  }

  // A second Flint on the same Library skips the gate it already passed, so the short timeout below bounds the
  // stuck Body and nothing else. Every healthy call keeps the default timeout.
  test("a Body that never returns fails with timeout while the event loop keeps running", async () => {
    const dir = await temporaryLibrary()
    try {
      await withOpenFlint({ dir }, async (flint) => {
        await flint.call("tool_create", LOOPING)
      })
      await withOpenFlint({ dir, callTimeoutMs: 150 }, async (flint) => {
        let ticks = 0
        const ticking = setInterval(() => {
          ticks += 1
        }, 10)
        const error = await refusal(() => flint.call("loop_forever", { forever: true }))
        clearInterval(ticking)
        assert.equal(error.code, "timeout")
        assert.equal(error.details["timeoutMs"], 150)
        assert.ok(ticks >= 3, `the event loop ticked ${ticks} times while the Body ran`)
      })
      await withOpenFlint({ dir }, async (flint) => {
        assert.deepEqual(await flint.call("loop_forever", { forever: false }), { ok: true })
      })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a Worker that does not answer in time is terminated, and the call queued behind it still runs", async () => {
    const dir = await temporaryLibrary()
    try {
      await withOpenFlint({ dir }, async (flint) => {
        await flint.call("tool_create", LOOPING)
      })
      // terminateAfterMs bounds the stuck call; the queued call needs a message round trip inside the same window,
      // and it only reaches the new Worker once that Worker reports itself ready, so 250 ms is a wide margin.
      await withOpenFlint({ dir, terminateAfterMs: 250 }, async (flint) => {
        const stuck = refusal(() => flint.call("loop_forever", { forever: true }))
        const queued = flint.call("loop_forever", { forever: false })
        const error = await stuck
        assert.equal(error.code, "timeout")
        assert.match(error.message, /the executor was restarted/)
        assert.deepEqual(await queued, { ok: true })
      })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  // The regex is the model's own, so it runs where the tier's own bound can stop it and never on the main thread.
  const CATASTROPHIC = {
    description: "Answer ok for a string made of the letter a.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { text: { type: "string", pattern: "^(a+)+$" } },
      required: ["text"],
      additionalProperties: false,
    }),
    examples: [{ args: { text: "aaa" }, expected: { ok: true } }],
  }

  test("a pattern that never finishes ends as timeout in both tiers, and the next call still runs", async () => {
    const dir = await temporaryLibrary()
    try {
      await withOpenFlint({ dir }, async (flint) => {
        await flint.call("tool_create", { ...CATASTROPHIC, name: "quickjs_pattern", execute_source: "return { ok: true }" })
        await flint.call("tool_create", {
          ...CATASTROPHIC,
          name: "node_pattern",
          execute_source: 'await import("node:crypto")\nreturn { ok: true }',
        })
      })
      const terminateAfterMs = 400
      await withOpenFlint({ dir, callTimeoutMs: 250, terminateAfterMs }, async (flint) => {
        const never = `${"a".repeat(40)}!`
        for (const name of ["quickjs_pattern", "node_pattern"]) {
          // The healthy call first, so the tier is already running and what is measured is the walk and its bound.
          assert.deepEqual(await flint.call(name, { text: "aaaa" }), { ok: true })
          const began = Date.now()
          const error = await refusal(() => flint.call(name, { text: never }))
          const waited = Date.now() - began
          assert.equal(error.code, "timeout")
          // V8's regex takes no interrupt, so the Node tier's bound is the pool killing the child at terminateAfterMs.
          assert.ok(waited < terminateAfterMs + 1000, `${name} answered after ${waited} ms, and the bound is ${terminateAfterMs} ms`)
          assert.deepEqual(await flint.call(name, { text: "aaaa" }), { ok: true })
        }
      })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a call in flight when stop() runs settles as a refusal, never as a store error", { timeout: 5_000 }, async () => {
    const dir = await temporaryLibrary()
    const flint = createFlint({ dir })
    await flint.start()
    try {
      await flint.call("tool_create", BUSY)
      const held = refusal(() => flint.call("busy_work", { ms: 60_000 }))
      await new Promise((tick) => setTimeout(tick, 30))
      await flint.stop()
      assert.equal((await held).code, "worker_unavailable")

      const again = createFlint({ dir })
      await again.start()
      assert.equal((await again.status()).tools, 1)
      await again.stop()
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  const ANNOUNCING = {
    name: "announce",
    description: "Say something to the host while it works, and answer that it did.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }),
    execute_source: "await ctx.log(`${ctx.toolName}: ${args.text}`)\nreturn { said: true }",
    examples: [{ args: { text: "ready" }, expected: { said: true } }],
  }

  const ASKING = {
    ...ANNOUNCING,
    name: "ask_host",
    execute_source:
      "try { await ctx.log(args.text) } catch (cause) { return { refused: cause.message } }\nreturn { refused: null }",
    examples: [{ args: { text: "ready" }, expected: { refused: null } }],
  }

  test("a Body reaches the main thread with ctx.log, and the result never carries the message", async () => {
    const seen: LogEntry[] = []
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", ANNOUNCING)
        const said = await flint.callWithId("announce", { text: "hello" })
        assert.deepEqual(said.result, { said: true })
        assert.deepEqual(seen.at(-1), { tool: "announce", callId: said.id, message: "announce: hello" })
      },
      { onLog: (entry) => seen.push(entry) },
    )
  })

  test("a host call the main thread refuses comes back to the Body as a thrown error", async () => {
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", ASKING)
        assert.deepEqual(await flint.call("ask_host", { text: "keep" }), { refused: null })
        assert.deepEqual(await flint.call("ask_host", { text: "drop" }), { refused: "the sink refused drop" })
      },
      {
        onLog: (entry) => {
          if (entry.message === "drop") throw new Error("the sink refused drop")
        },
      },
    )
  })

  const SLOW_MS = 350

  const SLOW_TO_PROVE = {
    name: "slow_work",
    description: "Hold the tier for the time it is given and answer that it did.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { ms: { type: "integer" } },
      required: ["ms"],
      additionalProperties: false,
    }),
    execute_source: "const until = Date.now() + args.ms\nwhile (Date.now() < until) {}\nreturn { ok: true }",
    examples: [{ args: { ms: SLOW_MS }, expected: { ok: true } }],
  }

  test("one slow Example in one Library holds up no call to the other", async () => {
    await withLibraries(async (flint) => {
      await flint.call("tool_create", creation(), { library: "user" })
      const creating = flint.call("tool_create", SLOW_TO_PROVE, { library: "project" })
      await new Promise((tick) => setTimeout(tick, 30))
      const started = Date.now()
      assert.deepEqual(await flint.call("word_count", { text: "one two" }, { library: "user" }), { count: 2 })
      const waited = Date.now() - started
      await creating
      // Each Library runs its Bodies in its own Worker: a call held up behind the slow one would cost it
      // close to the full SLOW_MS, so well under half of it is a generous margin, not a wall-clock guess.
      assert.ok(waited < SLOW_MS / 2, `the call waited ${waited} ms while a ${SLOW_MS} ms Example ran in the other Library`)
    })
  })
})
