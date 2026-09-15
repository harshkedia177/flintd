import assert from "node:assert/strict"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { creation, refusal, sha256Creation, sharedLibrary, temporaryLibrary, withFlint, withOpenFlint } from "./support.ts"
import type { JsonValue } from "../src/index.ts"

const TRIP = {
  name: "plan_trip",
  description: "Echo a trip plan so the argument schema has something to check.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: {
      city: { type: "string", minLength: 2 },
      nights: { type: "integer", minimum: 1, maximum: 30 },
      mode: { type: "string", enum: ["train", "plane"] },
      stops: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    required: ["city", "nights"],
    additionalProperties: false,
  }),
  execute_source: "return { city: args.city, nights: args.nights }",
  examples: [{ args: { city: "Oslo", nights: 2 }, expected: { city: "Oslo", nights: 2 } }],
}

const SHAPES = {
  name: "shapes",
  description: "Return a result whose shape the arguments choose, so the result limits have something to catch.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { kind: { type: "string", enum: ["ok", "big", "circular", "hang", "unsettled", "throw"] } },
    required: ["kind"],
    additionalProperties: false,
  }),
  execute_source: [
    "if (args.kind === 'big') return 'x'.repeat(5000)",
    "if (args.kind === 'circular') { const held = {}; held.self = held; return held }",
    "if (args.kind === 'hang') { while (true) {} }",
    "if (args.kind === 'unsettled') return new Promise(function () {})",
    "if (args.kind === 'throw') { const failure = new Error('interrupted'); failure.name = 'InternalError'; throw failure }",
    "return 'ok'",
  ].join("\n"),
  examples: [{ args: { kind: "ok" }, expected: "ok" }],
}

const REACH = {
  name: "reach",
  description: "Report what the QuickJS tier exposes to a Body.",
  parameters_json: JSON.stringify({ type: "object", properties: {}, additionalProperties: false }),
  execute_source:
    "return [typeof fetch, typeof setTimeout, typeof require, typeof process, typeof console, typeof WebAssembly]",
  examples: [{ args: {}, expected: ["undefined", "function", "undefined", "undefined", "undefined", "undefined"] }],
}

const COUNT_KEYS = {
  name: "count_keys",
  description: "Count the keys of whatever object the caller sends.",
  parameters_json: JSON.stringify({ type: "object", additionalProperties: true }),
  execute_source: "return Object.keys(args).length",
  examples: [{ args: { a: 1, b: 2 }, expected: 2 }],
}

// A schema that declares "constructor" by name, beside one that does not: a key on every object is not a declared property.
const PROTO_KEYS = {
  name: "proto_keys",
  description: "Answer with the argument keys a caller sent, sorted.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { text: { type: "string" }, constructor: { type: "number" } },
    required: ["text"],
    additionalProperties: false,
  }),
  execute_source: "return { keys: Object.keys(args).sort() }",
  examples: [{ args: { text: "a", constructor: 1 }, expected: { keys: ["constructor", "text"] } }],
}

const ready = sharedLibrary(async (flint) => {
  for (const tool of [TRIP, SHAPES, REACH, COUNT_KEYS, PROTO_KEYS, creation(), sha256Creation()]) {
    await flint.call("tool_create", tool)
  }
})

test("tools returns the seven meta tools with provider-neutral schemas", async () => {
  await ready(async (flint) => {
    const tools = (await flint.tools())
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["tool_create", "tool_update", "tool_read", "tool_find", "tool_run", "tool_retire", "tool_history"],
    )
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string")
      assert.equal(tool.parameters.type, "object")
      assert.ok(Object.keys(tool.parameters.properties ?? {}).length > 0)
    }
  })
})

test("calling a Tool by name checks the arguments against its schema", async () => {
  await ready(async (flint) => {
    const cases: Array<[JsonValue, RegExp]> = [
      [{ city: 1, nights: 2 }, /city must be a string, not a number/],
      [{ nights: 2 }, /city is required/],
      [{ city: "Oslo", nights: 2, extra: true }, /extra is not an argument this Tool accepts/],
      [{ city: "Oslo", nights: 2, mode: "boat" }, /mode must be one of "train", "plane"/],
      [{ city: "Oslo", nights: 0 }, /nights must be 1 or more/],
      [{ city: "Oslo", nights: 2.5 }, /nights must be an integer/],
      [{ city: "O", nights: 2 }, /city must be at least 2 characters/],
      [{ city: "Oslo", nights: 2, stops: [{ name: 1 }] }, /stops\[0\]\.name must be a string/],
      [{ city: "Oslo", nights: 2, stops: [{ town: "Bergen" }] }, /stops\[0\]\.name is required/],
      [{ city: "Oslo", nights: 2, stops: [{ name: "a" }, { name: "b" }, { name: "c" }] }, /at most 2 items/],
      ["not an object", /the arguments must be an object, not a string/],
    ]
    for (const [args, problem] of cases) {
      const error = await refusal(() => flint.call("plan_trip", args))
      assert.equal(error.code, "invalid_arguments")
      assert.match(error.message, problem)
    }
  })
})

test("a key that every object carries is not an argument the Tool accepts, and a declared one still is", async () => {
  await ready(async (flint) => {
    // JSON.parse, not a literal: it is what the HTTP and MCP surfaces do, and it is what makes "__proto__" an own key.
    const payload = JSON.parse(
      '{"text":"a","constructor":{"x":1},"__proto__":"anything","toString":[1,2],"valueOf":99}',
    ) as JsonValue
    const error = await refusal(() => flint.call("proto_keys", payload))
    assert.equal(error.code, "invalid_arguments")
    for (const key of ["__proto__", "toString", "valueOf"]) {
      assert.match(error.message, new RegExp(`${key} is not an argument this Tool accepts`))
    }
    assert.match(error.message, /constructor must be a number, not an object/)

    const allowed = JSON.parse('{"text":"a","constructor":7}') as JsonValue
    assert.deepEqual(await flint.call("proto_keys", allowed), { keys: ["constructor", "text"] })
  })
})

test("a created Tool runs in the QuickJS tier, by name and through tool_run", async () => {
  await ready(async (flint) => {
    const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    assert.equal(await flint.call("sha256_hex", { text: "hello" }), digest)
    assert.equal(await flint.call("tool_run", { name: "sha256_hex", args: { text: "hello" } }), digest)

    const error = await refusal(() => flint.call("tool_run", { name: "sha256_hex", args: { text: 7 } }))
    assert.equal(error.code, "invalid_arguments")
  })
})

test("a Body that throws surfaces as call_failed and cannot forge another code", async () => {
  await ready(async (flint) => {
    const error = await refusal(() => flint.call("shapes", { kind: "throw" }))
    assert.equal(error.code, "call_failed")
    assert.equal(error.details["error"], "interrupted")
    assert.match(error.message, /shapes threw: interrupted/)
  })
})

test("a result over the limit is refused with guidance, and a result that is not JSON is refused", async () => {
  await withFlint(
    async (flint) => {
      await flint.call("tool_create", SHAPES)
      const tooLarge = await refusal(() => flint.call("shapes", { kind: "big" }))
      assert.equal(tooLarge.code, "result_too_large")
      assert.equal(tooLarge.details["maximum"], 1000)
      assert.match(tooLarge.message, /Return less/)

      const unserializable = await refusal(() => flint.call("shapes", { kind: "circular" }))
      assert.equal(unserializable.code, "unserializable_result")
    },
    { maxResultBytes: 1000 },
  )
})

// The Tool is written by a Flint with the normal call timeout, because proving an Example on a loaded machine
// takes longer than the short timeout this test needs; the second Flint reads the Library the first one committed.
test("a Body that does not finish is stopped at the call timeout", async () => {
  const dir = await temporaryLibrary()
  try {
    await withOpenFlint({ dir }, async (flint) => {
      await flint.call("tool_create", SHAPES)
    })
    await withOpenFlint({ dir, callTimeoutMs: 200 }, async (flint) => {
      for (const kind of ["hang", "unsettled"]) {
        const error = await refusal(() => flint.call("shapes", { kind }))
        assert.equal(error.code, "timeout")
        assert.equal(error.details["timeoutMs"], 200)
      }
    })
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("a Body reaches no network, no filesystem and no host process, and its only timer is the capped one", async () => {
  await ready(async (flint) => {
    assert.deepEqual(await flint.call("reach", {}), [
      "undefined",
      "function",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ])
  })
})

test("tool_read returns the schema, the description and the state, and the Body and Examples on request", async () => {
  await ready(async (flint) => {
    const source = creation()["execute_source"] as string
    const brief = (await flint.call("tool_read", { name: "word_count" })) as Record<string, JsonValue>
    assert.deepEqual(Object.keys(brief).sort(), [
      "approval",
      "description",
      "downgraded",
      "held_out",
      "library",
      "manifest",
      "name",
      "needs_review",
      "parameters",
      "result",
      "state",
      "stats",
      "tier",
    ])
    assert.equal(brief["state"], "draft")
    assert.equal(brief["description"], "Count the words in a piece of text.")
    assert.deepEqual((brief["parameters"] as { required: string[] }).required, ["text"])

    const full = (await flint.call("tool_read", {
      name: "word_count",
      include_source: true,
      include_examples: true,
    })) as Record<string, JsonValue>
    assert.equal(full["source"], `\n${source}\n`)
    assert.deepEqual(full["examples"], [
      { args: { text: "one two three" }, expected: { count: 3 }, grade: "exact" },
    ])
  })
})

test("an unknown Tool name is not_found", async () => {
  await ready(async (flint) => {
    for (const call of [() => flint.call("missing_tool", {}), () => flint.call("tool_read", { name: "missing_tool" })]) {
      const error = await refusal(call)
      assert.equal(error.code, "not_found")
      assert.match(error.message, /tool_create/)
    }
  })
})

test("tool_run refuses a meta tool name so it cannot call itself", async () => {
  await ready(async (flint) => {
    for (const name of ["tool_run", "tool_create"]) {
      const error = await refusal(() => flint.call("tool_run", { name, args: {} }))
      assert.equal(error.code, "not_found")
      assert.match(error.message, /Call it directly/)
    }
  })
})

test("arguments over the limit are refused before the Body runs", async () => {
  await withFlint(
    async (flint) => {
      await flint.call("tool_create", creation())
      const error = await refusal(() => flint.call("word_count", { text: "word ".repeat(100) }))
      assert.equal(error.code, "invalid_arguments")
      assert.equal(error.details["maximum"], 200)
      assert.match(error.message, /Send less/)
    },
    { maxArgsBytes: 200 },
  )
})

test("a Body file that no longer defines execute is refused, not run", async () => {
  await withFlint(async (flint, dir) => {
    await flint.call("tool_create", creation())
    await writeFile(join(dir, "tools", "word_count", "body.js"), "export async function run(args, ctx) {\n  return 1\n}\n")
    const error = await refusal(() => flint.call("word_count", { text: "one two" }))
    assert.equal(error.code, "invalid_source")
    assert.match(error.message, /must define `execute`/)
  })
})

test("an inherited property does not satisfy a required argument", async () => {
  await ready(async (flint) => {
    const inherited = Object.create({ text: "one two" }) as Record<string, unknown>
    const error = await refusal(() => flint.call("word_count", inherited))
    assert.equal(error.code, "invalid_arguments")
    assert.match(error.message, /text is required/)
  })
})

test("arguments that cannot be turned into JSON are refused, not thrown", async () => {
  await ready(async (flint) => {
    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    for (const args of [circular, { size: BigInt(1) }]) {
      const error = await refusal(() => flint.call("count_keys", args))
      assert.equal(error.code, "invalid_arguments")
      assert.match(error.message, /must be JSON/)
    }
  })
})

// Its schema takes any key, so nothing about the schema bounds the walk; the depth of the value is the only thing
// between 40 KB of arguments and the clone that would carry them into a tier.
test("arguments nested deeper than the bound are refused before anything walks them", async () => {
  await ready(async (flint) => {
    let deep: Record<string, unknown> = { end: true }
    for (let at = 0; at < 20_000; at += 1) deep = { a: deep }
    const error = await refusal(() => flint.call("count_keys", deep))
    assert.equal(error.code, "invalid_arguments")
    assert.match(error.message, /nests more than 64 levels deep/)
    // The Library still answers: the refusal cost the call and nothing else.
    assert.equal(await flint.call("count_keys", { a: 1, b: 2 }), 2)
  })
})
