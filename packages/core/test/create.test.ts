import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { creation, refusal, sharedLibrary, withFlint } from "./support.ts"

const clean = sharedLibrary()

const git = promisify(execFile)

test("tool_create refuses a name outside the allowed pattern", async () => {
  await clean(async (flint) => {
    for (const name of ["WordCount", "1word", "word-count", "word count", ""]) {
      const error = await refusal(() => flint.call("tool_create", creation({ name })))
      assert.equal(error.code, "invalid_name")
    }
  })
})

test("tool_create refuses a name over sixty characters", async () => {
  await clean(async (flint) => {
    const error = await refusal(() => flint.call("tool_create", creation({ name: `a${"b".repeat(60)}` })))
    assert.equal(error.code, "invalid_name")
    assert.equal(error.details["maximum"], 60)
  })
})

test("tool_create refuses the meta tool names and the export prefix", async () => {
  await clean(async (flint) => {
    for (const name of ["tool_create", "tool_run", "fl_word_count"]) {
      const error = await refusal(() => flint.call("tool_create", creation({ name })))
      assert.equal(error.code, "invalid_name")
    }
  })
})

test("tool_create refuses an argument schema that is not an object schema", async () => {
  await clean(async (flint) => {
    for (const parameters_json of ['"text"', JSON.stringify({ type: "string" }), "{not json"]) {
      const error = await refusal(() => flint.call("tool_create", creation({ parameters_json })))
      assert.equal(error.code, "invalid_schema")
    }
  })
})

test("tool_create refuses a schema keyword that flintd does not check", async () => {
  await clean(async (flint) => {
    const parameters_json = JSON.stringify({
      type: "object",
      properties: { text: { type: "string", format: "email" } },
    })
    const error = await refusal(() => flint.call("tool_create", creation({ parameters_json })))
    assert.equal(error.code, "invalid_schema")
    assert.match(error.message, /format/)
  })
})

test("tool_create refuses a Body that does not parse and names the line", async () => {
  await clean(async (flint) => {
    const error = await refusal(() =>
      flint.call("tool_create", creation({ execute_source: "const a = 1\nreturn a +" })),
    )
    assert.equal(error.code, "invalid_source")
    assert.equal(error.details["line"], 2)
  })
})

test("tool_create refuses a Body that closes the function early", async () => {
  await clean(async (flint) => {
    const error = await refusal(() =>
      flint.call("tool_create", creation({ execute_source: "return 1\n}\nglobalThis.leak = 1\nfunction rest() {" })),
    )
    assert.equal(error.code, "invalid_source")
    assert.equal(error.details["topLevelStatements"], 3)
  })
})

test("tool_create unwraps a Body that carries the outer function", async () => {
  await withFlint(async (flint) => {
    const execute_source = "async function execute(args, ctx) {\n  return { count: args.text.split(' ').length }\n}"
    await flint.call("tool_create", creation({ execute_source }))
    assert.deepEqual(await flint.call("word_count", { text: "one two three" }), { count: 3 })
  })
})

test("tool_create requires at least one Example", async () => {
  await clean(async (flint) => {
    const error = await refusal(() => flint.call("tool_create", creation({ examples: [] })))
    assert.equal(error.code, "invalid_arguments")
    assert.match(error.message, /examples must hold at least 1 item/)
  })
})

test("tool_create refuses an Example whose arguments the Tool's own schema rejects", async () => {
  await clean(async (flint) => {
    const error = await refusal(() =>
      flint.call("tool_create", creation({ examples: [{ args: { text: 7 }, expected: { count: 1 } }] })),
    )
    assert.equal(error.code, "invalid_examples")
    assert.equal(error.details["index"], 0)
  })
})

test("tool_create runs every Example and returns the first failure with the actual result, saving nothing", async () => {
  await clean(async (flint, dir) => {
    const examples = [
      { args: { text: "one two three" }, expected: { count: 3 } },
      { args: { text: "one two" }, expected: { count: 99 } },
    ]
    const error = await refusal(() => flint.call("tool_create", creation({ examples })))
    assert.equal(error.code, "example_failed")
    assert.equal(error.details["index"], 1)
    assert.match(error.message, /Example 1 expected \{"count":99\} and the Body returned \{"count":2\}/)
    assert.deepEqual(error.details["expected"], { count: 99 })
    assert.deepEqual(error.details["actual"], { count: 2 })
    assert.deepEqual(await readdir(join(dir, "tools")), [])
    assert.equal((await flint.status()).tools, 0)
  })
})

test("a failed Example cuts a result too large to quote instead of sending it whole", async () => {
  await clean(async (flint) => {
    const error = await refusal(() =>
      flint.call(
        "tool_create",
        creation({
          name: "pad_text",
          execute_source: 'return { padded: args.text.padEnd(20000, "x") }',
          examples: [{ args: { text: "one" }, expected: { padded: "one" } }],
        }),
      ),
    )
    assert.equal(error.code, "example_failed")
    assert.match(error.message, /expected \{"padded":"one"\} and the Body returned \{"padded":"onexxx/)
    assert.match(error.message, /\(cut to the first 4096 bytes\)/)
    assert.ok(Buffer.byteLength(error.message, "utf8") < 4500)
  })
})

test("a key named after the prototype link is part of a result, so an Example that leaves it out fails", async () => {
  await clean(async (flint) => {
    const error = await refusal(() =>
      flint.call(
        "tool_create",
        creation({
          name: "proto_value",
          execute_source: `return JSON.parse('{"__proto__":"a","count":3}')`,
          examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
        }),
      ),
    )
    assert.equal(error.code, "example_failed")
    assert.deepEqual(error.details["actual"], JSON.parse('{"__proto__":"a","count":3}'))
  })
})

test("tool_create reports a Body that throws while an Example runs", async () => {
  await clean(async (flint) => {
    const error = await refusal(() =>
      flint.call("tool_create", creation({ execute_source: "throw new Error('not ready')" })),
    )
    assert.equal(error.code, "example_failed")
    assert.match(error.message, /not ready/)
  })
})

test("a passing tool_create writes the Tool directory, one commit and the index, in state draft", async () => {
  await withFlint(async (flint, dir) => {
    const created = await flint.call("tool_create", creation())
    assert.deepEqual(created, {
      name: "word_count",
      state: "draft",
      version: (created as { version: string }).version,
      tier: "quickjs",
      examples: 1,
      library: "user",
      approval: null,
    })

    const directory = join(dir, "tools", "word_count")
    assert.deepEqual((await readdir(directory)).sort(), ["body.js", "examples.json", "stats.json", "tool.json"])

    const definition = JSON.parse(await readFile(join(directory, "tool.json"), "utf8")) as Record<string, unknown>
    assert.equal(definition["state"], "draft")
    assert.deepEqual(definition["manifest"], {})
    assert.equal(definition["tier"], "quickjs")
    assert.deepEqual(definition["provenance"], {
      channel: "agent",
      session: null,
      harness: null,
      model: null,
      excerpt: null,
      createdAt: (definition["provenance"] as { createdAt: string }).createdAt,
    })
    assert.deepEqual(JSON.parse(await readFile(join(directory, "stats.json"), "utf8")), {
      calls: 0,
      errors: 0,
      lastCallAt: null,
      p50Ms: null,
      tokens: { input: 0, output: 0 },
      contribution: 0,
    })

    const log = await git("git", ["log", "--format=%s|%an|%ae"], { cwd: dir })
    assert.deepEqual(log.stdout.trim().split("\n"), ["create(word_count): agent|flintd|flintd@localhost"])
    assert.equal((await flint.status()).tools, 1)
  })
})

test("tool_create records the session and the harness it was given", async () => {
  await withFlint(async (flint, dir) => {
    await flint.call("tool_create", creation(), { sessionId: "s-1", harness: "claude-code" })
    const definition = JSON.parse(await readFile(join(dir, "tools", "word_count", "tool.json"), "utf8")) as {
      provenance: { session: string; harness: string }
    }
    assert.equal(definition.provenance.session, "s-1")
    assert.equal(definition.provenance.harness, "claude-code")
  })
})

test("tool_create refuses a name the Library already holds", async () => {
  await withFlint(async (flint) => {
    await flint.call("tool_create", creation())
    const error = await refusal(() => flint.call("tool_create", creation()))
    assert.equal(error.code, "exists")
    assert.equal(error.details["name"], "word_count")
  })
})

test("tool_create refuses a Body that only declares a function", async () => {
  await clean(async (flint) => {
    for (const execute_source of [
      "const execute = async (args, ctx) => { return { count: 1 } }",
      "async function run(args, ctx) { return { count: 1 } }",
      "function helper(text) { return text.length }",
    ]) {
      const error = await refusal(() => flint.call("tool_create", creation({ execute_source })))
      assert.equal(error.code, "invalid_source")
      assert.match(error.message, /returns nothing/)
    }
  })
})

test("tool_create refuses an execute whose parameters are not (args, ctx)", async () => {
  await withFlint(async (flint) => {
    const error = await refusal(() =>
      flint.call("tool_create", creation({ execute_source: "async function execute(a, b) {\n  return { count: 1 }\n}" })),
    )
    assert.equal(error.code, "invalid_source")
    assert.deepEqual(error.details["parameters"], ["a", "b"])
    assert.match(error.message, /\(args, ctx\)/)

    await flint.call("tool_create", creation({ execute_source: "async function execute(args) {\n  return { count: 3 }\n}" }))
    assert.deepEqual(await flint.call("word_count", { text: "one two three" }), { count: 3 })
  })
})

// The eval lane's authoring failures, each answered in the first thing a model reads.
test("the tool_create description names the ctx surface, the Bundle, exact Examples and the deferred Manifest Example", async () => {
  await clean(async (flint) => {
    const definition = (await flint.tools()).find((one) => one.name === "tool_create")
    assert.ok(definition !== undefined)
    assert.ok(definition.description.length <= 1200, `the description is ${definition.description.length} characters`)
    for (const said of [
      /\{ status, headers, body \}/,
      /never a Response/,
      /cheerio/,
      /await import\("<name>"\)/,
      /node:crypto, node:path/,
      /moves the Tool to the Node tier/,
      /top-level properties parameters_json declares/,
      /exact JSON/,
      /manifest_json/,
      /deferred/,
    ]) {
      assert.match(definition.description, said)
    }
  })
})
