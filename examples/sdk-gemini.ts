import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GoogleGenAI } from "@google/genai"
import type { Content, FunctionDeclaration } from "@google/genai"
import { callFrom, createFlint } from "@flintd/sdk"

// GEMINI_API_KEY has to be set: this example calls the real generateContent API.
const MODEL = process.env["GEMINI_MODEL"] ?? "gemini-3.8-flash"
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
  const genai = new GoogleGenAI({})
  // The one cast in these examples: the REST API takes the JSON Schema spelling of a type, and this SDK's own
  // `Schema.type` is a TypeScript enum, which no package that imports no framework can produce.
  const functionDeclarations = (await flint.tools("gemini")) as unknown as FunctionDeclaration[]
  const config = { tools: [{ functionDeclarations }] }
  const contents: Content[] = [{ role: "user", parts: [{ text: QUESTION }] }]

  const asked = await genai.models.generateContent({ model: MODEL, contents, config })
  const calls = asked.functionCalls ?? []
  console.log(`Gemini asked for: ${calls.map((call) => call.name).join(", ") || "no tool"}`)
  if (calls.length === 0) process.exit(0)

  contents.push({ role: "model", parts: calls.map((call) => ({ functionCall: call })) })
  contents.push({
    role: "user",
    parts: await Promise.all(
      calls.map((call) => callFrom(flint, "gemini", call, { harness: "sdk-gemini-example", model: MODEL })),
    ),
  })

  const answered = await genai.models.generateContent({ model: MODEL, contents, config })
  console.log(`\n${answered.text}`)
} finally {
  await flint.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}
