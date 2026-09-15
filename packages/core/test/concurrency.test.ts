import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { describe } from "node:test"
import { promisify } from "node:util"
import { ToolError, createFlint } from "../src/index.ts"
import type { JsonValue } from "../src/index.ts"
import { creation, refusal, withFlint } from "./support.ts"

// These tests each drive a remote, a lock or a stop() drain of their own, and run together they spend more time
// waiting for a core than they save: measured 5.0-10.1 s for the lane against 3.2-4.4 s in turn.
describe("Concurrency", () => {
  const run = promisify(execFile)

  const PLAIN = {
    parameters_json: JSON.stringify({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }),
    execute_source: "return { count: args.text.split(/\\s+/).filter(Boolean).length }",
    examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
  }

  const SCALED = {
    parameters_json: JSON.stringify({
      type: "object",
      properties: { text: { type: "string" }, factor: { type: "integer" } },
      required: ["text", "factor"],
      additionalProperties: false,
    }),
    execute_source: "return { count: args.text.split(/\\s+/).filter(Boolean).length * args.factor }",
    examples: [{ args: { text: "one two three", factor: 2 }, expected: { count: 6 } }],
  }

  type Answer = { value: JsonValue } | { error: ToolError }

  function answered(call: Promise<JsonValue>): Promise<Answer> {
    return call.then(
      (value) => ({ value }),
      (error: ToolError) => ({ error }),
    )
  }

  function oneVersion(value: JsonValue): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    return "parameters" in value || value["count"] === 2
  }

  test("four creates at the same time each produce a Tool and a Version", async () => {
    await withFlint(async (flint) => {
      const names = ["alpha_one", "beta_two", "gamma_three"]
      await Promise.all(names.map((name) => flint.call("tool_create", creation({ name }))))
      const versions = new Set<string>()
      for (const name of names) {
        const history = (await flint.call("tool_history", { name })) as { versions: { id: string }[] }
        assert.equal(history.versions.length, 1, name)
        versions.add(history.versions[0]?.id ?? "")
      }
      assert.equal(versions.size, names.length)
      assert.equal((await flint.status()).tools, names.length)
    })
  })

  test("two creates of one name at the same time leave one Tool, one Version and the Body that reported ok", async () => {
    await withFlint(async (flint) => {
      const answers = await Promise.all([
        answered(flint.call("tool_create", creation({ execute_source: "return { count: 1 }", examples: [{ args: { text: "one" }, expected: { count: 1 } }] }))),
        answered(flint.call("tool_create", creation({ execute_source: "return { count: 2 }", examples: [{ args: { text: "one" }, expected: { count: 2 } }] }))),
      ])
      const won = answers.findIndex((answer) => "value" in answer)
      assert.notEqual(won, -1, "neither create reported ok")
      const lost = answers[won === 0 ? 1 : 0] as { error: ToolError }
      assert.equal(lost.error.code, "exists")
      const history = (await flint.call("tool_history", { name: "word_count" })) as { versions: { id: string }[] }
      assert.equal(history.versions.length, 1)
      assert.equal((await flint.status()).tools, 1)
      // The Body that answers is the one whose create reported ok, not the one that lost the name.
      assert.deepEqual(await flint.call("word_count", { text: "one" }), { count: won + 1 })
    })
  })

  test("two identical creates at the same time leave one Tool that answers", async () => {
    await withFlint(async (flint) => {
      const answers = await Promise.all([answered(flint.call("tool_create", creation())), answered(flint.call("tool_create", creation()))])
      assert.equal(answers.filter((answer) => "value" in answer).length, 1)
      assert.equal(answers.filter((answer) => "error" in answer && answer.error.code === "exists").length, 1)
      assert.deepEqual(await flint.call("word_count", { text: "one two three" }), { count: 3 })
    })
  })

  test("a call and a read during an update never see half a Tool", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", creation())
      for (const version of [SCALED, PLAIN]) {
        const updating = answered(flint.call("tool_update", { name: "word_count", ...version }))
        // The readers are spread across the update, because a write spends most of its time proving its Examples
        // and only the last milliseconds writing the four files.
        const during: Promise<Answer>[] = []
        for (let at = 0; at < 16; at += 1) {
          during.push(
            answered(
              at % 2 === 0 ? flint.call("word_count", { text: "one two" }) : flint.call("tool_read", { name: "word_count" }),
            ),
          )
          await new Promise((tick) => setTimeout(tick, 2))
        }
        for (const answer of await Promise.all(during)) {
          // The Tool is one of its two Versions and never a mixture: the plain Body answers, and the scaled one
          // refuses arguments that carry no factor.
          if ("error" in answer) assert.equal(answer.error.code, "invalid_arguments")
          else assert.ok(oneVersion(answer.value), `a read saw ${JSON.stringify(answer.value)}`)
        }
        assert.ok(!("error" in (await updating)), "the update itself was refused")
      }
    })
  })

  test("stop waits for the write in flight and releases the lock after it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flintd-"))
    const flint = createFlint({ dir })
    try {
      await flint.start()
      const creating = flint.call("tool_create", creation())
      await new Promise((tick) => setTimeout(tick, 30))
      await flint.stop()
      assert.equal((await creating as { state: string }).state, "draft")
      await assert.rejects(readFile(join(dir, "flintd.lock"), "utf8"))

      const again = createFlint({ dir })
      await again.start()
      assert.equal((await again.status()).tools, 1)
      assert.deepEqual(await again.call("word_count", { text: "one two" }), { count: 2 })
      await again.stop()
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("two starts at the same time on one Flint open the Library once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flintd-"))
    const flint = createFlint({ dir })
    try {
      await Promise.all([flint.start(), flint.start()])
      assert.equal((await flint.status()).running, true)
    } finally {
      await flint.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a second flintd on the same Library is refused and names the process that holds it", async () => {
    await withFlint(async (flint, dir) => {
      const error = await refusal(() => createFlint({ dir }).start())
      assert.equal(error.code, "dir_in_use")
      assert.equal(error.details["pid"], process.pid)
      assert.match(error.message, /already open in process/)
      await flint.stop()
      const second = createFlint({ dir })
      await second.start()
      assert.equal((await second.status()).running, true)
      await second.stop()
    })
  })

  test("two flintds that find the same dead lock give the Library to exactly one", async () => {
    await withDeadLock(async (dir) => {
      const racing = [createFlint({ dir }), createFlint({ dir })]
      const settled = await Promise.allSettled(racing.map((flint) => flint.start()))
      try {
        assert.equal(settled.filter((answer) => answer.status === "fulfilled").length, 1)
        const refused = settled.flatMap((answer) => (answer.status === "rejected" ? [answer.reason as ToolError] : []))
        assert.equal(refused[0]?.code, "dir_in_use")
        const held = JSON.parse(await readFile(join(dir, "flintd.lock"), "utf8")) as { pid: number }
        assert.equal(held.pid, process.pid)
      } finally {
        for (const flint of racing) await flint.stop()
      }
    })
  })

  async function withDeadLock(use: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "flintd-"))
    try {
      const child = run(process.execPath, ["-e", ""])
      await child
      const gone = child.child.pid ?? 1
      await writeFile(join(dir, "flintd.lock"), JSON.stringify({ pid: gone, startedAt: new Date().toISOString() }))
      await use(dir)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }

  test("a remote that never answers holds up no call, and the push failure lands on its own", async () => {
    const black = createServer(() => undefined)
    await new Promise<void>((listening) => black.listen(0, "127.0.0.1", listening))
    const port = (black.address() as AddressInfo).port
    const dir = await mkdtemp(join(tmpdir(), "flintd-"))
    const syncTimeoutMs = 200
    const flint = createFlint({ userDir: dir, userRemote: `git://127.0.0.1:${port}/tools.git`, syncTimeoutMs })
    await flint.start()
    try {
      await flint.call("tool_create", creation())
      const started = Date.now()
      assert.deepEqual(await flint.call("word_count", { text: "one two three" }), { count: 3 })
      const waited = Date.now() - started
      // The push cannot fail before its own timeout, so a status with no push failure proves the call did not wait for it.
      assert.doesNotMatch(String((await flint.status()).libraries[0]?.error), /^push to/)
      assert.ok(waited < syncTimeoutMs, `the call waited ${waited} ms on the push`)
    } finally {
      await flint.stop()
      black.close()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("stop() drains pushes for every Library in parallel, bounded by one sync timeout", async () => {
    const black = createServer(() => undefined)
    await new Promise<void>((listening) => black.listen(0, "127.0.0.1", listening))
    const port = (black.address() as AddressInfo).port
    const remote = `git://127.0.0.1:${port}/tools.git`
    const syncTimeoutMs = 400
    const userDir = await mkdtemp(join(tmpdir(), "flintd-"))
    const projectDir = await mkdtemp(join(tmpdir(), "flintd-"))
    const flint = createFlint({ userDir, projectDir, userRemote: remote, projectRemote: remote, syncTimeoutMs })
    await flint.start()
    try {
      await flint.call("tool_create", creation(), { library: "user" })
      await flint.call("tool_create", creation(), { library: "project" })
      const started = Date.now()
      await flint.stop()
      const elapsed = Date.now() - started
      // Two dead remotes drain together, so stop() pays one sync timeout, not two.
      assert.ok(elapsed < syncTimeoutMs * 1.5, `stop() took ${elapsed} ms for two dead remotes`)
      assert.equal((await flint.status()).running, false)
    } finally {
      black.close()
      await rm(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
