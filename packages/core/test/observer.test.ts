import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { Flint, Provenance, Tool } from "../src/index.ts"
import { fakeModel } from "./fake-model.ts"
import {
  BRITTLE_SOURCE,
  creation,
  refusal,
  sharedLibrary,
  temporaryLibrary,
  verified,
  waitFor,
  withFlint,
} from "./support.ts"

const git = promisify(execFile)
const DAY_MS = 86_400_000
const CONSENTED = { transcriptHarnesses: ["claude-code"] }

interface Ran {
  tool: string
  keys: string[]
}

function ran(tool: string, ...keys: string[]): Ran {
  return { tool, keys }
}

async function sessions(
  flint: Flint,
  harness: string,
  named: string[],
  steps: Ran[],
  extra: { transcriptPath?: string } = {},
): Promise<void> {
  const began = Date.now() - 3600_000
  for (const session of named) {
    for (const [index, step] of steps.entries()) {
      await flint.observe({
        harness,
        session,
        tool: step.tool,
        argumentKeys: step.keys,
        status: "ok",
        at: new Date(began + index * 1000).toISOString(),
        ...extra,
      })
    }
  }
}

function patterns(candidates: { pattern: string }[]): string[] {
  return candidates.map((one) => one.pattern)
}

async function versionOf(dir: string, version: string, name: string): Promise<Tool> {
  const shown = await git("git", ["show", `${version}:tools/${name}/tool.json`], { cwd: dir })
  return JSON.parse(shown.stdout) as Tool
}

const observed = sharedLibrary(async () => undefined, CONSENTED)

test("a pattern three sessions ran is a candidate and one two sessions ran is not", async () => {
  await observed(async (flint) => {
    await sessions(flint, "claude-code", ["a1", "a2", "a3"], [ran("Bash", "command"), ran("Read", "file_path")])
    await sessions(flint, "claude-code", ["b1", "b2"], [ran("Grep", "pattern"), ran("Edit", "file_path")])
    const run = await flint.observer.run({ dryRun: true })
    assert.equal(run.dryRun, true)
    const found = run.candidates.find((one) => one.pattern === "Bash(command) -> Read(file_path)")
    assert.equal(found?.sessions, 3)
    assert.deepEqual(found?.harnesses, ["claude-code"])
    assert.deepEqual(found?.steps, [
      { tool: "Bash", argumentKeys: ["command"] },
      { tool: "Read", argumentKeys: ["file_path"] },
    ])
    assert.deepEqual(
      patterns(run.candidates).filter((one) => one.includes("Grep")),
      [],
      "a pattern two sessions ran is not a candidate",
    )
    // The one-step pattern inside it ran in the same three sessions, so the longer pattern is the whole candidate.
    assert.equal(patterns(run.candidates).includes("Bash(command)"), false)
  })
})

test("one repeated command shape is a candidate on its own", async () => {
  await observed(async (flint) => {
    await sessions(flint, "claude-code", ["c1"], [ran("Curl", "url"), ran("Write", "file_path")])
    await sessions(flint, "claude-code", ["c2"], [ran("Curl", "url"), ran("Glob", "pattern")])
    await sessions(flint, "claude-code", ["c3"], [ran("Curl", "url"), ran("Task", "prompt")])
    const run = await flint.observer.run({ dryRun: true })
    assert.ok(patterns(run.candidates).includes("Curl(url)"))
  })
})

test("the Observations of a harness the operator did not consent to are never read", async () => {
  await observed(async (flint) => {
    await sessions(flint, "codex", ["d1", "d2", "d3"], [ran("shell", "command"), ran("apply_patch", "input")])
    const run = await flint.observer.run({ dryRun: true })
    assert.deepEqual(
      patterns(run.candidates).filter((one) => one.includes("apply_patch")),
      [],
    )
  })
})

test("a session event and a step that failed are not steps of a pattern", async () => {
  await withFlint(async (flint) => {
    for (const session of ["e1", "e2", "e3"]) {
      await flint.observe({ harness: "claude-code", session, tool: "SessionStart", status: "ok" })
      await flint.observe({ harness: "claude-code", session, tool: "Fetch", argumentKeys: ["url"], status: "error" })
    }
    const run = await flint.observer.run({ dryRun: true })
    assert.deepEqual(run.candidates, [], "a session event and a failed step leave no pattern at all")
  }, CONSENTED)
})

test("a transcript is read only under consent, and only the tool entries in it", async () => {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "the passphrase is hunter2hunter2" } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "u1", name: "Deploy", input: { service: "api", tag: "v2" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: false }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "u2", name: "Smoke", input: { url: "https://example.test" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "u2", is_error: false }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "u3", name: "Rollback", input: { service: "api" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "u3", is_error: true }] } }),
    "this line is not JSON",
  ].join("\n")
  await withFlint(
    async (flint, dir) => {
      for (const session of ["f1", "f2", "f3"]) {
        const path = join(dir, `${session}.jsonl`)
        await writeFile(path, lines, "utf8")
        await sessions(flint, "claude-code", [session], [ran("Bash", "command")], { transcriptPath: path })
      }
      const run = await flint.observer.run({ dryRun: true })
      assert.deepEqual(run.transcripts, { read: 3, skipped: 0 })
      assert.ok(patterns(run.candidates).includes("Deploy(service, tag) -> Smoke(url)"))
      // The transcript is the record of that session, so the hook row of the same session is not counted beside it.
      assert.equal(patterns(run.candidates).some((one) => one.includes("Bash")), false)
      // A tool_result that failed takes its own tool_use out of the pattern.
      assert.equal(patterns(run.candidates).some((one) => one.includes("Rollback")), false)
      assert.equal(JSON.stringify(run).includes("hunter2hunter2"), false, "no transcript text may reach a result")
    },
    CONSENTED,
  )
  await withFlint(async (flint, dir) => {
    const path = join(dir, "transcript.jsonl")
    await writeFile(path, lines, "utf8")
    await sessions(flint, "claude-code", ["g1", "g2", "g3"], [ran("Bash", "command")], { transcriptPath: path })
    const run = await flint.observer.run({ dryRun: true })
    assert.deepEqual(run.transcripts, { read: 0, skipped: 0 })
    assert.deepEqual(run.candidates, [])
  })
})

test("three sessions that name one transcript are one sitting and one read", async () => {
  await withFlint(
    async (flint, dir) => {
      const path = join(dir, "one.jsonl")
      await writeFile(
        path,
        [
          JSON.stringify({ message: { content: [{ type: "tool_use", id: "u1", name: "Deploy", input: { service: "api" } }] } }),
          JSON.stringify({ message: { content: [{ type: "tool_use", id: "u2", name: "Smoke", input: { url: "u" } }] } }),
        ].join("\n"),
        "utf8",
      )
      await sessions(flint, "claude-code", ["q1", "q2", "q3"], [ran("Bash", "command")], { transcriptPath: path })
      const run = await flint.observer.run({ dryRun: true })
      assert.equal(run.transcripts.read, 1)
      // One file is one conversation however many sessions named it, so it is one session of evidence and no candidate.
      assert.deepEqual(run.candidates, [])
    },
    CONSENTED,
  )
})

test("a transcript flintd cannot read is skipped and the run goes on", async () => {
  await withFlint(
    async (flint, dir) => {
      for (const session of ["h1", "h2", "h3"]) {
        await sessions(flint, "claude-code", [session], [ran("Bash", "command"), ran("Read", "file_path")], {
          transcriptPath: join(dir, `${session}-is-no-such-file.jsonl`),
        })
      }
      const run = await flint.observer.run({ dryRun: true })
      assert.equal(run.transcripts.skipped, 3)
      assert.ok(patterns(run.candidates).includes("Bash(command) -> Read(file_path)"))
    },
    CONSENTED,
  )
})

test("a credential an argument name carries is redacted in the steps, the pattern and the prompt", async () => {
  const model = fakeModel({
    proposal: {
      name: "never_written",
      description: "A Tool the test never lets reach the gate.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      body: "return true",
      examples: [{ args: {}, expected: true }],
    },
  })
  await withFlint(
    async (flint) => {
      await sessions(flint, "claude-code", ["v1", "v2", "v3"], [ran("Bash", "not-a-real-credential-ABCDEFGH12345"), ran("Read", "file_path")])
      const run = await flint.observer.run()
      const [candidate] = run.candidates
      assert.equal(candidate?.pattern, "Bash([redacted]) -> Read(file_path)")
      assert.deepEqual(candidate?.steps[0], { tool: "Bash", argumentKeys: ["[redacted]"] })
      assert.equal(JSON.stringify(run).includes("not-a-real-credential-ABCDEFGH12345"), false)
      const asked = model.prompts.find((one) => one.kind === "proposal")
      assert.equal(asked?.user.includes("not-a-real-credential-ABCDEFGH12345"), false, "no credential may reach a provider")
      assert.ok(asked?.user.includes("[redacted]"))
    },
    {
      ...CONSENTED,
      model,
      connections: [{ name: "example", hosts: ["api.example.test"], header: { name: "authorization", value: "not-a-real-credential-ABCDEFGH12345" } }],
    },
  )
})

test("a transcript with thousands of long argument names makes a bounded prompt", async () => {
  const keys: Record<string, string> = {}
  for (let at = 0; at < 4000; at += 1) keys[`${"k".repeat(180)}${at}`] = "x"
  const model = fakeModel({
    proposal: {
      name: "bounded_proposal",
      description: "A Tool proposed from a transcript that tried to be large.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      body: "return true",
      examples: [{ args: {}, expected: true }],
    },
  })
  await withFlint(
    async (flint, dir) => {
      const line = JSON.stringify({
        message: { content: [{ type: "tool_use", id: "u1", name: "W".repeat(1000), input: keys }] },
      })
      for (const session of ["w1", "w2", "w3"]) {
        const path = join(dir, `${session}.jsonl`)
        await writeFile(path, line, "utf8")
        await sessions(flint, "claude-code", [session], [ran("Bash", "command")], { transcriptPath: path })
      }
      const run = await flint.observer.run()
      const [candidate] = run.candidates
      assert.equal(candidate?.steps[0]?.tool.length, 200)
      assert.equal(candidate?.steps[0]?.argumentKeys.length, 64)
      assert.equal(candidate?.steps[0]?.argumentKeys[0]?.length, 128)
      const asked = model.prompts.find((one) => one.kind === "proposal")
      assert.ok((asked?.user.length ?? 0) < 20_000, `the prompt was ${asked?.user.length ?? 0} characters`)
    },
    { ...CONSENTED, model },
  )
})

test("an observer Draft is the work of its own run until its Held-out examples pass", async () => {
  const model = fakeModel({
    generated: "this is not the JSON a Held-out run reads",
    proposal: {
      name: "still_a_draft",
      description: "A Tool whose Held-out run never passed.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      body: "return { echoed: args.text }",
      examples: [{ args: { text: "one" }, expected: { echoed: "one" } }],
    },
  })
  await withFlint(
    async (flint) => {
      await sessions(flint, "claude-code", ["x1", "x2", "x3"], [ran("Bash", "command"), ran("Read", "file_path")])
      const run = await flint.observer.run()
      assert.equal(run.drafts.length, 1)
      assert.equal((await flint.library())[0]?.state, "draft")
      const other = { sessionId: "another-session" }
      assert.equal((await refusal(() => flint.call("still_a_draft", { text: "one" }, other))).code, "not_found")
      assert.equal((await refusal(() => flint.call("tool_read", { name: "still_a_draft" }, other))).code, "not_found")
      const found = (await flint.call("tool_find", { query: "echo the text back" }, other)) as { tools: { name: string }[] }
      assert.deepEqual(found.tools, [])
    },
    { ...CONSENTED, model },
  )
})

test("a dry run never joins a real run in flight", async () => {
  let release = (): void => undefined
  const model = fakeModel({
    pause: new Promise<void>((wake) => {
      release = wake
    }),
    proposal: {
      name: "slow_proposal",
      description: "A Tool the model is still writing.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      body: "return true",
      examples: [{ args: {}, expected: true }],
    },
  })
  await withFlint(
    async (flint) => {
      await sessions(flint, "claude-code", ["y1", "y2", "y3"], [ran("Bash", "command"), ran("Read", "file_path")])
      const real = flint.observer.run()
      await waitFor(() => model.prompts.length > 0, "the real run never reached the model")
      // Two dry runs that meet are one run, and neither of them is the real run holding the model.
      const [dry, second] = await Promise.all([flint.observer.run({ dryRun: true }), flint.observer.run({ dryRun: true })])
      assert.equal(dry, second)
      assert.equal(dry.dryRun, true)
      assert.deepEqual(dry.drafts, [])
      assert.equal(dry.candidates.length, 1)
      release()
      assert.equal((await real).dryRun, false)
    },
    { ...CONSENTED, model },
  )
})

test("a single step the Library already holds is no candidate", async () => {
  await withFlint(async (flint) => {
    await flint.call("tool_create", creation())
    for (const session of ["z1", "z2", "z3"]) await flint.call("word_count", { text: "one two" }, { sessionId: session })
    const run = await flint.observer.run({ dryRun: true })
    assert.deepEqual(run.candidates, [], "a Tool called in three sessions is a Tool, not a candidate")
  }, CONSENTED)
})

test("one run asks the model for at most observerMaxCandidates patterns", async () => {
  await withFlint(
    async (flint) => {
      await sessions(flint, "claude-code", ["n1", "n2", "n3"], [ran("Bash", "command"), ran("Read", "file_path")])
      await sessions(flint, "claude-code", ["n4", "n5", "n6"], [ran("Grep", "pattern"), ran("Edit", "file_path")])
      const run = await flint.observer.run({ dryRun: true })
      assert.equal(run.candidates.length, 1, "the cap holds even though two patterns earned a candidacy")
    },
    { ...CONSENTED, observerMaxCandidates: 1 },
  )
})

test("consent is read at every run, so turning transcripts off is obeyed at the next one", async () => {
  let held = ["claude-code"]
  await withFlint(
    async (flint) => {
      await sessions(flint, "claude-code", ["u1", "u2", "u3"], [ran("Bash", "command"), ran("Read", "file_path")])
      assert.equal((await flint.observer.run({ dryRun: true })).candidates.length, 1)
      held = []
      assert.deepEqual((await flint.observer.run({ dryRun: true })).candidates, [])
      held = ["claude-code"]
      assert.equal((await flint.observer.run({ dryRun: true })).candidates.length, 1)
    },
    { transcriptHarnesses: () => held },
  )
})

test("a candidate becomes a Draft on the observer Channel with the pattern in its Provenance", async () => {
  const model = fakeModel({
    cases: [{ args: { text: "one" }, confident: true, expected: { echoed: "one" } }],
    proposal: {
      name: "read_after_run",
      description: "Run a command and read the file it wrote, in one call.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      body: "return { echoed: args.text }",
      examples: [{ args: { text: "one" }, expected: { echoed: "one" } }],
    },
  })
  await withFlint(
    async (flint, dir) => {
      await sessions(flint, "claude-code", ["i1", "i2", "i3"], [ran("Bash", "command"), ran("Read", "file_path")])
      const run = await flint.observer.run()
      assert.equal(run.modelConfigured, true)
      assert.deepEqual(run.refusals, [])
      assert.equal(run.drafts.length, 1)
      assert.equal(run.drafts[0]?.name, "read_after_run")
      assert.equal(run.drafts[0]?.pattern, "Bash(command) -> Read(file_path)")
      assert.equal(run.drafts[0]?.library, "user")

      const history = (await flint.call("tool_history", { name: "read_after_run" })) as {
        versions: { id: string; operation: string; channel: string }[]
      }
      const created = history.versions.find((one) => one.operation === "create")
      assert.equal(created?.channel, "observer")
      assert.equal(created?.id, run.drafts[0]?.version)

      const provenance = (await versionOf(dir, created?.id as string, "read_after_run")).provenance as Provenance
      assert.equal(provenance.channel, "observer")
      assert.match(String(provenance.session), /^observer:\d{4}-/)
      assert.equal(provenance.harness, "claude-code")
      assert.equal(provenance.model, "fake-model")
      assert.ok(provenance.excerpt?.includes("Bash(command) -> Read(file_path)"))
      assert.ok(provenance.excerpt?.includes("3 sessions"))
      assert.ok(provenance.excerpt?.includes("every value in the Examples is one the model invented"))

      const asked = model.prompts.filter((one) => one.kind === "proposal")
      assert.equal(asked.length, 1)
      assert.equal(asked[0]?.json, true)
      assert.ok(asked[0]?.user.includes("Bash with arguments named command"))

      const status = await flint.status()
      assert.equal(status.observer.candidates, 1)
      assert.equal(status.observer.drafts, 1)
      assert.equal(status.observer.lastRunAt, run.at)
      assert.equal(status.observer.running, false)
    },
    { ...CONSENTED, model },
  )
})

test("a proposal that repeats a Tool the Library holds is refused, and the refusal is recorded", async () => {
  const model = fakeModel({
    cases: [{ args: { text: "two words" }, confident: true, expected: { count: 2 } }],
    proposal: {
      name: "count_the_words",
      description: "Count the words in a piece of text.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      body: "return { count: args.text.trim().split(/\\s+/).filter(Boolean).length }",
      examples: [{ args: { text: "one two" }, expected: { count: 2 } }],
    },
  })
  await withFlint(
    async (flint) => {
      await flint.call("tool_create", creation())
      await verified(flint, "word_count")
      await sessions(flint, "claude-code", ["j1", "j2", "j3"], [ran("Bash", "command"), ran("Read", "file_path")])
      const run = await flint.observer.run()
      assert.deepEqual(run.drafts, [])
      assert.equal(run.refusals.length, 1)
      assert.equal(run.refusals[0]?.code, "duplicate")
      assert.equal(run.refusals[0]?.name, "count_the_words")
      assert.equal(run.refusals[0]?.pattern, "Bash(command) -> Read(file_path)")
      assert.ok(run.refusals[0]?.reason.includes("word_count"))
      assert.equal((await refusal(() => flint.call("tool_read", { name: "count_the_words" }))).code, "not_found")
      assert.equal((await flint.status()).observer.refusals, 1)
    },
    { ...CONSENTED, model, duplicateThreshold: 0.5 },
  )
})

test("with no model the run lists the candidates and writes nothing", async () => {
  await withFlint(
    async (flint) => {
      await sessions(flint, "claude-code", ["k1", "k2", "k3"], [ran("Bash", "command"), ran("Read", "file_path")])
      // Single-flight: two callers that meet get one run and one answer.
      const [run, second] = await Promise.all([flint.observer.run(), flint.observer.run()])
      assert.equal(run, second)
      assert.equal(run.modelConfigured, false)
      assert.equal(run.candidates.length, 1)
      assert.deepEqual(run.drafts, [])
      assert.deepEqual(run.refusals, [])
      assert.deepEqual(await flint.library(), [])
    },
    CONSENTED,
  )
})

test("a Tool that hurt more than it helped, and one nobody called, are proposed for retirement", async () => {
  const model = fakeModel({ cases: [{ args: { text: "one two" }, confident: true, expected: { count: 2 } }] })
  let now = Date.now() - 40 * DAY_MS
  await withFlint(
    async (flint) => {
      await flint.call("tool_create", creation({ name: "idle_count" }))
      await flint.call("tool_create", creation({ name: "brittle_count", execute_source: BRITTLE_SOURCE }))
      await verified(flint, "idle_count", "brittle_count")
      await flint.call("idle_count", { text: "one two" }, { sessionId: "m1" })
      now = Date.now()
      for (let call = 0; call < 2; call += 1) {
        await refusal(() => flint.call("brittle_count", { text: "boom" }, { sessionId: "m2" }))
      }
      const proposals = await flint.observer.proposals()
      assert.deepEqual(
        proposals.map((one) => [one.name, one.reason]),
        [
          ["brittle_count", "contribution"],
          ["idle_count", "idle"],
        ],
      )
      const poor = proposals[0]
      assert.equal(poor?.state, "verified")
      assert.equal(poor?.library, "user")
      assert.equal(poor?.calls, 2)
      assert.equal(poor?.errors, 2)
      assert.equal(poor?.contribution, -1)
      assert.equal(proposals[1]?.idleDays, 40)
      assert.equal(proposals[1]?.calls, 1)

      // A proposal is a list and never an act: both Tools are still there, and tool_retire is what retires one.
      assert.deepEqual(await flint.call("idle_count", { text: "one two" }, { sessionId: "m3" }), { count: 2 })
      await flint.call("tool_retire", { name: "idle_count" })
      assert.deepEqual(
        (await flint.observer.proposals()).map((one) => one.name),
        ["brittle_count"],
      )
    },
    { clock: () => now, model, retireMinCalls: 2, retireContribution: -0.1, retireIdleDays: 30 },
  )
})

test("a run that reaches its bound writes nothing and says so", async () => {
  let release = (): void => undefined
  const model = fakeModel({
    pause: new Promise<void>((wake) => {
      release = wake
    }),
    proposal: {
      name: "too_late",
      description: "A Tool the run was still asking for when its bound came.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      body: "return true",
      examples: [{ args: {}, expected: true }],
    },
  })
  const said: string[] = []
  await withFlint(
    async (flint) => {
      await sessions(flint, "claude-code", ["o1", "o2", "o3"], [ran("Bash", "command"), ran("Read", "file_path")])
      const run = await flint.observer.run()
      assert.equal(run.candidates.length, 1)
      assert.deepEqual(run.drafts, [])
      assert.deepEqual(run.refusals, [])
      assert.deepEqual(await flint.library(), [])
      assert.ok(said.some((line) => line.includes("stopped at its bound of 1 ms")))
      release()
    },
    { ...CONSENTED, model, observerTimeoutMs: 1, onLog: (entry) => said.push(entry.message) },
  )
})

test("stop() cancels an observer run that is waiting on the model", async () => {
  let release = (): void => undefined
  const model = fakeModel({
    pause: new Promise<void>((wake) => {
      release = wake
    }),
    proposal: {
      name: "never_saved",
      description: "A Tool the model was still writing when flintd stopped.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      body: "return true",
      examples: [{ args: {}, expected: true }],
    },
  })
  const dir = await temporaryLibrary()
  const flint = createFlint({ dir, ...CONSENTED, model, stopGraceMs: 500 })
  await flint.start()
  try {
    await sessions(flint, "claude-code", ["p1", "p2", "p3"], [ran("Bash", "command"), ran("Read", "file_path")])
    const run = flint.observer.run()
    await waitFor(() => model.prompts.length > 0, "the observer never reached the model")
    const began = Date.now()
    await flint.stop()
    assert.ok(Date.now() - began < 1000, `stop() took ${Date.now() - began} ms`)
    assert.deepEqual((await run).drafts, [])
  } finally {
    release()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
