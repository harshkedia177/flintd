import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import type { Flint, JsonValue } from "../src/index.ts"
import { refusal, sharedLibrary } from "./support.ts"

const shared = sharedLibrary()

const PARAMETERS = JSON.stringify({
  type: "object",
  properties: { text: { type: "string" }, shape: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
})

const RESULT = JSON.stringify({
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
  additionalProperties: false,
})

const SOURCE = `const count = args.text.trim().split(/\\s+/).filter(Boolean).length
if (args.shape === "string") return "the answer is " + count
if (args.shape === "extra") return { count, spare: true }
return { count }`

function counting(overrides: { [key: string]: JsonValue } = {}): { [key: string]: JsonValue } {
  return {
    name: "counted",
    description: "Count the words of a piece of text and answer the count in a fixed shape.",
    parameters_json: PARAMETERS,
    execute_source: SOURCE,
    result_json: RESULT,
    examples: [{ args: { text: "one two" }, expected: { count: 2 } }],
    ...overrides,
  }
}

async function read(flint: Flint, name: string): Promise<Record<string, JsonValue>> {
  return (await flint.call("tool_read", { name })) as Record<string, JsonValue>
}

test("a Tool saves its result schema, shows it, carries it in the model-facing list and versions it", async () => {
  await shared(async (flint, dir) => {
    await flint.call("tool_create", counting())
    assert.deepEqual((await read(flint, "counted"))["result"], JSON.parse(RESULT))
    const stored = JSON.parse(await readFile(join(dir, "tools", "counted", "tool.json"), "utf8")) as {
      result: JsonValue
    }
    assert.deepEqual(stored.result, JSON.parse(RESULT))
    // A Tool that declares none says so rather than leaving the field out of the answer.
    const unshaped = counting({ name: "unshaped" })
    delete unshaped["result_json"]
    await flint.call("tool_create", unshaped)
    assert.equal((await read(flint, "unshaped"))["result"], null)
  })
})

test("a call whose result the Tool's own result schema refuses is invalid_result, and it names the mismatch", async () => {
  await shared(async (flint) => {
    await flint.call("tool_create", counting({ name: "held_shape" }))
    assert.deepEqual(await flint.call("held_shape", { text: "one two three" }), { count: 3 })

    const wrong = await refusal(() => flint.call("held_shape", { text: "one two", shape: "string" }))
    assert.equal(wrong.code, "invalid_result")
    assert.match(wrong.message, /the result must be an object, not a string/)
    assert.equal(typeof wrong.details["callId"], "string")

    const extra = await refusal(() => flint.call("held_shape", { text: "one two", shape: "extra" }))
    assert.equal(extra.code, "invalid_result")
    assert.match(extra.message, /spare is not a key the result schema declares/)
  })
})

test("an Example the result schema refuses is refused at the save gate, and nothing is written", async () => {
  await shared(async (flint) => {
    const refused = await refusal(() =>
      flint.call(
        "tool_create",
        counting({
          name: "never_saved",
          examples: [{ args: { text: "one two", shape: "string" }, expected: "the answer is 2" }],
        }),
      ),
    )
    assert.equal(refused.code, "invalid_result")
    assert.match(refused.message, /Nothing was saved/)
    assert.equal((await flint.library()).find((one) => one.name === "never_saved"), undefined)
  })
})

test("tool_update replaces the result schema, runs every Example again, and the new schema is what holds", async () => {
  await shared(async (flint) => {
    await flint.call("tool_create", counting({ name: "reshaped" }))
    const changed = (await flint.call("tool_update", {
      name: "reshaped",
      result_json: JSON.stringify({ type: "object", properties: { count: { type: "integer" } }, additionalProperties: true }),
    })) as Record<string, JsonValue>
    assert.equal(changed["state"], "draft")
    // The looser schema lets the extra key through, where the first one refused it.
    assert.deepEqual(await flint.call("reshaped", { text: "one two", shape: "extra" }), { count: 2, spare: true })
  })
})

test("a result schema may name any root, and one flintd cannot check is refused", async () => {
  await shared(async (flint) => {
    await flint.call(
      "tool_create",
      counting({
        name: "worded",
        result_json: JSON.stringify({ type: "string", minLength: 3 }),
        execute_source: 'return "the answer is " + args.text.length',
        examples: [{ args: { text: "one two" }, expected: "the answer is 7" }],
      }),
    )
    assert.equal(await flint.call("worded", { text: "one" }), "the answer is 3")

    const unusable = await refusal(() =>
      flint.call("tool_create", counting({ name: "unusable", result_json: JSON.stringify({ format: "email" }) })),
    )
    assert.equal(unusable.code, "invalid_schema")
    assert.match(unusable.message, /The result schema is not usable/)
    // The refusal named the argument schema whichever schema it was reading, which sent the model to the wrong field.
    assert.match(unusable.message, /the result schema uses "format"/)
    assert.doesNotMatch(unusable.message, /argument schema/)
  })
})

test("a schema reads as the object itself, as its JSON text, and as that text written as JSON twice", async () => {
  await shared(async (flint) => {
    const sent: [string, JsonValue][] = [
      ["as_object", JSON.parse(RESULT) as JsonValue],
      ["as_text", RESULT],
      ["as_text_twice", JSON.stringify(RESULT)],
    ]
    for (const [name, result_json] of sent) await flint.call("tool_create", counting({ name, result_json }))
    for (const [name] of sent) assert.deepEqual((await read(flint, name))["result"], JSON.parse(RESULT))

    await flint.call(
      "tool_create",
      counting({
        name: "both_objects",
        parameters_json: JSON.parse(PARAMETERS) as JsonValue,
        result_json: JSON.parse(RESULT) as JsonValue,
      }),
    )
    assert.deepEqual((await read(flint, "both_objects"))["parameters"], JSON.parse(PARAMETERS))
  })
})

test("a result_json that is not a schema names the shape to send, and a broken schema object is still refused", async () => {
  await shared(async (flint) => {
    const shapes: [string, JsonValue, RegExp][] = [
      ["of_null", "null", /this one is null\. Write the schema as an object, for example \{"type": "string"\}\./],
      ["of_boolean", "true", /this one is a boolean\. Write the schema as an object/],
      ["of_number", "7", /this one is a number\. Write the schema as an object/],
      ["of_array", JSON.stringify([{ type: "string" }]), /this one is an array\. Declare a list as \{"type": "array"/],
      ["of_type_name", JSON.stringify("string"), /result_json is not valid JSON.+Send the JSON Schema object itself/],
      ["of_bare_type_name", "string", /result_json is not valid JSON.+Send the JSON Schema object itself/],
      ["of_number_field", 7, /result_json is a number\. Send the JSON Schema object itself/],
      [
        "of_named_types",
        JSON.stringify({ type: "object", properties: { count: "integer" } }),
        /the schema for count must be a JSON Schema object, and this one is a string\. Write a type as a schema object/,
      ],
      // The object path checks what the string path checks: an unusable schema is refused however it arrived.
      ["of_broken_object", { format: "email" }, /the result schema uses "format"/],
    ]
    for (const [name, result_json, names] of shapes) {
      const refused = await refusal(() => flint.call("tool_create", counting({ name, result_json })))
      assert.equal(refused.code, "invalid_schema", name)
      assert.match(refused.message, names)
    }
    const library = await flint.library()
    assert.deepEqual(library.filter((one) => one.name.startsWith("of_")), [])
  })
})

const PATTERN_PARAMETERS = JSON.stringify({
  type: "object",
  properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
  required: ["code"],
  additionalProperties: false,
})

const PATTERN_RESULT = JSON.stringify({
  type: "object",
  properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
  required: ["code"],
  additionalProperties: false,
})

function patterned(overrides: { [key: string]: JsonValue } = {}): { [key: string]: JsonValue } {
  return {
    name: "code_echo",
    description: "Answer with the currency code it was given, in upper case.",
    parameters_json: PATTERN_PARAMETERS,
    result_json: PATTERN_RESULT,
    execute_source: 'return { code: args.code === "LOW" ? "low" : args.code }',
    examples: [{ args: { code: "USD" }, expected: { code: "USD" } }],
    ...overrides,
  }
}

test("a pattern in a schema is enforced where the Body runs, on the arguments and on the result", async () => {
  await shared(async (flint) => {
    await flint.call("tool_create", patterned())
    assert.deepEqual(await flint.call("code_echo", { code: "EUR" }), { code: "EUR" })

    const wrong = await refusal(() => flint.call("code_echo", { code: "eur" }))
    assert.equal(wrong.code, "invalid_arguments")
    assert.match(wrong.message, /"code" must match the pattern "\^\[A-Z\]\{3\}\$"/)

    const returned = await refusal(() => flint.call("code_echo", { code: "LOW" }))
    assert.equal(returned.code, "invalid_result")
    assert.match(returned.message, /"code" must match the pattern "\^\[A-Z\]\{3\}\$"/)
  })
})

test("a pattern longer than the bound is refused at the save gate", async () => {
  await shared(async (flint) => {
    const refused = await refusal(() =>
      flint.call(
        "tool_create",
        patterned({
          name: "long_pattern",
          parameters_json: JSON.stringify({
            type: "object",
            properties: { code: { type: "string", pattern: `^${"a".repeat(300)}$` } },
            required: ["code"],
            additionalProperties: false,
          }),
        }),
      ),
    )
    assert.equal(refused.code, "invalid_schema")
    assert.match(refused.message, /has a "pattern" of 302 characters, and the limit is 256/)
    assert.equal((await flint.library()).find((one) => one.name === "long_pattern"), undefined)
  })
})

test("a pattern on anything but a string is refused at the save gate, the way every stray keyword is", async () => {
  await shared(async (flint) => {
    const refused = await refusal(() =>
      flint.call(
        "tool_create",
        patterned({
          name: "numeric_pattern",
          parameters_json: JSON.stringify({
            type: "object",
            properties: { code: { type: "number", pattern: "^[0-9]+$" } },
            required: ["code"],
            additionalProperties: false,
          }),
        }),
      ),
    )
    assert.equal(refused.code, "invalid_schema")
    assert.match(refused.message, /uses "pattern" on "number", and flintd checks a pattern on a string only, so it would constrain nothing/)
    assert.equal((await flint.library()).find((one) => one.name === "numeric_pattern"), undefined)
  })
})

// The subset is named to the model before it writes, and flintd's own refusal is what the advice is held to.
test("the schema advice in the model-facing list names every keyword flintd enforces", async () => {
  await shared(async (flint) => {
    const unchecked = await refusal(() =>
      flint.call(
        "tool_create",
        counting({
          name: "unchecked_keyword",
          parameters_json: JSON.stringify({
            type: "object",
            properties: { text: { type: "string", format: "email" } },
            required: ["text"],
            additionalProperties: false,
          }),
        }),
      ),
    )
    assert.equal(unchecked.code, "invalid_schema")
    const listed = /use one of: ([^.]+)\./.exec(unchecked.message)
    assert.ok(listed !== null, unchecked.message)
    const enforced = (listed[1] as string).split(", ")

    const definitions = await flint.tools()
    for (const name of ["tool_create", "tool_update"]) {
      const definition = definitions.find((one) => one.name === name)
      assert.ok(definition !== undefined, name)
      for (const field of ["parameters_json", "result_json"]) {
        const advice = definition.parameters.properties?.[field]?.description ?? ""
        for (const keyword of enforced) {
          assert.match(advice, new RegExp(`\\b${keyword}\\b`), `${name}.${field} does not name "${keyword}"`)
        }
        assert.match(advice, /"additionalProperties" takes true or false, never a schema/)
      }
    }

    const schemaValued = await refusal(() =>
      flint.call(
        "tool_create",
        counting({
          name: "schema_valued",
          result_json: JSON.stringify({
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
            additionalProperties: { type: "string" },
          }),
        }),
      ),
    )
    assert.equal(schemaValued.code, "invalid_schema")
    assert.match(schemaValued.message, /"additionalProperties" that is not true or false/)
  })
})
