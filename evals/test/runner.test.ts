import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createFlint } from "@flintd/core"
import type { ModelAdapter, ModelRequest } from "@flintd/core"
import { freePort, startDaemon } from "../daemon.ts"
import { callPrompt, run } from "../harness/smoke.ts"
import { APPENDED, SEEDS, readPrompts, runHeldOut } from "../held-out.ts"
import type { Prompt, PromptOutcome } from "../held-out.ts"
import { UNFINISHED, buildResults } from "../record.ts"
import type { RunState } from "../record.ts"
import { isResults } from "../results.ts"
import { startMeter } from "../servers.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, "..", "results")
const KINDS = ["pure", "bundle", "fs", "network", "composition", "exec"]

test("the fixed prompts cover every kind and name only prompts that exist", async () => {
  const prompts = await readPrompts()
  const fixed = prompts.filter((one) => one.requiresDocker !== true)
  assert.equal(fixed.length, 20, "the held-out suite is twenty fixed prompts")
  for (const kind of KINDS) {
    assert.ok(
      prompts.some((one) => one.kind === kind),
      `no prompt covers ${kind}`,
    )
  }
  for (const one of prompts) {
    assert.ok(KINDS.includes(one.kind), `${one.id} has the kind ${one.kind}, which is not one of ${KINDS.join(", ")}`)
    assert.ok(one.prompt.length > 40, `${one.id} has no real prompt text`)
  }
  // A probe call proves nothing without an answer to hold it to, so only a prompt whose answer really moves may omit one.
  const open = prompts.filter((one) => one.expect === undefined).map((one) => one.id)
  assert.deepEqual(open, ["append_line"], "a prompt with a fixed answer must declare `expect`")
})

// A prompt that fixes an answer a model cannot work out from the prompt alone costs a whole run of the suite.
test("every digest a prompt quotes is the digest of a seeded file the suite never changes", async () => {
  const digests = /^\s+(\S+)\s+([0-9a-f]{64})$/gm
  let quoted = 0
  for (const one of await readPrompts()) {
    for (const [, path, digest] of one.prompt.matchAll(digests)) {
      const seeded = SEEDS[path as string]
      assert.ok(seeded !== undefined, `${one.id} quotes a digest for ${String(path)}, which the suite does not seed`)
      assert.notEqual(path, APPENDED, `${one.id} quotes a digest for the one file the suite appends to`)
      assert.equal(createHash("sha256").update(seeded).digest("hex"), digest, `${one.id} quotes a wrong digest for ${String(path)}`)
      quoted += 1
    }
  }
  assert.ok(quoted > 0, "no prompt quotes a digest any more, so this check proves nothing")
})

// A prompt that quotes a tree the suite does not seed is the same bug as a prompt that quotes a wrong digest, so
// every row of every quoted tree is derived from SEEDS rather than read.
test("every tree a prompt quotes is the tree the suite seeds", async () => {
  const rows = /^ {2}(\S+) +.*?(\d+) lines?: (.+)$/gm
  const named = Object.keys(SEEDS).map((path) => (path.includes("/") ? `${path.split("/")[0]}/` : path))
  let trees = 0
  for (const one of await readPrompts()) {
    if (!one.prompt.includes("holds exactly this tree")) continue
    trees += 1
    const quoted = [...one.prompt.matchAll(rows)]
    assert.deepEqual(quoted.map(([, name]) => name).sort(), [...named].sort(), `${one.id} quotes a tree of other paths`)
    for (const [, name, count, rest] of quoted) {
      const lines = [...(rest as string).matchAll(/"([^"]*)"/g)].map(([, line]) => line)
      assert.equal(`${lines.join("\n")}\n`, seeded(name as string), `${one.id} quotes lines ${String(name)} does not hold`)
      assert.equal(Number(count), lines.length, `${one.id} quotes a wrong line count for ${String(name)}`)
    }
  }
  assert.ok(trees > 0, "no prompt quotes the tree any more, so this check proves nothing")
})

// A row of a directory quotes the lines of the one file under it, and a row of a file quotes its own.
function seeded(name: string): string | undefined {
  if (!name.endsWith("/")) return SEEDS[name]
  const under = Object.entries(SEEDS).filter(([path]) => path.startsWith(name))
  return under.length === 1 ? under[0]?.[1] : undefined
}

test("the prompt that appends names the one file it appends to, and nothing else fixes an answer from that file", async () => {
  const prompts = await readPrompts()
  const appending = prompts.find((one) => one.id === "append_line")
  assert.ok(appending !== undefined)
  assert.match(appending.prompt, new RegExp(`Write every Example against "${APPENDED}"`))
  assert.equal(appending.probe["path"], APPENDED)
  assert.equal(appending.expect, undefined, "an answer that depends on an appended file cannot be fixed")
})

test("a start that never returns a daemon leaves no home holding the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-eval-test-"))
  const home = join(dir, "home")
  // A root with no daemon binary under it: the child exits at once and startDaemon has to clean up after itself.
  await assert.rejects(
    startDaemon({
      root: join(dir, "nothing-here"),
      home,
      port: await freePort(),
      provider: "openai",
      apiKey: "not-a-key",
      model: "none",
      baseUrl: "http://127.0.0.1:1",
      seeds: {},
    }),
  )
  await assert.rejects(access(home), "the temporary flintd home outlived the failed start")
  await rm(dir, { recursive: true, force: true })
})

test("a prompt that names a placeholder names one the runner fills in", async () => {
  for (const one of await readPrompts()) {
    for (const [, name] of one.prompt.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(name === "fixture" || name === "requires", `${one.id} names the placeholder ${name}`)
      if (name === "requires") assert.ok(one.requires !== undefined, `${one.id} names {{requires}} and requires nothing`)
    }
  }
})

test("the results schema takes a whole result and refuses a broken one", () => {
  const usage = { requests: 1, input: 2, output: 3 }
  const whole = {
    startedAt: "2026-09-14T00:00:00.000Z",
    finishedAt: "2026-09-14T00:01:00.000Z",
    durationMs: 60_000,
    suite: "held-out",
    flintd: { treeHash: null, node: "v26.0.0" },
    model: { provider: "openai", id: "gpt-5-mini", price: null },
    estimate: { inputTokens: 1, outputTokens: 1, usd: null },
    usage: { author: usage, daemon: usage, harness: usage, total: usage, unreadable: 0, uncounted: [] },
    cost: { author: null, daemon: null, harness: null, total: null, cap: 2 },
    heldOut: {
      ran: 1,
      passed: 1,
      firstPass: 0,
      repaired: 1,
      skipped: 0,
      rate: 1,
      firstPassRate: 0,
      threshold: 0.9,
      prompts: [
        {
          id: "word_count",
          kind: "pure",
          tool: "word_count",
          created: true,
          approved: false,
          heldOut: "passed",
          verified: true,
          called: true,
          pass: true,
          skipped: false,
          reason: null,
          failures: [],
          sent: null,
          repair: { refusal: "tool_create: example_failed: Example 0 returned a different result.", second: null },
          durationMs: 10,
        },
      ],
    },
    harness: {
      pass: 0,
      handshake: 0,
      fail: 0,
      skipped: 1,
      daemonHomeUntouched: true,
      harnesses: [{ harness: "pi", status: "skipped", binary: null, version: null, reason: "not installed", steps: [], durationMs: 1 }],
    },
    observer: { status: "skipped", reason: "ticket 18" },
    stopped: null,
    thresholds: [{ name: "held-out pass rate", value: 1, threshold: 0.9, ok: true }],
    ok: true,
  }
  assert.ok(isResults(whole))
  assert.ok(!isResults({ ...whole, usage: { author: usage, daemon: usage } }))
  assert.ok(!isResults({ ...whole, thresholds: [{ name: "x", value: 1, threshold: 1 }] }))
  assert.ok(!isResults({ ...whole, heldOut: { ...whole.heldOut, prompts: [{ id: "x" }] } }))
  // A refusal carries the arguments that caused it as text, and a result written before that field reads as before.
  const one = whole.heldOut.prompts[0] as (typeof whole.heldOut.prompts)[0]
  const { sent: dropped, repair: unrepaired, ...older } = one
  const prompts = (first: unknown): unknown => ({ ...whole, heldOut: { ...whole.heldOut, prompts: [first] } })
  assert.ok(isResults(prompts({ ...one, sent: '{"name":"counted","result_json":"\"{}\""}' })))
  assert.ok(isResults(prompts(older)))
  assert.ok(!isResults(prompts({ ...one, sent: { result_json: "{}" } })))
  // The repair round is the newest field of all: a file written before it carries no rate of its own and still reads.
  const { firstPass, repaired, firstPassRate, ...before } = whole.heldOut
  assert.ok(isResults({ ...whole, heldOut: { ...before, prompts: [older] } }))
  assert.ok(!isResults(prompts({ ...one, repair: { refusal: 17, second: null } })))
})

test("every result already written reads as a result", async () => {
  const files = await readdir(RESULTS).catch(() => [])
  for (const name of files.filter((one) => one.endsWith(".json"))) {
    const parsed = JSON.parse(await readFile(join(RESULTS, name), "utf8")) as unknown
    assert.ok(isResults(parsed), `${name} is not the shape evals/results.ts documents`)
  }
})

const PLANNED = 21

function outcome(id: string, pass: boolean, skipped: boolean, repaired: boolean): PromptOutcome {
  return {
    id,
    kind: "pure",
    tool: pass ? id : null,
    created: pass,
    approved: false,
    heldOut: pass ? "passed" : null,
    verified: pass,
    called: pass,
    pass,
    skipped,
    reason: null,
    failures: [],
    sent: null,
    repair: repaired ? { refusal: "tool_create: example_failed: Example 0 returned a different result.", second: null } : null,
    durationMs: 10,
  }
}

test("a results file names no path of the machine that produced it", () => {
  const machine = "/tmp/a-machine/.tmp-harness-xyz"
  const ran = {
    ...outcome("word_count", true, false, false),
    reason: `the harness ran ${machine}/pi/npm/node_modules/.bin/pi and it answered`,
  }
  const built = buildResults({ ...state([ran]), roots: [{ label: "harness-dir", path: machine }] }, null)
  const written = JSON.stringify(built)
  assert.equal(written.includes(machine), false, written)
  assert.match(built.heldOut.prompts[0]?.reason ?? "", /<harness-dir>\/pi\/npm/)
})

function state(heldOut: PromptOutcome[]): RunState {
  return {
    startedAt: new Date("2026-09-15T00:00:00.000Z"),
    suite: "all",
    treeHash: null,
    provider: "openai",
    model: "gpt-5-mini",
    price: { input: 0.25, output: 2 },
    estimate: { inputTokens: PLANNED * 3_000, outputTokens: PLANNED * 8_000, usd: null },
    budget: 2,
    meter: undefined,
    heldOut,
    harness: [],
    observer: null,
    observerPlanned: true,
    daemonHomeUntouched: true,
    roots: [{ label: "harness-dir", path: "/tmp/a-machine/.tmp-harness-xyz" }],
  }
}

test("a run saved part way through describes the prompts that ran, not the prompts that were planned", () => {
  const saved = buildResults(
    state([outcome("one", true, false, false), outcome("two", true, false, true), outcome("three", true, false, false), outcome("four", false, true, false)]),
    UNFINISHED,
  )
  assert.ok(isResults(saved), "a partial result is the same shape as a whole one")
  assert.equal(saved.estimate.inputTokens, PLANNED * 3_000, "the estimate still names what the run planned")
  assert.equal(saved.heldOut.prompts.length, 4)
  assert.equal(saved.heldOut.ran, 3)
  assert.equal(saved.heldOut.passed, 3)
  assert.equal(saved.heldOut.skipped, 1)
  assert.equal(saved.heldOut.rate, 1, "the rate is over the prompts that ran")
  assert.equal(saved.heldOut.firstPass, 2)
  assert.equal(saved.heldOut.firstPassRate, 2 / 3)
  assert.equal(saved.stopped, UNFINISHED)
  assert.equal(saved.ok, false, "a run that has not finished is never a pass, whatever its rate")
  assert.equal(saved.observer.status, "skipped")
  assert.equal(saved.observer.reason, "the run stopped before the Observer finished")
})

test("a run that finishes with nothing wrong is a pass and says nothing stopped it", () => {
  const whole = buildResults(state([outcome("one", true, false, false)]), null)
  assert.equal(whole.stopped, null)
  assert.equal(whole.ok, true)
})

// The signal path itself, in a child process that takes a real SIGINT: the file it leaves is the whole point of it.
test("a signal leaves the results the run already had, runs the cleanup, and exits 130", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-eval-signal-"))
  const file = join(dir, "results", "2026-09-15T00-00-00.000Z.json")
  const marker = join(dir, "cleaned")
  const script = join(dir, "run.mjs")
  await writeFile(script, child(file, marker))
  const running = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script], { stdio: ["ignore", "pipe", "ignore"] })
  try {
    for await (const chunk of running.stdout) if (String(chunk).includes("ready")) break
    // What the file holds while the run is still going, which is all an OS kill of the process ever leaves.
    const going = JSON.parse(await readFile(file, "utf8")) as unknown
    assert.ok(isResults(going))
    assert.equal(going.stopped, UNFINISHED)
    assert.equal(going.ok, false)

    running.kill("SIGINT")
    const [code, signal] = (await once(running, "exit", { signal: AbortSignal.timeout(15_000) })) as [number | null, string | null]
    assert.equal(code, 130, `a signal exits 130 (signal ${String(signal)})`)
    const stopped = JSON.parse(await readFile(file, "utf8")) as unknown
    assert.ok(isResults(stopped), "the file a signal left is the shape every reader of this lane expects")
    assert.equal(stopped.stopped, "stopped by SIGINT")
    assert.equal(stopped.ok, false)
    assert.equal(stopped.heldOut.ran, 2, "the prompts that finished before the signal are in the file")
    assert.equal(stopped.heldOut.rate, 1)
    assert.equal(await readFile(marker, "utf8"), "cleaned", "the signal still stops everything the run started")
    await assert.rejects(access(`${file}.part`), "the file a save renames from is not left behind")
  } finally {
    running.kill("SIGKILL")
    await rm(dir, { recursive: true, force: true })
  }
})

function child(file: string, marker: string): string {
  const { startedAt, ...rest } = state([outcome("one", true, false, false), outcome("two", true, false, false)])
  return `import { writeFile } from "node:fs/promises"
import { UNFINISHED, startRecord } from ${JSON.stringify(pathToFileURL(join(HERE, "..", "record.ts")).href)}

const state = () => ({ ...${JSON.stringify(rest)}, startedAt: new Date(${JSON.stringify(startedAt.toISOString())}) })
const record = await startRecord(${JSON.stringify(file)}, state, async () => {
  await writeFile(${JSON.stringify(marker)}, "cleaned")
})
await record.save(UNFINISHED)
process.stdout.write("ready\\n")
// A signal listener alone does not hold the event loop open, so the child waits on a timer the signal cuts short.
await new Promise((soon) => setTimeout(soon, 60_000))
`
}

test("the meter reads the usage of a streamed answer, and asks the provider to send it", async () => {
  let sent = ""
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      sent = Buffer.concat(chunks).toString("utf8")
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\n' +
          "data: [DONE]\n\n",
      )
    })
  })
  await new Promise<void>((listening) => upstream.listen(0, "127.0.0.1", listening))
  const port = (upstream.address() as AddressInfo).port
  const meter = await startMeter({
    provider: "openai",
    apiKey: "not-a-key",
    upstream: `http://127.0.0.1:${port}`,
    headers: {},
  })
  try {
    await fetch(`${meter.url}/harness/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-mini", stream: true, messages: [] }),
    })
    assert.deepEqual(meter.lane("harness"), { requests: 1, input: 11, output: 22 })
    assert.equal(meter.unreadable(), 0)
    const asked = JSON.parse(sent) as { stream_options?: { include_usage?: boolean } }
    assert.equal(asked.stream_options?.include_usage, true)
  } finally {
    await meter.stop()
    await new Promise<void>((closed) => upstream.close(() => closed()))
  }
})

// A CLI that appends piped stdin to its prompt waits for the end of it, and the drive writes none.
test("a harness command whose stdin is a pipe is not left waiting for it", async () => {
  const said = await run("cat", [], { timeoutMs: 5_000 })
  assert.equal(said.code, 0)
  assert.equal(said.stdout, "")
})

test("the harness drive names the Tool to call and the arguments to call it with", () => {
  const written = callPrompt({ seededTool: "word_count", seededArgs: { text: "one two three" } })
  assert.match(written, /tool_run with \{"name": "word_count", "args": \{"text":"one two three"\}\}/)
})

// The meter runs inside the runner's own process: a rejection here would end the run and write no results file.
test("an upstream that drops its answer part way through does not take the meter with it", async () => {
  const upstream = createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      // The chunk has to reach the meter before the socket dies, or the answer fails at its headers instead.
      setTimeout(() => response.socket?.destroy(), 20)
    })
  })
  await new Promise<void>((listening) => upstream.listen(0, "127.0.0.1", listening))
  const port = (upstream.address() as AddressInfo).port
  const meter = await startMeter({
    provider: "openai",
    apiKey: "not-a-key",
    upstream: `http://127.0.0.1:${port}`,
    headers: {},
  })
  try {
    const answer = await fetch(`${meter.url}/author/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-mini", stream: true, messages: [] }),
    })
    assert.equal(answer.status, 502)
    assert.match(String((await answer.json() as { error?: string }).error), /could not read the provider's answer/)
    assert.equal(meter.unreadable(), 1)
    assert.equal(meter.reasons().length, 1)
    assert.deepEqual(meter.lane("author"), { requests: 0, input: 0, output: 0 })
  } finally {
    await meter.stop()
    await new Promise<void>((closed) => upstream.close(() => closed()))
  }
})

const TEXT_ARG = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }
const NO_ARGS = { type: "object", properties: {}, additionalProperties: false }
const FS_BODY = 'await ctx.fs.write("probe.txt", "abc\\n"); return (await ctx.fs.read("probe.txt")).length'

// The repair round, offline: a real Library refuses two real writes and the authoring model answers what it said.
test("only a refusal flintd returned earns one more authoring call, and it carries flintd's own words", async () => {
  const asked: string[] = []
  const answers = [
    authored({ name: "letter_count", parameters: TEXT_ARG, body: "return args.text.length", examples: [{ args: { text: "ab" }, expected: 3 }] }),
    authored({ name: "letter_count", parameters: TEXT_ARG, body: "return args.text.length", examples: [{ args: { text: "ab" }, expected: 2 }] }),
    authored({ name: "shout", parameters: TEXT_ARG, body: "return args.text.toUpperCase()", examples: [{ args: { text: "hi" }, expected: "HI" }] }),
    authored({ name: "probe_bytes", parameters: NO_ARGS, manifest: '{"fs":"workspace"}', body: FS_BODY, examples: [{ args: {}, expected: 99 }] }),
    authored({ name: "probe_bytes", parameters: NO_ARGS, manifest: '{"fs":"workspace"}', body: FS_BODY, examples: [{ args: {}, expected: 4 }] }),
  ]
  const adapter: ModelAdapter = {
    provider: "openai",
    model: "not-a-model",
    async complete(request: ModelRequest): Promise<string> {
      asked.push(request.messages.map((one) => one.content).join("\n"))
      const next = answers.shift()
      if (next === undefined) throw new Error("the runner authored more times than this test scripted")
      return next
    },
  }
  const prompts: Prompt[] = [
    { id: "refused_create", kind: "pure", prompt: "count the letters", probe: { text: "abc" } },
    { id: "taken_at_once", kind: "pure", prompt: "shout the text", probe: { text: "hi" } },
    { id: "refused_grant", kind: "fs", prompt: "write a file and read it back", probe: {} },
  ]

  const dir = await mkdtemp(join(tmpdir(), "flintd-eval-repair-"))
  await mkdir(join(dir, "workspace"))
  const flint = createFlint({ dir })
  await flint.start()
  let outcomes: PromptOutcome[]
  try {
    outcomes = await runHeldOut({
      flint,
      adapter,
      prompts,
      fixture: "http://127.0.0.1:1",
      docker: false,
      overBudget: () => null,
      say: () => undefined,
      onPrompt: async () => undefined,
    })
  } finally {
    await flint.stop()
    await rm(dir, { recursive: true, force: true })
  }
  const [create, once, grant] = outcomes as [PromptOutcome, PromptOutcome, PromptOutcome]

  assert.match(create.repair?.refusal ?? "", /^tool_create: example_failed: Example 0 expected /)
  assert.equal(asked[1], `count the letters\n\n${create.repair?.refusal}`, "the repair prompt is the prompt and the refusal, and nothing else")
  assert.equal(create.repair?.second, null)
  assert.equal(create.created, true)

  // A Tool flintd saved is never authored again: what happens to it after the save is the verification gate.
  assert.equal(once.repair, null)
  assert.equal(once.created, true)
  assert.deepEqual(asked.filter((one) => one.startsWith("shout the text")), ["shout the text"])

  // A grant flintd refused leaves the Tool in the Library, so its repair changes that Tool rather than writing it again.
  assert.match(grant.repair?.refusal ?? "", /^approval: The Examples of "probe_bytes" did not pass with the Manifest granted/)
  assert.equal(asked[4], `write a file and read it back\n\n${grant.repair?.refusal}`)
  assert.equal(grant.repair?.second, null)
  assert.equal(grant.approved, true)
  assert.equal(asked.length, 5, "one authoring call a prompt, and one more for each of the two flintd refused")
})

function authored(one: { name: string; parameters: unknown; body: string; examples: unknown[]; manifest?: string }): string {
  return JSON.stringify({
    name: one.name,
    description: "a Tool this offline check writes",
    parameters_json: JSON.stringify(one.parameters),
    execute_source: one.body,
    examples_json: JSON.stringify(one.examples),
    manifest_json: one.manifest ?? "{}",
    result_json: "",
  })
}
