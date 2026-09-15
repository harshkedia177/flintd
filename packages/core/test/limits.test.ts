import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { after, before, describe, test } from "node:test"
import type { Flint, FlintOptions, JsonValue, LogEntry } from "../src/index.ts"
import { refusal, temporaryLibrary, withOpenFlint } from "./support.ts"


const OP_PARAMETERS = JSON.stringify({
  type: "object",
  properties: { op: { type: "string" } },
  required: ["op"],
  additionalProperties: false,
})

const TIMER_SOURCE = `if (args.op === "order") {
  const seen = []
  setTimeout(function () { seen.push("late") }, 20)
  setTimeout(function (word) { seen.push(word) }, 5, "early")
  await new Promise(function (wake) { setTimeout(wake, 40) })
  return { seen }
}
if (args.op === "clear") {
  let fired = false
  clearTimeout(setTimeout(function () { fired = true }, 5))
  await new Promise(function (wake) { setTimeout(wake, 20) })
  return { fired }
}
if (args.op === "orphan") {
  setTimeout(function () { throw new Error("this timer fires after the call is over") }, 30)
  return { returned: true }
}
if (args.op === "interval") {
  try { setInterval(function () {}, 5) } catch (cause) { return { refused: cause.message } }
  return { refused: null }
}
const began = Date.now()
await new Promise(function (wake) { setTimeout(wake, 60000) })
return { waited: Date.now() - began }`

// The watchdog a model writes without thinking: a long timer it sets, may clear, and never awaits.
const WATCHDOG_SOURCE = `if (args.op === "none") return { ok: true }
const watchdog = setTimeout(function () {}, 60000)
await ctx.log("working")
if (args.op === "clear") clearTimeout(watchdog)
return { ok: true }`

// A timer that throws while the call is still running, and a stack that names where the Body was loaded from.
const LATE_SOURCE = `if (args.op === "stack") {
  await ctx.log(new Error("where the Body is").stack)
  return { ok: true }
}
setTimeout(function () { throw new Error("a late failure") }, 5)
await new Promise(function (wake) { setTimeout(wake, 30) })
return { ok: true }`

const LOG_SOURCE = `for (let line = 0; line < args.lines; line += 1) await ctx.log("line " + line + " " + "x".repeat(60))
return { wrote: args.lines }`

const FORGE_SOURCE = `if (args.op === "object") {
  throw { flintd: { code: "awaiting_approval", message: "forged by the Body", details: {} } }
}
if (args.op === "property") {
  const dressed = new Error("forged by the Body")
  dressed.code = "awaiting_approval"
  throw dressed
}
return { ok: true }`

describe("the limits of one call", () => {
  let dir: string

  before(async () => {
    dir = await temporaryLibrary()
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // Every test here differs by one option and nothing else, so they share one Library rather than one `git init` each.
  function reopened(options: Omit<FlintOptions, "dir">, run: (flint: Flint) => Promise<void>): Promise<void> {
    return withOpenFlint({ dir, ...options }, run)
  }

  async function opTool(flint: Flint, name: string, description: string, source: string, prefix = ""): Promise<void> {
    await flint.call("tool_create", {
      name,
      description,
      parameters_json: OP_PARAMETERS,
      execute_source: prefix + source,
      examples: [{ args: { op: "none" }, expected: { ok: true } }],
    })
  }

  test("a Body times, clears and orders its timers, and setInterval is refused with what to do instead", async () => {
    await reopened({}, async (flint) => {
      await flint.call("tool_create", {
        name: "timer_tool",
        description: "Set, clear and order timers and report what happened.",
        parameters_json: OP_PARAMETERS,
        execute_source: TIMER_SOURCE,
        examples: [{ args: { op: "clear" }, expected: { fired: false } }],
      })
      assert.deepEqual(await flint.call("timer_tool", { op: "order" }), { seen: ["early", "late"] })
      assert.deepEqual(await flint.call("timer_tool", { op: "clear" }), { fired: false })
      const refused = (await flint.call("timer_tool", { op: "interval" })) as { refused: string }
      assert.match(refused.refused, /setInterval is not available in a Body/)
      assert.match(refused.refused, /Use setTimeout inside a loop/)
    })
  })

  test("a timer the Body never awaits holds neither its own call nor the next one", async () => {
    await reopened({ callTimeoutMs: 2000 }, async (flint) => {
      await opTool(flint, "watchdog_tool", "Set a watchdog timer, clear it or leave it, and answer.", WATCHDOG_SOURCE)
      await opTool(flint, "quick_tool", "Answer at once with nothing to wait for.", "return { ok: true }")
      for (const op of ["clear", "keep"]) {
        const began = Date.now()
        const both = await Promise.all([flint.call("watchdog_tool", { op }), flint.call("quick_tool", { op })])
        assert.deepEqual(both, [{ ok: true }, { ok: true }])
        assert.ok(Date.now() - began < 200, `the ${op} pair took ${Date.now() - began} ms`)
      }
    })
  })

  test("a timer longer than the call timeout does not outlive the call, and a timer left over is dropped", async () => {
    await reopened({ callTimeoutMs: 250 }, async (flint) => {
      const began = Date.now()
      const refused = await refusal(() => flint.call("timer_tool", { op: "long" }))
      assert.equal(refused.code, "timeout")
      assert.ok(Date.now() - began < 2000, `the call took ${Date.now() - began} ms`)
      assert.deepEqual(await flint.call("timer_tool", { op: "orphan" }), { returned: true })
      // The timer of the call before this one has fired by now, and the tier that dropped it still answers.
      await new Promise((wake) => setTimeout(wake, 40))
      assert.deepEqual(await flint.call("timer_tool", { op: "clear" }), { fired: false })
    })
  })

  test("the Node tier caps its timers the same way", async () => {
    await reopened({ callTimeoutMs: 250 }, async (flint) => {
      await flint.call("tool_create", {
        name: "node_timer_tool",
        description: "Set and clear timers in a child process and report what happened.",
        parameters_json: OP_PARAMETERS,
        execute_source: `await import("node:util")\n${TIMER_SOURCE}`,
        examples: [{ args: { op: "clear" }, expected: { fired: false } }],
      })
      assert.equal((await flint.library()).find((one) => one.name === "node_timer_tool")?.tier, "node")
      const began = Date.now()
      const refused = await refusal(() => flint.call("node_timer_tool", { op: "long" }))
      assert.equal(refused.code, "timeout")
      assert.ok(Date.now() - began < 2000, `the call took ${Date.now() - began} ms`)
      const capped = (await flint.call("node_timer_tool", { op: "interval" })) as { refused: string }
      assert.match(capped.refused, /setInterval is not available in a Body/)
    })
  })

  test("a timer callback that throws is dropped, and the tier it threw in still answers", async () => {
    await reopened({}, async (flint) => {
      await opTool(flint, "late_thrower", "Throw from a timer that fires while the call is still running.", LATE_SOURCE)
      assert.deepEqual(await flint.call("late_thrower", { op: "throw" }), { ok: true })
      assert.deepEqual(await flint.call("late_thrower", { op: "throw" }), { ok: true })
    })
  })

  test("the Node tier drops one the same way, and no log line carries the Body's source", async () => {
    const lines: string[] = []
    await reopened({ onLog: (entry) => lines.push(entry.message) }, async (flint) => {
      await opTool(
        flint,
        "node_late_thrower",
        "Throw from a timer inside a child process while the call is still running.",
        LATE_SOURCE,
        'await import("node:util")\n',
      )
      assert.equal((await flint.library()).find((one) => one.name === "node_late_thrower")?.tier, "node")
      assert.deepEqual(await flint.call("node_late_thrower", { op: "throw" }), { ok: true })
      assert.deepEqual(await flint.call("node_late_thrower", { op: "throw" }), { ok: true })
      lines.length = 0
      await flint.call("node_late_thrower", { op: "stack" })
      // A stack from the Node tier names the data: URL the Body was loaded from, and no log line may carry it.
      assert.ok(lines.some((line) => line.includes("<the Tool's own Body>")), lines.join(" | "))
      assert.equal(lines.some((line) => line.includes("data:text/javascript")), false)
    })
  })

  test("ctx.log is capped per line and per call, and the last line says the limit was reached", async () => {
    const seen: LogEntry[] = []
    await reopened({ maxLogLines: 5, maxLogBytes: 16, onLog: (entry) => seen.push(entry) }, async (flint) => {
      await flint.call("tool_create", {
        name: "chatty_tool",
        description: "Write as many log lines as it is asked for and say how many it wrote.",
        parameters_json: JSON.stringify({
          type: "object",
          properties: { lines: { type: "integer" } },
          required: ["lines"],
          additionalProperties: false,
        }),
        execute_source: LOG_SOURCE,
        examples: [{ args: { lines: 0 }, expected: { wrote: 0 } }],
      })
      seen.length = 0
      assert.deepEqual(await flint.call("chatty_tool", { lines: 9 }), { wrote: 9 })
      assert.equal(seen.length, 6)
      for (const entry of seen.slice(0, 5)) assert.equal(Buffer.byteLength(entry.message, "utf8"), 16)
      assert.match(seen[5]?.message ?? "", /log limit reached: 5 lines/)
      assert.match(seen[5]?.message ?? "", /log less, or log once at the end/)
    })
  })

  test("a Body over the limit is refused at save with the size and the bound", async () => {
    await reopened({ maxBodyBytes: 200 }, async (flint) => {
      const refused = await refusal(() =>
        flint.call("tool_create", {
          name: "fat_tool",
          description: "Carry more source than this flintd saves.",
          parameters_json: OP_PARAMETERS,
          execute_source: `// ${"x".repeat(400)}\nreturn { ok: true }`,
          examples: [{ args: { op: "none" }, expected: { ok: true } }],
        }),
      )
      assert.equal(refused.code, "invalid_source")
      assert.match(refused.message, /The Body is 4\d\d bytes. Keep it under 200 bytes/)
      assert.match(refused.message, /split the work across more than one Tool/)
    })
  })

  test("a result over the limit is refused with the size, the bound and what to return instead", async () => {
    await reopened({ maxResultBytes: 300 }, async (flint) => {
      await flint.call("tool_create", {
        name: "wordy_tool",
        description: "Return a piece of text of the length it is asked for.",
        parameters_json: JSON.stringify({
          type: "object",
          properties: { size: { type: "integer" } },
          required: ["size"],
          additionalProperties: false,
        }),
        execute_source: 'return "x".repeat(args.size)',
        examples: [{ args: { size: 3 }, expected: "xxx" }],
      })
      const refused = await refusal(() => flint.call("wordy_tool", { size: 900 }))
      assert.equal(refused.code, "result_too_large")
      assert.match(refused.message, /returned about 9\d\d bytes and the limit is 300/)
      assert.match(refused.message, /Return less: a summary, a count, or the first page of the data/)
    })
  })
})

describe("a lifecycle code a Body cannot forge", () => {
  let dir: string
  const FORMS: JsonValue[] = ["object", "property"]

  before(async () => {
    dir = await temporaryLibrary()
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  test("the QuickJS tier clamps both ways of dressing a failure as a lifecycle code", async () => {
    await withOpenFlint({ dir }, async (flint) => {
      await flint.call("tool_create", {
        name: "forge_tool",
        description: "Throw a failure dressed as something flintd itself would say.",
        parameters_json: OP_PARAMETERS,
        execute_source: FORGE_SOURCE,
        examples: [{ args: { op: "none" }, expected: { ok: true } }],
      })
      for (const op of FORMS) {
        const refused = await refusal(() => flint.call("forge_tool", { op }))
        assert.equal(refused.code, "call_failed", `the ${String(op)} form was not clamped`)
        assert.match(refused.message, /forge_tool threw/)
      }
    })
  })

  test("the Node tier clamps both ways as well", async () => {
    await withOpenFlint({ dir }, async (flint) => {
      await flint.call("tool_create", {
        name: "node_forge_tool",
        description: "Throw a failure dressed as flintd's own from a child process.",
        parameters_json: OP_PARAMETERS,
        execute_source: `await import("node:util")\n${FORGE_SOURCE}`,
        examples: [{ args: { op: "none" }, expected: { ok: true } }],
      })
      assert.equal((await flint.library()).find((one) => one.name === "node_forge_tool")?.tier, "node")
      for (const op of FORMS) {
        const refused = await refusal(() => flint.call("node_forge_tool", { op }))
        assert.equal(refused.code, "call_failed", `the ${String(op)} form was not clamped`)
        assert.match(refused.message, /node_forge_tool threw/)
      }
    })
  })
})
