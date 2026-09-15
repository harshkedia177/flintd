# Your own loop: Gemini

`@flintd/sdk` gives you the same Library the harnesses use, as `functionDeclarations` for `generateContent`.

```
npm i @flintd/sdk @google/genai
```

`tools("gemini")` emits `{name, description, parameters, response?}` in the OpenAPI 3.03 subset a genai `Schema`
holds: `additionalProperties` and `examples` are removed from every node; `minItems`, `maxItems`, `minLength` and
`maxLength` are written as strings, the way proto JSON writes an int64; and an `enum` that is not a list of strings
on a string moves into the description as "One of: …".

Types keep the JSON Schema spelling the REST API takes. The genai SDK's own `Type` is a TypeScript enum, which no
package that imports no framework can produce, so this list needs one cast to reach `@google/genai`. That cast is
the only one in the examples.

## The whole loop

From [`examples/sdk-gemini.ts`](../../examples/sdk-gemini.ts), which runs against the real API with
`GEMINI_API_KEY` set:

```ts
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GoogleGenAI } from "@google/genai"
import type { Content, FunctionDeclaration } from "@google/genai"
import { callFrom, createFlint } from "@flintd/sdk"

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
  const functionDeclarations = (await flint.tools("gemini")) as unknown as FunctionDeclaration[]
  const config = { tools: [{ functionDeclarations }] }
  const contents: Content[] = [{ role: "user", parts: [{ text: QUESTION }] }]

  const asked = await genai.models.generateContent({ model: MODEL, contents, config })
  const calls = asked.functionCalls ?? []
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
```

`callFrom(flint, "gemini", call)` answers `{functionResponse: {id?, name, response: {output}}}`, and a refusal
arrives as `response: {"error": {code, message}}`, so the model reads the same refusal it would read through any
other provider.

## Google ADK

`googleAdkToolset(flint, parts, meta?)` gives one toolset whose `getTools` is resolved per invocation, so a Tool that
becomes Active mid-run is offered at the next step. `createFlint({ url, token })` points either at a running daemon
instead of an embedded directory.
