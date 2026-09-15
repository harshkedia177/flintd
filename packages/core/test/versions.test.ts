import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { CallMeta, Flint, JsonValue } from "../src/index.ts"
import { creation, refusal } from "./support.ts"

const git = promisify(execFile)

const LETTER_COUNT = {
  execute_source: "return { count: args.text.length }",
  examples: [{ args: { text: "one two three" }, expected: { count: 13 } }],
}

const WIDER_SCHEMA = JSON.stringify({
  type: "object",
  properties: { text: { type: "string" }, trim: { type: "boolean" } },
  required: ["text"],
  additionalProperties: false,
})

const NUMBER_SCHEMA = JSON.stringify({
  type: "object",
  properties: { text: { type: "number" } },
  required: ["text"],
  additionalProperties: false,
})

interface Version {
  id: string
  operation: string
  channel: string
  timestamp: string
  description: string
  message: string
  source?: string
}

let flint: Flint
let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "flintd-"))
  flint = createFlint({ dir })
  await flint.start()
})

after(async () => {
  await flint.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function subjects(name: string): Promise<string[]> {
  const log = await git("git", ["log", "--format=%s", "--", `tools/${name}`], { cwd: dir })
  return log.stdout.trim().split("\n")
}

async function provenance(name: string): Promise<Record<string, string | null>> {
  const text = await readFile(join(dir, "tools", name, "tool.json"), "utf8")
  return (JSON.parse(text) as { provenance: Record<string, string | null> }).provenance
}

async function history(args: JsonValue): Promise<{ name: string; versions: Version[] }> {
  return (await flint.call("tool_history", args)) as unknown as { name: string; versions: Version[] }
}

test("tool_update changes the description and writes one new Version on the agent channel", async () => {
  const name = "described"
  const created = (await flint.call("tool_create", creation({ name }))) as { version: string }
  const updated = (await flint.call("tool_update", {
    name,
    description: "Count the words in a piece of prose.",
  })) as { version: string; state: string }

  assert.notEqual(updated.version, created.version)
  assert.equal(updated.state, "draft")
  assert.deepEqual(await subjects(name), [`update(${name}): agent`, `create(${name}): agent`])
  const read = (await flint.call("tool_read", { name })) as { description: string }
  assert.equal(read.description, "Count the words in a piece of prose.")
  assert.deepEqual(await flint.call(name, { text: "one two" }), { count: 2 })
})

test("tool_update replaces the argument schema, the Body and the Examples together", async () => {
  const name = "rewritten"
  await flint.call("tool_create", creation({ name }))
  await flint.call("tool_update", { name, ...LETTER_COUNT, parameters_json: WIDER_SCHEMA })
  assert.deepEqual(await flint.call(name, { text: "one two three", trim: true }), { count: 13 })

  const read = (await flint.call("tool_read", { name, include_examples: true })) as {
    parameters: { properties: Record<string, JsonValue> }
    examples: JsonValue[]
  }
  assert.deepEqual(Object.keys(read.parameters.properties), ["text", "trim"])
  assert.deepEqual(read.examples, [{ args: { text: "one two three" }, expected: { count: 13 }, grade: "exact" }])

  await flint.call("tool_update", {
    name,
    examples: [...LETTER_COUNT.examples, { args: { text: "ab" }, expected: { count: 2 } }],
  })
  const again = (await flint.call("tool_read", { name, include_examples: true })) as { examples: JsonValue[] }
  assert.equal(again.examples.length, 2)
  assert.equal((await subjects(name)).length, 3)
})

test("a tool_update whose Examples fail saves nothing and leaves the Tool as it was", async () => {
  const name = "unchanged_by_failure"
  await flint.call("tool_create", creation({ name }))

  const body = await refusal(() => flint.call("tool_update", { name, execute_source: LETTER_COUNT.execute_source }))
  assert.equal(body.code, "example_failed")
  assert.deepEqual(body.details["actual"], { count: 13 })

  const schema = await refusal(() => flint.call("tool_update", { name, parameters_json: NUMBER_SCHEMA }))
  assert.equal(schema.code, "invalid_examples")

  assert.deepEqual(await flint.call(name, { text: "one two three" }), { count: 3 })
  assert.deepEqual(await subjects(name), [`create(${name}): agent`])
})

test("a tool_update that changes nothing is refused, because every write is a Version", async () => {
  const name = "no_change"
  await flint.call("tool_create", creation({ name }))
  const error = await refusal(() =>
    flint.call("tool_update", { name, description: "Count the words in a piece of text." }),
  )
  assert.equal(error.code, "invalid_arguments")
  assert.match(error.message, /already matches/)
  assert.deepEqual(await subjects(name), [`create(${name}): agent`])
})

test("tool_read, tool_update, tool_retire and tool_history refuse an unknown name and a meta tool name", async () => {
  for (const tool of ["tool_read", "tool_update", "tool_retire", "tool_history"]) {
    for (const name of ["no_such_tool", "tool_run"]) {
      const error = await refusal(() => flint.call(tool, { name }))
      assert.equal(error.code, "not_found", `${tool} on ${name}`)
    }
  }
  const meta = await refusal(() => flint.call("tool_read", { name: "tool_create" }))
  assert.match(meta.message, /one of flintd's own meta tools/)
  assert.doesNotMatch(meta.message, /Write it with tool_create/)
})

test("tool_history lists the Versions newest first with the operation, the Channel and the description", async () => {
  const name = "listed"
  await flint.call("tool_create", creation({ name }))
  await flint.call("tool_update", { name, description: "Count the words in a piece of prose." })
  const listed = await history({ name })

  assert.equal(listed.name, name)
  assert.equal(listed.versions.length, 2)
  const [newest, oldest] = listed.versions as [Version, Version]
  assert.equal(newest.operation, "update")
  assert.equal(newest.channel, "agent")
  assert.equal(newest.description, "Count the words in a piece of prose.")
  assert.equal(newest.message, `update(${name}): agent`)
  assert.ok(Date.parse(newest.timestamp) >= Date.parse(oldest.timestamp))
  assert.equal(oldest.operation, "create")
  assert.equal(oldest.description, "Count the words in a piece of text.")
  assert.equal(newest.source, undefined)

  const withSource = await history({ name, include_source: true })
  assert.match(String(withSource.versions[0]?.source), /split/)
  assert.match(String(withSource.versions[1]?.source), /split/)
})

test("tool_history pages with before and a limit, and refuses an id that is not a Version of the Tool", async () => {
  const name = "paged"
  await flint.call("tool_create", creation({ name }))
  await flint.call("tool_update", { name, description: "Count the words in a report." })
  await flint.call("tool_update", { name, description: "Count the words in a letter." })

  const first = await history({ name, limit: 2 })
  assert.equal(first.versions.length, 2)
  const next = await history({ name, before: (first.versions[1] as Version).id })
  assert.equal(next.versions.length, 1)
  assert.equal((next.versions[0] as Version).operation, "create")

  const error = await refusal(() => flint.call("tool_history", { name, before: "0123456789abcdef" }))
  assert.equal(error.code, "invalid_arguments")
  assert.match(error.message, /tool_history/)
})

test("a restore by Version id brings the old Body back as a new Version and the old id stays valid", async () => {
  const name = "restored"
  const created = (await flint.call("tool_create", creation({ name }))) as { version: string }
  await flint.call("tool_update", { name, ...LETTER_COUNT })
  assert.deepEqual(await flint.call(name, { text: "one two three" }), { count: 13 })

  const restored = (await flint.call("tool_update", {
    name,
    restore_version: created.version,
    description: "ignored while restoring",
  })) as { version: string; restored_from: string; state: string }

  assert.equal(restored.restored_from, created.version)
  assert.notEqual(restored.version, created.version)
  assert.equal(restored.state, "draft")
  assert.deepEqual(await flint.call(name, { text: "one two three" }), { count: 3 })
  const read = (await flint.call("tool_read", { name })) as { description: string }
  assert.equal(read.description, "Count the words in a piece of text.")
  assert.deepEqual(await subjects(name), [
    `restore(${name}): agent`,
    `update(${name}): agent`,
    `create(${name}): agent`,
  ])

  const listed = await history({ name })
  assert.equal(listed.versions.length, 3)
  assert.ok(listed.versions.some((version) => version.id === created.version))
})

test("a restore refuses an id that belongs to another Tool and an id that is not a commit", async () => {
  const other = (await flint.call("tool_create", creation({ name: "other_history" }))) as { version: string }
  const name = "picky_restore"
  await flint.call("tool_create", creation({ name }))
  for (const restore_version of [other.version, "0123456789abcdef", "not-a-hash"]) {
    const error = await refusal(() => flint.call("tool_update", { name, restore_version }))
    assert.equal(error.code, "invalid_arguments")
  }
})

test("every Version records the Channel, the session, the harness, the model and a capped excerpt", async () => {
  const name = "provenanced"
  await flint.call("tool_create", creation({ name }), {
    sessionId: "s-1",
    harness: "claude-code",
    model: "a-model",
    excerpt: "why the Tool exists",
  })
  const first = await provenance(name)
  assert.deepEqual(first, {
    channel: "agent",
    session: "s-1",
    harness: "claude-code",
    model: "a-model",
    excerpt: "why the Tool exists",
    createdAt: first["createdAt"] as string,
  })

  await flint.call(
    "tool_update",
    { name, description: "Count the words in a piece of prose." },
    { excerpt: "€".repeat(2000) },
  )
  const second = await provenance(name)
  assert.equal(second["channel"], "agent")
  assert.equal(second["session"], null)
  const bytes = Buffer.byteLength(String(second["excerpt"]), "utf8")
  assert.ok(bytes <= 4096 && bytes > 4092, String(bytes))
  assert.ok(!String(second["excerpt"]).includes("�"))
  assert.equal((await subjects(name))[0], `update(${name}): agent`)
})

test("a caller may not choose the Channel of the Version it writes", async () => {
  const refused = await refusal(() =>
    flint.call("tool_create", creation({ name: "forged_channel" }), { channel: "observer" } as CallMeta),
  )
  assert.equal(refused.code, "invalid_arguments")
  assert.match(refused.message, /a caller does not choose the Channel/)
  assert.equal((await flint.library()).find((one) => one.name === "forged_channel"), undefined)
})

test("an excerpt that ends in a replacement character keeps it when the cut falls elsewhere", async () => {
  const name = "kept_character"
  await flint.call("tool_create", creation({ name }), { excerpt: `short �` })
  assert.equal((await provenance(name))["excerpt"], "short �")
})
