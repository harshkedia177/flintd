import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openai } from "@ai-sdk/openai"
import { dynamicTool, generateText, jsonSchema } from "ai"
import { createFlint, vercelTools } from "@flintd/sdk"

// OPENAI_API_KEY has to be set: this example calls a real model through the AI SDK.
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
  // The step hook fills this map from the Library before every step, so a Tool written in one step runs in the next.
  const step = vercelTools(flint, { dynamicTool, jsonSchema }, { harness: "sdk-vercel-example", model: MODEL })

  const answered = await generateText({
    model: openai(MODEL),
    tools: step.tools,
    prepareStep: step.prepareStep,
    stopWhen: ({ steps }) => steps.length >= 5,
    prompt: QUESTION,
  })

  for (const call of answered.staticToolCalls) console.log(`The model asked for: ${call.toolName}`)
  console.log(`\n${answered.text}`)
} finally {
  await flint.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}
