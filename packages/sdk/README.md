# @flintd/sdk

The client an agent loop is built on. [flintd](https://github.com/harshkedia177/flintd) is a Library of Tools that
agents write for themselves: the model writes a Tool mid-task, flintd runs that Tool's own Examples before saving
anything, keeps it out of the model's tool list until held-out examples and real use earn it a place, declares what
it may reach and runs it at the strictest isolation that satisfies the declaration, and keeps every Version as a git
commit. This package is how your own loop, or your own harness, reaches that Library.

```
npm i @flintd/sdk
```

One client, two modes. `createFlint({ dir })` opens a Library in this process; `createFlint({ url, token })` talks to
a daemon — the same one every harness on the machine talks to. Both answer the same `Flint` interface, method for
method, and every method answers a promise.

```ts
import { createFlint } from "@flintd/sdk"

const flint = createFlint({ dir: "./library" })
await flint.start()

await flint.call("tool_create", {
  name: "word_count",
  description: "Count the words in a piece of text. Call it when a question asks how many words a text holds.",
  parameters_json: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  execute_source: "return { count: args.text.trim().split(/\\s+/).filter(Boolean).length }",
  examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
})

await flint.call("word_count", { text: "the quick brown fox" })   // {count: 4}
const tools = await flint.tools("anthropic")                      // the list you hand your model
```

A new Tool is a Draft, and `tools()` carries the seven meta tools plus the Active Tools of the Library, so a Draft
reaches a model through `tool_find` and `tool_run` until it earns its place.
[The SDK quickstart](https://github.com/harshkedia177/flintd/blob/main/docs/quickstarts/sdk.md) is the whole path:
embedded, remote, one adapter end to end, and where the token comes from. Node 22.18 or newer.

## `tools(format)`

`tools()` answers the provider-neutral list: the seven meta tools and the Active Tools of the Library. `tools(format)`
answers the same list in one provider's own shape. **A meta tool keeps its own name and an Active Tool is exported as
`fl_<name>`**, which is the one place the prefix is applied. A stored name is at most 60 characters, so `fl_` always
fits the 64 every provider allows.

| Format | Shape | The result schema |
| --- | --- | --- |
| `"anthropic"` | `{name, description, input_schema}` for the Messages API `tools` array | not carried: a tool definition has no output schema |
| `"openai"` | `{type: "function", name, description, parameters, strict}` for the Responses API | not carried |
| `"openai-chat"` | `{type: "function", function: {name, description, parameters, strict}}` for Chat Completions | not carried |
| `"gemini"` | a `FunctionDeclaration`: `{name, description, parameters, response?}` | `response`, in the same subset |
| `"vercel"` | a record of name to `{description, inputSchema, outputSchema?}` for the AI SDK | `outputSchema` |
| `"mcp"` | `{name, description, inputSchema, outputSchema?, annotations?}` | `outputSchema` when its root is an object |

`tools("mcp")` reads each Tool's Manifest for its annotations, so it costs a second request against a daemon.

**The AI SDK needs `inputSchema` inside `jsonSchema()`.** `tools("vercel")` answers the JSON Schema itself, because
this package imports no framework; `vercelToolSet(flint, jsonSchema)` and `vercelTools(flint, {dynamicTool,
jsonSchema})` below wrap it with your own copy of the SDK. A bare JSON Schema handed to `generateText` throws inside
`asSchema`.

**The `mcp` format is the daemon's own `tools/list`**, byte for byte: the same shaping builds both, annotations and
the meta tools' `outputSchema` included, and the daemon adds only the per-client quirk table on top.

`strict` is `true` only when the argument schema is what OpenAI's structured outputs asks for:

- the root is an object, every object node closes with `additionalProperties: false` and requires every property it
  declares;
- nothing nests deeper than ten levels, the limit that page names (flintd's own bound is 32);
- no node says `"type": "null"`, which is not one of the types it lists;
- no node carries `minLength`, `maxLength`, `title`, `default` or `examples`, none of which it lists either.

Anything else is `strict: false`, which is a valid tool, not a refused one. Two of those keywords are named only in
that page's fine-tuned-model clause, so this reading is the closed one: a tool that is not strict costs schema
adherence, and a strict tool the API refuses costs the whole request.

The Gemini shape is the OpenAPI 3.03 subset a genai `Schema` holds: `additionalProperties` and `examples` come out of
every node, `minItems`, `maxItems`, `minLength` and `maxLength` are written as strings the way proto JSON writes an
int64, and an `enum` that is not a list of strings on a string moves into the description as "One of: …", because
`Schema.enum` is `string[]`. The one thing this package cannot do is spell `type` as genai's own `Type` enum, which is
a TypeScript enum and so has no structural spelling; the REST API takes the JSON Schema spelling this emits, and
`@google/genai` needs one cast (`examples/sdk-gemini.ts`).

## `callFrom(flint, format, block, meta?)`

`call(name, args, meta)` takes a name and arguments. `callFrom` takes the tool-call block the provider gave you, runs
it, and answers the result shape that provider wants back:

| Format | It reads | It answers |
| --- | --- | --- |
| `"anthropic"` | a `tool_use` block | `{type: "tool_result", tool_use_id, content, is_error?}` |
| `"openai"` | a `function_call` item | `{type: "function_call_output", call_id, output}` |
| `"openai-chat"` | one entry of `tool_calls` | `{role: "tool", tool_call_id, content}` |
| `"gemini"` | a `functionCall` part, or the call itself | `{functionResponse: {id?, name, response}}` |
| `"vercel"` | a tool call | `{type: "tool-result", toolCallId, toolName, output: {type: "json", value}}` |
| `"mcp"` | `{name, arguments}` | `{content: [{type: "text", text}], structuredContent?, isError?}` |

The `fl_` prefix comes off the name, a JSON string of arguments is parsed (`""` is an empty object, which is what
Chat Completions sends for a call with no arguments), and a `ToolError` comes back as `{"error": {"code", "message"}}`
in that provider's error slot, with `is_error` or `isError` where there is one. The AI SDK has no tool-error content
part, so its refusal is a `tool-result` whose `output` is `{type: "error-json", value}`. A block that is not a tool
call at all throws: that is the caller's own bug, not something a model can act on.

```ts
const result = await callFrom(flint, "anthropic", block, { harness: "my-agent" })
```

## `onApproval` and `onLog`

`flint.onApproval(watcher)` registers a watcher and answers with the call that takes it off again. Both modes answer
it: the embedded client runs the watcher as soon as a Manifest starts waiting, and the remote client runs it when a
call of its own comes back `awaiting_approval`, with the request as `GET /api/v1/approvals` holds it. Either way the
watcher decides with `approve(id, note?)` or `deny(id, note?)`.

`onLog` is an option of the embedded client — `createFlint({ dir, onLog })` — and it is where `ctx.log` lines arrive,
redacted, as `{tool, callId, message}`. A remote client has no log stream of its own: the daemon writes those lines,
and `flintd serve --verbose` puts them on stdout.

## Framework adapters

Each adapter takes the framework's own factory as an argument, so flintd imports no framework at runtime and every
adapter type-checks against the version you installed. Each reads the Library again at the framework's own per-step
hook, so a Tool that becomes callable during a run is offered in the next step.

```ts
// Vercel AI SDK: one tools map and one prepareStep, both filled from the Library before every step.
import { dynamicTool, generateText, jsonSchema } from "ai"
import { vercelToolSet, vercelTools } from "@flintd/sdk"

const step = vercelTools(flint, { dynamicTool, jsonSchema })
await generateText({ model, tools: step.tools, prepareStep: step.prepareStep, prompt })

// Or, for a loop of your own: the same list with no `execute`, which `callFrom(flint, "vercel", call)` answers.
const tools = await vercelToolSet(flint, jsonSchema)
```

```ts
// OpenAI Agents SDK: function tools whose isEnabled asks the Library again on every run.
import { Agent, tool } from "@openai/agents"
import { openaiAgentsTools } from "@flintd/sdk"

const agent = new Agent({ name: "mine", tools: await openaiAgentsTools(flint, tool) })
```

```ts
// LangChain: a wrapModelCall body that puts the Library into every model call.
import { createMiddleware, tool } from "langchain"
import { langchainModelCall } from "@flintd/sdk"

const middleware = createMiddleware({ name: "flintd", wrapModelCall: langchainModelCall(flint, tool) })
```

```ts
// Google ADK: one toolset, resolved per invocation. `Type` is genai's own enum, which ADK spells its schemas with.
import { BaseToolset, FunctionTool } from "@google/adk"
import { Type } from "@google/genai"
import { googleAdkToolset } from "@flintd/sdk"

const toolset = googleAdkToolset(flint, { BaseToolset, FunctionTool, Type })
const agent = new LlmAgent({ name: "mine", model, tools: [toolset] })
```

The OpenAI Agents SDK reads an agent's `tools` array once per run and decides each one with `isEnabled`, once per
turn. The whole array shares one list read per turn: the answer is kept against the run context the SDK passes in,
for 250 ms, which covers one turn's sweep and no more. So a Tool that was retired or pushed off the Active list
stops being offered from the next turn of the same run, at the cost of one read per turn, and a Tool written during
the run joins the array the next time you call the adapter. Until then it is reachable the way every cached-list client
reaches one: `tool_find` to find it, `tool_run` to run it.

## Examples

| File | What it needs |
| --- | --- |
| `examples/sdk-offline.ts` | nothing: it proves `tools("anthropic")` and `callFrom` against a written-out model reply |
| `examples/sdk-anthropic.ts` | `ANTHROPIC_API_KEY` |
| `examples/sdk-openai.ts` | `OPENAI_API_KEY` |
| `examples/sdk-gemini.ts` | `GEMINI_API_KEY` |
| `examples/sdk-vercel.ts` | `OPENAI_API_KEY` |
