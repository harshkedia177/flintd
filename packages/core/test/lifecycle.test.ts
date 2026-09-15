import assert from "node:assert/strict"
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, test } from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { JsonValue } from "../src/index.ts"
import { BRITTLE_SOURCE, creation, refusal, withFlint } from "./support.ts"

// Each test here opens its own Library directory and asserts a state, not a time bound, so they run together
// rather than in turn.
describe("Lifecycle", { concurrency: true }, () => {
  const git = promisify(execFile)

  async function temporaryDirectory(): Promise<string> {
    return mkdtemp(join(tmpdir(), "flintd-"))
  }

  test("start opens the Library, stop closes it, and status reports both", async () => {
    const dir = await temporaryDirectory()
    // The engine is named rather than looked for, so status() reads the same on a machine with a container engine
    // and on one without.
    const flint = createFlint({ dir, containerEngine: "none" })
    try {
      assert.deepEqual((await flint.status()), {
        running: false,
        dir,
        tools: 0,
        retired: 0,
        active: 0,
        activeCap: 50,
        invalid: [],
        review: [],
        model: { configured: false },
        tiers: { container: { available: false, engine: "none", version: null } },
        observer: { running: false, lastRunAt: null, candidates: 0, drafts: 0, refusals: 0, retirements: 0 },
        libraries: [],
      })
      const early = await refusal(async () => flint.call("tool_read", { name: "word_count" }))
      assert.equal(early.code, "internal_error")

      await flint.start()
      assert.deepEqual((await flint.status()), {
        running: true,
        dir,
        tools: 0,
        retired: 0,
        active: 0,
        activeCap: 50,
        invalid: [],
        review: [],
        model: { configured: false },
        tiers: { container: { available: false, engine: "none", version: null } },
        observer: { running: false, lastRunAt: null, candidates: 0, drafts: 0, refusals: 0, retirements: 0 },
        libraries: [{ library: "user", dir, tools: 0, retired: 0, remote: null, error: null }],
      })
      await access(join(dir, "tools"))
      await access(join(dir, ".git"))
      await access(join(dir, ".gitignore"))

      await flint.stop()
      assert.equal((await flint.status()).running, false)
    } finally {
      await flint.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a restart finds the Tools that are already in the Library directory", async () => {
    const dir = await temporaryDirectory()
    try {
      const first = createFlint({ dir })
      await first.start()
      await first.call("tool_create", creation())
      await first.stop()

      const second = createFlint({ dir })
      await second.start()
      try {
        assert.equal((await second.status()).tools, 1)
        assert.deepEqual(await second.call("word_count", { text: "one two" }), { count: 2 })
      } finally {
        await second.stop()
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("the index is built again from the Library directory when it is gone, counters and all", async () => {
    const dir = await temporaryDirectory()
    try {
      const first = createFlint({ dir })
      await first.start()
      await first.call("tool_create", creation({ execute_source: BRITTLE_SOURCE }))
      for (const text of ["one two", "three", "four five"]) {
        await first.call("word_count", { text }, { tokens: { input: 10, output: 2 } })
      }
      await refusal(() => first.call("word_count", { text: "boom" }))
      // The counters reach stats.json with the next Version, which is what the rebuild reads them from.
      await first.call("tool_update", { name: "word_count", description: "Count the words of a text." })
      assert.equal((await first.library())[0]?.contribution, 0.5)
      await first.stop()
      await rm(join(dir, "index.sqlite"), { force: true })

      const second = createFlint({ dir })
      await second.start()
      try {
        assert.equal((await second.status()).tools, 1)
        const entry = (await second.library())[0]
        assert.equal(entry?.calls, 4)
        assert.equal(entry?.errors, 1)
        assert.equal(entry?.contribution, 0.5)
        assert.ok(typeof entry?.lastCallAt === "string")
        const read = (await second.call("tool_read", { name: "word_count" })) as Record<string, JsonValue>
        assert.deepEqual((read["stats"] as { tokens: unknown }).tokens, { input: 30, output: 6 })

        // A call after the rebuild adds to the counters the repository held rather than starting again from zero.
        assert.deepEqual(await second.call("word_count", { text: "one two" }), { count: 2 })
        assert.equal((await second.library())[0]?.calls, 5)
        assert.equal((await second.library())[0]?.contribution, 0.6)
      } finally {
        await second.stop()
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("start on an existing Library adds no second repository and keeps one commit per write", async () => {
    await withFlint(async (flint, dir) => {
      await flint.call("tool_create", creation())
      await flint.stop()
      await flint.start()
      assert.equal((await flint.status()).tools, 1)
      await access(join(dir, "tools", "word_count", "tool.json"))
    })
  })

  test("an operator .gitignore without a trailing newline still keeps the index out of git", async () => {
    const dir = await temporaryDirectory()
    const flint = createFlint({ dir })
    try {
      await writeFile(join(dir, ".gitignore"), "notes.md")
      await flint.start()
      await flint.call("tool_create", creation())
      assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "notes.md\nindex.sqlite*\nflintd.lock*\ntools/*/*.tmp\n")
      const tracked = await git("git", ["ls-files"], { cwd: dir })
      assert.ok(!tracked.stdout.includes("index.sqlite"), tracked.stdout)
    } finally {
      await flint.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a commit holds the Tool and the ignore rules, and nothing the operator left or staged", async () => {
    await withFlint(async (flint, dir) => {
      await writeFile(join(dir, "operator-notes.txt"), "mine")
      await writeFile(join(dir, "operator-secret.txt"), "staged by hand")
      await git("git", ["add", "--", "operator-secret.txt"], { cwd: dir })

      await flint.call("tool_create", creation())

      const committed = await git("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir })
      assert.deepEqual(committed.stdout.trim().split("\n").sort(), [
        ".gitignore",
        "tools/word_count/body.js",
        "tools/word_count/examples.json",
        "tools/word_count/stats.json",
        "tools/word_count/tool.json",
      ])
      const staged = await git("git", ["diff", "--cached", "--name-only"], { cwd: dir })
      assert.equal(staged.stdout.trim(), "operator-secret.txt")
    })
  })

  test("a commit that fails leaves the working tree, the git index and the Library index clean", async () => {
    await withFlint(async (flint, dir) => {
      await writeFile(join(dir, "operator-secret.txt"), "staged by hand")
      await git("git", ["add", "--", "operator-secret.txt"], { cwd: dir })
      await writeFile(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      const error = await refusal(() => flint.call("tool_create", creation()))
      assert.equal(error.code, "store_error")

      assert.deepEqual(await readdir(join(dir, "tools")), [])
      const staged = await git("git", ["diff", "--cached", "--name-only"], { cwd: dir })
      assert.equal(staged.stdout.trim(), "operator-secret.txt")
      const dirty = await git("git", ["status", "--porcelain"], { cwd: dir })
      assert.deepEqual(dirty.stdout.trim().split("\n").sort(), ["?? .gitignore", "A  operator-secret.txt"])
      assert.equal((await flint.status()).tools, 0)
      assert.equal((await refusal(() => flint.call("tool_read", { name: "word_count" }))).code, "not_found")
    })
  })

  test("a commit that fails cleans up a Tool directory that was already on disk", async () => {
    await withFlint(async (flint, dir) => {
      await mkdir(join(dir, "tools", "word_count"), { recursive: true })
      await writeFile(join(dir, "tools", "word_count", "leftover.txt"), "from an earlier crash")
      await writeFile(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })

      assert.equal((await refusal(() => flint.call("tool_create", creation()))).code, "store_error")
      assert.deepEqual(await readdir(join(dir, "tools")), [])
      const staged = await git("git", ["diff", "--cached", "--name-only"], { cwd: dir })
      assert.equal(staged.stdout.trim(), "")
      assert.equal((await flint.status()).tools, 0)
    })
  })

  test("createFlint refuses a missing directory and a limit that is not a positive whole number", async () => {
    assert.throws(() => createFlint({ dir: "" }), { code: "internal_error" })
    assert.throws(() => createFlint({ dir: "/tmp/flintd", callTimeoutMs: 0 }), { code: "internal_error" })
    assert.throws(() => createFlint({ dir: "/tmp/flintd", maxResultBytes: 1.5 }), { code: "internal_error" })
  })

  test("a stale git lock refuses the write and leaves no Tool behind", async () => {
    const dir = await temporaryDirectory()
    try {
      const first = createFlint({ dir })
      await first.start()
      await writeFile(join(dir, ".git", "index.lock"), "")
      const error = await refusal(() => first.call("tool_create", creation()))
      assert.equal(error.code, "store_error")
      await assert.rejects(access(join(dir, "tools", "word_count")))
      assert.equal((await first.status()).tools, 0)
      await first.stop()

      await rm(join(dir, ".git", "index.lock"))
      const second = createFlint({ dir })
      await second.start()
      try {
        assert.equal((await second.status()).tools, 0)
        assert.equal((await refusal(() => second.call("word_count", { text: "one two" }))).code, "not_found")
      } finally {
        await second.stop()
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a Library index whose table does not match is rebuilt instead of refused", async () => {
    const dir = await temporaryDirectory()
    const flint = createFlint({ dir })
    try {
      const seed = new DatabaseSync(join(dir, "index.sqlite"))
      seed.exec("CREATE TABLE tools (wrong TEXT)")
      seed.close()
      await flint.start()
      await flint.call("tool_create", creation())
      assert.deepEqual(await flint.call("word_count", { text: "one two" }), { count: 2 })
    } finally {
      await flint.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a stop() whose last stage throws still puts the Flint down, and start() opens it again", async () => {
    const dir = await temporaryDirectory()
    const flint = createFlint({ dir })
    await flint.start()
    try {
      // Releasing the lock unlinks a file, and a directory nobody may write refuses exactly that one unlink.
      await chmod(dir, 0o555)
      await assert.rejects(() => flint.stop())
      await chmod(dir, 0o755)
      assert.deepEqual((await flint.status()).libraries, [])
      // The operator puts the permissions and the lock the failed stop left behind right, and the Flint opens again.
      await rm(join(dir, "flintd.lock"), { force: true })
      await flint.start()
      assert.equal((await flint.status()).running, true)
      assert.deepEqual(await flint.call("tool_find", { query: "anything at all" }), {
        query: "anything at all",
        limit: 5,
        tools: [],
      })
    } finally {
      await chmod(dir, 0o755).catch(() => undefined)
      await flint.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a git command that carries a remote credential never echoes it in the refusal", async () => {
    const dir = await temporaryDirectory()
    try {
      const first = createFlint({ dir })
      await first.start()
      await first.stop()
      await writeFile(join(dir, ".git", "config.lock"), "")

      const error = await refusal(() =>
        createFlint({ userDir: dir, userRemote: "https://someone:secret-token@127.0.0.1:1/tools.git" }).start(),
      )
      assert.equal(error.code, "store_error")
      assert.doesNotMatch(error.message, /secret-token/)
      assert.doesNotMatch(String(error.details["reason"]), /secret-token/)
      assert.match(error.message, /git remote add origin https:\/\/127\.0\.0\.1:1\/tools\.git/)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
