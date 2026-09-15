import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { IncomingHttpHeaders, Server } from "node:http"
import { test } from "node:test"
import { createModelAdapter, ToolError } from "../src/index.ts"
import type { JsonSchema, ModelConfig } from "../src/index.ts"

const TIMEOUT_MS = 2000
const SCHEMA: JsonSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
}

interface Seen {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

async function withEndpoint(
  answer: (seen: Seen) => { status?: number; body: unknown } | string,
  run: (base: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const entry: Seen = {
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }
      seen.push(entry)
      const written = answer(entry)
      const payload = typeof written === "string" ? written : JSON.stringify(written.body)
      response.writeHead(typeof written === "string" ? 200 : (written.status ?? 200), {
        "content-type": "application/json",
      })
      response.end(payload)
    })
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  try {
    await run(`http://127.0.0.1:${port(server)}`, seen)
  } finally {
    await new Promise<void>((ok, fail) => server.close((cause) => (cause === undefined ? ok() : fail(cause))))
  }
}

function port(server: Server): number {
  const address = server.address()
  return typeof address === "object" && address !== null ? address.port : 0
}

function adapter(config: ModelConfig): ReturnType<typeof createModelAdapter> {
  return createModelAdapter(config, TIMEOUT_MS)
}

test("the Anthropic adapter sends the Messages API shape and reads the text blocks back", async () => {
  await withEndpoint(
    () => ({ body: { content: [{ type: "text", text: "one" }, { type: "thinking" }, { type: "text", text: " two" }] } }),
    async (base, seen) => {
      const model = adapter({ provider: "anthropic", apiKey: "sk-anthropic", baseUrl: `${base}/` })
      assert.equal(model.model, "claude-sonnet-5")
      assert.equal(model.embed, undefined)

      const written = await model.complete({
        system: "Be exact.",
        messages: [{ role: "user", content: "Write it." }],
        maxTokens: 64,
        json: SCHEMA,
      })
      assert.equal(written, "one two")

      const request = seen[0] as Seen
      assert.equal(request.method, "POST")
      assert.equal(request.path, "/v1/messages")
      assert.equal(request.headers["x-api-key"], "sk-anthropic")
      assert.equal(request.headers["anthropic-version"], "2023-06-01")
      assert.equal(request.headers["content-type"], "application/json")
      assert.equal(request.headers.authorization, undefined)
      assert.equal(request.body["model"], "claude-sonnet-5")
      assert.equal(request.body["max_tokens"], 64)
      assert.deepEqual(request.body["messages"], [{ role: "user", content: "Write it." }])
      // Thinking is on by default from Claude Sonnet 5 and its tokens come out of max_tokens.
      assert.deepEqual(request.body["thinking"], { type: "disabled" })
      // Structured outputs, not a sentence in the prompt: the Messages API carries output_config.format.
      assert.deepEqual(request.body["output_config"], { format: { type: "json_schema", schema: SCHEMA } })
      assert.equal(request.body["system"], "Be exact.")
    },
  )
})

test("the OpenAI-compatible adapter sends the chat completions shape and reads the choice back", async () => {
  await withEndpoint(
    () => ({ body: { choices: [{ message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }] } }),
    async (base, seen) => {
      const model = adapter({ provider: "openai", apiKey: "sk-openai", model: "gpt-test", baseUrl: base })
      assert.equal(model.embed, undefined)
      assert.equal(
        await model.complete({
          system: "Be exact.",
          messages: [{ role: "user", content: "Write JSON." }],
          maxTokens: 64,
          json: SCHEMA,
        }),
        '{"ok":true}',
      )

      const request = seen[0] as Seen
      assert.equal(request.path, "/v1/chat/completions")
      assert.equal(request.headers.authorization, "Bearer sk-openai")
      assert.equal(request.body["model"], "gpt-test")
      assert.equal(request.body["max_completion_tokens"], 64)
      assert.deepEqual(request.body["response_format"], { type: "json_object" })
      assert.deepEqual(request.body["messages"], [
        { role: "system", content: "Be exact." },
        { role: "user", content: "Write JSON." },
      ])
    },
  )
})

test("an OpenAI-compatible adapter with an embedding model embeds, and one without carries no embed", async () => {
  await withEndpoint(
    () => ({ body: { data: [{ index: 0, embedding: [0.5, -0.25] }, { index: 1, embedding: [1, 0] }] } }),
    async (base, seen) => {
      const plain = adapter({ provider: "openai", apiKey: "sk-openai", model: "gpt-test", baseUrl: base })
      assert.equal(plain.embed, undefined)

      const model = adapter({
        provider: "openai",
        apiKey: "sk-openai",
        model: "gpt-test",
        embedModel: "embed-test",
        baseUrl: base,
      })
      assert.deepEqual(await model.embed?.(["one", "two"]), [[0.5, -0.25], [1, 0]])

      const request = seen[0] as Seen
      assert.equal(request.path, "/v1/embeddings")
      assert.equal(request.headers.authorization, "Bearer sk-openai")
      assert.equal(request.body["model"], "embed-test")
      assert.deepEqual(request.body["input"], ["one", "two"])
      assert.equal(request.body["encoding_format"], "float")

      // The caller's signal reaches the request, so stop() can cut an embedding the way it cuts a completion.
      const cancelled = await model.embed?.(["one"], AbortSignal.abort()).then(
        () => undefined,
        (cause: unknown) => cause as Error,
      )
      assert.equal(cancelled instanceof ToolError, true)
      assert.equal(seen.length, 1)
    },
  )
})

test("a refusal from the provider carries no key, and a config flintd cannot use is refused at once", async () => {
  await withEndpoint(
    () => ({ status: 401, body: { error: { message: "the key sk-secret-key is not valid" } } }),
    async (base) => {
      const model = adapter({ provider: "anthropic", apiKey: "sk-secret-key", baseUrl: base })
      const failure = await model
        .complete({ system: "Be exact.", messages: [{ role: "user", content: "Hello." }], maxTokens: 8 })
        .catch((cause: unknown) => cause as ToolError)
      assert.ok(failure instanceof ToolError)
      assert.match(failure.message, /answered 401/)
      assert.match(failure.message, /\[redacted]/)
      assert.equal(failure.message.includes("sk-secret-key"), false)
    },
  )

  assert.throws(
    () => adapter({ provider: "openai", apiKey: "sk-openai" }),
    /`model\.model` names the model an OpenAI-compatible endpoint serves/,
  )
  assert.throws(
    () => adapter({ provider: "gemini" as ModelConfig["provider"], apiKey: "k" }),
    /`model\.provider` is "anthropic" or "openai"/,
  )
  assert.throws(() => adapter({ provider: "anthropic", apiKey: "" }), /`model\.apiKey`/)
  assert.throws(() => adapter({ provider: "anthropic", apiKey: "k", baseUrl: "not a url" }), /`model\.baseUrl`/)
})

test("an answer in a shape the adapter cannot read fails with a message that names the shape", async () => {
  await withEndpoint(
    () => "not json at all",
    async (base) => {
      const model = adapter({ provider: "anthropic", apiKey: "sk-anthropic", baseUrl: base })
      await assert.rejects(
        model.complete({ system: "Be exact.", messages: [{ role: "user", content: "Hello." }], maxTokens: 8 }),
        /answered in a shape flintd does not read: the answer is not JSON/,
      )
    },
  )

  await withEndpoint(
    () => ({ body: { content: [] } }),
    async (base) => {
      const model = adapter({ provider: "anthropic", apiKey: "sk-anthropic", baseUrl: base })
      await assert.rejects(
        model.complete({ system: "Be exact.", messages: [{ role: "user", content: "Hello." }], maxTokens: 8 }),
        /carries no text block/,
      )
    },
  )
})

test("an endpoint that refuses structured outputs keeps thinking disabled, and each schema is asked for itself", async () => {
  await withEndpoint(
    (seen) =>
      seen.body["output_config"] === undefined
        ? { body: { content: [{ type: "text", text: '{"ok":true}' }] } }
        : { status: 400, body: { error: { message: "output_config.format: unsupported" } } },
    async (base, seen) => {
      const model = adapter({ provider: "anthropic", apiKey: "sk-anthropic", baseUrl: base })
      const ask = (json: JsonSchema): Promise<string> =>
        model.complete({
          system: "Be exact.",
          messages: [{ role: "user", content: "Write it." }],
          maxTokens: 64,
          json,
        })

      assert.equal(await ask(SCHEMA), '{"ok":true}')
      assert.equal(seen.length, 2)
      // The second request drops only the schema: a model that takes no structured output still takes `thinking`.
      assert.deepEqual(seen[1]?.body["thinking"], { type: "disabled" })
      assert.equal(seen[1]?.body["output_config"], undefined)
      assert.match(String(seen[1]?.body["system"]), /^Be exact\.\n\nAnswer with one JSON object/)

      // That schema is remembered, so the next call with it asks once.
      await ask(SCHEMA)
      assert.equal(seen.length, 3)
      assert.deepEqual(seen[2]?.body["thinking"], { type: "disabled" })

      // Another schema is its own question: one shape may pass where another fails.
      await ask({ type: "object", properties: { other: { type: "string" } }, additionalProperties: false })
      assert.equal(seen.length, 5)
      assert.notEqual(seen[3]?.body["output_config"], undefined)
    },
  )
})

test("an endpoint that refuses thinking as well is asked a third time with neither field", async () => {
  await withEndpoint(
    (seen) =>
      seen.body["output_config"] === undefined && seen.body["thinking"] === undefined
        ? { body: { content: [{ type: "text", text: '{"ok":true}' }] } }
        : { status: 400, body: { error: { message: "not supported for this model" } } },
    async (base, seen) => {
      const model = adapter({ provider: "anthropic", apiKey: "sk-anthropic", model: "claude-mythos-5", baseUrl: base })
      const request = {
        system: "Be exact.",
        messages: [{ role: "user" as const, content: "Write it." }],
        maxTokens: 64,
        json: SCHEMA,
      }
      assert.equal(await model.complete(request), '{"ok":true}')
      assert.deepEqual(
        seen.map((one) => `${one.body["output_config"] === undefined ? "-" : "schema"}/${one.body["thinking"] === undefined ? "-" : "thinking"}`),
        ["schema/thinking", "-/thinking", "-/-"],
      )

      // Both refusals are remembered, so the next call asks once.
      await model.complete(request)
      assert.equal(seen.length, 4)
    },
  )
})

test("json_object mode always carries the word JSON, because OpenAI refuses the request without it", async () => {
  await withEndpoint(
    () => ({ body: { choices: [{ message: { content: "{}" } }] } }),
    async (base, seen) => {
      const model = adapter({ provider: "openai", apiKey: "sk-openai", model: "gpt-test", baseUrl: base })
      await model.complete({
        system: "Be exact.",
        messages: [{ role: "user", content: "Count the words." }],
        maxTokens: 64,
        json: SCHEMA,
      })
      const messages = seen[0]?.body["messages"] as { role: string; content: string }[]
      assert.match(messages[0]?.content ?? "", /^Be exact\.\n\nAnswer with one JSON object/)

      // A prompt that already says JSON is left as it is.
      await model.complete({
        system: "Answer in JSON.",
        messages: [{ role: "user", content: "Count the words." }],
        maxTokens: 64,
        json: SCHEMA,
      })
      const second = seen[1]?.body["messages"] as { role: string; content: string }[]
      assert.equal(second[0]?.content, "Answer in JSON.")
    },
  )
})
