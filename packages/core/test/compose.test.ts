import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { rm } from "node:fs/promises"
import { after, before, describe, test } from "node:test"
import { createFlint } from "../src/index.ts"
import type { Flint } from "../src/index.ts"
import { refusal, temporaryLibrary, waitFor, withFlint, withOpenFlint } from "./support.ts"


const RELAY_PARAMETERS = JSON.stringify({
  type: "object",
  properties: { chain: { type: "array", items: { type: "string" } }, caught: { type: "boolean" } },
  required: ["chain"],
  additionalProperties: false,
})

// One Body for every link of a chain: it calls the next name it is given and hands back what came back.
const RELAY_SOURCE = `if (args.chain.length === 0) return { reached: ctx.toolName }
try {
  return await ctx.callTool(args.chain[0], { chain: args.chain.slice(1), caught: args.caught })
} catch (cause) {
  if (args.caught === false) throw cause
  return { code: cause.code, refused: cause.message }
}`

const RELAYS: Array<[string, string]> = [
  ["relay_one", "Hand the work to the first name in the list it is given."],
  ["relay_two", "Take a job, give it onward, and answer with whatever came back."],
  ["relay_three", "Forward a request down the line and return the answer unchanged."],
]

const UPPER = {
  name: "shout_text",
  description: "Put a piece of text into capital letters.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  }),
  execute_source: "return { shouted: args.text.toUpperCase() }",
  examples: [{ args: { text: "quiet" }, expected: { shouted: "QUIET" } }],
}

const SHOUT_TWICE = {
  name: "shout_twice",
  description: "Ask another Tool to capitalise a piece of text and say it two times over.",
  parameters_json: UPPER.parameters_json,
  execute_source: `const said = await ctx.callTool("shout_text", { text: args.text })
return { said: said.shouted + " " + said.shouted }`,
  examples: [{ args: { text: "hi" }, expected: { said: "HI HI" } }],
}

const FETCH_PARAMETERS = JSON.stringify({
  type: "object",
  properties: { url: { type: "string" } },
  required: ["url"],
  additionalProperties: false,
})

const CALLEE_SOURCE = `if (args.url === "") return { refused: null }
try { return { status: (await ctx.fetch(args.url)).status } } catch (cause) { return { refused: cause.message } }`

const CALLER_SOURCE = `if (args.url === "") return { refused: null }
const own = await (async () => {
  try { return { status: (await ctx.fetch(args.url)).status } } catch (cause) { return { refused: cause.message } }
})()
try {
  return { own, through: await ctx.callTool("reaching_callee", { url: args.url }) }
} catch (cause) {
  return { own, through: { code: cause.code, refused: cause.message } }
}`

// The callee logs on each side of work it cannot finish, so the caller's clock is visible: only the first line arrives.
const SPIN_SOURCE = `await ctx.log("started")
const until = Date.now() + args.ms
while (Date.now() < until) {}
await ctx.log("finished")
return { spun: args.ms }`

const RETHROW_SOURCE = `if (args.url === "") return { refused: null }
await ctx.callTool("reaching_callee", { url: args.url })
return { refused: null }`

const TIMES_PARAMETERS = JSON.stringify({
  type: "object",
  properties: { times: { type: "integer" } },
  required: ["times"],
  additionalProperties: false,
})

const ECHO = {
  name: "echo_back",
  description: "Answer at once with the number it was given.",
  parameters_json: TIMES_PARAMETERS,
  execute_source: "return { times: args.times }",
  examples: [{ args: { times: 1 }, expected: { times: 1 } }],
}

const FANOUT = {
  name: "fanout_tool",
  description: "Hand the same job to another Tool as many times in a row as it is asked for.",
  parameters_json: TIMES_PARAMETERS,
  execute_source: `let last = null
for (let n = 0; n < args.times; n += 1) last = await ctx.callTool("echo_back", { times: n })
return last`,
  examples: [{ args: { times: 1 }, expected: { times: 0 } }],
}

const SLEEP_PARAMETERS = JSON.stringify({
  type: "object",
  properties: { ms: { type: "integer" } },
  required: ["ms"],
  additionalProperties: false,
})

const HOG = {
  name: "hold_the_tier",
  description: "Wait for the number of milliseconds it is given and say that it waited.",
  parameters_json: SLEEP_PARAMETERS,
  execute_source: "await new Promise((wake) => setTimeout(wake, args.ms))\nreturn { waited: args.ms }",
  examples: [{ args: { ms: 1 }, expected: { waited: 1 } }],
}

const WAIT_THROUGH = {
  name: "wait_through",
  description: "Give a long wait to another Tool and answer once that Tool is done.",
  parameters_json: SLEEP_PARAMETERS,
  execute_source: `return await ctx.callTool("hold_the_tier", { ms: args.ms })`,
  examples: [{ args: { ms: 1 }, expected: { waited: 1 } }],
}

async function relays(flint: Flint, ...names: string[]): Promise<void> {
  for (const name of names) {
    const [, description] = RELAYS.find(([one]) => one === name) as [string, string]
    await flint.call("tool_create", {
      name,
      description,
      parameters_json: RELAY_PARAMETERS,
      execute_source: RELAY_SOURCE,
      examples: [{ args: { chain: [] }, expected: { reached: name } }],
    })
  }
}

async function upstream(): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"ok":true}')
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) }
}

describe("composition", () => {
  let flint: Flint
  let dir: string

  before(async () => {
    dir = await temporaryLibrary()
    flint = createFlint({ dir })
    await flint.start()
    await flint.call("tool_create", UPPER)
    await flint.call("tool_create", SHOUT_TWICE)
    await relays(flint, "relay_one", "relay_two", "relay_three")
    await flint.call("tool_create", ECHO)
    await flint.call("tool_create", FANOUT)
  })

  after(async () => {
    await flint.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  test("a Body calls another Tool, and the call the callee ran is recorded as a call of its own", async () => {
    const before = (await flint.library()).find((one) => one.name === "shout_text")?.calls ?? 0
    const said = await flint.callWithId("shout_twice", { text: "again" })
    assert.deepEqual(said.result, { said: "AGAIN AGAIN" })
    assert.equal(typeof said.id, "string")
    assert.equal((await flint.library()).find((one) => one.name === "shout_text")?.calls, before + 1)
  })

  test("a chain that reaches a Tool twice is refused with the chain named, and the Body can catch it", async () => {
    const looped = (await flint.call("relay_one", { chain: ["relay_two", "relay_one"] })) as {
      code: string
      refused: string
    }
    assert.equal(looped.code, "recursive_call")
    assert.match(looped.refused, /The Tool chain relay_one -> relay_two -> relay_one calls relay_one again/)
    assert.match(looped.refused, /a Tool may appear once in a chain/)
  })

  test("a cycle the Body does not catch fails the call with the chain in the message", async () => {
    const refused = await refusal(() =>
      flint.call("relay_one", { chain: ["relay_two", "relay_one"], caught: false }),
    )
    assert.equal(refused.code, "call_failed")
    assert.match(refused.message, /relay_one -> relay_two -> relay_one/)
  })

  test("a chain deeper than the cap is refused with the depth and the limit", async () => {
    await withFlint(
      async (deep) => {
        await relays(deep, "relay_one", "relay_two", "relay_three")
        const refused = (await deep.call("relay_one", { chain: ["relay_two", "relay_three"] })) as {
          code: string
          refused: string
        }
        assert.equal(refused.code, "recursive_call")
        assert.match(refused.refused, /relay_one -> relay_two -> relay_three is 3 Tools long and the limit is 2/)
        assert.match(refused.refused, /Call fewer Tools from a Body/)
      },
      { maxCallDepth: 2 },
    )
  })

  test("the caller's clock is the callee's: a callee stops where the caller runs out, and the stop is its own", async () => {
    const lines: string[] = []
    await withFlint(
      async (tight) => {
        await tight.call("tool_create", {
          name: "spin_tool",
          description: "Say that it started, work for the time it is given, and say that it finished.",
          parameters_json: SLEEP_PARAMETERS,
          execute_source: SPIN_SOURCE,
          examples: [{ args: { ms: 0 }, expected: { spun: 0 } }],
        })
        await tight.call("tool_create", {
          name: "spin_through",
          description: "Hand a long piece of work to another Tool and answer once that Tool is done.",
          parameters_json: SLEEP_PARAMETERS,
          execute_source: `return await ctx.callTool("spin_tool", { ms: args.ms })`,
          examples: [{ args: { ms: 0 }, expected: { spun: 0 } }],
        })
        lines.length = 0
        const refused = await refusal(() => tight.call("spin_through", { ms: 30_000 }))
        assert.equal(refused.code, "timeout")
        // The callee ran on the caller's clock: it started, and it never reached the line after its work.
        assert.deepEqual(lines, ["spin_tool: started"])
        // The callee's own call settles just after the caller's, so its record is the one to wait for.
        await waitFor(
          async () => (await tight.library()).find((one) => one.name === "spin_tool")?.errors === 1,
          "the callee's own call was never recorded as a failure",
        )
      },
      { callTimeoutMs: 400, onLog: (entry) => lines.push(`${entry.tool}: ${entry.message}`) },
    )
  })

  // A save runs the Tool's own Examples, and those are healthy calls. Under the 250 ms clock this test needs they
  // race it on a loaded machine, so the Library is written with ordinary limits and read back with the tight one.
  test("a callee that never answers cannot make the caller outlive its own timeout", async () => {
    const dir = await temporaryLibrary()
    await withOpenFlint({ dir }, async (flint) => {
      await flint.call("tool_create", HOG)
      await flint.call("tool_create", WAIT_THROUGH)
    })
    await withOpenFlint({ dir, callTimeoutMs: 250 }, async (tight) => {
      const began = Date.now()
      const refused = await refusal(() => tight.call("wait_through", { ms: 30_000 }))
      assert.equal(refused.code, "timeout")
      // The callee asked for 30 s. Anything near that means the caller waited for it; the bound is generous on
      // purpose, because what is under test is that the caller stopped, not how fast a runner starts.
      assert.ok(Date.now() - began < 10_000, `the call took ${Date.now() - began} ms`)
    })
  })

  test("a Body that calls a Tool five times in a row pays for one runner, not five", async () => {
    const took = async (times: number): Promise<number> => {
      const began = Date.now()
      await flint.call("fanout_tool", { times })
      return Date.now() - began
    }
    await took(1)
    const one = await took(1)
    const five = await took(5)
    // The first nested call of a chain starts a runner; the four after it must find that runner still there.
    assert.ok(five - one < one, `one nested call took ${one} ms and five took ${five} ms`)
  })

  test("a chain leaves no worker behind: only the lane every call shares keeps one", async () => {
    const alone = (): number => (process.report.getReport() as { workers: unknown[] }).workers.length
    const before = alone()
    assert.deepEqual(await flint.call("relay_one", { chain: ["relay_two", "relay_three"] }), { reached: "relay_three" })
    await waitFor(() => alone() === before, `the chain left ${alone() - before} worker(s) behind`)
  })

  test("a Node tier Body calls a QuickJS Tool the same way", async () => {
    await withFlint(async (mixed) => {
      await mixed.call("tool_create", UPPER)
      await mixed.call("tool_create", {
        name: "shout_digest",
        description: "Capitalise a piece of text with another Tool and hash what came back.",
        parameters_json: UPPER.parameters_json,
        execute_source: `const { createHash } = await import("node:crypto")
const said = await ctx.callTool("shout_text", { text: args.text })
return { shouted: said.shouted, digest: createHash("sha256").update(said.shouted).digest("hex").slice(0, 8) }`,
        examples: [{ args: { text: "abc" }, expected: { shouted: "ABC", digest: "b5d4045c" } }],
      })
      assert.equal((await mixed.library()).find((one) => one.name === "shout_digest")?.tier, "node")
      assert.deepEqual(await mixed.call("shout_digest", { text: "abc" }), { shouted: "ABC", digest: "b5d4045c" })
    })
  })
})

describe("a callee's Manifest governs the callee", () => {
  let service: { origin: string; close(): Promise<void> }

  before(async () => {
    service = await upstream()
  })

  after(async () => {
    await service.close()
  })

  test("a caller with no hosts reaches nothing itself, and reaches one only through the Tool that declared it", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", {
        name: "reaching_callee",
        description: "Ask one declared host for an answer and report the status it gave.",
        parameters_json: FETCH_PARAMETERS,
        execute_source: CALLEE_SOURCE,
        examples: [{ args: { url: "" }, expected: { refused: null } }],
        manifest_json: JSON.stringify({ hosts: ["127.0.0.1"] }),
      })
      await flint.call("tool_create", {
        name: "reaching_caller",
        description: "Try a host of its own and then let another Tool try the same one.",
        parameters_json: FETCH_PARAMETERS,
        execute_source: CALLER_SOURCE,
        examples: [{ args: { url: "" }, expected: { refused: null } }],
      })
      await flint.call("tool_create", {
        name: "rethrowing_caller",
        description: "Let another Tool fail and throw that failure onward without changing it.",
        parameters_json: FETCH_PARAMETERS,
        execute_source: RETHROW_SOURCE,
        examples: [{ args: { url: "" }, expected: { refused: null } }],
      })
      const url = `${service.origin}/`

      const waiting = (await flint.call("reaching_caller", { url })) as {
        own: { refused: string }
        through: { code: string }
      }
      assert.match(waiting.own.refused, /does not declare it/)
      assert.equal(waiting.through.code, "awaiting_approval")

      // The caller threw the callee's own refusal onward, and a Body cannot put a lifecycle code on a call.
      const rethrown = await refusal(() => flint.call("rethrowing_caller", { url }))
      assert.equal(rethrown.code, "call_failed")
      assert.match(rethrown.message, /reaching_callee/)

      const approval = (await flint.approvals()).find((one) => one.tool === "reaching_callee")
      assert.ok(approval !== undefined, "the callee's Manifest raised no Approval")
      await flint.approve(approval.id)

      const granted = (await flint.call("reaching_caller", { url })) as {
        own: { refused: string }
        through: { status: number }
      }
      assert.equal(granted.through.status, 200)
      assert.match(granted.own.refused, /reaching_caller tried to reach 127.0.0.1, and its Manifest does not declare it/)
    })
  })
})
