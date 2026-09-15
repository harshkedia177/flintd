import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFlint } from "@flintd/core"
import type { Flint, FlintOptions, JsonValue } from "@flintd/core"
import { startExports } from "../src/export.ts"
import type { ExportWatch } from "../src/export.ts"
import { serve } from "../src/server.ts"

// The product debounce is half a second; a gate test waits for the same code path and not for the clock.
const EXPORT_DEBOUNCE_MS = 20

// No test reads or writes the operator's own flintd home: every Connection a test makes lives in a temporary one.
process.env["FLINTD_HOME"] = join(tmpdir(), `flintd-home-${randomUUID()}`)

export interface Running {
  url: string
  token: string
  dir: string
  project?: string
  flint: Flint
  logged: string[]
  exports?: ExportWatch
  // Closing the daemon is a test's own business where the test measures the close; the second call is a no-op.
  stop(): Promise<void>
}

export interface Answer {
  status: number
  connection: string | null
  body: { [key: string]: JsonValue }
}

export async function withDaemon(
  run: (running: Running) => Promise<void>,
  options: Omit<FlintOptions, "dir" | "userDir" | "projectDir"> & { project?: boolean; skillExports?: string[] } = {},
): Promise<void> {
  const { project: wantsProject, skillExports, ...limits } = options
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  const project = wantsProject === true ? await mkdtemp(join(tmpdir(), "flintd-")) : undefined
  const token = randomBytes(16).toString("base64url")
  // One Connections file per daemon, outside every Library, so no two tests in one process share it.
  const connectionsFile = join(tmpdir(), `flintd-connections-${randomUUID()}.json`)
  const flint = createFlint({
    userDir: dir,
    connectionsFile,
    ...(project === undefined ? {} : { projectDir: project }),
    ...limits,
  })
  await flint.start()
  const logged: string[] = []
  const exports =
    skillExports === undefined
      ? undefined
      : await startExports(flint, skillExports, (said) => logged.push(said), EXPORT_DEBOUNCE_MS)
  const daemon = await serve({
    flint,
    token,
    port: 0,
    ...(limits.stopGraceMs === undefined ? {} : { stopGraceMs: limits.stopGraceMs }),
    ...(exports === undefined ? {} : { exports: exports.status }),
  })
  let closed = false
  const stop = async (): Promise<void> => {
    if (closed) return
    closed = true
    await daemon.close()
  }
  try {
    await run({
      url: daemon.url,
      token,
      dir,
      flint,
      logged,
      stop,
      ...(exports === undefined ? {} : { exports }),
      ...(project === undefined ? {} : { project }),
    })
  } finally {
    await exports?.stop()
    await stop()
    await flint.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await rm(connectionsFile, { force: true })
    if (project !== undefined) await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

export function called(answer: Answer): JsonValue {
  return (answer.body["call"] as { result: JsonValue }).result
}

export function callId(answer: Answer): string {
  return String((answer.body["call"] as { id: string }).id)
}

export async function ask(
  running: Running,
  method: string,
  path: string,
  options: { body?: JsonValue; token?: string | null; origin?: string; raw?: string; type?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {}
  const token = options.token === undefined ? running.token : options.token
  if (token !== null) headers["authorization"] = `Bearer ${token}`
  if (options.origin !== undefined) headers["origin"] = options.origin
  if (options.body !== undefined || options.raw !== undefined) {
    headers["content-type"] = options.type ?? "application/json"
  }
  const response = await fetch(`${running.url}${path}`, {
    method,
    headers,
    ...(options.raw !== undefined
      ? { body: options.raw }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  })
  return {
    status: response.status,
    connection: response.headers.get("connection"),
    body: (await response.json()) as { [key: string]: JsonValue },
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

export const LOOPING: { [key: string]: JsonValue } = {
  name: "loop_forever",
  description: "Loop until the call timeout when asked to, and answer at once otherwise.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { forever: { type: "boolean" } },
    required: ["forever"],
    additionalProperties: false,
  }),
  execute_source: "if (args.forever) { for (;;) {} }\nreturn { ok: true }",
  examples: [{ args: { forever: false }, expected: { ok: true } }],
}
