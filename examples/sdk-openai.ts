import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import OpenAI from "openai"
import type { ResponseInput, Tool } from "openai/resources/responses/responses"
import { callFrom, createFlint } from "@flintd/sdk"

// OPENAI_API_KEY has to be set: this example calls the real Responses API.
const MODEL = process.env["OPENAI_MODEL"] ?? "gpt-6-astra"
const QUESTION = "How many words are in: the quick brown fox jumps over the lazy dog?"

const CREATION = {
  name: "word_count",
  description: "Count the words in a piece of text. Call it whenever a question asks how many words a text holds.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  }),
  execute_source: "return { count: args.text.trim().split(/\\s+/).filter(Boolean).length }",
  examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
}

const dir = await mkdtemp(join(tmpdir(), "flintd-sdk-"))
const flint = createFlint({ dir })
await flint.start()

try {
  await flint.call("tool_create", CREATION)
  const openai = new OpenAI()
  const tools: Tool[] = await flint.tools("openai")
  const input: ResponseInput = [{ role: "user", content: QUESTION }]

  const asked = await openai.responses.create({ model: MODEL, tools, input })
  const calls = asked.output.filter((item) => item.type === "function_call")
  console.log(`The model asked for: ${calls.map((item) => item.name).join(", ") || "no tool"}`)
  if (calls.length === 0) process.exit(0)

  input.push(...calls)
  for (const call of calls) {
    input.push(await callFrom(flint, "openai", call, { harness: "sdk-openai-example", model: MODEL }))
  }

  const answered = await openai.responses.create({ model: MODEL, tools, input })
  console.log(`\n${answered.output_text}`)
} finally {
  await flint.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}
