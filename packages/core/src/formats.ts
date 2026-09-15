import { ToolError, causeMessage } from "./errors.ts"
import { META_TOOL_NAMES } from "./meta-tools.ts"
import { EXPORT_PREFIX } from "./validate.ts"
import type {
  AnthropicTool,
  CallMeta,
  Flint,
  GeminiSchema,
  GeminiTool,
  JsonSchema,
  JsonValue,
  Manifest,
  McpTool,
  ObjectSchema,
  OpenAiChatTool,
  OpenAiTool,
  ProviderSchema,
  ToolAnnotations,
  ToolDefinition,
  ToolFormat,
  ToolFormats,
  ToolResults,
  VercelTool,
} from "./types.ts"

export { EXPORT_PREFIX }

// Gemini's Schema is a subset of OpenAPI 3.03: it has no `additionalProperties`, and its examples field is singular.
const GEMINI_UNSUPPORTED = new Set(["additionalProperties", "examples"])

// A genai Schema spells these four as strings, the way proto JSON spells an int64. `maximum` and `minimum` stay numbers.
const GEMINI_COUNTS = new Set(["minItems", "maxItems", "minLength", "maxLength"])

// Structured outputs names the keywords it takes, and these five of flintd's are not among them.
const STRICT_UNSUPPORTED = new Set(["minLength", "maxLength", "title", "default", "examples"])

// "Objects have limitations on nesting depth and size": up to 10 levels. flintd's own bound is 32.
const STRICT_MAX_DEPTH = 10

// Every meta tool but tool_run answers a JSON object of its own; tool_run answers whatever the Tool it ran answered.
const OBJECT_RESULT: ObjectSchema = { type: "object" }

const READ_ONLY_META = new Set(["tool_read", "tool_find", "tool_history"])

export function exportName(name: string): string {
  return META_TOOL_NAMES.has(name) ? name : `${EXPORT_PREFIX}${name}`
}

// `fl_` is reserved at create, so a Tool never carries it and the prefix can only be the spelling a format exports.
export function libraryName(exported: string): string {
  if (META_TOOL_NAMES.has(exported) || !exported.startsWith(EXPORT_PREFIX)) return exported
  const bare = exported.slice(EXPORT_PREFIX.length)
  return META_TOOL_NAMES.has(bare) ? exported : bare
}

export function formatTools(tools: ToolDefinition[], format: "anthropic"): AnthropicTool[]
export function formatTools(tools: ToolDefinition[], format: "openai"): OpenAiTool[]
export function formatTools(tools: ToolDefinition[], format: "openai-chat"): OpenAiChatTool[]
export function formatTools(tools: ToolDefinition[], format: "gemini"): GeminiTool[]
export function formatTools(tools: ToolDefinition[], format: "vercel"): Record<string, VercelTool>
export function formatTools(
  tools: ToolDefinition[],
  format: "mcp",
  manifests?: ReadonlyMap<string, Manifest>,
): McpTool[]
export function formatTools<F extends ToolFormat>(tools: ToolDefinition[], format: F): ToolFormats[F]
export function formatTools(
  tools: ToolDefinition[],
  format: ToolFormat,
  manifests?: ReadonlyMap<string, Manifest>,
): unknown {
  switch (format) {
    case "anthropic":
      return tools.map((tool) => ({
        name: exportName(tool.name),
        description: tool.description,
        input_schema: objectSchema(tool.parameters),
      }))
    case "openai":
      return tools.map((tool) => ({
        type: "function" as const,
        name: exportName(tool.name),
        description: tool.description,
        parameters: open(tool.parameters),
        strict: strictly(tool.parameters),
      }))
    case "openai-chat":
      return tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: exportName(tool.name),
          description: tool.description,
          parameters: open(tool.parameters),
          strict: strictly(tool.parameters),
        },
      }))
    case "gemini":
      return tools.map((tool) => ({
        name: exportName(tool.name),
        description: tool.description,
        parameters: subset(tool.parameters),
        ...(tool.result === undefined ? {} : { response: subset(tool.result) }),
      }))
    case "vercel":
      return Object.fromEntries(
        tools.map((tool) => [
          exportName(tool.name),
          {
            description: tool.description,
            inputSchema: open(tool.parameters),
            ...(tool.result === undefined ? {} : { outputSchema: open(tool.result) }),
          },
        ]),
      )
    case "mcp":
      return tools.map((tool) => describe(tool, manifests?.get(tool.name)))
  }
}

// The whole MCP tool shape, so the daemon's surface and this format cannot say two different things about one Tool.
function describe(tool: ToolDefinition, manifest: Manifest | undefined): McpTool {
  const meta = META_TOOL_NAMES.has(tool.name)
  // MCP pairs an output schema with `structuredContent`, which is an object, so a result schema with any other root declares none.
  const output = meta ? (tool.name === "tool_run" ? undefined : OBJECT_RESULT) : objectRoot(tool.result)
  return {
    name: exportName(tool.name),
    description: tool.description,
    inputSchema: objectSchema(tool.parameters),
    ...(output === undefined ? {} : { outputSchema: output }),
    ...(meta ? metaAnnotations(tool.name) : { annotations: annotations(manifest ?? {}) }),
  }
}

function metaAnnotations(name: string): { annotations?: ToolAnnotations } {
  if (READ_ONLY_META.has(name)) {
    return { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
  }
  // tool_run carries the annotations of whatever it dispatches to, which flintd cannot know here, so it carries none.
  if (name === "tool_run") return {}
  return { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
}

function annotations(manifest: Manifest): ToolAnnotations {
  const files = manifest.fs !== undefined
  const commands = manifest.exec === true
  const reaches = (manifest.hosts?.length ?? 0) > 0 || (manifest.connections?.length ?? 0) > 0
  return {
    readOnlyHint: !files && !commands && !reaches,
    destructiveHint: files || commands,
    // A Body is arbitrary JavaScript, so flintd never promises that calling it twice is the same as calling it once.
    idempotentHint: false,
    openWorldHint: reaches,
  }
}

function objectRoot(schema: JsonSchema | undefined): ObjectSchema | undefined {
  return schema?.type === "object" ? objectSchema(schema) : undefined
}

export async function callFrom<F extends ToolFormat>(
  flint: Flint,
  format: F,
  block: unknown,
  meta: CallMeta = {},
): Promise<ToolResults[F]> {
  const asked = read(format, block)
  let args: JsonValue
  try {
    args = parsed(asked.args)
  } catch (cause) {
    return failure(format, asked, refusal(cause)) as ToolResults[F]
  }
  try {
    return success(format, asked, await flint.call(libraryName(asked.name), args, meta)) as ToolResults[F]
  } catch (cause) {
    return failure(format, asked, refusal(cause)) as ToolResults[F]
  }
}

interface Asked {
  id: string
  name: string
  args: unknown
}

function read(format: ToolFormat, block: unknown): Asked {
  const one = object(block, "the tool call")
  switch (format) {
    case "anthropic":
      return { id: string(one["id"], "id"), name: string(one["name"], "name"), args: one["input"] }
    case "openai":
      return { id: string(one["call_id"], "call_id"), name: string(one["name"], "name"), args: one["arguments"] }
    case "openai-chat": {
      const call = object(one["function"], "function")
      return { id: string(one["id"], "id"), name: string(call["name"], "name"), args: call["arguments"] }
    }
    case "gemini": {
      const part = "functionCall" in one ? object(one["functionCall"], "functionCall") : one
      const id = part["id"]
      return { id: id === undefined ? "" : string(id, "id"), name: string(part["name"], "name"), args: part["args"] }
    }
    case "vercel":
      return {
        id: string(one["toolCallId"], "toolCallId"),
        name: string(one["toolName"], "toolName"),
        args: one["input"],
      }
    case "mcp":
      return { id: "", name: string(one["name"], "name"), args: one["arguments"] }
  }
}

function success(format: ToolFormat, asked: Asked, result: JsonValue): ToolResults[ToolFormat] {
  switch (format) {
    case "anthropic":
      return { type: "tool_result", tool_use_id: asked.id, content: JSON.stringify(result) }
    case "openai":
      return { type: "function_call_output", call_id: asked.id, output: JSON.stringify(result) }
    case "openai-chat":
      return { role: "tool", tool_call_id: asked.id, content: JSON.stringify(result) }
    case "gemini":
      return { functionResponse: { ...identified(asked), name: asked.name, response: { output: result } } }
    case "vercel":
      return { type: "tool-result", toolCallId: asked.id, toolName: asked.name, output: { type: "json", value: result } }
    case "mcp":
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(isObject(result) ? { structuredContent: result } : {}),
      }
  }
}

function failure(format: ToolFormat, asked: Asked, error: ToolError): ToolResults[ToolFormat] {
  const payload = { error: { code: error.code, message: error.message } }
  switch (format) {
    case "anthropic":
      return { type: "tool_result", tool_use_id: asked.id, content: JSON.stringify(payload), is_error: true }
    case "openai":
      return { type: "function_call_output", call_id: asked.id, output: JSON.stringify(payload) }
    case "openai-chat":
      return { role: "tool", tool_call_id: asked.id, content: JSON.stringify(payload) }
    case "gemini":
      return { functionResponse: { ...identified(asked), name: asked.name, response: payload } }
    case "vercel":
      return {
        type: "tool-result",
        toolCallId: asked.id,
        toolName: asked.name,
        // The AI SDK has no tool-error content part: a refusal is a result whose output says it is one.
        output: { type: "error-json", value: payload },
      }
    case "mcp":
      return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true }
  }
}

function identified(asked: Asked): { id?: string } {
  return asked.id === "" ? {} : { id: asked.id }
}

// `tool_create` refuses a schema whose root is not an object, so the literal a provider's own type asks for holds.
function objectSchema(schema: JsonSchema): ObjectSchema {
  return { ...schema, type: "object" }
}

function open(schema: JsonSchema): ProviderSchema {
  return { ...schema }
}

// OpenAI structured outputs holds a strict schema to a closed object whose every property is required.
function strictly(schema: JsonSchema): boolean {
  return schema.type === "object" && qualifies(schema, 1)
}

function qualifies(schema: JsonSchema, depth: number): boolean {
  if (depth > STRICT_MAX_DEPTH) return false
  // The supported types are string, number, boolean, integer, object, array, enum and anyOf. A null is none of them.
  if (schema.type === "null") return false
  if (Object.keys(schema).some((keyword) => STRICT_UNSUPPORTED.has(keyword))) return false
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) return false
    const required = new Set(schema.required ?? [])
    if (Object.keys(schema.properties ?? {}).some((key) => !required.has(key))) return false
  }
  if (Object.values(schema.properties ?? {}).some((child) => !qualifies(child, depth + 1))) return false
  return schema.items === undefined || qualifies(schema.items, depth + 1)
}

function subset(schema: JsonSchema): GeminiSchema {
  const kept: Record<string, unknown> = {}
  for (const [keyword, value] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED.has(keyword)) continue
    if (keyword === "properties") {
      kept[keyword] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([child, one]) => [child, subset(one)]),
      )
      continue
    }
    if (GEMINI_COUNTS.has(keyword)) {
      kept[keyword] = String(value)
      continue
    }
    kept[keyword] = keyword === "items" ? subset(value as JsonSchema) : value
  }
  // A genai Schema.enum is string[], so an enum of anything else moves into the description, where a model still reads it.
  if (schema.enum !== undefined && !(schema.type === "string" && schema.enum.every((one) => typeof one === "string"))) {
    delete kept["enum"]
    const values = schema.enum.map((one) => JSON.stringify(one)).join(", ")
    kept["description"] = `${schema.description === undefined ? "" : `${schema.description} `}One of: ${values}.`
  }
  return kept as GeminiSchema
}

function parsed(args: unknown): JsonValue {
  if (typeof args !== "string") return (args ?? {}) as JsonValue
  // Chat Completions sends "" for a call with no arguments at all.
  if (args.trim() === "") return {}
  try {
    return JSON.parse(args) as JsonValue
  } catch (cause) {
    throw new ToolError(
      "invalid_arguments",
      `The arguments are not JSON: ${causeMessage(cause)}. Send the arguments again as one JSON object.`,
    )
  }
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ToolError("invalid_arguments", `${what} is not an object, so there is no tool call to run.`)
  }
  return value
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ToolError("invalid_arguments", `The tool call carries no \`${field}\`, so there is nothing to run.`)
  }
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function refusal(cause: unknown): ToolError {
  return cause instanceof ToolError ? cause : new ToolError("internal_error", causeMessage(cause))
}
