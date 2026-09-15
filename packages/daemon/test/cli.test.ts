import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { creation } from "./support.ts"

const BIN = new URL("../bin/flintd.ts", import.meta.url).pathname
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"]

interface Result {
  code: number
  out: string
  err: string
}

test("the flintd binary serves a Library and drives it from the terminal", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "flintd-home-"))
  const skills = join(home, "skills")
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      port: 0,
      libraryDir: join(home, "library"),
      projectLibraryDir: join(home, "project"),
      skillExports: [skills],
    }),
  )
  await seedForReview(join(home, "library"))
  await mkdir(join(home, "project", "workspace"), { recursive: true })
  await writeFile(join(home, "project", "workspace", "notes.txt"), "one two three")
  const daemon = spawn(process.execPath, [...NODE_FLAGS, BIN, "serve"], { env: { ...process.env, FLINTD_HOME: home } })
  t.after(async () => {
    daemon.kill("SIGTERM")
    await new Promise((done) => daemon.once("exit", done))
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const url = await listeningOn(daemon)

  const run = (...args: string[]): Promise<Result> => cli(home, [...args, "--url", url])

  // Every command here costs its own process, so the ones that change nothing are started together and read after.
  const [status, flagged] = await Promise.all([run("status"), run("tools", "list")])
  assert.equal(status.code, 0)
  assert.match(status.out, /\n1 tools, 0\/50 active, 0 retired, 0 invalid\n/)
  assert.match(status.out, /\nmodel not configured\n/)
  assert.match(status.out, /\n {2}project\t.*\t0 tools\n {2}user\t.*\t1 tools\n/)
  assert.match(status.out, /\n {2}review\treview_me\tuser\n/)
  // `flintd serve` writes every configured skills directory once at start and says so in status.
  assert.match(status.out, new RegExp(`\n {2}skills\t${skills}\t1 skills\n`))
  assert.match(await readFile(join(skills, "flintd", "SKILL.md"), "utf8"), /^---\nname: flintd\n/)

  assert.equal(
    flagged.out,
    "review_me\tuser\tdraft\tquickjs\tno approval needed\t0.00\t0 calls\tnever used\tneeds review\tAnswer with the number one.\n",
  )

  const [created, scoped] = await Promise.all([
    run("call", "tool_create", JSON.stringify(creation())),
    run("call", "tool_create", JSON.stringify(reading())),
  ])
  assert.equal(created.code, 0)
  assert.match(created.out, /"state": "draft"/)
  // An Example a pending Manifest kept from running is saved as deferred, and `tools show` is where a person reads it.
  assert.equal(scoped.code, 0)
  assert.match(scoped.out, /"deferred": \[\n\s+0\n\s+\]/)

  const [listed, noneActive, drafts] = await Promise.all([
    run("tools", "list"),
    run("tools", "list", "--state", "active"),
    run("tools", "list", "--state", "draft"),
  ])
  assert.match(listed.out, /\nword_count\tproject\tdraft\tquickjs\tno approval needed\t0\.00\t0 calls\tnever used\tCount the words/)
  assert.equal(noneActive.out, "no Tools\n")
  assert.match(drafts.out, /^note_words\t/)

  // `fl_word_count` is the spelling the SKILL.md export writes, and it names the Tool `word_count` here.
  const called = await run("call", "fl_word_count", '{"text":"one two three"}')
  assert.match(called.out, /"count": 3/)
  // The id goes to stderr, so the result alone reaches a pipe and `flintd report` still has an id to name.
  const id = /^call (\S+)$/m.exec(called.err)?.[1] ?? ""
  assert.match(id, /^[0-9a-f-]{36}$/)
  const reported = await run("report", id, "negative", "--note", "it counted the wrong thing")
  assert.equal(reported.code, 0)
  assert.match(reported.out, /"tool": "word_count"/)
  assert.match(reported.out, /"contribution": -1/)
  // The Approval routes are proved over HTTP in approvals.test.ts. One command here is the smoke test that the
  // binary reaches them at all, and it reads the request the deferred Example raised. None of these changes the
  // Library, so they all run at once.
  const [sideways, scored, found, empty, shown, deferred, history, approvals, polish, refused, second] = await Promise.all([
    run("report", id, "sideways"),
    run("tools", "list"),
    run("find", "count the words in a sentence"),
    run("find", "wobble frobnicate"),
    run("tools", "show", "word_count", "--source"),
    run("tools", "show", "note_words"),
    run("tools", "history", "word_count", "--json"),
    run("approvals", "list"),
    run("tools", "polish", "word_count"),
    run("status", "--token", "not-the-token"),
    cli(home, ["serve"]),
  ])
  assert.equal(sideways.code, 2)
  assert.match(scored.out, /\nword_count\tproject\tdraft\tquickjs\tno approval needed\t-1\.00\t1 calls\t2/)
  assert.match(approvals.out, /\tnote_words\tproject\tpending\t\w+\tread and write files under "workspace"/)
  // The score is the share of the query the Tool matched, so it is a number the corpus decides and not always 1.
  assert.match(found.out, /^word_count\tproject\tdraft\t0\.\d\d\t-1\.00\tCount the words in a piece of text\.\n/)
  assert.equal(empty.out, "no Tools\n")
  assert.match(shown.out, /^word_count {2}draft\n/)
  assert.match(shown.out, /\nheld-out unavailable\n {2}flintd has no model configured/)
  assert.match(shown.out, /split/)
  assert.match(deferred.out, /^deferred examples 0$/m)
  assert.equal(polish.code, 2)
  assert.equal(refused.code, 1)
  assert.match(refused.err, /^unauthorized: /)
  assert.equal(second.code, 1)
  assert.match(second.err, /^dir_in_use: /)
  const versions = (JSON.parse(history.out) as { versions: { id: string }[] }).versions
  assert.equal(versions.length, 1)

  const restored = await run("tools", "restore", "word_count", versions[0]?.id ?? "")
  assert.match(restored.out, /"restored_from"/)

  const retired = await run("tools", "retire", "word_count")
  assert.match(retired.out, /"state": "retired"/)

  const gone = await run("call", "word_count", "{}")
  assert.equal(gone.code, 1)
  assert.match(gone.err, /^not_found: /)

  // FLINTD_TOKEN reaches a daemon whose token this home does not hold.
  const token = (await readFile(join(home, "token"), "utf8")).trim()
  const elsewhere = await mkdtemp(join(tmpdir(), "flintd-home-"))
  t.after(async () => rm(elsewhere, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const carried = await cli(elsewhere, ["status", "--url", url], { FLINTD_TOKEN: token })
  assert.equal(carried.code, 0)
  assert.match(carried.out, /^running {2}/)
})

test("the flintd binary refuses a request that carries no token", async () => {
  const home = await mkdtemp(join(tmpdir(), "flintd-home-"))
  try {
    const answer = await cli(home, ["status"])
    assert.equal(answer.code, 1)
    assert.match(answer.err, /There is no token/)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

// `--version` is also a string option of the Approval commands, where it names the Version of a Tool, and `--help`
// was no option at all: both printed a parse error and the usage instead of answering.
test("the flintd binary answers --version and --help as a binary is expected to", async () => {
  const home = await mkdtemp(join(tmpdir(), "flintd-flags-"))
  try {
    for (const flag of ["--version", "-v"]) {
      const answer = await cli(home, [flag])
      assert.equal(answer.code, 0, answer.err)
      assert.match(answer.out.trim(), /^\d+\.\d+\.\d+$/, answer.out)
    }
    for (const flag of ["--help", "-h"]) {
      const answer = await cli(home, [flag])
      assert.equal(answer.code, 0, answer.err)
      assert.match(answer.out, /^flintd — /)
      assert.equal(answer.err, "", answer.err)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// Before this, `init` wrote a harness config naming a port nothing listened on and printed `cat .../token` for a
// token file that did not exist. A check and a dry run still start nothing: neither may change the machine.
test("init starts a daemon, stop ends it, and neither a check nor a dry run starts one", async () => {
  const home = await mkdtemp(join(tmpdir(), "flintd-autostart-"))
  const elsewhere = await mkdtemp(join(tmpdir(), "flintd-home-"))
  await writeFile(join(home, "config.json"), JSON.stringify({ port: 0 }))
  try {
    for (const mode of ["--dry-run", "--check"]) {
      await cli(home, ["init", "--harness", "codex", "--transcripts", "no", mode], { HOME: elsewhere })
      assert.equal(await readFile(join(home, "pid"), "utf8").catch(() => null), null, `${mode} started a daemon`)
    }
    const stopped = await cli(home, ["stop"])
    assert.equal(stopped.code, 0, stopped.err)
    assert.match(stopped.out, /no flintd daemon is running/)

    const written = await cli(home, ["init", "--harness", "codex", "--transcripts", "no"], { HOME: elsewhere })
    assert.equal(written.code, 0, written.err)
    const port = Number((await readFile(join(home, "port"), "utf8")).trim())
    assert.ok(port > 0, "the daemon published no port")
    assert.ok((await readFile(join(home, "token"), "utf8")).trim().length > 0, "no token for init to point at")
    assert.match(written.out, new RegExp(`127\\.0\\.0\\.1:${port}`))

    const ended = await cli(home, ["stop"])
    assert.equal(ended.code, 0, ended.err)
    assert.match(ended.out, /^stopped flintd \d+$/m)
    assert.equal(await readFile(join(home, "pid"), "utf8").catch(() => null), null, "stop left its pid file behind")
  } finally {
    await cli(home, ["stop"]).catch(() => undefined)
    await rm(home, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  }
})

// An operating system reuses a pid. A stale file naming a live process that is not this daemon must never be signalled.
test("stop leaves a process that is not its daemon alone", async () => {
  const home = await mkdtemp(join(tmpdir(), "flintd-stale-"))
  const stray = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" })
  try {
    await writeFile(join(home, "pid"), `${stray.pid}\n`)
    await writeFile(join(home, "port"), "1\n")
    const answer = await cli(home, ["stop"])
    assert.equal(answer.code, 0, answer.err)
    assert.match(answer.out, /no flintd daemon is running/)
    assert.equal(stray.killed, false)
    assert.equal(stray.exitCode, null, "stop signalled a process that was not its daemon")
  } finally {
    stray.kill()
    await rm(home, { recursive: true, force: true })
  }
})

function reading(): Record<string, unknown> {
  return {
    name: "note_words",
    description: "Count the words of a file in the workspace directory.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    }),
    execute_source: "const text = await ctx.fs.read(args.path)\nreturn { count: text.trim().split(/\\s+/).length }",
    manifest_json: JSON.stringify({ fs: "workspace" }),
    examples: [{ args: { path: "notes.txt" }, expected: { count: 3 } }],
  }
}

// The file channel is the only way into the Library before the daemon starts, and a Tool a sync flagged looks like this.
async function seedForReview(library: string): Promise<void> {
  const directory = join(library, "tools", "review_me")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "tool.json"),
    JSON.stringify({
      name: "review_me",
      description: "Answer with the number one.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      manifest: {},
      state: "draft",
      needs_review: true,
      provenance: { channel: "file", session: null, harness: null, model: null, excerpt: null, createdAt: "2026-01-01T00:00:00.000Z" },
    }),
  )
  await writeFile(join(directory, "body.js"), "export async function execute(args, ctx) {\n  return 1\n}\n")
  await writeFile(join(directory, "examples.json"), JSON.stringify([{ args: {}, expected: 1, grade: "exact" }]))
}

function cli(home: string, args: string[], extra: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, BIN, ...args], {
      env: { ...process.env, FLINTD_HOME: home, ...extra },
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
