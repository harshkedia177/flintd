import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const BIN = new URL("../bin/flintd.ts", import.meta.url).pathname
const HOOK = new URL("../../hooks/bin/flintd-hook.ts", import.meta.url).pathname
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"]

interface Ran {
  code: number
  out: string
  err: string
}

test("a daemon on port 0 writes the port it bound, a hook reaches it, and a clean stop takes the file away", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "flintd-home-"))
  await writeFile(join(home, "config.json"), JSON.stringify({ port: 0, libraryDir: join(home, "library") }))
  const daemon = spawn(process.execPath, [...NODE_FLAGS, BIN, "serve"], { env: { ...process.env, FLINTD_HOME: home } })
  let stopped = false
  t.after(async () => {
    if (!stopped) {
      daemon.kill("SIGKILL")
      await new Promise((done) => daemon.once("exit", done))
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const url = await listeningOn(daemon)

  const published = (await readFile(join(home, "port"), "utf8")).trim()
  assert.equal(`http://127.0.0.1:${published}`, url)

  // The hook is told nothing but the flintd home, and a hook that could not send writes one line to stderr.
  const posted = await hook(home, "claude-code", { session_id: "s-1", tool_name: "Bash", tool_input: { command: "ls" } })
  assert.equal(posted.code, 0)
  assert.equal(posted.err, "")
  assert.equal(posted.out, "")

  // The CLI reads the same file, so a port-0 daemon is reachable without --url while it runs, and named when it is gone.
  const status = await cli(home, ["status"])
  assert.equal(status.code, 0, status.err)
  assert.match(status.out, /^running {2}/)

  daemon.kill("SIGTERM")
  await new Promise((done) => daemon.once("exit", done))
  stopped = true
  await assert.rejects(access(join(home, "port")), /ENOENT/)
  const gone = await cli(home, ["status"])
  assert.equal(gone.code, 1)
  assert.match(gone.err, /^invalid_arguments: The config names port 0/)
})

test("`flintd init` refuses to write a harness config while the port only a running daemon knows is unknown", async () => {
  const home = await mkdtemp(join(tmpdir(), "flintd-home-"))
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ port: 0 }))
    const refused = await cli(home, ["init", "--harness", "claude-code", "--transcripts", "no", "--dry-run"])
    assert.equal(refused.code, 1)
    assert.match(refused.err, /^invalid_arguments: The config names port 0/)
    assert.match(refused.err, /Start `flintd serve`/)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

function hook(home: string, harness: string, payload: unknown): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, HOOK, harness], {
      env: { ...process.env, FLINTD_HOME: home, FLINTD_TOKEN: "", FLINTD_URL: "" },
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
    child.on("close", (code) => done({ code: code ?? 0, out, err }))
    child.stdin.end(JSON.stringify(payload))
  })
}

function cli(home: string, args: string[]): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, BIN, ...args], {
      env: { ...process.env, FLINTD_HOME: home },
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
    child.on("close", (code) => done({ code: code ?? 0, out, err }))
  })
}

function listeningOn(daemon: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((found, fail) => {
    const timer = setTimeout(() => fail(new Error(`the daemon did not log a URL: ${seen}`)), 10_000)
    let seen = ""
    daemon.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString()
      const url = /flintd listening on (\S+)/.exec(seen)
      if (url?.[1] === undefined) return
      clearTimeout(timer)
      found(url[1])
    })
    daemon.stderr.on("data", (chunk: Buffer) => (seen += chunk.toString()))
  })
}
