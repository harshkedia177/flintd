import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ToolDefinition } from "@flintd/core"
import { createFlint as connect } from "@flintd/sdk"
import { fakeModel } from "../../core/test/fake-model.ts"
import { exportSkills } from "../src/export.ts"
import { ask, creation, withDaemon } from "./support.ts"
import type { Running } from "./support.ts"

const BIN = new URL("../bin/flintd.ts", import.meta.url).pathname
const CASES = [{ args: { text: "one two" }, confident: false }]
const HANDMADE = "# my own notes\n"

test("the SKILL.md export writes the Library into a skills directory and keeps it there", async (t) => {
  const skills = await mkdtemp(join(tmpdir(), "flintd-skills-"))
  const wall = await mkdtemp(join(tmpdir(), "flintd-wall-"))
  const fresh = await mkdtemp(join(tmpdir(), "flintd-fresh-"))
  // A directory under a file can never be made, whatever the user is, so this export always fails to write.
  await writeFile(join(wall, "file"), "not a directory\n")
  const unwritable = join(wall, "file", "skills")
  t.after(async () => {
    for (const dir of [skills, wall, fresh]) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  await withDaemon(
    async (running) => {
      await t.test("the teaching skill is written once at start, marked as flintd's own", async () => {
        assert.match(await readFile(join(skills, "flintd", "SKILL.md"), "utf8"), /^---\nname: flintd\n/)
        assert.match(await readFile(join(skills, "flintd", ".flintd"), "utf8"), /flintd wrote this skill directory/)
      })

      await t.test("a directory that cannot be written is reported in status and never fatal", async () => {
        const held = exports(await status(running))
        assert.deepEqual(
          held.map((one) => one.dir),
          [skills, unwritable],
        )
        assert.equal(held[0]?.error, null)
        assert.equal(held[0]?.skills, 1)
        assert.match(String(held[1]?.error), /ENOTDIR|ENOENT/)
        assert.equal(running.logged.filter((one) => one.startsWith(`skill export ${unwritable}:`)).length, 1)
      })

      await mkdir(join(skills, "my-notes"), { recursive: true })
      await writeFile(join(skills, "my-notes", "SKILL.md"), HANDMADE)
      await mkdir(join(skills, "fl-handmade"), { recursive: true })
      await writeFile(join(skills, "fl-handmade", "SKILL.md"), HANDMADE)

      await create(running, "word_count", "Count the words in a piece of text.")
      await create(running, "title_slug", "Turn a title into a URL slug.")
      await verified(running, ["word_count", "title_slug"])
      await promote(running, "word_count")
      await promote(running, "title_slug")

      await t.test("a promotion regenerates the directory, one skill for each Active Tool", async () => {
        await until(() => holds(join(skills, "fl-word-count", "SKILL.md")), "fl-word-count was never written")
        await until(() => holds(join(skills, "fl-title-slug", "SKILL.md")), "fl-title-slug was never written")
        const written = await readFile(join(skills, "fl-word-count", "SKILL.md"), "utf8")
        assert.match(written, /^---\nname: fl-word-count\ndescription: "Count the words in a piece of text\."\n---\n/)
        assert.match(written, /\n- `text` \(string, required\)\n/)
        assert.match(written, /\nflintd call fl_word_count '\{"text":"one two three"\}'\n/)
        // The file lands before startExports updates status, so status is its own observable to await.
        await until(async () => exports(await status(running))[0]?.skills === 3, "status never counted 3 skills")
      })

      await t.test("a retired Tool loses its skill and a hand-written one beside it is untouched", async () => {
        assert.equal((await ask(running, "POST", "/api/v1/tools/word_count/retire", { body: {} })).status, 200)
        await until(async () => !(await holds(join(skills, "fl-word-count", "SKILL.md"))), "fl-word-count stayed")
        assert.ok(await holds(join(skills, "fl-title-slug", "SKILL.md")))
        assert.equal(await readFile(join(skills, "fl-handmade", "SKILL.md"), "utf8"), HANDMADE)
        assert.equal(await readFile(join(skills, "my-notes", "SKILL.md"), "utf8"), HANDMADE)
      })

      await t.test("--dry-run says what it would change and writes nothing", async () => {
        const dry = await cli(["export", "--to", fresh, "--dry-run", "--url", running.url, "--token", running.token])
        assert.equal(dry.code, 0, dry.err)
        assert.match(dry.out, /^written\t.*fl-title-slug$/m)
        assert.match(dry.out, /\n2 changes, 2 skills, nothing written\n$/)
        assert.deepEqual(await readdir(fresh), [])
      })

      await t.test("an export writes the set, refuses a skill it did not write, and repeats to nothing", async () => {
        const client = connect({ url: running.url, token: running.token })
        await mkdir(join(fresh, "flintd"), { recursive: true })
        await writeFile(join(fresh, "flintd", "SKILL.md"), HANDMADE)
        assert.deepEqual((await exportSkills(client, fresh)).changes, [
          { skill: "flintd", action: "refused" },
          { skill: "fl-title-slug", action: "written" },
        ])
        assert.equal(await readFile(join(fresh, "flintd", "SKILL.md"), "utf8"), HANDMADE)
        assert.deepEqual((await readdir(fresh)).sort(), ["fl-title-slug", "flintd"])
        // The bytes a Version renders to never move, so regenerating an unchanged Library writes nothing.
        assert.deepEqual((await exportSkills(client, fresh)).changes, [{ skill: "flintd", action: "refused" }])
      })
    },
    { model: fakeModel({ cases: CASES }), skillExports: [skills, unwritable] },
  )
})

async function create(running: Running, name: string, description: string): Promise<void> {
  const written = await ask(running, "POST", "/api/v1/call", {
    body: { name: "tool_create", args: creation({ name, description }) },
  })
  assert.equal(written.status, 200, JSON.stringify(written.body))
}

// Five clean calls across two sessions are what an Active Tool is made of, and only Active Tools are exported.
async function promote(running: Running, name: string): Promise<void> {
  for (let at = 0; at < 5; at += 1) {
    const ran = await ask(running, "POST", "/api/v1/call", {
      body: { name, args: { text: `call ${at}` }, meta: { sessionId: at < 4 ? "s-one" : "s-two" } },
    })
    assert.equal(ran.status, 200, JSON.stringify(ran.body))
  }
  const state = (await library(running)).find((one) => one.name === name)?.state
  assert.equal(state, "active", `${name} is ${String(state)}`)
}

async function library(running: Running): Promise<{ name: string; state: string }[]> {
  const answer = await ask(running, "GET", "/api/v1/library")
  return answer.body["library"] as unknown as { name: string; state: string }[]
}

async function status(running: Running): Promise<Record<string, unknown>> {
  return (await ask(running, "GET", "/api/v1/status")).body["status"] as unknown as Record<string, unknown>
}

function exports(held: Record<string, unknown>): { dir: string; skills: number; error: string | null }[] {
  return held["exports"] as { dir: string; skills: number; error: string | null }[]
}

async function verified(running: Running, names: string[]): Promise<void> {
  await until(async () => {
    const held = await library(running)
    return names.every((name) => held.find((one) => one.name === name)?.state === "verified")
  }, `the Held-out runs never verified ${names.join(", ")}`)
}

async function holds(path: string): Promise<boolean> {
  return readFile(path, "utf8").then(
    () => true,
    () => false,
  )
}

// The poll interval matches the test debounce (support.ts) so it never polls tighter than the product can settle.
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(what)
    await new Promise((wake) => setTimeout(wake, 20))
  }
}

function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, ...args])
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
    child.on("close", (code) => done({ code: code ?? 0, out, err }))
  })
}

test("an export takes nothing on trust from the daemon it reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-hostile-"))
  const outside = join(dir, "..", "b-feddf167")
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    await rm(outside, { recursive: true, force: true })
  })
  // Two skills flintd wrote on an earlier pass: one whose Tool now fails to read, one whose Tool is gone.
  for (const skill of ["fl-needs-args", "fl-gone-tool"]) {
    await mkdir(join(dir, skill), { recursive: true })
    await writeFile(join(dir, skill, "SKILL.md"), HANDMADE)
    await writeFile(join(dir, skill, ".flintd"), "flintd\n")
  }

  const daemon = await hostile()
  t.after(() => daemon.close())
  const client = connect({ url: daemon.url, token: "any" })
  const report = await exportSkills(client, dir)

  await t.test("a name off the wire that is not a Tool name reaches no path at all", async () => {
    assert.ok(
      report.problems.some((one) => one.startsWith('"a/../../b" is not the name of a Tool')),
      report.problems.join("; "),
    )
    assert.equal(await holds(join(outside, "SKILL.md")), false)
    assert.deepEqual((await readdir(dir)).sort(), ["fl-good-tool", "fl-needs-args", "flintd"])
  })

  await t.test("a Tool whose read fails keeps the file it has, and the reason reaches the report", async () => {
    assert.ok(report.problems.includes("needs_args: the index is gone"), report.problems.join("; "))
    assert.equal(await readFile(join(dir, "fl-needs-args", "SKILL.md"), "utf8"), HANDMADE)
    assert.deepEqual(
      report.changes.filter((one) => one.skill === "fl-needs-args"),
      [],
    )
  })

  await t.test("a Tool retired between the list and the read loses its skill without a word", async () => {
    assert.deepEqual(
      report.changes.filter((one) => one.skill === "fl-gone-tool"),
      [{ skill: "fl-gone-tool", action: "removed" }],
    )
    assert.ok(!report.problems.some((one) => one.startsWith("gone_tool:")), report.problems.join("; "))
  })

  await t.test("the Tools that did read are written", async () => {
    assert.match(await readFile(join(dir, "fl-good-tool", "SKILL.md"), "utf8"), /\nflintd call fl_good_tool '\{"text":"hi"\}'\n/)
  })
})

// A daemon that answers the two routes an export reads, and answers them badly. It is a real HTTP server on
// 127.0.0.1, so the client under test is the shipped one and nothing about it is stood in for.
async function hostile(): Promise<{ url: string; close: () => void }> {
  const named = (one: string): ToolDefinition => ({
    name: one,
    description: `Do the work of ${one}.`,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  })
  const server = createServer((request, response) => {
    const write = (status: number, payload: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(payload))
    }
    if (request.url === "/api/v1/tools") {
      return write(200, { tools: ["a/../../b", "needs_args", "gone_tool", "good_tool"].map(named) })
    }
    let body = ""
    request.on("data", (chunk: Buffer) => (body += chunk.toString()))
    request.on("end", () => {
      const name = String((JSON.parse(body) as { args: { name: string } }).args.name)
      if (name === "needs_args") return write(500, { error: { code: "store_error", message: "the index is gone" } })
      if (name === "gone_tool") return write(404, { error: { code: "not_found", message: "no such Tool" } })
      write(200, { call: { id: null, result: { examples: [{ args: { text: "hi" }, expected: { ok: true }, grade: "exact" }] } } })
    })
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}
