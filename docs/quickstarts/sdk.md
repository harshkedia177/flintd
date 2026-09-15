# Your own loop: the SDK

`@flintd/sdk` is the client an agent loop imports. One `createFlint`, and the Library it opens is either in this
process or in a daemon; both answer the same `Flint` interface, method for method, and every method answers a
promise.

```
npm i @flintd/sdk
```

Node 22.18 or newer. The package imports no agent framework at runtime, so the only thing it pulls in is flintd
itself.

## Embedded: the Library is this process

`createFlint({ dir })` opens a Library at that directory, creating it if it is not there. Nothing binds a port and
nothing else on the machine sees it.

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
// {name: "word_count", state: "draft", version: "<sha>", tier: "quickjs", examples: 1, library: "user", approval: null}

await flint.call("word_count", { text: "the quick brown fox" })   // {count: 4}
await flint.find("count the words in a text")                     // the Tools closest to that query
await flint.stop()
```

The Example ran before anything was written: a Body that fails its own Example is not saved at all.
`parameters_json` reads the schema object as written above and reads that same object sent as a JSON string, which
is the form a model usually produces.

**A new Tool is a Draft, and a Draft is not in the list you hand the model.** `tools()` answers the seven meta tools
plus the Active Tools of the Library, so a Draft reaches a model through `tool_find` and `tool_run` and not through
the tool list. Held-out examples earn Verified and real use earns Active; the [main page](../../README.md) has the
whole lifecycle. Held-out examples need a model, which `createFlint({ dir, model })` takes — without one the Tool
stays a Draft and everything else, retrieval included, works with no key.

`dir` is the whole of the required configuration. Every other option — the timeouts, the size bounds, the container
image, the Active caps, a second project Library — is in [the configuration reference](../config.md), which names
the `createFlint` option each `config.json` key maps to.

## Remote: the Library is the daemon every harness already talks to

`createFlint({ url, token })` answers the same interface against a running daemon. The one call that differs is
`stop()`, which does nothing: a daemon belongs to whoever started it.

```ts
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createFlint } from "@flintd/sdk"

const home = process.env["FLINTD_HOME"] ?? join(homedir(), ".flintd")
const token = process.env["FLINTD_TOKEN"] ?? (await readFile(join(home, "token"), "utf8")).trim()

const flint = createFlint({ url: "http://127.0.0.1:3546", token })
await flint.start()                                               // answers when the daemon answers
await flint.call("word_count", { text: "the quick brown fox" })   // {count: 4}
```

Everything above the `createFlint` line is the same code in both modes, so a loop developed in-process moves to the
shared daemon by changing one argument. What that buys is one Library: a Tool your loop writes is callable from
Claude Code, from Codex, from a hook and from the shell, and a Tool one of them wrote is callable from your loop.

### Where the token comes from

`flintd serve` generates a bearer token into a 0600 file on its first start and prints the path:

```
$ flintd serve
flintd listening on http://127.0.0.1:3546
MCP http://127.0.0.1:3546/mcp
Library user  /Users/me/.flintd/library
token /Users/me/.flintd/token
```

The file is `<flintd home>/token`, and the flintd home is `~/.flintd` unless `FLINTD_HOME` moves it. Every route
needs it, `/api/v1` and `/mcp` alike, compared in constant time.

**This package reads no environment variable.** `FLINTD_TOKEN` and `FLINTD_URL` are the convention the CLI, the hook
and the harness configs follow; your loop reads the file, or the variable, and passes the value. Read the token at
startup and keep it out of your own logs.

The address is `127.0.0.1` and nothing else. The default port is 3546, but a `config.json` that names `port: 0`
binds a free port and writes it to `<flintd home>/port`, which the file is there to be read for. Pass
`timeoutMs` to `createFlint` to move the 35 s clock a request gets.

A refusal arrives as a `ToolError` carrying the daemon's own stable `code`, its `message` and its `details`, the
same shape in both modes. A daemon that is not there, or that did not answer in time, raises the one code no daemon
ever sends, `transport_failed`, so a Tool that refused is never confused with a daemon that is down.
[The REST contract](../rest-contract.md) is the source of truth for every route, every payload and every code; this
client implements it and adds nothing to it.

## Handing the Library to the model

`tools(format)` answers the list in one provider's own shape, and `callFrom(flint, format, block, meta?)` takes the
tool-call block back:

| Format | `tools(format)` | `callFrom` reads |
| --- | --- | --- |
| `"anthropic"` | `{name, description, input_schema}` | a `tool_use` block |
| `"openai"` | `{type, name, description, parameters, strict}` | a `function_call` item |
| `"openai-chat"` | the same inside `{function: …}` | one entry of `tool_calls` |
| `"gemini"` | a `FunctionDeclaration` | a `functionCall` part |
| `"vercel"` | a record of name to `{description, inputSchema}` | a tool call |
| `"mcp"` | `{name, description, inputSchema, …}` | `{name, arguments}` |

A meta tool keeps its own name and an Active Tool is exported as `fl_<name>`; `callFrom` takes the prefix off again.
Read the list at the top of every turn and a Tool the model wrote in turn two is callable in turn three. One loop
per provider: [Anthropic](sdk-anthropic.md), [OpenAI](sdk-openai.md), [Gemini](sdk-gemini.md) and
[Python](sdk-python.md). The full table, including `strict` and the Gemini subset, is in
[the package README](../../packages/sdk/README.md).

## One adapter, end to end

Four adapters skip the format step and hand a framework its own tool objects. Each takes that framework's own
factory as an argument, so flintd imports no framework and every adapter type-checks against the version you
installed. The Vercel AI SDK one, whole:

```ts
import { openai } from "@ai-sdk/openai"
import { dynamicTool, generateText, jsonSchema } from "ai"
import { createFlint, vercelTools } from "@flintd/sdk"

const flint = createFlint({ dir: "./library" })
await flint.start()

const step = vercelTools(flint, { dynamicTool, jsonSchema }, { harness: "my-loop" })

const answered = await generateText({
  model: openai("gpt-6-astra"),
  tools: step.tools,
  prepareStep: step.prepareStep,
  stopWhen: ({ steps }) => steps.length >= 5,
  prompt: "How many words are in: the quick brown fox jumps over the lazy dog?",
})

console.log(answered.text)
await flint.stop()
```

`vercelTools` answers `{tools, prepareStep}`. **The AI SDK snapshots its tool list per step**, which is why the step
hook exists: `prepareStep` reads the Library again and refills the same map, so a Tool the model writes in step two
is callable in step three of the same run. [`examples/sdk-vercel.ts`](../../examples/sdk-vercel.ts) is this file
against a real model with `OPENAI_API_KEY` set, and [`examples/sdk-offline.ts`](../../examples/sdk-offline.ts) is
the same idea with no key and no network.

The other three, each at their own framework's per-step hook:

```ts
// OpenAI Agents: function tools whose isEnabled asks the Library again once a turn.
const agent = new Agent({ name: "mine", tools: await openaiAgentsTools(flint, tool) })

// LangChain: a wrapModelCall body that puts the Library into every model call.
const middleware = createMiddleware({ name: "flintd", wrapModelCall: langchainModelCall(flint, tool) })

// Google ADK: one toolset, resolved per invocation. `Type` is genai's own enum.
const toolset = googleAdkToolset(flint, { BaseToolset, FunctionTool, Type })
```

[The Vercel quickstart](sdk-vercel.md) has the AI SDK and LangChain in full, and
[the package README](../../packages/sdk/README.md) has all four with their imports.

## The rest of the interface

| Call | What it does |
| --- | --- |
| `call(name, args, meta)` | the result alone; `callWithId` answers `{id, result}` |
| `find(query, limit?)` | the Tools closest to `query`, siblings named |
| `library()`, `status()` | every Tool of the Tenant, and what the daemon holds |
| `report(callId, "positive" \| "negative", note?)` | one Outcome report against a recorded call, which moves the Contribution |
| `approvals()`, `approve(id, note?)`, `deny(id, note?)` | the Manifest decisions waiting, and the answer |
| `onApproval(watcher)`, `onChange(watcher)` | a Manifest started waiting; the model-facing list changed |
| `observations()`, `observe(…)`, `observer.run(…)` | what the [Observer](../observer.md) reads and proposes |
| `connections` | the stored credentials a Tool receives by name and never by value |

`meta` carries `sessionId`, `harness`, `model`, `excerpt`, `library` and `tokens`. A `sessionId` scopes Drafts; a
`harness` and a `model` land in the Provenance of what the model writes. A caller never chooses the Channel.

`onLog` is an option of the embedded client alone — `createFlint({ dir, onLog })` — and it is where `ctx.log` lines
arrive, redacted, as `{tool, callId, message}`. A remote client has no log stream: the daemon writes those lines and
`flintd serve --verbose` puts them on stdout.

Before you approve a Manifest, read [the security page](../security.md): what each tier stops, what the Proxy does
with a hostname, and what none of it promises.
