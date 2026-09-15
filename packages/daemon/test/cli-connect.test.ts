import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const BIN = new URL("../bin/flintd.ts", import.meta.url).pathname
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"]
const VALUE = "not-a-real-credential-9f3c2b7a1d"

test("`flintd connect` stores a credential in the flintd home and shows names and hosts only", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "flintd-home-"))
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      port: 0,
      libraryDir: join(home, "library"),
      connections: [{ name: "configured", hosts: ["config.example.com"], header: { name: "authorization", value: "Bearer 1234567890" } }],
    }),
    { mode: 0o600 },
  )
  const daemon = spawn(process.execPath, [...NODE_FLAGS, BIN, "serve"], { env: { ...process.env, FLINTD_HOME: home } })
  t.after(async () => {
    daemon.kill("SIGTERM")
    await new Promise((done) => daemon.once("exit", done))
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const url = await listeningOn(daemon)
  const run = (...args: string[]): Promise<Result> => cli(home, [...args, "--url", url])

  const stored = await run("connect", "upstream", "--host", "api.example.com", "--host", "127.0.0.1", "--header", `x-api-key: ${VALUE}`)
  assert.equal(stored.code, 0, stored.err)
  assert.match(stored.out, /"name": "upstream"/)
  assert.ok(!stored.out.includes(VALUE), "the CLI wrote the credential back")

  const listed = await run("connect", "--list")
  assert.equal(listed.out, "configured\tconfig.example.com\nupstream\tapi.example.com, 127.0.0.1\n")

  // The file lives beside the token, never in a Library, and no other user may read it.
  const file = join(home, "connections.json")
  assert.equal((await stat(file)).mode & 0o077, 0)
  const held = JSON.parse(await readFile(file, "utf8")) as { name: string }[]
  assert.deepEqual(
    held.map((one) => one.name),
    ["upstream"],
  )
  assert.equal(await readFile(join(home, "library", "connections.json"), "utf8").catch(() => null), null)

  const kept = await run("connect", "--remove", "configured")
  assert.equal(kept.code, 1)
  assert.match(kept.err, /comes from the flintd config file/)

  const gone = await run("connect", "--remove", "upstream")
  assert.equal(gone.code, 0, gone.err)
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [])
})

interface Result {
  code: number
  out: string
  err: string
}

function cli(home: string, args: string[]): Promise<Result> {
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
