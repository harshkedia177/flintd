# Your own loop: Anthropic

`@flintd/sdk` gives you the same Library the harnesses use, in the shape the Messages API asks for.

```
npm i @flintd/sdk @anthropic-ai/sdk
```

## Two lines

```ts
import { createFlint } from "@flintd/sdk"

const flint = createFlint({ dir: "./library" })                       // embedded: this process is the Library
const remote = createFlint({ url: "http://127.0.0.1:3546", token })   // remote: the daemon your harnesses use
await flint.start()
```

Both answer the same interface. `tools("anthropic")` gives `{name, description, input_schema}` per Tool: the meta
tools under their own names, every Active Tool as `fl_<name>`. `callFrom(flint, "anthropic", block)` takes the
`tool_use` block the model produced and answers the `tool_result` block to send back, error slot included.

Read the list again every turn. A Tool the model writes in turn 2 is callable in turn 3, with no restart.

## The whole loop

From [`examples/sdk-anthropic.ts`](../../examples/sdk-anthropic.ts), which runs against the real API with
`ANTHROPIC_API_KEY` set:

```ts
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import { callFrom, createFlint } from "@flintd/sdk"

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
```

`examples/sdk-offline.ts` is the same loop with no key and no network, and `pnpm example` runs it.

## What else the client answers

| Call | What it does |
| --- | --- |
| `call(name, args, meta)` | the result alone; `callWithId` answers `{id, result}` |
| `report(callId, "positive" \| "negative", note?)` | one Outcome report against a recorded call, which moves the Contribution |
| `onApproval(watcher)` | a Manifest waiting for a decision reaches your own review flow |
| `onChange(watcher)` | the model-facing list changed |
| `status()`, `library()` | what the Tenant holds |

`meta` carries `sessionId`, `harness`, `model`, `excerpt`, `library` and `tokens`. A `sessionId` scopes Drafts; a
`harness` and a `model` land in the Provenance of what the model writes.
