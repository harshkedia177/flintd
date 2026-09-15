import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"
import { adapt } from "../src/adapt.ts"
import { HOOK_TIMEOUT_MS } from "../src/post.ts"
import { runHook } from "../src/run.ts"
import { hookSettings } from "../src/settings.ts"

const BIN = new URL("../bin/flintd-hook.ts", import.meta.url).pathname
const TOKEN = "hook-token"

interface Posted {
  authorization: string | undefined
  body: Record<string, unknown>
}

interface Standing {
  home: string
  port: number
  posted: Posted[]
  close(): Promise<void>
}

// The daemon's own route is proved in the daemon package; this lane needs a socket that answers, and holds no Library.
async function standing(config: Record<string, unknown> = {}): Promise<Standing> {
  const posted: Posted[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      posted.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      })
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"observation":{}}\n')
    })
  })
  const port = await listen(server)
  const home = await mkdtemp(join(tmpdir(), "flintd-hook-"))
  await writeFile(join(home, "config.json"), JSON.stringify({ port, ...config }))
  await writeFile(join(home, "token"), `${TOKEN}\n`, { mode: 0o600 })
  return {
    home,
    port,
    posted,
    async close(): Promise<void> {
      await new Promise<void>((done) => server.close(() => done()))
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      ok(typeof address === "object" && address !== null ? address.port : 0)
    })
  })
}

function run(home: string, harness: string, payload: unknown): Promise<void> {
  const held = process.env["FLINTD_HOME"]
  process.env["FLINTD_HOME"] = home
  return runHook([harness], Readable.from([JSON.stringify(payload)])).finally(() => {
    if (held === undefined) delete process.env["FLINTD_HOME"]
    else process.env["FLINTD_HOME"] = held
  })
}

function spawned(
  home: string,
  harness: string,
  payload: unknown,
  extra: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, harness], {
      env: { ...process.env, FLINTD_HOME: home, ...extra },
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("exit", (code) =>
      done({ code: code ?? -1, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }),
    )
    child.stdin.end(JSON.stringify(payload))
  })
}

test("the hook binary posts what Claude Code ran and writes nothing to stdout", async (t) => {
  const daemon = await standing()
  t.after(() => daemon.close())
  const ran = await spawned(daemon.home, "claude-code", {
    session_id: "s-9",
    transcript_path: "/tmp/transcript.jsonl",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/secret", description: "clean" },
    tool_response: { success: true },
  })
  assert.equal(ran.code, 0)
  assert.equal(ran.out, "")
  assert.equal(daemon.posted.length, 1)
  const posted = daemon.posted[0] as Posted
  assert.equal(posted.authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(posted.body, {
    harness: "claude-code",
    tool: "Bash",
    status: "ok",
    session: "s-9",
    argumentKeys: ["command", "description"],
    transcriptPath: null,
  })
  // The command was in the payload and is in no field of the Observation.
  assert.ok(!JSON.stringify(posted.body).includes("rm -rf"))
})

test("the hook exits 0, says nothing on stdout, and says on stderr why it sent nothing", async (t) => {
  const daemon = await standing()
  await daemon.close()
  t.after(() => rm(daemon.home, { recursive: true, force: true }))
  await mkdir(daemon.home, { recursive: true })
  await writeFile(join(daemon.home, "config.json"), JSON.stringify({ port: daemon.port }))
  await writeFile(join(daemon.home, "token"), `${TOKEN}\n`, { mode: 0o600 })
  const began = Date.now()
  const ran = await spawned(daemon.home, "codex", { tool_name: "shell", tool_input: {} })
  assert.equal(ran.code, 0)
  assert.equal(ran.out, "")
  assert.equal(lines(ran.err).length, 1, ran.err)
  assert.match(ran.err, /^flintd-hook: .+/)
  assert.ok(Date.now() - began < 3_000, `the hook took ${Date.now() - began} ms`)

  // A home with no token file is the other silent drop: it says so once and still costs the turn nothing.
  await rm(join(daemon.home, "token"))
  const untokened = await spawned(daemon.home, "codex", { tool_name: "shell", tool_input: {} })
  assert.equal(untokened.code, 0)
  assert.equal(untokened.out, "")
  assert.equal(lines(untokened.err).length, 1, untokened.err)
  assert.match(untokened.err, /^flintd-hook: there is no token in .*token, so start the daemon/)
})

test("an empty FLINTD_TOKEN is no token at all, so the hook reads the token file", async (t) => {
  const daemon = await standing()
  t.after(() => daemon.close())
  const ran = await spawned(daemon.home, "codex", { tool_name: "shell", tool_input: {} }, { FLINTD_TOKEN: "" })
  assert.equal(ran.code, 0)
  assert.equal(ran.err, "")
  assert.equal((daemon.posted[0] as Posted).authorization, `Bearer ${TOKEN}`)
})

test("FLINTD_URL carries the token to a loopback address and nowhere else", async (t) => {
  const daemon = await standing()
  t.after(() => daemon.close())
  const settings = (url: string): Promise<{ url: string }> => withUrl(url, () => hookSettings("codex", daemon.home))

  await assert.rejects(settings("http://elsewhere.example"), /FLINTD_URL must name a daemon on the loopback address/)
  await assert.rejects(settings("http://127.0.0.1.attacker.example:3546"), /FLINTD_URL must name a daemon/)
  // The daemon is a local process, so a hostname somebody else answers for takes no token, https or not.
  await assert.rejects(settings("https://elsewhere.example"), /FLINTD_URL must name a daemon on the loopback address/)
  await assert.rejects(settings("not a url"), /FLINTD_URL is not a URL/)
  assert.equal((await settings("https://127.0.0.1:3546")).url, "https://127.0.0.1:3546")
  assert.equal((await settings("http://[::1]:3546")).url, "http://[::1]:3546")
  assert.equal((await settings("http://127.9.9.9:3546")).url, "http://127.9.9.9:3546")

  // The refusal reaches the operator as one line, and the Observation never leaves the machine.
  const ran = await spawned(daemon.home, "codex", { tool_name: "shell", tool_input: {} }, { FLINTD_URL: "http://elsewhere.example" })
  assert.equal(ran.code, 0)
  assert.equal(ran.out, "")
  assert.equal(lines(ran.err).length, 1, ran.err)
  assert.match(ran.err, /^flintd-hook: FLINTD_URL must name a daemon/)
  assert.equal(daemon.posted.length, 0)
})

test("a hook whose port is 0 in the config reads the port the running daemon published", async (t) => {
  const daemon = await standing({ port: 0 })
  t.after(() => daemon.close())
  await writeFile(join(daemon.home, "port"), `${daemon.port}\n`)
  const ran = await spawned(daemon.home, "codex", { tool_name: "shell", tool_input: {} })
  assert.equal(ran.code, 0)
  assert.equal(ran.err, "")
  assert.equal(daemon.posted.length, 1)
})

function lines(written: string): string[] {
  return written.split("\n").filter((one) => one !== "")
}

async function withUrl<T>(url: string, read: () => Promise<T>): Promise<T> {
  const held = process.env["FLINTD_URL"]
  process.env["FLINTD_URL"] = url
  try {
    return await read()
  } finally {
    if (held === undefined) delete process.env["FLINTD_URL"]
    else process.env["FLINTD_URL"] = held
  }
}

test("the hook ends on its own clock when the harness never closes the pipe", async (t) => {
  const daemon = await standing()
  t.after(() => daemon.close())
  const began = Date.now()
  const code = await new Promise<number>((done) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "claude-code"], {
      env: { ...process.env, FLINTD_HOME: daemon.home },
    })
    child.stdout.resume()
    child.stderr.resume()
    child.on("exit", (exit) => done(exit ?? -1))
    // Written and never ended: a harness that holds the pipe open must not hold the turn open with it.
    child.stdin.write('{"tool_name":"Bash","tool_input":{"command":"ls"}}')
  })
  assert.equal(code, 0)
  // Proves the hook exits on its own deadline rather than waiting for the pipe forever; a generous multiple survives load.
  assert.ok(Date.now() - began < HOOK_TIMEOUT_MS * 6, `the hook lived ${Date.now() - began} ms`)
})

test("the transcript path travels only when the operator turned transcripts on for that harness", async (t) => {
  const off = await standing()
  const on = await standing({ harnesses: { codex: { transcripts: true } } })
  t.after(async () => {
    await off.close()
    await on.close()
  })
  const payload = { session_id: "s-1", transcript_path: "/tmp/t.jsonl", tool_name: "shell", tool_input: {} }
  await run(off.home, "codex", payload)
  await run(on.home, "codex", payload)
  assert.equal((off.posted[0] as Posted).body["transcriptPath"], null)
  assert.equal((on.posted[0] as Posted).body["transcriptPath"], "/tmp/t.jsonl")
})

test("each harness's own payload shape reaches the same Observation", () => {
  assert.deepEqual(adapt("codex", { tool_name: "shell", tool_input: { command: "ls" }, tool_response: { success: false } }, false), {
    harness: "codex",
    tool: "shell",
    status: "error",
    session: null,
    argumentKeys: ["command"],
    transcriptPath: null,
  })
  assert.deepEqual(adapt("opencode", { tool: "bash", session: "s-2", args: { command: null }, status: "error" }, true), {
    harness: "opencode",
    tool: "bash",
    status: "error",
    session: "s-2",
    argumentKeys: ["command"],
    transcriptPath: null,
  })
  assert.equal(adapt("hermes", { args: {} }, false), undefined)
  assert.equal(adapt("openclaw", "command:new", false), undefined)
  const many = Object.fromEntries(Array.from({ length: 100 }, (_one, index) => [`k${index}`.padEnd(200, "x"), 1]))
  const capped = adapt("claude-code", { tool_name: "Bash", tool_input: many }, false)
  assert.equal(capped?.argumentKeys.length, 64)
  assert.equal(capped?.argumentKeys[0]?.length, 128)
})

test("a session event is recorded under the name of the event", async (t) => {
  const daemon = await standing()
  t.after(() => daemon.close())
  await run(daemon.home, "claude-code", { hook_event_name: "SessionStart", session_id: "s-3" })
  assert.deepEqual((daemon.posted[0] as Posted).body, {
    harness: "claude-code",
    tool: "SessionStart",
    status: "ok",
    session: "s-3",
    argumentKeys: [],
    transcriptPath: null,
  })
})
