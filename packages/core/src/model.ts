import { ToolError, causeMessage } from "./errors.ts"
import { redact, rememberSecret } from "./redact.ts"
import { canonicalJson } from "./validate.ts"
import type { JsonSchema, JsonValue, ModelConfig, ModelProvider } from "./types.ts"

const ANTHROPIC_BASE_URL = "https://api.anthropic.com"
const ANTHROPIC_VERSION = "2023-06-01"
const ANTHROPIC_MODEL = "claude-sonnet-5"
const OPENAI_BASE_URL = "https://api.openai.com"
const PROVIDERS: readonly ModelProvider[] = ["anthropic", "openai"]
const MAX_ANSWER_BYTES = 262_144
const JSON_ONLY = "Answer with one JSON object and nothing else. Write no prose before it and none after it."
const MENTIONS_JSON = /json/i

export interface ModelMessage {
  role: "user" | "assistant"
  content: string
}

export interface ModelRequest {
  system: string
  messages: ModelMessage[]
  maxTokens: number
  // Present means the answer must be one JSON object of this shape; the adapter asks the provider its own way.
  json?: JsonSchema
  signal?: AbortSignal
}

// What this provider still takes: a refusal turns one off, so the next request does not ask for it again.
interface Sends {
  structured: boolean
  thinking: boolean
}

// The seam every model-dependent part of flintd uses; `embed` is present only where the provider serves embeddings.
export interface ModelAdapter {
  readonly provider: ModelProvider
  readonly model: string
  complete(request: ModelRequest): Promise<string>
  embed?(texts: string[], signal?: AbortSignal): Promise<number[][]>
}

export function isModelAdapter(value: ModelConfig | ModelAdapter): value is ModelAdapter {
  return typeof (value as ModelAdapter).complete === "function"
}

export function createModelAdapter(config: ModelConfig, timeoutMs: number): ModelAdapter {
  if (!PROVIDERS.includes(config.provider)) {
    throw configError(`\`model.provider\` is "anthropic" or "openai", and it is ${JSON.stringify(config.provider)}.`)
  }
  if (typeof config.apiKey !== "string" || config.apiKey === "") {
    throw configError("`model.apiKey` is the key flintd sends to the model provider, and it must not be empty.")
  }
  rememberSecret(config.apiKey)
  const base = baseUrl(config.baseUrl, config.provider === "anthropic" ? ANTHROPIC_BASE_URL : OPENAI_BASE_URL)
  return config.provider === "anthropic" ? anthropic(config, base, timeoutMs) : openaiCompatible(config, base, timeoutMs)
}

function anthropic(config: ModelConfig, base: string, timeoutMs: number): ModelAdapter {
  const model = text(config.model, "model.model") ?? ANTHROPIC_MODEL
  const url = `${base}/v1/messages`
  const headers = { "x-api-key": config.apiKey, "anthropic-version": ANTHROPIC_VERSION }
  // What a model refuses is remembered per option, and a refused schema per schema: one shape may pass where another fails.
  const refusedSchemas = new Set<string>()
  let refusesThinking = false

  function body(request: ModelRequest, sends: Sends): Record<string, unknown> {
    return {
      model,
      max_tokens: request.maxTokens,
      system: !sends.structured && request.json !== undefined ? `${request.system}\n\n${JSON_ONLY}` : request.system,
      messages: request.messages,
      // Thinking is on by default from Claude Sonnet 5 and its tokens come out of max_tokens, which a judgment needs.
      ...(sends.thinking ? { thinking: { type: "disabled" } } : {}),
      ...(sends.structured ? { output_config: { format: { type: "json_schema", schema: request.json } } } : {}),
    }
  }

  async function ask(request: ModelRequest, sends: Sends): Promise<string> {
    const answer = await send(url, headers, body(request, sends), timeoutMs, request.signal)
    const blocks = (answer as { content?: unknown }).content
    if (!Array.isArray(blocks)) throw unexpected(base, 'the answer carries no "content" array')
    const written = blocks
      .filter((block) => isRecord(block) && block["type"] === "text" && typeof block["text"] === "string")
      .map((block) => (block as { text: string }).text)
      .join("")
    if (written === "") throw unexpected(base, "the answer carries no text block")
    return written
  }

  return {
    provider: "anthropic",
    model,
    async complete(request: ModelRequest): Promise<string> {
      const schema = request.json === undefined ? undefined : canonicalJson(request.json as JsonValue)
      const sends: Sends = {
        structured: schema !== undefined && !refusedSchemas.has(schema),
        thinking: !refusesThinking,
      }
      for (;;) {
        try {
          const written = await ask(request, sends)
          if (schema !== undefined && !sends.structured) refusedSchemas.add(schema)
          if (!sends.thinking) refusesThinking = true
          return written
        } catch (cause) {
          if (!refusedRequest(cause)) throw cause
          // The schema goes first: a model that takes no structured output usually still takes `thinking`.
          if (sends.structured) sends.structured = false
          else if (sends.thinking) sends.thinking = false
          else throw cause
        }
      }
    },
  }
}

function openaiCompatible(config: ModelConfig, base: string, timeoutMs: number): ModelAdapter {
  const model = text(config.model, "model.model")
  if (model === undefined) {
    throw configError("`model.model` names the model an OpenAI-compatible endpoint serves, and it has no default.")
  }
  const embedModel = text(config.embedModel, "model.embedModel")
  const bearer = { authorization: `Bearer ${config.apiKey}` }
  const adapter: ModelAdapter = {
    provider: "openai",
    model,
    async complete(request: ModelRequest): Promise<string> {
      const answer = await send(
        `${base}/v1/chat/completions`,
        bearer,
        {
          model,
          messages: [{ role: "system", content: jsonSystem(request) }, ...request.messages],
          max_completion_tokens: request.maxTokens,
          ...(request.json === undefined ? {} : { response_format: { type: "json_object" } }),
        },
        timeoutMs,
        request.signal,
      )
      const choice = (answer as { choices?: unknown }).choices
      const written = Array.isArray(choice) && isRecord(choice[0]) ? (choice[0]["message"] as unknown) : undefined
      if (!isRecord(written) || typeof written["content"] !== "string" || written["content"] === "") {
        throw unexpected(base, "the answer carries no choices[0].message.content")
      }
      return written["content"]
    },
  }
  // The presence of `embed` is what tells a caller the provider serves embeddings, so it is absent without a model to call.
  if (embedModel === undefined) return adapter
  return {
    ...adapter,
    async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
      const answer = await send(
        `${base}/v1/embeddings`,
        bearer,
        { model: embedModel, input: texts, encoding_format: "float" },
        timeoutMs,
        signal,
      )
      const rows = (answer as { data?: unknown }).data
      if (!Array.isArray(rows) || rows.length !== texts.length) {
        throw unexpected(base, `the answer carries ${Array.isArray(rows) ? rows.length : 0} embeddings for ${texts.length} texts`)
      }
      return rows.map((row) => {
        const vector = isRecord(row) ? row["embedding"] : undefined
        if (!Array.isArray(vector) || vector.some((one) => typeof one !== "number")) {
          throw unexpected(base, "an entry of the answer carries no numeric embedding")
        }
        return vector as number[]
      })
    },
  }
}

async function send(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const stop = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: stop,
    })
  } catch (cause) {
    if (deadline.aborted) throw failed(`${url} did not answer within ${timeoutMs} ms`)
    throw failed(`the request to ${url} failed: ${causeMessage(cause)}`)
  }
  const body = await read(response, url)
  if (!response.ok) {
    throw failed(`${url} answered ${response.status}: ${body.slice(0, 500)}`, { status: response.status })
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw unexpected(url, "the answer is not JSON")
  }
}

async function read(response: Response, url: string): Promise<string> {
  const stream = response.body
  if (stream === null) return ""
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > MAX_ANSWER_BYTES) {
      await stream.cancel().catch(() => undefined)
      throw unexpected(url, `the answer is larger than ${MAX_ANSWER_BYTES} bytes`)
    }
    chunks.push(Buffer.from(chunk))
  }
  return redact(Buffer.concat(chunks).toString("utf8"))
}

// json_object mode is refused unless the word JSON is in the conversation, so the adapter makes sure of it.
function jsonSystem(request: ModelRequest): string {
  if (request.json === undefined) return request.system
  const written = [request.system, ...request.messages.map((message) => message.content)].join("\n")
  return MENTIONS_JSON.test(written) ? request.system : `${request.system}\n\n${JSON_ONLY}`
}

function refusedRequest(cause: unknown): boolean {
  return cause instanceof ToolError && cause.details["status"] === 400
}

function baseUrl(given: string | undefined, fallback: string): string {
  const named = text(given, "model.baseUrl")
  if (named === undefined) return fallback
  try {
    new URL(named)
  } catch {
    throw configError(`\`model.baseUrl\` must be a URL, and it is ${JSON.stringify(named)}.`)
  }
  return named.replace(/\/+$/, "")
}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value === "") {
    throw configError(`\`${field}\` must be a non-empty string.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function configError(message: string): ToolError {
  return new ToolError("internal_error", message)
}

function failed(what: string, details: Record<string, number> = {}): ToolError {
  return new ToolError("internal_error", `The model flintd is configured with could not be reached: ${what}.`, details)
}

function unexpected(url: string, what: string): ToolError {
  return new ToolError("internal_error", `The model at ${url} answered in a shape flintd does not read: ${what}.`)
}
