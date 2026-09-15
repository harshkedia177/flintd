import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeModel } from "../packages/core/test/fake-model.ts"
import { callFrom, createFlint } from "@flintd/sdk"

const CREATION = {
  name: "word_count",
  description: "Count the words in a piece of text.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  }),
  execute_source: "return { count: args.text.trim().split(/\\s+/).filter(Boolean).length }",
  examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
}

// What a model would answer: the block is written here so this example needs no key and reaches no network.
const REPLY = {
  type: "tool_use",
  id: "toolu_01A09q90qw90lq917835lq9",
  name: "fl_word_count",
  input: { text: "one two three four" },
}

const dir = await mkdtemp(join(tmpdir(), "flintd-sdk-"))
// The one test double flintd has: a model that answers from a fixed table, so the Held-out run needs no key.
const flint = createFlint({ dir, model: fakeModel({ cases: [{ args: { text: "one two" }, confident: true, expected: { count: 2 } }] }) })
await flint.start()

try {
  await flint.call("tool_create", CREATION)
  await earn()

  const tools = await flint.tools("anthropic")
  console.log(`Anthropic tools: ${tools.map((tool) => tool.name).join(", ")}`)
  console.log(`  each one carries ${Object.keys(tools[0] ?? {}).join(", ")}`)
  // A meta tool keeps its own name and an Active Tool is exported as `fl_<name>`, which is the whole of the rule.
  assert.deepEqual(Object.keys(tools[0] ?? {}), ["name", "description", "input_schema"])
  assert.equal(tools.at(-1)?.name, "fl_word_count")
  for (const tool of tools) assert.match(tool.name, /^[a-zA-Z0-9_-]{1,128}$/)

  const openai = await flint.tools("openai")
  console.log(`\nOpenAI tools: ${openai.map((tool) => `${tool.name}${tool.strict ? " (strict)" : ""}`).join(", ")}`)
  assert.equal(openai.at(-1)?.strict, true)

  const result = await callFrom(flint, "anthropic", REPLY, { harness: "sdk-offline-example" })
  console.log(`\nThe model asked for ${REPLY.name} and the tool_result is:`)
  console.log(`  ${JSON.stringify(result)}`)
  assert.deepEqual(result, {
    type: "tool_result",
    tool_use_id: REPLY.id,
    content: '{"count":4}',
  })

  const refused = await callFrom(flint, "anthropic", { ...REPLY, input: { text: 7 } })
  console.log(`\nA refusal comes back as an error result the model can act on:`)
  console.log(`  ${JSON.stringify(refused)}`)
  assert.equal(refused.is_error, true)

  console.log("\nNo API key was used and the Body reached no network.")
} finally {
  await flint.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

// A Draft is not exported. Held-out examples earn Verified, and five clean calls across two sessions earn Active.
async function earn(): Promise<void> {
  const deadline = Date.now() + 10_000
  while ((await flint.library())[0]?.state !== "verified") {
    if (Date.now() > deadline) throw new Error("the Held-out run never finished")
    await new Promise((wake) => setTimeout(wake, 10))
  }
  for (const [at, sessionId] of ["one", "one", "one", "one", "two"].entries()) {
    await flint.call("word_count", { text: `call number ${at}` }, { sessionId })
  }
  assert.equal((await flint.library())[0]?.state, "active")
}
