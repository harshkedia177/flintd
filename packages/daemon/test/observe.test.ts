import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ObserverRun } from "@flintd/core"
import { createFlint } from "@flintd/core"
import { fakeModel } from "../../core/test/fake-model.ts"
import { main } from "../src/cli.ts"
import { startObserver } from "../src/observe.ts"
import { ask, creation, withDaemon } from "./support.ts"
import type { Running } from "./support.ts"

interface Said {
  code: number
  out: string
  err: string
}

async function flintd(running: Running, ...args: string[]): Promise<Said> {
  return capture([...args, "--url", running.url, "--token", running.token])
}

async function capture(args: string[]): Promise<Said> {
  const out: string[] = []
  const err: string[] = []
  const toOut = process.stdout.write.bind(process.stdout)
  const toErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk: string | Uint8Array): boolean => (out.push(String(chunk)), true)
  process.stderr.write = (chunk: string | Uint8Array): boolean => (err.push(String(chunk)), true)
  try {
    const code = await main(args)
    return { code, out: out.join(""), err: err.join("") }
  } finally {
    process.stdout.write = toOut
    process.stderr.write = toErr
  }
}

async function repeated(running: Running, ...named: string[]): Promise<void> {
  const began = Date.now() - 3600_000
  for (const session of named) {
    for (const [index, step] of [
      { tool: "Bash", argumentKeys: ["command"] },
      { tool: "Read", argumentKeys: ["file_path"] },
    ].entries()) {
      const answer = await ask(running, "POST", "/api/v1/observations", {
        body: { harness: "claude-code", session, ...step, status: "ok", at: new Date(began + index * 1000).toISOString() },
      })
      assert.equal(answer.status, 200)
    }
  }
}

async function within(ready: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(what)
    await new Promise((wake) => setTimeout(wake, 5))
  }
}

test("the observe routes run the Observer, and flintd observe says what it found", async () => {
  await withDaemon(
    async (running) => {
      await repeated(running, "r1", "r2", "r3")
      assert.match((await flintd(running, "status")).out, /\nobserver has not run yet\n/)
      const ran = await ask(running, "POST", "/api/v1/observe", { body: { dry_run: true } })
      assert.equal(ran.status, 200)
      const run = ran.body["run"] as unknown as ObserverRun
      assert.equal(run.dryRun, true)
      assert.equal(run.modelConfigured, false)
      assert.deepEqual(
        run.candidates.map((one) => [one.pattern, one.sessions]),
        [["Bash(command) -> Read(file_path)", 3]],
      )

      const listed = await ask(running, "GET", "/api/v1/observe")
      assert.equal(listed.status, 200)
      assert.deepEqual(listed.body["proposals"], [])

      const refused = await ask(running, "DELETE", "/api/v1/observe")
      assert.equal(refused.status, 405)
      const unauthorized = await ask(running, "GET", "/api/v1/observe", { token: null })
      assert.equal(unauthorized.status, 401)

      const status = await ask(running, "GET", "/api/v1/status")
      assert.equal((status.body["status"] as { observer: { candidates: number } }).observer.candidates, 1)
      assert.match((await flintd(running, "status")).out, /\nobserver ran \S+: 1 candidates, 0 drafts, 0 retirement proposals\n/)

      const said = await flintd(running, "observe", "--dry-run")
      assert.equal(said.code, 0)
      assert.equal(
        said.out,
        "candidate\t3 sessions\tBash(command) -> Read(file_path)\n" +
          "model not configured: candidates only\n" +
          "1 candidates, 0 drafts, 0 refused, 0 retirement proposals\n",
      )
    },
    { transcriptHarnesses: ["claude-code"] },
  )
})

test("flintd observe lists the retirement proposals and retires the one the operator names", async () => {
  const model = fakeModel({ cases: [{ args: { text: "one two" }, confident: true, expected: { count: 2 } }] })
  let now = Date.now() - 5 * 86_400_000
  await withDaemon(
    async (running) => {
      await running.flint.call("tool_create", creation())
      await within(async () => (await running.flint.library())[0]?.state === "verified", "word_count never verified")
      await running.flint.call("word_count", { text: "one two" }, { sessionId: "s1" })
      now = Date.now()

      const proposals = await flintd(running, "observe", "--proposals")
      assert.equal(proposals.code, 0)
      assert.equal(proposals.out, "retire?\tword_count\tuser\tverified\tidle\t1.00\t1 calls\t0 errors\t5 days idle\n")

      const retired = await flintd(running, "observe", "--retire", "word_count")
      assert.equal(retired.code, 0)
      assert.match(retired.out, /^word_count\tretired\trestore [0-9a-f]{7,40}\n$/)
      assert.equal((await running.flint.library())[0]?.state, "retired")
      assert.equal((await flintd(running, "observe", "--proposals")).out, "no retirement proposals\n")
    },
    { model, clock: () => now, retireIdleDays: 1 },
  )
})

test("flintd observe waits as long as the run it asked for may take", async () => {
  const hung = createServer(() => undefined)
  await new Promise<void>((ok) => hung.listen(0, "127.0.0.1", ok))
  const port = (hung.address() as AddressInfo).port
  const home = await mkdtemp(join(tmpdir(), "flintd-observe-"))
  const held = process.env["FLINTD_HOME"]
  process.env["FLINTD_HOME"] = home
  // A short bound, so the client's own clock is short enough for a gate test to watch it run out.
  await writeFile(join(home, "config.json"), JSON.stringify({ observerTimeoutMs: 400 }))
  try {
    const said = await capture(["observe", "--dry-run", "--url", `http://127.0.0.1:${port}`, "--token", "not-read"])
    assert.equal(said.code, 1)
    // 400 ms of run bound and a tenth more: the client never uses its own 35 s default for this command.
    assert.match(said.err, /^transport_failed: .*within 440 ms/)
  } finally {
    if (held === undefined) delete process.env["FLINTD_HOME"]
    else process.env["FLINTD_HOME"] = held
    hung.closeAllConnections()
    await new Promise<void>((ok) => hung.close(() => ok()))
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("stopping the schedule while a run waits on the model returns inside the grace", async () => {
  let release = (): void => undefined
  const model = fakeModel({
    pause: new Promise<void>((wake) => {
      release = wake
    }),
    proposal: {
      name: "never_saved",
      description: "A Tool the model was still writing when the daemon stopped.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      body: "return true",
      examples: [{ args: {}, expected: true }],
    },
  })
  await withDaemon(
    async (running) => {
      await repeated(running, "a1", "a2", "a3")
      const schedule = startObserver(running.flint, { idleMs: 1, everyMs: 0, checkMs: 5, stopGraceMs: 200 })
      try {
        await within(async () => model.prompts.length > 0, "the schedule never reached the model")
        const began = Date.now()
        await schedule.stop()
        assert.ok(Date.now() - began < 1000, `the schedule took ${Date.now() - began} ms to stop`)
      } finally {
        release()
      }
    },
    { transcriptHarnesses: ["claude-code"], model },
  )
})

test("a check that throws is logged and the schedule keeps running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-idle-"))
  // A Flint nobody started refuses library(), which is the first thing a tick asks for.
  const flint = createFlint({ dir })
  const said: string[] = []
  const schedule = startObserver(flint, { idleMs: 1, everyMs: 0, checkMs: 5, onLog: (line) => said.push(line) })
  try {
    await within(async () => said.length > 0, "the schedule never logged the refusal")
    assert.match(String(said[0]), /^observer: the run did not finish: flintd is not started/)
  } finally {
    await schedule.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("the daemon observes when it is idle, and not while a call has just landed", async () => {
  await withDaemon(async (running) => {
    await repeated(running, "t1", "t2", "t3")
    await running.flint.call("tool_create", creation())
    await running.flint.call("word_count", { text: "one two" }, { sessionId: "t1" })

    const busy = startObserver(running.flint, { idleMs: 600_000, everyMs: 0, checkMs: 5 })
    await new Promise((wake) => setTimeout(wake, 60))
    await busy.stop()
    assert.equal((await running.flint.status()).observer.lastRunAt, null, "a busy daemon does not observe")

    const said: string[] = []
    const idle = startObserver(running.flint, { idleMs: 1, everyMs: 0, checkMs: 5, onLog: (line) => said.push(line) })
    try {
      await within(async () => (await running.flint.status()).observer.lastRunAt !== null, "the daemon never observed")
    } finally {
      await idle.stop()
    }
    assert.match(String(said[0]), /^observer: \d+ candidates, 0 drafts, 0 refused, \d+ retirement proposals$/)
  })
})
