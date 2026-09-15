# Your own loop: the Vercel AI SDK

`@flintd/sdk` fills the AI SDK's tools map from the Library before every step, so a Tool the model writes in one step
runs in the next.

```
npm i @flintd/sdk ai @ai-sdk/openai
```

`vercelTools(flint, { dynamicTool, jsonSchema }, meta?)` takes the AI SDK's own factories as arguments and answers
`{tools, prepareStep}`. The adapter imports the framework nowhere. `prepareStep` reads the Library again and answers
`activeTools` for that step. **The AI SDK snapshots its tool list per turn**, which is why the step hook exists;
without it a Tool created in step 2 would not be callable until the next run.

## The whole loop

[`examples/sdk-vercel.ts`](../../examples/sdk-vercel.ts), which runs against a real model with `OPENAI_API_KEY` set:

```ts
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openai } from "@ai-sdk/openai"
import { dynamicTool, generateText, jsonSchema } from "ai"
import { createFlint, vercelTools } from "@flintd/sdk"

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
```

`createFlint({ url, token })` points the same loop at a running daemon instead of an embedded directory.

## The shapes

`tools("vercel")` answers `{<name>: {description, inputSchema, outputSchema?}}` with the raw JSON Schema; the SDK
layer wraps it with the AI SDK's own `jsonSchema`, which is why the factory is passed in.
`callFrom(flint, "vercel", call)` answers a `tool-result` part, and a refusal arrives as
`output: {type: "error-json", value}` because the AI SDK has no tool-error content part.

## LangChain

`langchainModelCall(flint, tool, meta?)`, with LangChain's own `tool()` passed in, is the same idea at LangChain's
hook: a `wrapModelCall` body that puts the Library into each model call as it stands at that moment.
