import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { Flint, JsonValue } from "../src/index.ts"
import { creation, refusal, withFlint } from "./support.ts"

const git = promisify(execFile)

const LETTER_COUNT = {
  execute_source: "return { count: args.text.length }",
  examples: [{ args: { text: "one two three" }, expected: { count: 13 } }],
}

const BROKEN_BODY = "export async function execute(args, ctx) {\nreturn { count: 0 }\n}\n"

async function subjects(dir: string): Promise<string[]> {
  const log = await git("git", ["log", "--format=%s"], { cwd: dir })
  return log.stdout.trim().split("\n")
}

async function library(): Promise<[Flint, string]> {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  const flint = createFlint({ dir })
  await flint.start()
  return [flint, dir]
}

test("tool_retire keeps the directory, takes the Tool out of use and hands back the id that undoes it", async () => {
  await withFlint(async (flint, dir) => {
    await flint.call("tool_create", creation())
    const retired = (await flint.call("tool_retire", { name: "word_count" })) as {
      state: string
      version: string
      restore_version: string
    }

    assert.equal(retired.state, "retired")
    assert.deepEqual((await readdir(join(dir, "tools", "word_count"))).sort(), [
      "body.js",
      "examples.json",
      "stats.json",
      "tool.json",
    ])
    assert.deepEqual(await subjects(dir), ["retire(word_count): agent", "create(word_count): agent"])
    assert.equal((await flint.status()).tools, 0)
    assert.equal((await flint.status()).retired, 1)

    const call = await refusal(() => flint.call("word_count", { text: "one two" }))
    assert.equal(call.code, "not_found")
    assert.match(call.message, /Retired/)
    assert.match(call.message, /restore_version/)
    const run = await refusal(() => flint.call("tool_run", { name: "word_count", args: { text: "one two" } }))
    assert.equal(run.code, "not_found")

    const read = (await flint.call("tool_read", { name: "word_count" })) as { state: string }
    assert.equal(read.state, "retired")
    assert.equal((await refusal(() => flint.call("tool_retire", { name: "word_count" }))).code, "invalid_arguments")
    const change = await refusal(() => flint.call("tool_update", { name: "word_count", description: "A new line." }))
    assert.equal(change.code, "not_found")
    assert.match(change.message, /Retired/)

    const back = (await flint.call("tool_update", {
      name: "word_count",
      restore_version: retired.restore_version,
    })) as { state: string }
    assert.equal(back.state, "draft")
    assert.equal((await flint.status()).tools, 1)
    assert.equal((await flint.status()).retired, 0)
    assert.deepEqual(await flint.call("word_count", { text: "one two" }), { count: 2 })
  })
})

test("a commit that fails during an update restores the Tool that was there before", async () => {
  await withFlint(async (flint, dir) => {
    await flint.call("tool_create", creation())
    await writeFile(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })

    const error = await refusal(() => flint.call("tool_update", { name: "word_count", ...LETTER_COUNT }))
    assert.equal(error.code, "store_error")

    const dirty = await git("git", ["status", "--porcelain"], { cwd: dir })
    assert.equal(dirty.stdout.trim(), "")
    assert.deepEqual(await subjects(dir), ["create(word_count): agent"])
    assert.equal((await flint.status()).tools, 1)
    assert.deepEqual(await flint.call("word_count", { text: "one two three" }), { count: 3 })
    const read = (await flint.call("tool_read", { name: "word_count", include_examples: true })) as {
      examples: JsonValue[]
    }
    assert.deepEqual(read.examples, [{ args: { text: "one two three" }, expected: { count: 3 }, grade: "exact" }])
  })
})

test("an update the Library cannot stage puts the old Body back, and no later start commits the refused one", async () => {
  const [first, dir] = await library()
  try {
    await first.call("tool_create", creation())
    await writeFile(join(dir, ".git", "index.lock"), "")

    const error = await refusal(() => first.call("tool_update", { name: "word_count", ...LETTER_COUNT }))
    assert.equal(error.code, "store_error")
    assert.deepEqual(await first.call("word_count", { text: "one two three" }), { count: 3 })
    await first.stop()

    await rm(join(dir, ".git", "index.lock"))
    const second = createFlint({ dir })
    await second.start()
    try {
      assert.deepEqual((await second.status()).invalid, [])
      assert.deepEqual(await second.call("word_count", { text: "one two three" }), { count: 3 })
      assert.deepEqual(await subjects(dir), ["create(word_count): agent"])
      const dirty = await git("git", ["status", "--porcelain", "--", "tools"], { cwd: dir })
      assert.equal(dirty.stdout.trim(), "")
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("an update that cannot be put back says the refused change is still on disk", async () => {
  const [flint, dir] = await library()
  const body = join(dir, "tools", "word_count", "body.js")
  try {
    await flint.call("tool_create", creation())
    await writeFile(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nchmod 444 tools/word_count/body.js\nexit 1\n", {
      mode: 0o755,
    })

    const error = await refusal(() => flint.call("tool_update", { name: "word_count", ...LETTER_COUNT }))
    assert.equal(error.code, "store_error")
    assert.match(error.message, /could not undo/)
    assert.equal(error.details["name"], "word_count")
    assert.match(String(await readFile(body, "utf8")), /args\.text\.length/)
  } finally {
    await chmod(body, 0o644).catch(() => undefined)
    await flint.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("an update that changes only the description runs the gate when the directory holds a change of its own", async () => {
  await withFlint(async (flint, dir) => {
    await flint.call("tool_create", creation())
    await writeFile(join(dir, "tools", "word_count", "body.js"), BROKEN_BODY)

    const error = await refusal(() =>
      flint.call("tool_update", { name: "word_count", description: "Count the words in a piece of prose." }),
    )
    assert.equal(error.code, "example_failed")
    assert.deepEqual(await subjects(dir), ["create(word_count): agent"])
    const head = await git("git", ["show", "HEAD:tools/word_count/body.js"], { cwd: dir })
    assert.match(head.stdout, /split/)
  })
})

test("a retire runs the gate when the directory holds a change of its own", async () => {
  await withFlint(async (flint, dir) => {
    await flint.call("tool_create", creation())
    await writeFile(join(dir, "tools", "word_count", "body.js"), BROKEN_BODY)

    const error = await refusal(() => flint.call("tool_retire", { name: "word_count" }))
    assert.equal(error.code, "example_failed")
    assert.deepEqual(await subjects(dir), ["create(word_count): agent"])
    const read = (await flint.call("tool_read", { name: "word_count" })) as { state: string }
    assert.equal(read.state, "draft")
  })
})
