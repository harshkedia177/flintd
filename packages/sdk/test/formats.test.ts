import assert from "node:assert/strict"
import test from "node:test"
import { jsonSchema } from "ai"
import { asSchema } from "@ai-sdk/provider-utils"
import { callFrom, formatTools } from "../src/index.ts"
import { creation, embedded } from "./support.ts"
import type Anthropic from "@anthropic-ai/sdk"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import type { ToolResultPart, ToolSet } from "ai"
import type { FunctionTool } from "openai/resources/responses/responses"
import type { JsonSchema, ToolDefinition } from "../src/index.ts"

const PARAMETERS: JsonSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
}

const RESULT: JsonSchema = {
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
  additionalProperties: false,
}

const WORD_COUNT: ToolDefinition = {
  name: "word_count",
  description: "Count the words in a piece of text.",
  parameters: PARAMETERS,
  result: RESULT,
}

// The keywords flintd stores that no provider subset takes: Gemini drops them, and OpenAI's strict mode refuses them.
const ANNOTATED: JsonSchema = {
  ...PARAMETERS,
  properties: { text: { type: "string", minLength: 1 } },
  examples: [{ text: "one two" }],
}

// tool_create takes optional arguments, so its schema is not the closed object OpenAI's strict mode asks for.
const TOOL_CREATE: ToolDefinition = {
  name: "tool_create",
  description: "Write a new Tool into the Library.",
  parameters: { type: "object", properties: { name: { type: "string" }, manifest_json: { type: "string" } }, required: ["name"] },
}

const LIST = [TOOL_CREATE, WORD_COUNT]

test("the Anthropic format names the meta tools plainly and the Tools with the export prefix", () => {
  const tools = formatTools(LIST, "anthropic")
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["tool_create", "fl_word_count"],
  )
  assert.deepEqual(tools[1], {
    name: "fl_word_count",
    description: WORD_COUNT.description,
    input_schema: { ...PARAMETERS, type: "object" },
  })
})

test("every emitted list assigns to the provider's own request type with no cast", () => {
  const anthropic: Anthropic.Tool[] = formatTools(LIST, "anthropic")
  const responses: FunctionTool[] = formatTools(LIST, "openai")
  const chat: ChatCompletionTool[] = formatTools(LIST, "openai-chat")
  const vercel: ToolSet = Object.fromEntries(
    Object.entries(formatTools(LIST, "vercel")).map(([name, one]) => [
      name,
      { description: one.description, inputSchema: jsonSchema(one.inputSchema) },
    ]),
  )
  assert.equal(anthropic[1]?.name, "fl_word_count")
  assert.equal(responses[1]?.name, "fl_word_count")
  assert.equal(chat.length, LIST.length)
  assert.equal(formatTools(LIST, "openai-chat")[1]?.function.name, "fl_word_count")
  // asSchema is what the AI SDK runs on every tool before it calls a model: a bare JSON Schema throws there.
  assert.deepEqual(asSchema(vercel["fl_word_count"]?.inputSchema).jsonSchema, { ...PARAMETERS })
})

test("the OpenAI formats declare strict only for a schema the structured-outputs subset accepts", () => {
  const responses = formatTools(LIST, "openai")
  assert.deepEqual(responses[1], {
    type: "function",
    name: "fl_word_count",
    description: WORD_COUNT.description,
    parameters: { ...PARAMETERS },
    strict: true,
  })
  assert.equal(responses[0]?.strict, false)
  // Structured outputs takes no minLength and no examples, so a schema that declares one is a tool, but not a strict one.
  assert.equal(formatTools([{ ...WORD_COUNT, parameters: ANNOTATED }], "openai")[0]?.strict, false)

  assert.deepEqual(formatTools(LIST, "openai-chat")[1], {
    type: "function",
    function: { name: "fl_word_count", description: WORD_COUNT.description, parameters: { ...PARAMETERS }, strict: true },
  })
})

test("strict stops at ten levels of nesting and at a type the subset does not name", () => {
  assert.equal(formatTools([{ ...WORD_COUNT, parameters: nested(10) }], "openai")[0]?.strict, true)
  assert.equal(formatTools([{ ...WORD_COUNT, parameters: nested(11) }], "openai")[0]?.strict, false)

  const nothing: JsonSchema = {
    type: "object",
    properties: { nothing: { type: "null" } },
    required: ["nothing"],
    additionalProperties: false,
  }
  assert.equal(formatTools([{ ...WORD_COUNT, parameters: nothing }], "openai")[0]?.strict, false)
})

test("the Gemini format keeps only the schema keywords its OpenAPI subset holds", () => {
  const one = formatTools([{ ...WORD_COUNT, parameters: ANNOTATED }], "gemini")[0]
  // A genai Schema spells a length the way proto JSON spells an int64: as a string.
  assert.deepEqual(one?.parameters, {
    type: "object",
    properties: { text: { type: "string", minLength: "1" } },
    required: ["text"],
  })
  assert.deepEqual(one?.response, { type: "object", properties: { count: { type: "integer" } }, required: ["count"] })
})

test("the Gemini format moves an enum its Schema cannot hold into the description", () => {
  const choices: JsonSchema = {
    type: "object",
    properties: {
      size: { type: "integer", enum: [1, 2], description: "How many." },
      unit: { type: "string", enum: ["cm", "in"] },
    },
    required: ["size", "unit"],
    additionalProperties: false,
  }
  const parameters = formatTools([{ ...WORD_COUNT, parameters: choices }], "gemini")[0]?.parameters
  // A genai Schema.enum is string[], so a numeric enum becomes a sentence and a string enum stays an enum.
  assert.deepEqual(parameters?.["properties"], {
    size: { type: "integer", description: "How many. One of: 1, 2." },
    unit: { type: "string", enum: ["cm", "in"] },
  })
})

test("the MCP format is the list the daemon's own surface answers", () => {
  const tools = formatTools(LIST, "mcp")
  assert.deepEqual(tools[0], {
    name: "tool_create",
    description: TOOL_CREATE.description,
    inputSchema: { ...TOOL_CREATE.parameters, type: "object" },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  })
  assert.deepEqual(tools[1], {
    name: "fl_word_count",
    description: WORD_COUNT.description,
    inputSchema: { ...PARAMETERS, type: "object" },
    outputSchema: { ...RESULT, type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  })
  // tool_run answers whatever the Tool it ran answered, and a Manifest that reaches out is not read-only.
  assert.equal(formatTools([{ ...TOOL_CREATE, name: "tool_run" }], "mcp")[0]?.outputSchema, undefined)
  const reaching = formatTools(LIST, "mcp", new Map([["word_count", { hosts: ["api.example.com"] }]]))
  assert.deepEqual(reaching[1]?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  })
  // MCP pairs an output schema with `structuredContent`, which is an object, so a string result declares none.
  assert.equal(formatTools([{ ...WORD_COUNT, result: { type: "string" } }], "mcp")[0]?.outputSchema, undefined)
})

test("the longest name a Library can hold fits every provider's own name rule", () => {
  const longest: ToolDefinition = { ...WORD_COUNT, name: "w".repeat(60) }
  const exported = `fl_${longest.name}`
  assert.equal(formatTools([longest], "anthropic")[0]?.name, exported)
  // The rules the providers document: Anthropic 128, OpenAI 64, Gemini letter or underscore first and 64.
  assert.match(exported, /^[a-zA-Z0-9_-]{1,128}$/)
  assert.match(formatTools([longest], "openai")[0]?.name ?? "", /^[a-zA-Z0-9_-]{1,64}$/)
  assert.match(formatTools([longest], "openai-chat")[0]?.function.name ?? "", /^[a-zA-Z0-9_-]{1,64}$/)
  assert.match(formatTools([longest], "gemini")[0]?.name ?? "", /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/)
  assert.equal(Object.keys(formatTools([longest], "vercel"))[0], exported)
  assert.equal(formatTools([longest], "mcp")[0]?.name, exported)
})

test("callFrom runs the tool-call block of every provider and answers in that provider's own result shape", async () => {
  const session = await embedded()
  try {
    const client = session.client
    await client.call("tool_create", creation())

    assert.deepEqual(
      await callFrom(client, "openai", { type: "function_call", call_id: "call_1", name: "fl_word_count", arguments: '{"text":"one two"}' }),
      { type: "function_call_output", call_id: "call_1", output: '{"count":2}' },
    )
    assert.deepEqual(
      await callFrom(client, "openai-chat", { id: "call_2", type: "function", function: { name: "fl_word_count", arguments: '{"text":"one two three"}' } }),
      { role: "tool", tool_call_id: "call_2", content: '{"count":3}' },
    )
    assert.deepEqual(
      await callFrom(client, "gemini", { functionCall: { id: "call_3", name: "fl_word_count", args: { text: "one" } } }),
      { functionResponse: { id: "call_3", name: "fl_word_count", response: { output: { count: 1 } } } },
    )
    const part: ToolResultPart = await callFrom(client, "vercel", {
      toolCallId: "call_4",
      toolName: "fl_word_count",
      input: { text: "one two" },
    })
    assert.deepEqual(part, {
      type: "tool-result",
      toolCallId: "call_4",
      toolName: "fl_word_count",
      output: { type: "json", value: { count: 2 } },
    })
    assert.deepEqual(await callFrom(client, "mcp", { name: "fl_word_count", arguments: { text: "one two" } }), {
      content: [{ type: "text", text: '{"count":2}' }],
      structuredContent: { count: 2 },
    })
  } finally {
    await session.close()
  }
})

test("a refusal comes back in the provider's own error slot, and a name no Library holds is one", async () => {
  const session = await embedded()
  try {
    const client = session.client
    await client.call("tool_create", creation())

    const missing = await callFrom(client, "gemini", { functionCall: { name: "fl_nothing_here", args: {} } })
    assert.deepEqual(missing.functionResponse.response, {
      error: { code: "not_found", message: (missing.functionResponse.response as { error: { message: string } }).error.message },
    })

    // `fl_` is reserved at create, so `fl_tool_create` is refused by name and is never another way to spell tool_create.
    const forged = await callFrom(client, "openai", { type: "function_call", call_id: "call_5", name: "fl_tool_create", arguments: "{}" })
    assert.match(forged.output, /"code":"invalid_name"/)
    assert.match(forged.output, /reserved/)
    assert.equal((await client.library()).length, 1)

    const broken = await callFrom(client, "openai", { type: "function_call", call_id: "call_6", name: "fl_word_count", arguments: "{text:" })
    assert.match(broken.output, /"code":"invalid_arguments"/)
    assert.match(broken.output, /not JSON/)

    // Chat Completions sends "" for a call with no arguments, which is an empty object and not a broken one.
    const empty = await callFrom(client, "openai-chat", { id: "call_7", type: "function", function: { name: "fl_word_count", arguments: "" } })
    assert.match(empty.content, /"code":"invalid_arguments"/)
    assert.doesNotMatch(empty.content, /not JSON/)

    const failed = await callFrom(client, "vercel", { toolCallId: "call_8", toolName: "fl_word_count", input: { text: 7 } })
    assert.equal(failed.output.type, "error-json")
    assert.deepEqual(failed.output.value, {
      error: { code: "invalid_arguments", message: (failed.output.value as { error: { message: string } }).error.message },
    })

    const refused = await callFrom(client, "mcp", { name: "fl_word_count", arguments: { text: 7 } })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0]?.text ?? "", /^\{"error":\{"code":"invalid_arguments"/)
  } finally {
    await session.close()
  }
})

function nested(levels: number): JsonSchema {
  let node: JsonSchema = { type: "object", properties: {}, required: [], additionalProperties: false }
  for (let at = 1; at < levels; at += 1) {
    node = { type: "object", properties: { next: node }, required: ["next"], additionalProperties: false }
  }
  return node
}
