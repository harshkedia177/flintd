# Your own loop: OpenAI

`@flintd/sdk` gives you the same Library the harnesses use, in the shape the Responses API asks for.

```
npm i @flintd/sdk openai
```

Two formats, because OpenAI has two APIs:

| `tools(format)` | Shape |
| --- | --- |
| `"openai"` | the Responses API: `{type: "function", name, description, parameters, strict}` |
| `"openai-chat"` | Chat Completions: `{type: "function", function: {name, description, parameters, strict}}` |

`strict` is `true` only for a schema that meets OpenAI's own subset: an object root, every object closed with
`additionalProperties: false` and requiring every property it declares, at most ten levels, no `"type": "null"`, and
none of `minLength`, `maxLength`, `title`, `default` or `examples`. flintd stores all five keywords, so a Tool that
uses one is a valid tool with `strict: false`.

## The whole loop

From [`examples/sdk-openai.ts`](../../examples/sdk-openai.ts), which runs against the real API with
`OPENAI_API_KEY` set:

```ts
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import OpenAI from "openai"
import type { ResponseInput, Tool } from "openai/resources/responses/responses"
import { callFrom, createFlint } from "@flintd/sdk"

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
```

`createFlint({ url, token })` points the same loop at a running daemon instead of an embedded directory.

## The OpenAI Agents SDK

`await openaiAgentsTools(flint, tool, meta?)`, with the framework's own `tool()` passed in, builds function tools
whose `isEnabled` asks the Library again once per turn, so a Tool that becomes Active during a run is offered at the
next step. The adapter imports the framework nowhere.

## Reading the list again

Read `tools(format)` every turn. A Tool the model writes in turn 2 is callable in turn 3, with no restart.
`report(callId, outcome)` writes back whether a call helped the task, which is what moves a Contribution.
