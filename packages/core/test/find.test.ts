import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { describe, test } from "node:test"
import { fakeModel } from "./fake-model.ts"
import type { FakeModel } from "./fake-model.ts"
import { creation, refusal, temporaryLibrary, verified, withFlint, withOpenFlint } from "./support.ts"
import { createFlint } from "../src/index.ts"
import type { FindEntry, Flint, JsonValue, LogEntry } from "../src/index.ts"

const FAHRENHEIT: { [key: string]: JsonValue } = {
  name: "celsius_to_fahrenheit",
  description: "Convert a temperature out of Celsius and into degrees Fahrenheit.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { celsius: { type: "number", description: "The temperature in degrees Celsius." } },
    required: ["celsius"],
    additionalProperties: false,
  }),
  execute_source: "return { fahrenheit: (args.celsius * 9) / 5 + 32 }",
  examples: [{ args: { celsius: 100 }, expected: { fahrenheit: 212 } }],
}

const JSON_PRETTY: { [key: string]: JsonValue } = {
  name: "json_pretty",
  description: "Format a JSON string into lines of indented text so the reader can follow it. Bad JSON throws.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { source: { type: "string", description: "The JSON to format." } },
    required: ["source"],
    additionalProperties: false,
  }),
  execute_source: "return JSON.stringify(JSON.parse(args.source), null, 2)",
  examples: [{ args: { source: '{"a":1}' }, expected: '{\n  "a": 1\n}' }],
}

// The name tokens of these two are one set and their descriptions are almost one set: only the arguments say
// which way round they go.
const CSV_TO_JSON: { [key: string]: JsonValue } = {
  name: "csv_to_json",
  description: "Turn a CSV string into a list of JSON objects.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { csv: { type: "string" } },
    required: ["csv"],
    additionalProperties: false,
  }),
  execute_source: "return { objects: args.csv.split('\\n').length }",
  examples: [{ args: { csv: "a,b" }, expected: { objects: 1 } }],
}

const JSON_TO_CSV: { [key: string]: JsonValue } = {
  name: "json_to_csv",
  description: "Turn a list of JSON objects into a CSV string.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { rows: { type: "array", items: { type: "object", additionalProperties: true } } },
    required: ["rows"],
    additionalProperties: false,
  }),
  execute_source: "return { csv: args.rows.length + ' rows' }",
  examples: [{ args: { rows: [{ a: 1 }] }, expected: { csv: "1 rows" } }],
}

// One set of tokens between them, in a different order, so a search scores them identically and only the
// Contribution can break the tie.
// Grouped with word_count on its words, and ranked above it by a query that names a sentence.
const NEARBY: { [key: string]: JsonValue } = {
  ...creation(),
  name: "sentence_word_count",
  description: "Count the words in a piece of prose or a sentence.",
}

const TIED_ONE: { [key: string]: JsonValue } = { ...creation(), name: "text_word_count" }
const TIED_TWO: { [key: string]: JsonValue } = { ...creation(), name: "word_count_text" }

// The same set of tokens as word_count, so the thresholds alone decide and no model is ever asked.
const CERTAIN_COPY: { [key: string]: JsonValue } = { ...creation(), name: "count_word" }

// The name an agent reaches for when it has forgotten it already wrote word_count: one capability, two names, and
// not one word of the two descriptions in common beyond the work they both do.
const COUNT_WORDS: { [key: string]: JsonValue } = {
  ...creation(),
  name: "count_words",
  description: "Count how many words a piece of text holds.",
}

const SHA256: { [key: string]: JsonValue } = {
  name: "sha256_hex",
  description: "Return the SHA-256 digest of a piece of text as lower-case hexadecimal.",
  parameters_json: JSON.stringify({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  }),
  execute_source: "return 'deadbeef'",
  examples: [{ args: { text: "abc" }, expected: "deadbeef" }],
}

function like(name: string, description: string): { [key: string]: JsonValue } {
  return { ...SHA256, name, description }
}

const SHA256_HELD_OUT = [{ args: { text: "abc" }, confident: true, expected: "deadbeef" }]
const HELD_OUT_PASSES = [{ args: { text: "one two three" }, confident: true, expected: { count: 3 } }]

function names(found: readonly FindEntry[]): string[] {
  return found.map((one) => one.name)
}

async function called(result: Promise<JsonValue>): Promise<{ query: string; limit: number; tools: FindEntry[] }> {
  return (await result) as unknown as { query: string; limit: number; tools: FindEntry[] }
}

describe("retrieval", { concurrency: true }, () => {
  test("a lexical search with no model ranks the Tool that answers the query first", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", creation())
      await flint.call("tool_create", FAHRENHEIT)
      await flint.call("tool_create", JSON_PRETTY)

      for (const [query, wanted] of [
        ["count the words in a sentence", "word_count"],
        ["convert a temperature to fahrenheit", "celsius_to_fahrenheit"],
        ["pretty print a json document", "json_pretty"],
      ] as [string, string][]) {
        const found = await flint.find(query)
        assert.equal(found[0]?.name, wanted, `${query} put ${String(found[0]?.name)} first`)
        // The score is the share of the query the Tool matched, not a rank normalized to the best result.
        assert.ok((found[0]?.score ?? 0) > 0.3 && (found[0]?.score ?? 0) <= 1, `score ${String(found[0]?.score)}`)
        assert.equal(found[0]?.siblings.length, 0)
      }

      const one = (await flint.find("pretty print a json document"))[0] as FindEntry
      assert.equal(one.description, "Format a JSON string into lines of indented text so the reader can follow it.")
      assert.equal(one.state, "draft")
      assert.equal(one.library, "user")
      assert.equal(one.contribution, 0)

      assert.deepEqual(await flint.find("tool_find"), [])
      assert.deepEqual(await flint.find("tally each phrase"), [])
      // Every word of this query is in every one of these Tools, so it separates none of them.
      assert.deepEqual(await flint.find("the a of"), [])
      await flint.call("tool_retire", { name: "json_pretty" })
      assert.deepEqual(await flint.find("pretty print a json document"), [])
    })
  })

  test("a Draft is found by the session that wrote it and by no other", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", creation(), { sessionId: "alpha" })
      const mine = await called(flint.call("tool_find", { query: "count the words" }, { sessionId: "alpha" }))
      assert.deepEqual(names(mine.tools), ["word_count"])
      assert.equal(mine.limit, 5)
      assert.deepEqual((await called(flint.call("tool_find", { query: "count the words" }, { sessionId: "beta" }))).tools, [])
      // A caller that names no session is the Tenant, and every Draft of the Tenant answers it.
      assert.deepEqual(names(await flint.find("count the words")), ["word_count"])

      const long = await called(flint.call("tool_find", { query: `count ${"x".repeat(5000)}`, limit: 20 }))
      assert.equal(long.query.length, 2000)
      assert.equal(long.limit, 5)
    })
  })

  test("two Tools that do opposite work are told apart by their arguments", async () => {
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", CSV_TO_JSON)
        await flint.call("tool_create", JSON_TO_CSV)
        await flint.call("tool_create", FAHRENHEIT)
        await flint.call("csv_to_json", { csv: "a,b" })
        const found = await flint.find("json to csv")
        assert.deepEqual(names(found).sort(), ["csv_to_json", "json_to_csv"])
        assert.deepEqual(found[0]?.siblings, [])
        // The Tool with the Contribution is the wrong answer to this query, and the ranking says so.
        assert.equal((await flint.find("convert json rows into a csv string"))[0]?.name, "json_to_csv")
      },
      // Their names and their descriptions are one set of words in a different order, so only what each one takes
      // separates them, and this is the line above which that is the whole of the difference.
      { siblingThreshold: 0.95 },
    )
  })

  test("the query picks the representative of a group, not the Tool that earned the most", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", creation())
      await flint.call("tool_create", NEARBY)
      await flint.call("tool_create", FAHRENHEIT)
      await flint.call("word_count", { text: "one two" })
      const found = await flint.find("count the words in a sentence")
      assert.equal(found.length, 1)
      // word_count has the Contribution and the query still asked for the other one.
      assert.equal(found[0]?.name, "sentence_word_count")
      assert.equal(found[0]?.contribution, 0)
      assert.deepEqual(found[0]?.siblings, [{ name: "word_count", state: "draft", library: "user" }])
    })
  })

  test("one capability under two names is one entry, and one word of the name finds it", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", creation())
      const second = (await flint.call("tool_create", COUNT_WORDS)) as { warning?: string }
      // The save already said these two may be one capability, so no search may offer them as two answers.
      assert.match(String(second.warning), /"word_count"/)

      for (const query of [
        "count the words in a text",
        "how many words does a text hold",
        "count_words",
        "words",
      ]) {
        const found = await flint.find(query)
        assert.deepEqual(names(found), ["count_words"], query)
        assert.deepEqual(found[0]?.siblings, [{ name: "word_count", state: "draft", library: "user" }], query)
      }
    })
  })

  test("the Contribution breaks a tie between two Tools the query cannot separate", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", TIED_ONE)
      await flint.call("tool_create", TIED_TWO)
      await flint.call("tool_create", FAHRENHEIT)
      await flint.call("word_count_text", { text: "one two" })
      // The two hold one set of tokens in a different order, so nothing but the Contribution separates them.
      const tied = await flint.find("count the words in a piece of text")
      assert.equal(tied.length, 1)
      assert.equal(tied[0]?.name, "word_count_text")
      assert.equal(tied[0]?.contribution, 1)
      assert.deepEqual(tied[0]?.siblings, [{ name: "text_word_count", state: "draft", library: "user" }])
    })
  })

  test("an embedding-capable adapter answers a paraphrase, and still answers nothing to a junk query", async () => {
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        await flint.call("tool_create", FAHRENHEIT)
        assert.equal((await flint.find("tally each phrase"))[0]?.name, "word_count")
        // The lexical search still decides a query whose words are in the Library.
        assert.equal((await flint.find("convert a temperature to fahrenheit"))[0]?.name, "celsius_to_fahrenheit")
        // The cosine list has a floor of its own, so a query that means nothing answers nothing on both retrievers.
        assert.deepEqual(await flint.find("xyzzy plugh frobnicate"), [])
        assert.deepEqual(await flint.find("zzz"), [])
      },
      { model: fakeModel({ embedding: true, synonyms: { tally: "count", phrase: "text" } }) },
    )
  })

  test("the cosine thresholds decide the vector floor, the siblings and the duplicates", async () => {
    const model = fakeModel({ embedding: true, judgments: { celsius_to_fahrenheit: true } })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        // A floor of almost nothing lets the junk query through the vector retriever, which is what the default stops.
        assert.equal((await flint.find("xyzzy plugh frobnicate"))[0]?.name, "word_count")
        // A cosine duplicate threshold of almost nothing makes two Tools that share no word one capability.
        const near = (await flint.call("tool_create", FAHRENHEIT)) as { warning?: string }
        assert.match(String(near.warning), /Draft named "word_count"/)
        // A cosine sibling threshold of almost nothing groups two Tools that share no word.
        const found = await flint.find("count the words in a sentence")
        assert.equal(found.length, 1)
        assert.deepEqual(names(found[0]?.siblings.map((one) => ({ ...one, description: "", contribution: 0, score: 0, siblings: [] })) ?? []), [
          "celsius_to_fahrenheit",
        ])
      },
      { model, searchCosine: 0.01, siblingCosine: 0.01, duplicateCosine: 0.01, duplicateCosineBand: 0.005 },
    )
  })

  test("an embedding that fails leaves a lexical search and a line in the log", async () => {
    const logged: LogEntry[] = []
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        assert.deepEqual(names(await flint.find("count the words")), ["word_count"])
        assert.deepEqual(await flint.find("tally each phrase"), [])
        assert.ok(
          logged.some((entry) => entry.message.includes("no embedding endpoint")),
          `nothing in the log named the failure: ${JSON.stringify(logged)}`,
        )
      },
      {
        model: fakeModel({ embedding: true, embedError: "no embedding endpoint" }),
        onLog: (entry) => logged.push(entry),
      },
    )
  })

  test("stop() gives up on an embedding that ignores it, and the pass that wakes later writes nothing", async () => {
    const logged: LogEntry[] = []
    const dir = await temporaryLibrary()
    try {
      await withOpenFlint({ dir }, async (flint) => {
        await flint.call("tool_create", creation())
      })
      // The pass at start() is the one that covers a whole Library, and this provider never honours its signal.
      const model = fakeModel({
        cases: HELD_OUT_PASSES,
        embedding: true,
        // Far longer than the 250 ms a search waits for a pass, so the two are told apart by a wide margin rather
        // than by 45 ms of headroom that a slow machine eats.
        embedPauseMs: 4000,
      })
      const flint = createFlint({ dir, model, stopGraceMs: 50, onLog: (entry) => logged.push(entry) })
      await flint.start()
      // A search reads the vectors a pass has written; it never waits out a pass over a whole Library.
      const searched = Date.now()
      assert.deepEqual(names(await flint.find("count the words in a sentence")), ["word_count"])
      const waited = Date.now() - searched
      assert.ok(waited < 2000, `the search waited ${waited} ms for a pass that had not finished`)
      await flint.stop()
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
    // The pass wakes after the Library is closed; a pass of an older generation writes nothing and says nothing.
    await new Promise((wake) => setTimeout(wake, 300))
    assert.deepEqual(logged.filter((entry) => entry.message.includes("is not open")), [])
  })

  test("a create waits for the embeddings of a Library that has never been embedded", async () => {
    const dir = await temporaryLibrary()
    try {
      await withOpenFlint({ dir }, async (flint) => {
        await flint.call("tool_create", creation())
      })
      // The vectors are made by the pass at start(), and this provider is slower than a search would wait for.
      const model = fakeModel({ cases: HELD_OUT_PASSES, embedding: true, embedPauseMs: 300 })
      await withOpenFlint({ dir, model, duplicateCosine: 0.01, duplicateCosineBand: 0.005 }, async (flint) => {
        // Nothing lexical connects these two; only a vector the pass has not written yet can find the likeness.
        const saved = (await flint.call("tool_create", FAHRENHEIT)) as { warning?: string }
        assert.match(String(saved.warning), /"word_count"/)
      })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test("a near-duplicate of an Active Tool is refused, and a schema change into one is refused too", async () => {
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", creation())
        await verified(flint, "word_count")
        for (const sessionId of ["alpha", "alpha", "alpha", "beta", "beta"]) {
          await flint.call("word_count", { text: "one two" }, { sessionId })
        }
        assert.equal((await flint.status()).active, 1)

        const refused = await refusal(() => flint.call("tool_create", CERTAIN_COPY))
        assert.equal(refused.code, "duplicate")
        assert.match(refused.message, /"word_count"/)
        assert.match(refused.message, /an Active Tool/i)
        assert.match(refused.message, /call it instead of writing a copy/)
        assert.equal(refused.details["state"], "active")
        assert.equal(refused.details["judged"], null)
        assert.deepEqual(refused.details["parameters"], JSON.parse(creation()["parameters_json"] as string))
        assert.equal((await flint.library()).length, 1)

        await flint.call("tool_create", {
          ...creation(),
          name: "letter_count",
          description: "Return how many letters a string holds.",
        })
        const changed = await refusal(() =>
          flint.call("tool_update", { name: "letter_count", description: "Count the words in a piece of text." }),
        )
        assert.equal(changed.code, "duplicate")
        assert.equal(changed.details["name"], "word_count")

        // A new Body is the same capability, so it is never a duplicate of anything.
        const saved = (await flint.call("tool_update", {
          name: "letter_count",
          execute_source: "return { count: args.text.length }",
          examples: [{ args: { text: "ab" }, expected: { count: 2 } }],
        })) as { version: string }
        assert.equal(typeof saved.version, "string")
      },
      { model: fakeModel({ cases: HELD_OUT_PASSES, judgments: { count_word: true, letter_count: true } }) },
    )
  })

  test("the model decides the band between alike and certain, and is never asked outside it", async () => {
    const model = fakeModel({
      cases: SHA256_HELD_OUT,
      judgments: { hash_sha256: true, digest_text: true, checksum: true, sha512_hex: false },
    })
    await withFlint(
      async (flint) => {
        await flint.call("tool_create", SHA256)
        await verified(flint, "sha256_hex")
        const judgments = (): number => model.prompts.filter((one) => one.kind === "duplicate").length

        // Above the certainty threshold: the same words, refused, and the model is not asked.
        const asked = judgments()
        const certain = await refusal(() =>
          flint.call("tool_create", like("hex_sha256", SHA256["description"] as string)),
        )
        assert.equal(certain.code, "duplicate")
        assert.equal(certain.details["judged"], null)
        assert.equal(judgments(), asked)

        // In the band, and the model says the two do different work.
        const different = (await flint.call(
          "tool_create",
          like("sha512_hex", "Return the SHA-512 digest of a piece of text as lower-case hexadecimal."),
        )) as { state: string; warning?: string }
        assert.equal(different.state, "draft")
        assert.equal(different.warning, undefined)

        // In the band, and the model says the two are one capability. Three shapes of the same Tool, all refused.
        for (const [name, description] of [
          ["hash_sha256", "Return the SHA-256 digest of a piece of text as lower-case hexadecimal."],
          ["digest_text", "Compute a cryptographic fingerprint for a string and give it back in base 16."],
          ["checksum", "Hash some input with SHA-256 and answer with the hexadecimal digest."],
        ] as [string, string][]) {
          const copy = await refusal(() => flint.call("tool_create", like(name, description)))
          assert.equal(copy.code, "duplicate", name)
          assert.equal(copy.details["name"], "sha256_hex")
          assert.match(copy.message, /the model read both and said they are one capability/i)
        }
        assert.equal(judgments(), asked + 4)
        assert.deepEqual(
          (await flint.library()).map((one) => one.name).sort(),
          ["sha256_hex", "sha512_hex"],
        )
      },
      // The band reaches down to a tenth so the two Tools that share almost no word still reach the model; the
      // default 0.5 leaves them to the embedding cosine, which a keyless install does not have.
      { model, duplicateBand: 0.1 },
    )
  })

  test("with no model the thresholds alone decide, a copy of a Draft warns, and a restore runs the same check", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", SHA256)
      // No model, so nothing above the band and below certainty is ever refused.
      const saved = (await flint.call(
        "tool_create",
        like("digest_text", "Compute a cryptographic fingerprint for a string and give it back in base 16."),
      )) as { state: string; warning?: string }
      assert.equal(saved.state, "draft")
      assert.equal(saved.warning, undefined)

      // In the band, and no model to judge it: the save goes through and the answer names the Tool it reads like.
      const banded = (await flint.call(
        "tool_create",
        like("hash_sha256", SHA256["description"] as string),
      )) as { state: string; warning?: string }
      assert.equal(banded.state, "draft")
      assert.match(String(banded.warning), /"sha256_hex"/)
      assert.match(String(banded.warning), /0\.875/)
      assert.match(String(banded.warning), /could not get a judgment/)

      await flint.call("tool_create", creation())
      assert.equal((await refusal(() => flint.call("tool_create", creation()))).code, "exists")
      const copy = (await flint.call("tool_create", CERTAIN_COPY)) as { warning?: string }
      assert.match(String(copy.warning), /Draft named "word_count"/)
      const history = (await flint.call("tool_history", { name: "count_word" })) as { versions: { id: string }[] }
      await flint.call("tool_retire", { name: "count_word" })
      const restored = (await flint.call("tool_update", {
        name: "count_word",
        restore_version: history.versions[0]?.id ?? "",
      })) as { warning?: string }
      // The Version coming back is still a copy of word_count, and the restore says so.
      assert.match(String(restored.warning), /Draft named "word_count"/)
    })
  })
})

// The two digests share every word but one, so the SHA-512 Tool outranks the SHA-256 one against a paraphrase of
// the SHA-256 one. Judging only the best of the band let that paraphrase through.
const SHA256_LONG = "Return the SHA-256 digest of a piece of text as lower-case hexadecimal, sixty-four characters long."
const SHA512_SHORT = "Return the SHA-512 digest of a piece of text as lower-case hexadecimal."
const PARAPHRASE = "Return the digest of a piece of text as lower-case hexadecimal."

// The second create is itself in the band of the first, and the model calls the two different, so it is saved.
async function twoDigests(flint: Flint): Promise<{ state: string; warning?: string }> {
  await flint.call("tool_create", like("sha512_hex", SHA512_SHORT))
  const second = (await flint.call("tool_create", like("sha256_hex", SHA256_LONG))) as { state: string; warning?: string }
  await verified(flint, "sha512_hex", "sha256_hex")
  return second
}

function judged(model: FakeModel): string[] {
  return model.prompts
    .filter((one) => one.kind === "duplicate")
    .map((one) => /Library already holds:\nName: (\w+)/.exec(one.user)?.[1] ?? "")
}

test("every Tool in the band is judged, best first, until one of them is the same capability", async () => {
  const model = fakeModel({ cases: SHA256_HELD_OUT, judgments: { sha512_hex: false, sha256_hex: true } })
  await withFlint(
    async (flint) => {
      const different = await twoDigests(flint)
      assert.equal(different.state, "draft")
      assert.equal(different.warning, undefined)
      const asked = judged(model).length

      const copy = await refusal(() => flint.call("tool_create", like("digest_hex", PARAPHRASE)))
      assert.equal(copy.code, "duplicate")
      assert.equal(copy.details["name"], "sha256_hex")
      // sha512_hex scored higher and was judged first; the refusal is the Tool behind it in the band.
      assert.deepEqual(judged(model).slice(asked), ["sha512_hex", "sha256_hex"])
      assert.deepEqual((await flint.library()).map((one) => one.name).sort(), ["sha256_hex", "sha512_hex"])
    },
    { model },
  )
})

test("one create asks the model duplicateMaxJudgments times, and the band it never judged is a warning", async () => {
  const model = fakeModel({ cases: SHA256_HELD_OUT, judgments: { sha512_hex: false, sha256_hex: true } })
  await withFlint(
    async (flint) => {
      await twoDigests(flint)
      const asked = judged(model).length

      const saved = (await flint.call("tool_create", like("digest_hex", PARAPHRASE))) as {
        state: string
        warning?: string
      }
      assert.equal(saved.state, "draft")
      assert.deepEqual(judged(model).slice(asked), ["sha512_hex"])
      assert.match(String(saved.warning), /"sha256_hex"/)
      assert.match(String(saved.warning), /0\.6316/)
    },
    { model, duplicateMaxJudgments: 1 },
  )
})
