import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { JsonValue } from "../src/index.ts"
import { creation, temporaryLibrary } from "./support.ts"

const run = promisify(execFile)

async function bareRepository(): Promise<string> {
  const dir = await temporaryLibrary()
  await run("git", ["init", "--bare", "-b", "main", dir])
  return dir
}

async function started(dir: string, remote: string, activeCap?: number): Promise<ReturnType<typeof createFlint>> {
  const flint = createFlint({ userDir: dir, userRemote: remote, ...(activeCap === undefined ? {} : { activeCap }) })
  await flint.start()
  return flint
}

async function pushed(origin: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const found = await run("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: origin }).then(
      () => true,
      () => false,
    )
    if (found) return
    await new Promise((wake) => setTimeout(wake, 5))
  }
  throw new Error("the Library never pushed a first Version")
}

const PASSED = { status: "passed", examples: [], grades: { exact: 0, assertion: 0 }, failures: [], reason: null }

// A Version is a file a colleague wrote, so the state it declares is a claim. The evidence travels in git beside
// it: the held-out record and the counts. Nothing else is trusted, whatever tool.json says.
async function declare(
  dir: string,
  name: string,
  state: string,
  heldOut: unknown,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const path = join(dir, "tools", name, "tool.json")
  const tool = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  await writeFile(path, `${JSON.stringify({ ...tool, ...extra, state }, null, 2)}\n`)
  if (heldOut !== null) {
    await writeFile(join(dir, "tools", name, "held-out.json"), `${JSON.stringify(heldOut, null, 2)}\n`)
  }
}

async function commitAndPush(dir: string, subject: string): Promise<void> {
  await run("git", ["add", "-A"], { cwd: dir })
  await run("git", ["commit", "-m", subject], { cwd: dir })
  await run("git", ["push", "origin", "main"], { cwd: dir })
}

function stateOf(entries: { name: string; state: string; downgraded: string | null }[], name: string): {
  state: string
  downgraded: string | null
} {
  const found = entries.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`the Library holds no Tool named ${name}`)
  return { state: found.state, downgraded: found.downgraded }
}

test("a Version another Library pushed keeps Verified and Active only on evidence this one can read", async () => {
  const origin = await bareRepository()
  const theirs = await temporaryLibrary()
  const mine = await temporaryLibrary()
  const first = await started(theirs, origin)
  await first.call("tool_create", creation())
  await first.call("tool_create", creation({ name: "second_tool" }))
  await pushed(origin)
  await first.stop()

  // The colleague commits "active" with no calls behind it, and "verified" with no Held-out record at all.
  await declare(theirs, "word_count", "active", PASSED)
  await declare(theirs, "second_tool", "verified", null)
  await run("git", ["add", "-A"], { cwd: theirs })
  await run("git", ["commit", "-m", "update(word_count): agent"], { cwd: theirs })
  await run("git", ["push", "origin", "main"], { cwd: theirs })

  const second = await started(mine, origin)
  try {
    const entries = new Map((await second.library()).map((entry) => [entry.name, entry]))
    assert.equal(entries.get("word_count")?.state, "verified")
    assert.match(String(entries.get("word_count")?.downgraded), /this Library holds no evidence of it/)
    assert.equal(entries.get("second_tool")?.state, "draft")
    assert.match(String(entries.get("second_tool")?.downgraded), /no held-out.json/)
    // The claim never reaches the model-facing list, which is what the forgery was worth taking.
    assert.deepEqual((await second.tools()).filter((tool) => tool.name === "word_count"), [])
    const read = (await second.call("tool_read", { name: "word_count" })) as Record<string, JsonValue>
    assert.equal(read["state"], "verified")
    assert.match(String(read["downgraded"]), /this Library holds no evidence of it/)
    // The Tool still runs: the downgrade is about the prompt slot, never about the Body.
    assert.deepEqual(await second.call("word_count", { text: "one two" }), { count: 2 })
  } finally {
    await second.stop()
    for (const path of [origin, mine, theirs]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

// The scan writes the request itself, so the row it wrote must never be the evidence the next scan reads back.
test("a pulled Version that declares Active with a Manifest nobody granted stays Verified, scan after scan", async () => {
  const origin = await bareRepository()
  const theirs = await temporaryLibrary()
  const mine = await temporaryLibrary()
  const first = await started(theirs, origin)
  await first.call("tool_create", creation())
  await pushed(origin)
  await first.stop()

  await declare(theirs, "word_count", "active", PASSED, { manifest: { fs: "workspace" } })
  await commitAndPush(theirs, "update(word_count): agent")

  const second = await started(mine, origin)
  try {
    assert.equal(stateOf(await second.library(), "word_count").state, "verified")
    const waiting = (await second.approvals())[0]
    assert.equal(waiting?.status, "pending")
    await second.deny(waiting?.id ?? "", "not on this machine")
  } finally {
    await second.stop()
  }

  // A second commit changes the tree hash, so this Library gates the Tool again with a row of its own already there.
  await declare(theirs, "word_count", "active", PASSED, {
    manifest: { fs: "workspace" },
    description: "Count the words in a piece of text, exactly.",
  })
  await commitAndPush(theirs, "update(word_count): agent")

  const third = await started(mine, origin)
  try {
    const found = stateOf(await third.library(), "word_count")
    assert.equal(found.state, "verified")
    assert.match(String(found.downgraded), /this Library holds no evidence of it/)
    assert.equal((await third.approvals())[0]?.status, "denied")
  } finally {
    await third.stop()
    for (const path of [origin, mine, theirs]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test("a description-only update of a downgraded Version keeps the state this Library indexed", async () => {
  const origin = await bareRepository()
  const theirs = await temporaryLibrary()
  const mine = await temporaryLibrary()
  const first = await started(theirs, origin)
  await first.call("tool_create", creation())
  await first.call("tool_create", creation({ name: "second_tool" }))
  await pushed(origin)
  await first.stop()

  for (const name of ["word_count", "second_tool"]) await declare(theirs, name, "active", PASSED)
  await commitAndPush(theirs, "update(word_count): agent")

  // One Active Tool is all this cap allows, so two Tools that talked their way back to Active would break it.
  const second = await started(mine, origin, 1)
  try {
    assert.equal((await second.status()).active, 0)
    for (const name of ["word_count", "second_tool"]) {
      await second.call("tool_update", { name, description: `Count the words of a piece of text for ${name}.` })
    }
    for (const name of ["word_count", "second_tool"]) {
      const found = stateOf(await second.library(), name)
      assert.equal(found.state, "verified")
      assert.match(String(found.downgraded), /this Library holds no evidence of it/)
    }
    assert.equal((await second.status()).active, 0)
    const held = JSON.parse(await readFile(join(mine, "tools", "word_count", "tool.json"), "utf8")) as { state: string }
    assert.equal(held.state, "verified")
  } finally {
    await second.stop()
    for (const path of [origin, mine, theirs]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
