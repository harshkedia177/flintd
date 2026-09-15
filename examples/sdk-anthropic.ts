import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import { callFrom, createFlint } from "@flintd/sdk"

// ANTHROPIC_API_KEY has to be set: this example calls the real Messages API.
const MODEL = process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-5"
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
  const anthropic = new Anthropic()
  const tools: Anthropic.Tool[] = await flint.tools("anthropic")
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: QUESTION }]

  const asked = await anthropic.messages.create({ model: MODEL, max_tokens: 1024, tools, messages })
  const calls = asked.content.filter((block) => block.type === "tool_use")
  console.log(`Claude asked for: ${calls.map((block) => block.name).join(", ") || "no tool"}`)
  if (calls.length === 0) process.exit(0)

  messages.push({ role: "assistant", content: asked.content })
  messages.push({
    role: "user",
    content: await Promise.all(
      calls.map((block) => callFrom(flint, "anthropic", block, { harness: "sdk-anthropic-example", model: MODEL })),
    ),
  })

  const answered = await anthropic.messages.create({ model: MODEL, max_tokens: 1024, tools, messages })
  for (const block of answered.content) if (block.type === "text") console.log(`\n${block.text}`)
} finally {
  await flint.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}
