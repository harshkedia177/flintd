import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import test, { describe } from "node:test"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { Flint, JsonValue } from "../src/index.ts"
import { creation, temporaryLibrary } from "./support.ts"

// These tests each drive their own remote through real git, and run together they cost the lane more than they
// save: measured 5.0-10.1 s against 3.2-4.4 s in turn.
describe("Library sync", () => {
  const run = promisify(execFile)

  const CHARACTERS = {
    execute_source: "return { count: args.text.length }",
    examples: [{ args: { text: "one two three" }, expected: { count: 13 } }],
  }

  // A push runs beside the write queue, so the test waits for it rather than for a call that would order it.
  async function waitFor<T>(read: () => Promise<T | null | undefined> | T | null | undefined): Promise<T> {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const value = await read()
      if (value !== undefined && value !== null) return value
      await new Promise((wake) => setTimeout(wake, 5))
    }
    throw new Error("the Library never reached the sync state the test waits for")
  }

  function pushed(origin: string): Promise<string> {
    return waitFor(() => run("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: origin }).then(
      ({ stdout }) => stdout.trim(),
      () => undefined,
    ))
  }

  async function bareRepository(): Promise<string> {
    const dir = await temporaryLibrary()
    await run("git", ["init", "--bare", "-b", "main", dir])
    return dir
  }

  async function started(dir: string, remote: string): Promise<Flint> {
    const flint = createFlint({ userDir: dir, userRemote: remote })
    await flint.start()
    return flint
  }

  test("a push that fails is reported in status and the next write sends every Version", async () => {
    const origin = join(await temporaryLibrary(), "origin.git")
    const dir = await temporaryLibrary()
    const flint = await started(dir, origin)
    try {
      assert.match(String((await flint.status()).libraries[0]?.error), /^pull from .*origin\.git: /)
      await flint.call("tool_create", creation())
      const failure = await waitFor(async () => {
        const error = (await flint.status()).libraries[0]?.error
        return error?.startsWith("push to") === true ? error : undefined
      })
      assert.match(failure, /^push to .*origin\.git: /)

      await run("git", ["init", "--bare", "-b", "main", origin])
      await flint.call("tool_create", creation({ name: "second_tool" }))
      await waitFor(async () => ((await flint.status()).libraries[0]?.error === null ? "cleared" : undefined))
    } finally {
      await flint.stop()
    }
    const names = await run("git", ["ls-tree", "--name-only", "main:tools"], { cwd: origin })
    assert.deepEqual(names.stdout.trim().split("\n").sort(), ["second_tool", "word_count"])
    for (const path of [origin, dir]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  test("two Flints on one remote pull at start, push each Version, and flag a Tool both of them changed", async () => {
    const origin = await bareRepository()
    const mine = await temporaryLibrary()
    const theirs = await temporaryLibrary()
    let flint = await started(mine, origin)
    await flint.call("tool_create", creation())
    await pushed(origin)

    const other = await started(theirs, origin)
    assert.equal((await other.status()).tools, 1)
    assert.equal((await other.status()).libraries[0]?.remote, origin)
    assert.deepEqual(await other.call("word_count", { text: "one two" }), { count: 2 })
    const remote = (await other.call("tool_update", {
      name: "word_count",
      description: "Count the letters of a text.",
      ...CHARACTERS,
    })) as { version: string }
    await other.stop()

    const local = (await flint.call("tool_update", {
      name: "word_count",
      description: "Count the words, and say so.",
      execute_source: "return { count: args.text.trim().split(/\\s+/).filter(Boolean).length, counted: true }",
      examples: [{ args: { text: "one two" }, expected: { count: 2, counted: true } }],
    })) as { version: string }
    await flint.stop()

    flint = await started(mine, origin)
    assert.equal((await flint.status()).libraries[0]?.error, null)
    try {
      assert.deepEqual((await flint.status()).review, [{ name: "word_count", library: "user" }])
      assert.equal((await flint.library())[0]?.needs_review, true)
      assert.deepEqual(await flint.call("word_count", { text: "one two" }), { count: 2, counted: true })

      const history = (await flint.call("tool_history", { name: "word_count" })) as {
        versions: { id: string; message: string }[]
      }
      const ids = history.versions.map((version) => version.id)
      assert.ok(ids.includes(local.version), "the local Version is in the history")
      assert.ok(ids.includes(remote.version), "the remote Version is in the history")
      assert.equal(history.versions[0]?.message, "review(word_count): sync")
      const shared = await run("git", ["log", "-1", "--format=%s", "main"], { cwd: origin })
      assert.equal(shared.stdout.trim(), "review(word_count): sync")

      const restored = (await flint.call("tool_update", {
        name: "word_count",
        restore_version: remote.version,
      })) as Record<string, JsonValue>
      assert.equal(restored["needs_review"], false)
      assert.deepEqual((await flint.status()).review, [])
      assert.deepEqual(await flint.call("word_count", { text: "one two" }), { count: 7 })
    } finally {
      await flint.stop()
      for (const dir of [origin, mine, theirs]) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("two Libraries that were filled before either pulled keep both Tools and meet on the review path", async () => {
    const origin = await bareRepository()
    const mine = await temporaryLibrary()
    const theirs = await temporaryLibrary()
    const first = await started(mine, origin)
    let second = await started(theirs, origin)
    await first.call("tool_create", creation())
    await pushed(origin)
    await second.call("tool_create", creation(CHARACTERS))
    await first.stop()
    await second.stop()

    second = await started(theirs, origin)
    try {
      assert.deepEqual((await second.status()).review, [{ name: "word_count", library: "user" }])
      assert.deepEqual(await second.call("word_count", { text: "one two three" }), { count: 13 })
      const history = (await second.call("tool_history", { name: "word_count" })) as {
        versions: { message: string }[]
      }
      assert.equal(history.versions.length, 3)
      assert.equal(history.versions[0]?.message, "review(word_count): sync")
      const dirty = await run("git", ["status", "--porcelain"], { cwd: theirs })
      assert.equal(dirty.stdout, "")
      // start() pushed the resolution, so the Library that wrote the other Tool reads it on its next pull.
      const remote = await run("git", ["log", "-1", "--format=%s", "main"], { cwd: origin })
      assert.equal(remote.stdout.trim(), "review(word_count): sync")
    } finally {
      await second.stop()
    }

    for (const path of [origin, mine, theirs]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  async function names(origin: string): Promise<string[]> {
    const listed = await run("git", ["ls-tree", "--name-only", "main:tools"], { cwd: origin }).then(
      ({ stdout }) => stdout.trim(),
      () => "",
    )
    return listed === "" ? [] : listed.split("\n").sort()
  }

  test("a push the remote refuses pulls once and sends again, and both clones keep every Tool", async () => {
    const origin = await bareRepository()
    const mine = await temporaryLibrary()
    const theirs = await temporaryLibrary()
    const first = await started(mine, origin)
    const second = await started(theirs, origin)
    try {
      await first.call("tool_create", creation())
      await waitFor(async () => ((await names(origin)).includes("word_count") ? true : undefined))

      // The second clone never saw that Version, so its own push is refused until it pulls.
      await second.call("tool_create", creation({ name: "second_tool" }))
      await waitFor(async () =>
        (await names(origin)).join() === "second_tool,word_count" ? true : undefined,
      )
      assert.equal((await second.status()).libraries[0]?.error, null)
      assert.deepEqual(
        (await second.library()).map((entry) => entry.name),
        ["second_tool", "word_count"],
      )
      assert.deepEqual(await second.call("word_count", { text: "one two" }), { count: 2 })
    } finally {
      await first.stop()
      await second.stop()
      for (const path of [origin, mine, theirs]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a remote that carries a credential never shows it in status or in a sync failure", async () => {
    const dir = await temporaryLibrary()
    const flint = createFlint({ userDir: dir, userRemote: "https://someone:secret-token@127.0.0.1:1/tools.git" })
    await flint.start()
    try {
      const library = (await flint.status()).libraries[0]
      assert.equal(library?.remote, "https://127.0.0.1:1/tools.git")
      assert.doesNotMatch(String(library?.error), /secret-token/)
    } finally {
      await flint.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
