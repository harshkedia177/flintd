import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { Flint, JsonValue, LibraryEntry } from "../src/index.ts"
import { creation, refusal, sharedLibraries, temporaryLibrary, withFlint, withLibraries } from "./support.ts"

const git = promisify(execFile)

const SLOW_SUM = {
  name: "slow_sum",
  description: "Add every whole number below the count.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
    additionalProperties: false,
  }),
  execute_source: "let total = 0\nfor (let index = 0; index < args.count; index += 1) total += index\nreturn { total }",
  examples: [{ args: { count: 300000 }, expected: { total: 44999850000 } }],
}

interface Version {
  id: string
  operation: string
  channel: string
  timestamp: string
  description: string
  message: string
  source?: string
}

async function subjects(dir: string): Promise<string[]> {
  const log = await git("git", ["log", "--format=%s"], { cwd: dir })
  return log.stdout.trim().split("\n")
}

async function provenance(dir: string, name: string): Promise<Record<string, string | null>> {
  const text = await readFile(join(dir, "tools", name, "tool.json"), "utf8")
  return (JSON.parse(text) as { provenance: Record<string, string | null> }).provenance
}

async function history(flint: { call: (name: string, args: JsonValue) => Promise<JsonValue> }, args: JsonValue) {
  return (await flint.call("tool_history", args)) as unknown as { name: string; versions: Version[] }
}

test("the index is rebuilt from the repository alone, Versions, Retired state and all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.call("tool_create", creation())
    await first.call("tool_update", { name: "word_count", description: "Count the words in a piece of prose." })
    await first.call("tool_create", creation({ name: "other_tool" }))
    await first.call("tool_retire", { name: "other_tool" })
    const before = await history(first, { name: "word_count" })
    await first.stop()

    await rm(join(dir, "index.sqlite"), { force: true })
    const second = createFlint({ dir, containerEngine: "none" })
    await second.start()
    try {
      assert.deepEqual((await second.status()), {
        running: true,
        dir,
        tools: 1,
        retired: 1,
        active: 0,
        activeCap: 50,
        invalid: [],
        review: [],
        model: { configured: false },
        tiers: { container: { available: false, engine: "none", version: null } },
        observer: { running: false, lastRunAt: null, candidates: 0, drafts: 0, refusals: 0, retirements: 0 },
        libraries: [{ library: "user", dir, tools: 1, retired: 1, remote: null, error: null }],
      })
      const read = (await second.call("tool_read", { name: "word_count" })) as { description: string }
      assert.equal(read.description, "Count the words in a piece of prose.")
      assert.equal((await refusal(() => second.call("other_tool", { text: "x" }))).code, "not_found")
      assert.deepEqual(await history(second, { name: "word_count" }), before)
      const dirty = await git("git", ["status", "--porcelain"], { cwd: dir })
      assert.equal(dirty.stdout.trim(), "")
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("an index that will not open is moved aside, not deleted, and status names the move", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir, containerEngine: "none" })
    await first.start()
    await first.call("tool_create", creation())
    await first.stop()

    const garbage = Buffer.from("not a sqlite database, only plain bytes")
    await writeFile(join(dir, "index.sqlite"), garbage)

    const second = createFlint({ dir, containerEngine: "none" })
    await second.start()
    try {
      const broken = (await readdir(dir)).find((name) => name.startsWith("index.sqlite.broken-"))
      assert.ok(broken !== undefined, "no index.sqlite.broken-* file was left behind")
      assert.deepEqual(await readFile(join(dir, broken as string)), garbage)
      assert.equal((await second.status()).libraries[0]?.movedIndex, join(dir, broken as string))

      // Rebuilt from the repository, and open for both reads and writes.
      assert.deepEqual(await second.call("word_count", { text: "one two" }), { count: 2 })
      await second.call("tool_create", creation({ name: "other_tool" }))
      assert.equal((await second.status()).tools, 2)
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("an Approval survives a broken index: the approved Tool answers with no new decision, and a denial holds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const manifest = JSON.stringify({ fs: "workspace" })
    const first = createFlint({ dir, containerEngine: "none" })
    await first.start()
    await first.call("tool_create", creation({ manifest_json: manifest }))
    await first.call("tool_create", creation({ name: "other_tool", manifest_json: manifest }))
    await first.call("tool_create", creation({ name: "gone_tool", manifest_json: manifest }))
    const before = await first.approvals()
    const approvedId = before.find((one) => one.tool === "word_count")?.id ?? ""
    const deniedId = before.find((one) => one.tool === "other_tool")?.id ?? ""
    await first.approve(approvedId)
    await first.approve(before.find((one) => one.tool === "gone_tool")?.id ?? "")
    await first.deny(deniedId, "not needed here")
    await first.stop()

    // The decision log outlives the directory, and a Tool that is gone declares nothing for it to be live for.
    await rm(join(dir, "tools", "gone_tool"), { recursive: true, force: true })

    await writeFile(join(dir, "index.sqlite"), "not a sqlite database")

    const second = createFlint({ dir, containerEngine: "none" })
    await second.start()
    try {
      const after = await second.approvals()
      assert.deepEqual(after.map((one) => one.tool).sort(), ["other_tool", "word_count"])
      assert.equal(after.find((one) => one.tool === "word_count")?.id, approvedId)
      assert.equal(after.find((one) => one.tool === "word_count")?.status, "approved")
      assert.equal(after.find((one) => one.tool === "other_tool")?.status, "denied")

      assert.deepEqual(await second.call("word_count", { text: "one two" }), { count: 2 })
      const refused = await refusal(() => second.call("other_tool", { text: "one two" }))
      assert.match(refused.message, /It was denied: not needed here/)
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("start drops an index row whose Tool directory is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.call("tool_create", creation())
    await first.call("tool_create", creation({ name: "other_tool" }))
    await first.stop()
    await rm(join(dir, "tools", "other_tool"), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

    const second = createFlint({ dir })
    await second.start()
    try {
      assert.equal((await second.status()).tools, 1)
      assert.equal((await refusal(() => second.call("tool_read", { name: "other_tool" }))).code, "not_found")
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("a Tool directory edited by hand is re-gated and committed on the file Channel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.call("tool_create", creation())
    await first.stop()

    const directory = join(dir, "tools", "word_count")
    await writeFile(
      join(directory, "body.js"),
      "export async function execute(args, ctx) {\nreturn { count: args.text.length }\n}\n",
    )
    await writeFile(
      join(directory, "examples.json"),
      JSON.stringify([{ args: { text: "one two three" }, expected: { count: 13 }, grade: "exact" }]),
    )

    const second = createFlint({ dir })
    await second.start()
    try {
      assert.deepEqual((await second.status()).invalid, [])
      assert.equal((await second.status()).tools, 1)
      assert.deepEqual(await second.call("word_count", { text: "one two three" }), { count: 13 })
      assert.deepEqual(await subjects(dir), ["update(word_count): file", "create(word_count): agent"])
      assert.equal((await provenance(dir, "word_count"))["channel"], "file")
      const dirty = await git("git", ["status", "--porcelain"], { cwd: dir })
      assert.equal(dirty.stdout.trim(), "")
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("a Tool directory dropped into the Library enters through the file Channel as a create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.stop()

    const directory = join(dir, "tools", "greet")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "tool.json"),
      JSON.stringify({
        name: "greet",
        description: "Greet a person by name.",
        state: "active",
        parameters: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
      }),
    )
    await writeFile(
      join(directory, "body.js"),
      "export async function execute(args, ctx) {\nreturn `hello ${args.who}`\n}\n",
    )
    await writeFile(join(directory, "examples.json"), JSON.stringify([{ args: { who: "Ada" }, expected: "hello Ada" }]))

    const second = createFlint({ dir })
    await second.start()
    try {
      assert.equal((await second.status()).tools, 1)
      assert.equal(await second.call("greet", { who: "Ada" }), "hello Ada")
      assert.equal(((await second.call("tool_read", { name: "greet" })) as { state: string }).state, "draft")
      assert.deepEqual(await subjects(dir), ["create(greet): file"])
      await access(join(directory, "stats.json"))
      const listed = await history(second, { name: "greet" })
      assert.equal((listed.versions[0] as Version).channel, "file")
      assert.equal((listed.versions[0] as Version).operation, "create")
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("a Tool that fails the gate is not callable, stays readable, and comes back with a restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    const created = (await first.call("tool_create", creation())) as { version: string }
    await first.stop()

    await writeFile(
      join(dir, "tools", "word_count", "body.js"),
      "export async function execute(args, ctx) {\nreturn { count: 0 }\n}\n",
    )
    await rm(join(dir, "index.sqlite"), { force: true })

    const second = createFlint({ dir })
    await second.start()
    try {
      assert.equal((await second.status()).invalid.length, 1)
      assert.equal((await second.status()).invalid[0]?.name, "word_count")
      assert.equal((await second.status()).invalid[0]?.code, "example_failed")
      assert.equal((await second.status()).tools, 0)

      const call = await refusal(() => second.call("word_count", { text: "one two" }))
      assert.equal(call.code, "example_failed")
      assert.match(call.message, /tool_history/)
      assert.deepEqual(await subjects(dir), ["create(word_count): agent"])

      const read = (await second.call("tool_read", { name: "word_count" })) as {
        description: string
        problem: string
      }
      assert.equal(read.description, "Count the words in a piece of text.")
      assert.match(read.problem, /Example 0 expected \S+ and the Body returned \S+/)
      const listed = await history(second, { name: "word_count" })
      assert.equal(listed.versions.length, 1)

      await second.call("tool_update", { name: "word_count", restore_version: created.version })
      assert.deepEqual((await second.status()).invalid, [])
      assert.equal((await second.status()).tools, 1)
      assert.deepEqual(await second.call("word_count", { text: "one two" }), { count: 2 })
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("start runs the Examples of a Tool that changed and of no other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.call("tool_create", SLOW_SUM)
    await first.stop()

    const second = createFlint({ dir, callTimeoutMs: 1 })
    await second.start()
    assert.deepEqual((await second.status()).invalid, [])
    assert.equal((await second.status()).tools, 1)
    await second.stop()

    await writeFile(
      join(dir, "tools", "slow_sum", "body.js"),
      "export async function execute(args, ctx) {\nlet total = 0\nfor (let index = 0; index < args.count; index += 1) total += index * 1\nreturn { total }\n}\n",
    )
    await git("git", ["add", "--", "tools/slow_sum"], { cwd: dir })
    await git("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "update(slow_sum): file"], { cwd: dir })

    const third = createFlint({ dir, callTimeoutMs: 1 })
    await third.start()
    try {
      assert.equal((await third.status()).invalid[0]?.name, "slow_sum")
      assert.equal((await third.status()).invalid[0]?.code, "example_failed")
      assert.match(String((await third.status()).invalid[0]?.message), /longer than 1 ms|timed out|time/)
    } finally {
      await third.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("a malformed stats.json stops the file Channel and names the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.call("tool_create", creation())
    await first.stop()
    await writeFile(
      join(dir, "tools", "word_count", "stats.json"),
      JSON.stringify({ calls: "many", errors: 0, lastCallAt: null }),
    )

    const second = createFlint({ dir })
    await second.start()
    try {
      assert.equal((await second.status()).invalid[0]?.code, "store_error")
      assert.match(String((await second.status()).invalid[0]?.message), /stats\.json/)
      assert.deepEqual(await subjects(dir), ["create(word_count): agent"])
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("tool_history says what it could not read instead of reporting an empty Version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.call("tool_create", creation())
    await first.stop()

    const body = join(dir, "tools", "word_count", "body.js")
    const definition = join(dir, "tools", "word_count", "tool.json")
    const tool = JSON.parse(await readFile(definition, "utf8")) as { description: unknown }
    const described = tool.description
    await writeFile(definition, JSON.stringify({ ...tool, description: 42 }))
    await writeFile(body, "export async function execute(args, ctx) {\nreturn {\n}\n")
    await git("git", ["add", "--", "tools/word_count"], { cwd: dir })
    await git("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "by hand"], { cwd: dir })
    await writeFile(definition, JSON.stringify({ ...tool, description: described }))
    await writeFile(body, "export async function execute(args, ctx) {\nconst words = args.text.split(/\\s+/)\nreturn { count: words.length }\n}\n")

    const second = createFlint({ dir })
    await second.start()
    try {
      assert.deepEqual((await second.status()).invalid, [])
      const listed = await history(second, { name: "word_count", include_source: true })
      assert.equal(listed.versions.length, 3)
      const middle = listed.versions[1] as Version & { problem?: string }
      assert.equal(middle.message, "by hand")
      assert.equal(middle.operation, null)
      assert.equal(middle.source, null)
      assert.equal(middle.description, null)
      assert.match(String(middle.problem), /does not parse/)
      assert.match(String((listed.versions[2] as Version).source), /split/)
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("a file with a non-ASCII name in a Tool directory still marks it changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  try {
    const first = createFlint({ dir })
    await first.start()
    await first.call("tool_create", creation())
    await first.stop()
    await writeFile(join(dir, "tools", "word_count", "noté.txt"), "left by a person")

    const second = createFlint({ dir })
    await second.start()
    try {
      assert.deepEqual((await second.status()).invalid, [])
      assert.deepEqual(await subjects(dir), ["update(word_count): file", "create(word_count): agent"])
      const dirty = await git("git", ["status", "--porcelain"], { cwd: dir })
      assert.equal(dirty.stdout.trim(), "")
    } finally {
      await second.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

const CHARACTERS = {
  execute_source: "return { count: args.text.length }",
  examples: [{ args: { text: "one two three" }, expected: { count: 13 } }],
}

async function fill(flint: Flint): Promise<void> {
  await flint.call("tool_create", creation(), { library: "project" })
  await flint.call("tool_create", creation(CHARACTERS), { library: "user" })
  await flint.call("tool_create", creation({ name: "only_user", description: "Count the letters of a text." }), {
    library: "user",
  })
}

const ready = sharedLibraries(fill)

test("the project Tool wins a name collision for a call, for tool_run and for tool_read", async () => {
  await ready(async (flint) => {
    assert.deepEqual(await flint.call("word_count", { text: "one two three" }), { count: 3 })
    assert.deepEqual(await flint.call("tool_run", { name: "word_count", args: { text: "one two three" } }), {
      count: 3,
    })
    const read = (await flint.call("tool_read", { name: "word_count" })) as Record<string, JsonValue>
    assert.equal(read["library"], "project")
    assert.deepEqual(read["shadows"], { library: "user", description: "Count the words in a piece of text." })
    assert.equal(read["shadowed_by"], undefined)
  })
})

test("a call names the user Library to reach the Tool the project Library shadows", async () => {
  await ready(async (flint) => {
    assert.deepEqual(await flint.call("word_count", { text: "one two three" }, { library: "user" }), { count: 13 })
    const read = (await flint.call("tool_read", { name: "word_count" }, { library: "user" })) as Record<
      string,
      JsonValue
    >
    assert.equal(read["library"], "user")
    assert.deepEqual(read["shadowed_by"], { library: "project", description: "Count the words in a piece of text." })
    assert.equal(read["shadows"], undefined)
  })
})

test("library() and status() hold the union of both Libraries, counting a shadowed name once", async () => {
  await ready(async (flint) => {
    assert.deepEqual(
      (await flint.library()).map((entry: LibraryEntry) => [entry.name, entry.library, entry.needs_review]),
      [
        ["only_user", "user", false],
        ["word_count", "project", false],
      ],
    )
    const status = (await flint.status())
    assert.equal(status.tools, 2)
    assert.equal(status.retired, 0)
    assert.deepEqual(
      status.libraries.map((library) => [library.library, library.tools]),
      [
        ["project", 1],
        ["user", 2],
      ],
    )
  })
})

test("a call that names a Library this flintd does not hold says so, and an unknown name is refused", async () => {
  await ready(async (flint) => {
    const wrong = await refusal(() => flint.call("word_count", { text: "a" }, { library: "nowhere" as "user" }))
    assert.equal(wrong.code, "invalid_arguments")
    assert.match(wrong.message, /"user" or "project"/)
  })
  await withFlint(async (flint) => {
    const alone = await refusal(() => flint.call("tool_read", { name: "word_count" }, { library: "project" }))
    assert.equal(alone.code, "not_found")
    assert.match(alone.message, /no project Library/)
  })
})

test("tool_create writes to the project Library, and a create in the user Library warns that it is shadowed", async () => {
  await withLibraries(async (flint) => {
    const first = (await flint.call("tool_create", creation())) as Record<string, JsonValue>
    assert.equal(first["library"], "project")
    assert.equal(first["warning"], undefined)

    const second = (await flint.call("tool_create", creation(CHARACTERS), { library: "user" })) as Record<
      string,
      JsonValue
    >
    assert.equal(second["library"], "user")
    assert.match(String(second["warning"]), /project Library also holds a Tool named "word_count"/)
    assert.deepEqual(await flint.call("word_count", { text: "one two three" }), { count: 3 })
  })
})

test("tool_update and tool_retire act on the Tool that wins unless the call names the other Library", async () => {
  await withLibraries(async (flint) => {
    await flint.call("tool_create", creation(), { library: "project" })
    await flint.call("tool_create", creation(CHARACTERS), { library: "user" })
    await flint.call("tool_update", { name: "word_count", description: "Count the words of a project text." })
    assert.equal(
      ((await flint.call("tool_read", { name: "word_count" })) as { description: string }).description,
      "Count the words of a project text.",
    )
    assert.equal(
      ((await flint.call("tool_read", { name: "word_count" }, { library: "user" })) as { description: string })
        .description,
      "Count the words in a piece of text.",
    )

    const retired = (await flint.call("tool_retire", { name: "word_count" }, { library: "user" })) as Record<
      string,
      JsonValue
    >
    assert.equal(retired["library"], "user")
    assert.deepEqual(await flint.call("word_count", { text: "one two three" }), { count: 3 })
    assert.equal((await flint.status()).tools, 1)

    await flint.call("tool_retire", { name: "word_count" })
    const gone = await refusal(() => flint.call("word_count", { text: "one" }))
    assert.equal(gone.code, "not_found")
    assert.match(gone.message, /user Library holds a Tool named "word_count" as well; reach it with meta\.library "user"/)
  })
})

test("createFlint refuses one directory for both Libraries", async () => {
  const dir = await temporaryLibrary()
  assert.throws(() => createFlint({ userDir: dir, projectDir: dir }), /one directory/)
  assert.throws(() => createFlint({ dir, userDir: dir }), /not both/)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
