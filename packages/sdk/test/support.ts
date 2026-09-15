import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "flintd"
import { ToolError, createFlint } from "../src/index.ts"
import type { FlintClient, FlintOptions, JsonValue } from "../src/index.ts"

// No test reads or writes the operator's own flintd home: every Connection a test makes lives in a temporary one.
process.env["FLINTD_HOME"] = join(tmpdir(), `flintd-home-${randomUUID()}`)

export interface Mode {
  name: string
  open(): Promise<Session>
}

export interface Session {
  client: FlintClient
  close(): Promise<void>
}

export async function embedded(): Promise<Session> {
  return embeddedWith({})
}

export async function embeddedWith(options: Omit<FlintOptions, "dir">): Promise<Session> {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  const client = createFlint({ dir, ...options })
  await client.start()
  return {
    client,
    async close(): Promise<void> {
      await client.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

export async function remote(): Promise<Session> {
  return daemon({})
}

export interface Running extends Session {
  url: string
  token: string
}

export async function daemon(options: Omit<FlintOptions, "dir">): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  const token = randomBytes(16).toString("base64url")
  const flint = createFlint({ dir, ...options })
  await flint.start()
  const running = await serve({ flint, token, port: 0 })
  const client = createFlint({ url: running.url, token })
  await client.start()
  return {
    client,
    url: running.url,
    token,
    async close(): Promise<void> {
      await client.stop()
      await running.close()
      await flint.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

export function creation(overrides: { [key: string]: JsonValue } = {}): { [key: string]: JsonValue } {
  return {
    name: "word_count",
    description: "Count the words in a piece of text.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }),
    execute_source: "return { count: args.text.trim().split(/\\s+/).filter(Boolean).length }",
    examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
    ...overrides,
  }
}

export async function refusal(action: () => Promise<unknown>): Promise<ToolError> {
  try {
    await action()
  } catch (cause) {
    if (cause instanceof ToolError) return cause
    throw cause
  }
  throw new Error("the call returned a result where a ToolError was expected")
}
