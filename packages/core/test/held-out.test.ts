import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { Flint, JsonValue } from "../src/index.ts"
import { fakeModel } from "./fake-model.ts"
import { BRITTLE_SOURCE, creation, temporaryLibrary, verified, waitFor, withFlint } from "./support.ts"

// Each test here opens its own Library and its own model fake and asserts a state, not a time bound, so they run
// together rather than in turn.
describe("Held-out runs", { concurrency: true }, () => {
  const git = promisify(execFile)

  const LOOSER_BODY = "const words = args.text.split(/\\s+/).filter(Boolean)\nreturn { count: words.length }"

  type Read = Record<string, JsonValue>
  type HeldOutView = {
    status: string
    grades: { exact: number; assertion: number }
    failures: Record<string, JsonValue>[]
    reason?: string
  }

  async function settled(flint: Flint, name = "word_count"): Promise<Read> {
    const deadline = Date.now() + 5000
    for (;;) {
      const read = (await flint.call("tool_read", { name })) as Read
      if (view(read).status !== "pending") return read
      if (Date.now() > deadline) throw new Error("the Held-out run never reached a state")
      await new Promise((wake) => setTimeout(wake, 5))
    }
  }

  function view(read: Read): HeldOutView {
    return read["held_out"] as unknown as HeldOutView
  }

  async function subjects(flint: Flint, name = "word_count"): Promise<string[]> {
    const history = (await flint.call("tool_history", { name })) as {
      versions: { operation: string | null; channel: string | null }[]
    }
    return history.versions.map((one) => `${String(one.operation)}:${String(one.channel)}`)
  }

  test("a Draft whose Held-out examples all pass becomes Verified", async () => {
    const model = fakeModel({
      cases: [
        { args: { text: "one two" }, confident: true, expected: { count: 2 } },
        { args: { text: "" }, confident: true, expected: { count: 0 } },
        { args: { text: "a b c d" }, confident: false },
      ],
    })
    await withFlint(
      async (flint, dir) => {
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        assert.equal(read["state"], "verified")
        assert.deepEqual(view(read), { status: "passed", grades: { exact: 2, assertion: 1 }, failures: [] })
        assert.deepEqual(await subjects(flint), ["verify:flintd", "create:agent"])

        assert.deepEqual(
          model.prompts.map((one) => one.kind),
          ["held-out", "plausibility"],
        )
        assert.ok(model.prompts.every((one) => one.json))
        assert.match(model.prompts[0]?.user ?? "", /Count the words in a piece of text\./)

        const stored = JSON.parse(await readFile(join(dir, "tools", "word_count", "held-out.json"), "utf8")) as {
          examples: { args: JsonValue; expected: JsonValue; grade: string; judgment: string | null }[]
        }
        assert.deepEqual(
          stored.examples.map((one) => one.grade),
          ["exact", "exact", "assertion"],
        )
        // The judgment is kept on a passing Example too, so a reader sees why the Tool was verified.
        assert.deepEqual(stored.examples[2], {
          args: { text: "a b c d" },
          expected: null,
          grade: "assertion",
          judgment: "the result matches what the Tool promises",
        })
        assert.equal(stored.examples[0]?.judgment, null)

        const dirty = await git("git", ["status", "--porcelain"], { cwd: dir })
        assert.equal(dirty.stdout.trim(), "")

        // A Body change drops the Held-out evidence with the Version that carried it, and the run starts again.
        await flint.call("tool_update", { name: "word_count", execute_source: LOOSER_BODY })
        const again = await settled(flint)
        assert.equal(again["state"], "verified")
        assert.deepEqual(await subjects(flint), ["verify:flintd", "update:agent", "verify:flintd", "create:agent"])
        const after = await git("git", ["status", "--porcelain"], { cwd: dir })
        assert.equal(after.stdout.trim(), "")
      },
      { model },
    )
  })

  // An assertion-graded case has no expected result to compare, so the result schema is the only hard evidence the
  // run has; without one the model's judgment is the whole of it.
  test("an assertion-graded Held-out example fails when the result schema refuses the result", async () => {
    const model = fakeModel({ cases: [{ args: { text: "three words here" }, confident: false }] })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", {
          ...creation({ name: "shaped_count" }),
          result_json: JSON.stringify({
            type: "object",
            properties: { total: { type: "integer" } },
            required: ["total"],
            additionalProperties: false,
          }),
          examples: [{ args: { text: "one two" }, expected: { total: 2 } }],
          execute_source: 'const n = args.text.trim().split(/\\s+/).filter(Boolean).length\nreturn args.text === "one two" ? { total: n } : { count: n }',
        })
        const read = await settled(flint, "shaped_count")
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.match(String(held.failures[0]?.["reason"]), /the result schema of the Tool refuses this result/)
        assert.match(String(held.failures[0]?.["reason"]), /count is not a key the result schema declares/)
        // The judgment never ran: a result the Tool's own schema refuses is not a result to ask a model about.
        assert.deepEqual(model.prompts.map((one) => one.kind), ["held-out"])
      },
      { model },
    )
  })

  test("a Held-out example that fails attaches to the Tool and leaves it Draft", async () => {
    const model = fakeModel({
      cases: [
        { args: { text: "a b" }, confident: true, expected: { count: 5 } },
        { args: { text: "c d" }, confident: false },
      ],
      plausible: false,
      clause: "Count the words in a piece of text",
      reason: "the count is larger than the number of words",
    })
    await withFlint(
      async (flint, dir) => {
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.equal(held.failures.length, 2)
        const stored = JSON.parse(await readFile(join(dir, "tools", "word_count", "held-out.json"), "utf8")) as {
          examples: { judgment: string | null }[]
        }
        assert.match(String(stored.examples[1]?.judgment), /The clause it judged against: "Count the words in a piece of text"\./)
        assert.deepEqual(held.failures[0], {
          index: 0,
          args: { text: "a b" },
          grade: "exact",
          expected: { count: 5 },
          actual: { count: 2 },
          reason: "the result is not the one the Held-out example expects",
        })
        assert.deepEqual(held.failures[1], {
          index: 1,
          args: { text: "c d" },
          grade: "assertion",
          expected: null,
          actual: { count: 2 },
          reason:
            'the count is larger than the number of words The clause it judged against: "Count the words in a piece of text".',
        })
        assert.deepEqual(await subjects(flint), ["verify:flintd", "create:agent"])
        assert.deepEqual(await flint.call("word_count", { text: "one two" }), { count: 2 })
      },
      { model },
    )
  })

  // The judge decides one question: does the result do what the Tool's own description says. A refusal that quotes
  // no clause of it is the judge's own requirement, so the case is undecided, which is neither a pass nor a failure.
  test("a judgment that quotes no clause of the Tool's own words decides nothing and leaves the Tool Draft", async () => {
    const model = fakeModel({
      cases: [{ args: { text: "Cafe au lait" }, confident: false }],
      plausible: false,
      clause: "it should transliterate accented letters",
      reason: "the Tool should have transliterated the accents first",
    })
    await withFlint(
      async (flint, dir) => {
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.deepEqual(held.failures, [])
        assert.match(held.reason ?? "", /1 of the 1 Held-out examples were not decided and count as no evidence\./)
        const stored = JSON.parse(await readFile(join(dir, "tools", "word_count", "held-out.json"), "utf8")) as {
          examples: { judgment: string | null }[]
        }
        assert.match(String(stored.examples[0]?.judgment), /named no clause of the Tool's description, so this example was not decided/)
        // The judge is given the Tool's description and is told it is the whole standard, and nothing else is quoted.
        assert.match(model.prompts[1]?.user ?? "", /Its description, and this is the whole standard: "Count the words in a piece of text\."/)
        assert.doesNotMatch(model.prompts[1]?.user ?? "", /result schema/)
      },
      { model },
    )
  })

  test("a run one case of which went undecided still passes on a case it did decide", async () => {
    const model = fakeModel({
      cases: [
        { args: { text: "one two" }, confident: true, expected: { count: 2 } },
        { args: { text: "Cafe au lait" }, confident: false },
      ],
      plausible: false,
      clause: "it should transliterate accented letters",
      reason: "the Tool should have transliterated the accents first",
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        assert.equal(read["state"], "verified")
        const held = view(read)
        assert.equal(held.status, "passed")
        assert.deepEqual(held.failures, [])
        assert.match(held.reason ?? "", /1 of the 2 Held-out examples were not decided/)
      },
      { model },
    )
  })

  // The result schema is enforced deterministically before the judge runs, so quoting a word of it quotes nothing.
  test("a judgment that quotes a word of the result schema and not of the description decides nothing", async () => {
    const model = fakeModel({
      cases: [{ args: { text: "one two" }, confident: false }],
      plausible: false,
      clause: "string",
      reason: "the label is not the kind of text the schema means",
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", {
          ...creation({ name: "labelled_count" }),
          result_json: JSON.stringify({
            type: "object",
            properties: { count: { type: "integer" }, label: { type: "string" } },
            required: ["count", "label"],
            additionalProperties: false,
          }),
          examples: [{ args: { text: "one two" }, expected: { count: 2, label: "words" } }],
          execute_source:
            'return { count: args.text.trim().split(/\\s+/).filter(Boolean).length, label: "words" }',
        })
        const read = await settled(flint, "labelled_count")
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.deepEqual(held.failures, [])
        assert.match(held.reason ?? "", /1 of the 1 Held-out examples were not decided and count as no evidence\./)
      },
      { model },
    )
  })

  test("a model answer flintd cannot read is a Held-out failure with a reason, never a refusal to the caller", async () => {
    const model = fakeModel({ generated: "Sure! Here are some cases for you." })
    await withFlint(
      async (flint) => {
        const created = (await flint.call("tool_create", creation())) as Read
        assert.equal(created["state"], "draft")
        const read = await settled(flint)
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.deepEqual(held.failures, [])
        assert.match(held.reason ?? "", /shape flintd does not read: the answer is not JSON/)
      },
      { model },
    )
  })

  test("with no model configured the Held-out status is unavailable and nothing else changes", async () => {
    await withFlint(async (flint) => {
      assert.deepEqual((await flint.status()).model, { configured: false })
      await flint.call("tool_create", creation())
      const read = (await flint.call("tool_read", { name: "word_count" })) as Read
      assert.equal(read["state"], "draft")
      const held = view(read)
      assert.equal(held.status, "unavailable")
      assert.deepEqual(held.failures, [])
      assert.match(held.reason ?? "", /no model configured/)
      assert.deepEqual(await subjects(flint), ["create:agent"])
      assert.deepEqual(await flint.call("word_count", { text: "one two" }), { count: 2 })
    })
  })

  test("a newer Version supersedes the Held-out run of the Version before it", async () => {
    let release: () => void = () => undefined
    const pause = new Promise<void>((wake) => {
      release = wake
    })
    const model = fakeModel({ cases: [{ args: { text: "a b" }, confident: true, expected: { count: 2 } }], pause })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        await waitFor(() => model.prompts.length === 1, "the Held-out run never reached the model")
        await flint.call("tool_update", { name: "word_count", execute_source: LOOSER_BODY })
        release()
        const read = await settled(flint)
        assert.equal(read["state"], "verified")
        // One verify Version, and it sits above the update: the run of the Version before it wrote nothing.
        assert.deepEqual(await subjects(flint), ["verify:flintd", "update:agent", "create:agent"])
        assert.equal(model.prompts.length, 2)
      },
      { model },
    )
  })

  test("the key of a configured model never reaches status(), the Library or the answer of a call", async () => {
    const key = "gate-test-model-key-not-a-real-credential"
    await withFlint(
      async (flint, dir) => {
        assert.deepEqual((await flint.status()).model, { configured: true, provider: "anthropic", model: "claude-sonnet-5" })
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.match(held.reason ?? "", /127\.0\.0\.1:1/)

        const written = [JSON.stringify((await flint.status())), JSON.stringify(read), ...(await everyFile(dir))]
        for (const text of written) assert.equal(text.includes(key), false)
      },
      { model: { provider: "anthropic", apiKey: key, baseUrl: "http://127.0.0.1:1" } },
    )
  })

  test("stop() cancels a Held-out run still waiting on the model rather than waiting with it", async () => {
    let release: () => void = () => undefined
    const pause = new Promise<void>((wake) => {
      release = wake
    })
    const model = fakeModel({ cases: [{ args: { text: "a b" }, confident: true, expected: { count: 2 } }], pause })
    const dir = await temporaryLibrary()
    const flint = createFlint({ dir, model })
    await flint.start()
    try {
      await flint.call("tool_create", creation())
      await waitFor(() => model.prompts.length === 1, "the Held-out run never reached the model")
      const from = Date.now()
      await flint.stop()
      assert.ok(Date.now() - from < 1000, "stop() waited for the model instead of cancelling the Held-out run")
      const written = await git("git", ["log", "--format=%s"], { cwd: dir })
      assert.deepEqual(written.stdout.trim().split("\n"), ["create(word_count): agent"])
    } finally {
      release()
      await flint.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a Held-out run leaves a Tool directory a person edited while it ran exactly as it found it", async () => {
    let release: () => void = () => undefined
    const pause = new Promise<void>((wake) => {
      release = wake
    })
    const model = fakeModel({ cases: [{ args: { text: "a b" }, confident: true, expected: { count: 2 } }], pause })
    await withFlint(
      async (flint, dir) => {
        await flint.call("tool_create", creation())
        await waitFor(() => model.prompts.length === 1, "the Held-out run never reached the model")
        const path = join(dir, "tools", "word_count", "body.js")
        const edited = `${await readFile(path, "utf8")}\n// a person was here\n`
        await writeFile(path, edited)
        release()

        // The run writes in a few milliseconds when it does not look, so this window is wide enough to catch it.
        const promoted = await watch(300, async () => (await subjects(flint)).includes("verify:flintd"))
        assert.equal(promoted, false, "the Held-out run wrote over an edit made while it ran")
        assert.equal(await readFile(path, "utf8"), edited)
        assert.equal(((await flint.call("tool_read", { name: "word_count" })) as Read)["state"], "draft")
        assert.deepEqual(await subjects(flint), ["create:agent"])
        const dirty = await git("git", ["status", "--porcelain"], { cwd: dir })
        assert.match(dirty.stdout, /tools\/word_count\/body\.js/)
      },
      { model },
    )
  })

  test("a case the model malformed is left out and the rest of the run still decides the Tool", async () => {
    const model = fakeModel({
      generated: JSON.stringify({
        cases: [
          { expected: { count: 1 } },
          { args: { text: "a b" }, confident: true, expected: { count: 2 } },
          { args: { text: "c" }, confident: "yes" },
        ],
      }),
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        assert.equal(read["state"], "verified")
        const held = view(read)
        assert.deepEqual(held.grades, { exact: 1, assertion: 0 })
        assert.match(held.reason ?? "", /case 0 carries no "args" and was left out\./)
        assert.match(held.reason ?? "", /case 2 carries no "confident" boolean and was left out\./)
      },
      { model },
    )
  })

  // The generator, not the Tool, wrote those arguments, and a Tool that refuses them is doing what it declared.
  test("a case whose arguments the Tool's own schema refuses is left out and never fails the Tool", async () => {
    const model = fakeModel({
      generated: JSON.stringify({
        cases: [
          { args: JSON.stringify({ path: "README.md" }), confident: true, expected: JSON.stringify({ count: 1 }) },
          { args: JSON.stringify({ text: "a b" }), confident: true, expected: JSON.stringify({ count: 2 }) },
        ],
      }),
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        assert.equal(read["state"], "verified")
        const held = view(read)
        assert.equal(held.status, "passed")
        assert.deepEqual(held.failures, [])
        assert.deepEqual(held.grades, { exact: 1, assertion: 0 })
        assert.match(held.reason ?? "", /case 0 carries arguments the Tool's own schema refuses, and was left out: /)
      },
      { model },
    )
  })

  test("a Tool that throws where no clause of its description accepts those arguments is not failed for it", async () => {
    const model = fakeModel({ cases: [{ args: { text: "boom" }, confident: false }] })
    await withFlint(
      async (flint, dir) => {
        await flint.call("tool_create", { ...creation({ name: "brittle_count" }), execute_source: BRITTLE_SOURCE })
        const read = await settled(flint, "brittle_count")
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.deepEqual(held.failures, [])
        assert.match(held.reason ?? "", /1 of the 1 Held-out examples were not decided and count as no evidence\./)
        const stored = JSON.parse(await readFile(join(dir, "tools", "brittle_count", "held-out.json"), "utf8")) as {
          examples: { judgment: string | null }[]
        }
        assert.match(String(stored.examples[0]?.judgment), /the Tool's description was not shown to accept those arguments/)
        // The judge of a refusal sees the description, the arguments and what was thrown, and not the Body.
        assert.deepEqual(model.prompts.map((one) => one.kind), ["held-out", "acceptance"])
        assert.match(model.prompts[1]?.user ?? "", /What it threw: "brittle_count threw: the Body refused that text"/)
        assert.doesNotMatch(model.prompts[1]?.user ?? "", /filter\(Boolean\)/)
      },
      { model },
    )
  })

  test("a Tool that throws on arguments a clause of its description accepts fails the Tool", async () => {
    const model = fakeModel({
      cases: [{ args: { text: "boom" }, confident: false }],
      accepted: true,
      clause: "Count the words in a piece of text",
      reason: "the description takes any piece of text",
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", { ...creation({ name: "charged_count" }), execute_source: BRITTLE_SOURCE })
        const read = await settled(flint, "charged_count")
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.equal(held.failures.length, 1)
        assert.match(
          String(held.failures[0]?.["reason"]),
          /the Tool did not produce a result: charged_count threw: the Body refused that text the description takes any piece of text The clause it judged against: "Count the words in a piece of text"\./,
        )
        assert.equal(held.reason ?? "", "")
      },
      { model },
    )
  })

  test("a Tool that throws at every Held-out example decides nothing and stays Draft", async () => {
    const model = fakeModel({
      cases: [
        { args: { text: "boom" }, confident: false },
        { args: { text: "bang" }, confident: false },
      ],
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", {
          ...creation({ name: "always_throws" }),
          execute_source: 'if (args.text !== "one two three") throw new Error("the Body refused that text")\nreturn { count: 3 }',
        })
        const read = await settled(flint, "always_throws")
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.deepEqual(held.failures, [])
        assert.match(held.reason ?? "", /2 of the 2 Held-out examples were not decided and count as no evidence\./)
      },
      { model },
    )
  })

  test("a result larger than the cap is cut before it is committed, and the reason says so", async () => {
    const model = fakeModel({ cases: [{ args: { size: 20000 }, confident: true, expected: "" }] })
    await withFlint(
      async (flint, dir) => {
        await flint.call("tool_create", {
          name: "long_text",
          description: "Return a piece of text of the length asked for.",
          parameters_json: JSON.stringify({
            type: "object",
            properties: { size: { type: "integer" } },
            required: ["size"],
            additionalProperties: false,
          }),
          execute_source: 'return "x".repeat(args.size)',
          examples: [{ args: { size: 3 }, expected: "xxx" }],
        })
        const read = await settled(flint, "long_text")
        const held = view(read)
        assert.equal(held.status, "failed")
        const actual = held.failures[0]?.["actual"]
        assert.equal(typeof actual, "string")
        assert.equal((actual as string).length, 4096)
        assert.match(String(held.failures[0]?.["reason"]), /cut to the first 4096 bytes of its JSON/)
        const written = await readFile(join(dir, "tools", "long_text", "held-out.json"), "utf8")
        assert.ok(written.length < 20000, "the Held-out file carries the whole result")
      },
      { model },
    )
  })

  test("a Held-out run that cannot finish its write says so through onLog instead of going quiet", async () => {
    const lines: string[] = []
    let release: () => void = () => undefined
    const pause = new Promise<void>((wake) => {
      release = wake
    })
    const model = fakeModel({ cases: [{ args: { text: "a b" }, confident: true, expected: { count: 2 } }], pause })
    await withFlint(
      async (flint, dir) => {
        await flint.call("tool_create", creation())
        await waitFor(() => model.prompts.length === 1, "the Held-out run never reached the model")
        await rm(join(dir, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        release()
        await waitFor(() => lines.length > 0, "the Held-out run logged nothing")
        assert.match(lines[0] ?? "", /^word_count: the Held-out run did not finish: /)
      },
      { model, onLog: (entry) => lines.push(`${entry.tool}: ${entry.message}`) },
    )
  })

  test("a run that reaches its own bound leaves the Tool Draft with a reason, and says so through onLog", async () => {
    const lines: string[] = []
    // Never released: the run's own deadline is what ends it, and stop() is not what cut it.
    const model = fakeModel({
      cases: [{ args: { text: "a b" }, confident: true, expected: { count: 2 } }],
      pause: new Promise<void>(() => undefined),
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        assert.equal(read["state"], "draft")
        const held = view(read)
        assert.equal(held.status, "failed")
        assert.deepEqual(held.failures, [])
        assert.match(held.reason ?? "", /the run stopped after 0 of 1 Held-out examples\./)
        await waitFor(() => lines.length > 0, "the Held-out run logged nothing")
        assert.match(lines[0] ?? "", /^word_count: the Held-out run stopped at its bound of 60 ms and stays Draft$/)
      },
      { model, heldOutTimeoutMs: 60, onLog: (entry) => lines.push(`${entry.tool}: ${entry.message}`) },
    )
  })

  // The model writes the arguments and the result as JSON strings, and a value it sent unwrapped still reads.
  test("a case the model wrote as a JSON string and one it wrote as a value both read", async () => {
    const model = fakeModel({
      generated: JSON.stringify({
        cases: [
          { args: JSON.stringify({ text: "a b" }), confident: true, expected: JSON.stringify({ count: 2 }) },
          { args: { text: "c d e" }, confident: true, expected: { count: 3 } },
        ],
      }),
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        const read = await settled(flint)
        assert.equal(read["state"], "verified")
        assert.deepEqual(view(read).grades, { exact: 2, assertion: 0 })
      },
      { model },
    )
  })

  // A model that writes an array into a JSON string closes the answer's own brackets inside it as well, which left
  // the Tool compared against a piece of text it could never equal.
  test("an expected array the model closed twice reads as that array and the Tool becomes Verified", async () => {
    const model = fakeModel({
      generated: JSON.stringify({
        cases: [
          { args: { text: "a b" }, confident: true, expected: '["a","b"]}]}' },
          { args: { text: "c d e" }, confident: true, expected: '["c","d","e"]' },
        ],
      }),
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", splitting())
        const read = await settled(flint, "split_words")
        assert.equal(read["state"], "verified")
        assert.deepEqual(view(read), { status: "passed", grades: { exact: 2, assertion: 0 }, failures: [] })
      },
      { model },
    )
  })

  test("an expected array of objects the model closed twice reads as that array", async () => {
    const model = fakeModel({
      generated: JSON.stringify({
        cases: [{ args: { text: "a b" }, confident: true, expected: '[{"at":0,"word":"a"},{"at":1,"word":"b"}]}]}' }],
      }),
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", {
          ...splitting({ name: "number_words" }),
          execute_source:
            "return args.text.trim().split(/\\s+/).filter(Boolean).map((word, at) => ({ at, word }))",
          examples: [{ args: { text: "one" }, expected: [{ at: 0, word: "one" }] }],
        })
        const read = await settled(flint, "number_words")
        assert.equal(read["state"], "verified")
        assert.deepEqual(view(read).grades, { exact: 1, assertion: 0 })
      },
      { model },
    )
  })

  // A result that is a piece of text starts no array and no object, so it stays the text the model sent.
  test("a text result the model sent without its quotes still reads as that text", async () => {
    const model = fakeModel({ generated: JSON.stringify({ cases: [{ args: { text: "a b" }, confident: true, expected: "2 words" }] }) })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", {
          ...splitting({ name: "say_count" }),
          execute_source: 'return args.text.trim().split(/\\s+/).filter(Boolean).length + " words"',
          examples: [{ args: { text: "one" }, expected: "1 words" }],
        })
        const read = await settled(flint, "say_count")
        assert.equal(read["state"], "verified")
        assert.deepEqual(view(read).grades, { exact: 1, assertion: 0 })
      },
      { model },
    )
  })

  test("start works through the Drafts that never had a Held-out run, oldest first, a few at a time", async () => {
    let release = (): void => undefined
    const model = fakeModel({
      cases: [{ args: { text: "one two" }, confident: true, expected: { count: 2 } }],
      pause: new Promise<void>((ok) => {
        release = ok
      }),
    })
    const names = ["c_tool", "b_tool", "a_tool"]
    const dir = await temporaryLibrary()
    try {
      const first = createFlint({ dir })
      await first.start()
      for (const name of names) await first.call("tool_create", creation({ name }))
      await first.stop()

      const second = createFlint({ dir, model, heldOutConcurrency: 2 })
      await second.start()
      try {
        await waitFor(() => model.prompts.length === 2, "the sweep never reached the model")
        await new Promise((wake) => setTimeout(wake, 20))
        // The third Draft waits for a run to end rather than reaching the model with the other two.
        assert.equal(model.prompts.length, 2)
        release()
        await verified(second, ...names)
        assert.equal(model.inFlight.peak, 2)
        // The two oldest Drafts go first, in either order between them, and the newest waits for a free turn.
        const asked = model.prompts.map((one) => one.user.split("\n")[0])
        assert.deepEqual(asked.slice(0, 2).sort(), ["Tool: b_tool", "Tool: c_tool"])
        assert.equal(asked[2], "Tool: a_tool")
      } finally {
        release()
        await second.stop()
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  function splitting(overrides: { [key: string]: JsonValue } = {}): { [key: string]: JsonValue } {
    return {
      name: "split_words",
      description: "Split a piece of text into its words.",
      parameters_json: JSON.stringify({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      }),
      execute_source: "return args.text.trim().split(/\\s+/).filter(Boolean)",
      examples: [{ args: { text: "one two" }, expected: ["one", "two"] }],
      ...overrides,
    }
  }

  async function watch(withinMs: number, ready: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + withinMs
    while (Date.now() < deadline) {
      if (await ready()) return true
      await new Promise((wake) => setTimeout(wake, 5))
    }
    return false
  }

  async function everyFile(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    const texts: string[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      texts.push(await readFile(join(entry.parentPath, entry.name), "utf8").catch(() => ""))
    }
    return texts
  }
})
