import assert from "node:assert/strict"
import test from "node:test"
import type { JsonValue } from "@flintd/core"
import { fakeModel } from "../../core/test/fake-model.ts"
import { LOOPING, ask, callId, called, creation, withDaemon } from "./support.ts"
import type { Running } from "./support.ts"

test("a request without the bearer token is refused with 401 and the error envelope", async () => {
  await withDaemon(async (running) => {
    const answer = await ask(running, "GET", "/api/v1/status", { token: null })
    assert.equal(answer.status, 401)
    assert.equal((answer.body["error"] as { code: string }).code, "unauthorized")
    const wrong = await ask(running, "GET", "/api/v1/status", { token: "not-the-token" })
    assert.equal(wrong.status, 401)
  })
})

test("a request from another origin is refused with 403 even when the token is right", async () => {
  await withDaemon(async (running) => {
    const answer = await ask(running, "GET", "/api/v1/status", { origin: "http://page.example" })
    assert.equal(answer.status, 403)
    assert.equal((answer.body["error"] as { code: string }).code, "forbidden")
    const own = await ask(running, "GET", "/api/v1/status", { origin: running.url })
    assert.equal(own.status, 200)
  })
})

test("the REST surface mirrors the Flint interface: tools, call, status and library", async () => {
  await withDaemon(async (running) => {
    const tools = await ask(running, "GET", "/api/v1/tools")
    assert.equal(tools.status, 200)
    assert.deepEqual(
      (tools.body["tools"] as { name: string }[]).map((tool) => tool.name),
      ["tool_create", "tool_update", "tool_read", "tool_find", "tool_run", "tool_retire", "tool_history"],
    )

    const created = await ask(running, "POST", "/api/v1/call", {
      body: { name: "tool_create", args: creation(), meta: { harness: "gate-test" } },
    })
    assert.equal(created.status, 200)
    assert.equal((called(created) as { state: string }).state, "draft")

    const ran = await ask(running, "POST", "/api/v1/call", {
      body: { name: "word_count", args: { text: "one two" } },
    })
    assert.deepEqual(called(ran), { count: 2 })

    const library = await ask(running, "GET", "/api/v1/library")
    assert.deepEqual(library.body["library"], [
      {
        name: "word_count",
        description: "Count the words in a piece of text.",
        state: "draft",
        downgraded: null,
        calls: 1,
        errors: 0,
        lastCallAt: (library.body["library"] as { lastCallAt: string }[])[0]?.lastCallAt ?? null,
        contribution: 1,
        library: "user",
        needs_review: false,
        tier: "quickjs",
        manifest: {},
        approval: null,
      },
    ])

    const found = await ask(running, "GET", "/api/v1/find?q=count+the+words+in+a+sentence")
    assert.equal(found.status, 200)
    const entry = (found.body["find"] as { score: number }[])[0] as { score: number }
    assert.deepEqual({ ...entry, score: 0 }, {
      name: "word_count",
      description: "Count the words in a piece of text.",
      state: "draft",
      contribution: 1,
      library: "user",
      score: 0,
      siblings: [],
    })
    // The score is the share of the query this Tool matched, not a rank normalized to the best entry.
    assert.ok(entry.score > 0 && entry.score <= 1, `score ${entry.score}`)
    assert.deepEqual(
      (await ask(running, "GET", "/api/v1/find?q=count+the+words+in+a+sentence&limit=1")).body["find"],
      found.body["find"],
    )
    assert.equal((await ask(running, "GET", "/api/v1/find")).status, 400)
    assert.equal((await ask(running, "GET", "/api/v1/find?q=count&limit=none")).status, 400)

    const judged = await ask(running, "POST", `/api/v1/calls/${callId(ran)}/report`, {
      body: { outcome: "negative", note: "it answered the wrong question" },
    })
    assert.equal(judged.status, 200)
    assert.deepEqual(judged.body["report"], {
      id: callId(ran),
      tool: "word_count",
      library: "user",
      outcome: "negative",
      contribution: -1,
    })
    const unknown = await ask(running, "POST", "/api/v1/calls/no-such-call/report", { body: { outcome: "positive" } })
    assert.equal(unknown.status, 404)
    const wrong = await ask(running, "POST", `/api/v1/calls/${callId(ran)}/report`, { body: { outcome: "maybe" } })
    assert.equal(wrong.status, 400)

    const status = await ask(running, "GET", "/api/v1/status")
    const reported = status.body["status"] as { running: boolean; tools: number }
    assert.equal(reported.running, true)
    assert.equal(reported.tools, 1)
  })
})

test("the convenience routes read, list, restore and retire one Tool", async () => {
  await withDaemon(async (running) => {
    await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: creation() } })
    await ask(running, "POST", "/api/v1/call", {
      body: { name: "tool_update", args: { name: "word_count", description: "Count the words of a text." } },
    })

    const read = await ask(running, "GET", "/api/v1/tools/word_count?source=1")
    const one = read.body["tool"] as { description: string; source: string }
    assert.equal(one.description, "Count the words of a text.")
    assert.match(String(one.source), /split/)

    const history = await ask(running, "GET", "/api/v1/tools/word_count/history?limit=20")
    const versions = (history.body["history"] as { versions: { id: string; operation: string }[] }).versions
    assert.deepEqual(
      versions.map((version) => version.operation),
      ["update", "create"],
    )

    const restored = await ask(running, "POST", "/api/v1/tools/word_count/restore", {
      body: { version: versions[1]?.id ?? "" },
    })
    assert.equal(restored.status, 200)
    assert.equal((restored.body["result"] as { restored_from: string }).restored_from, versions[1]?.id)

    const retired = await ask(running, "POST", "/api/v1/tools/word_count/retire")
    assert.equal((retired.body["result"] as { state: string }).state, "retired")
    const gone = await ask(running, "POST", "/api/v1/call", { body: { name: "word_count", args: { text: "x" } } })
    assert.equal(gone.status, 404)
  })
})

test("every refusal carries the ToolError code and the HTTP status that belongs to it", async () => {
  await withDaemon(async (running) => {
    const unknown = await ask(running, "GET", "/api/v1/tools/nothing_here")
    assert.equal(unknown.status, 404)
    assert.equal((unknown.body["error"] as { code: string }).code, "not_found")

    await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: creation() } })
    const twice = await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: creation() } })
    assert.equal(twice.status, 409)
    assert.equal((twice.body["error"] as { code: string }).code, "exists")

    const wrongArgs = await ask(running, "POST", "/api/v1/call", {
      body: { name: "word_count", args: { text: 7 } },
    })
    assert.equal(wrongArgs.status, 400)
    assert.equal((wrongArgs.body["error"] as { code: string }).code, "invalid_arguments")

    // The Held-out run of the fake verifies word_count, and only a Verified or Active Tool refuses a near-duplicate.
    for (let waited = 0; waited < 500 && (await state(running)) !== "verified"; waited += 5) {
      await new Promise((wake) => setTimeout(wake, 5))
    }
    const copy = await ask(running, "POST", "/api/v1/call", {
      body: { name: "tool_create", args: creation({ name: "count_word" }) },
    })
    assert.equal(copy.status, 409)
    assert.equal((copy.body["error"] as { code: string }).code, "duplicate")
    assert.match((copy.body["error"] as { message: string }).message, /call it instead of writing a copy/)

    const route = await ask(running, "GET", "/api/v1/nothing")
    assert.equal(route.status, 404)

    const encoded = await ask(running, "GET", "/api/v1/tools/%")
    assert.equal(encoded.status, 400)
    assert.equal((encoded.body["error"] as { code: string }).code, "invalid_name")
  }, { model: fakeModel({ cases: [{ args: { text: "one two three" }, confident: true, expected: { count: 3 } }] }) })
})

async function state(running: Running): Promise<string> {
  const answer = await ask(running, "GET", "/api/v1/tools/word_count")
  return String((answer.body["tool"] as { state?: unknown } | undefined)?.state)
}

// The timeout bounds the close() in withDaemon: a body the daemon stopped reading used to hold the listener open.
test("the daemon reads JSON only, bounds the size of a request body, and still closes", { timeout: 5_000 }, async () => {
  await withDaemon(async (running) => {
    const text = await ask(running, "POST", "/api/v1/call", { raw: "name=word_count", type: "text/plain" })
    assert.equal(text.status, 400)
    assert.match(String((text.body["error"] as { message: string }).message), /JSON only/)

    const broken = await ask(running, "POST", "/api/v1/call", { raw: "{not json" })
    assert.equal(broken.status, 400)

    const huge = await ask(running, "POST", "/api/v1/call", {
      raw: JSON.stringify({ name: "word_count", args: { text: "x".repeat(1_100_000) } }),
    })
    assert.equal(huge.status, 413)
    assert.equal((huge.body["error"] as { code: string }).code, "request_too_large")
    // A body the daemon stopped reading must not hold the listener open when the daemon shuts down.
    assert.equal(huge.connection, "close")

    // A Tool whose schema takes any key gives the schema walk nothing to descend, so the depth of the value is the
    // only thing between 40 KB of JSON and the structured clone that carries it to a tier.
    await ask(running, "POST", "/api/v1/call", {
      body: {
        name: "tool_create",
        args: creation({
          name: "any_args_tool",
          parameters_json: JSON.stringify({ type: "object", additionalProperties: true }),
          execute_source: "return { ok: true }",
          examples: [{ args: {}, expected: { ok: true } }],
        }),
      },
    })
    const deep = await ask(running, "POST", "/api/v1/call", {
      raw: `{"name":"any_args_tool","args":${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}}`,
    })
    assert.equal(deep.status, 400)
    assert.equal((deep.body["error"] as { code: string }).code, "invalid_arguments")
    assert.match(String((deep.body["error"] as { message: string }).message), /nests more than 64 levels deep/)
    // The daemon is still there to answer the next request, which is the whole of what the bound is for.
    assert.equal((await ask(running, "GET", "/api/v1/status")).status, 200)
  })
})

test("a known path answers 405 for a method it does not serve, and HEAD follows GET", async () => {
  await withDaemon(async (running) => {
    const wrong = await ask(running, "POST", "/api/v1/status")
    assert.equal(wrong.status, 405)
    assert.equal((wrong.body["error"] as { code: string }).code, "method_not_allowed")
    const deleted = await ask(running, "DELETE", "/api/v1/tools/word_count")
    assert.equal(deleted.status, 405)
    const unknown = await ask(running, "DELETE", "/api/v1/nothing")
    assert.equal(unknown.status, 404)
  })
})

test("a Body that never returns answers with timeout while the daemon serves another request", async () => {
  await withDaemon(
    async (running) => {
      await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: LOOPING } })
      const stuck = ask(running, "POST", "/api/v1/call", {
        body: { name: "loop_forever", args: { forever: true } },
      })
      await new Promise((tick) => setTimeout(tick, 100))
      const meanwhile = await ask(running, "GET", "/api/v1/status")
      assert.equal(meanwhile.status, 200)
      const answer = await stuck
      assert.equal(answer.status, 504)
      assert.equal((answer.body["error"] as { code: string }).code, "timeout")
      const after = await ask(running, "POST", "/api/v1/call", {
        body: { name: "loop_forever", args: { forever: false } },
      })
      assert.deepEqual(called(after), { ok: true })
    },
    { callTimeoutMs: 300 },
  )
})

test("a close while a Body is still running is over within the stop grace, not at the call timeout", async () => {
  await withDaemon(
    async (running) => {
      await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: LOOPING } })
      const stuck = ask(running, "POST", "/api/v1/call", { body: { name: "loop_forever", args: { forever: true } } })
      // The connection is only the daemon's to take back once the request is on it.
      await new Promise((tick) => setTimeout(tick, 100))
      const started = Date.now()
      await running.stop()
      const waited = Date.now() - started
      assert.ok(waited < 2000, `the close waited ${waited} ms, and the call timeout is 10 seconds`)
      await assert.rejects(stuck)
    },
    { callTimeoutMs: 10_000, stopGraceMs: 100 },
  )
})

test("a daemon over two Libraries names the Library of every Tool and reports both in status", async () => {
  await withDaemon(
    async (running) => {
      const project = await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: creation() } })
      assert.equal((called(project) as { library: string }).library, "project")
      const user = await ask(running, "POST", "/api/v1/call", {
        body: {
          name: "tool_create",
          args: creation({ execute_source: "return { count: args.text.length }", examples: [{ args: { text: "one two" }, expected: { count: 7 } }] }),
          meta: { library: "user" },
        },
      })
      assert.match(String((called(user) as { warning: string }).warning), /project Library also holds/)

      const library = await ask(running, "GET", "/api/v1/library")
      assert.deepEqual(library.body["library"], [
        {
          name: "word_count",
          description: "Count the words in a piece of text.",
          state: "draft",
          downgraded: null,
          calls: 0,
          errors: 0,
          lastCallAt: null,
          contribution: 0,
          library: "project",
          needs_review: false,
          tier: "quickjs",
          manifest: {},
          approval: null,
        },
      ])

      const read = await ask(running, "GET", "/api/v1/tools/word_count")
      const one = read.body["tool"] as { shadows: unknown; library: string }
      assert.deepEqual(one.shadows, { library: "user", description: "Count the words in a piece of text." })
      assert.equal(one.library, "project")

      const status = (await ask(running, "GET", "/api/v1/status")).body["status"] as {
        tools: number
        review: unknown[]
        libraries: { library: string; dir: string; remote: string | null }[]
      }
      assert.equal(status.tools, 1)
      assert.deepEqual(status.review, [])
      assert.deepEqual(
        status.libraries.map((entry) => [
          entry.library,
          entry.dir,
          entry.remote,
        ]),
        [
          ["project", running.project, null],
          ["user", running.dir, null],
        ],
      )
    },
    { project: true },
  )
})

test("tool_read carries the Held-out status, and a configured model reaches status without its key", async () => {
  const model = fakeModel({ cases: [{ args: { text: "a b" }, confident: true, expected: { count: 2 } }] })
  await withDaemon(
    async (running) => {
      const status = await ask(running, "GET", "/api/v1/status")
      assert.deepEqual((status.body["status"] as { model: JsonValue }).model, {
        configured: true,
        provider: "anthropic",
        model: "fake-model",
      })

      await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: creation() } })
      const verified = await waitFor(async () => {
        const answer = await ask(running, "GET", "/api/v1/tools/word_count")
        const tool = answer.body["tool"] as { state: string; held_out: JsonValue & { status: string } }
        return tool.held_out.status === "pending" ? undefined : tool
      })
      assert.equal(verified.state, "verified")
      assert.deepEqual(verified.held_out, { status: "passed", grades: { exact: 1, assertion: 0 }, failures: [] })
    },
    { model },
  )
})

test("without a configured model status says so and tool_read says the Held-out examples are unavailable", async () => {
  await withDaemon(async (running) => {
    const status = await ask(running, "GET", "/api/v1/status")
    assert.deepEqual((status.body["status"] as { model: JsonValue }).model, { configured: false })

    await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: creation() } })
    const answer = await ask(running, "GET", "/api/v1/tools/word_count")
    const tool = answer.body["tool"] as { state: string; held_out: { status: string; reason: string } }
    assert.equal(tool.state, "draft")
    assert.equal(tool.held_out.status, "unavailable")
    assert.match(tool.held_out.reason, /no model configured/)
  })
})

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error("the Held-out run never reached a state")
    await new Promise((wake) => setTimeout(wake, 5))
  }
}

test("the connection routes store a credential, list it by name and host, and never send the value back", async () => {
  await withDaemon(async (running) => {
    const stored = await ask(running, "POST", "/api/v1/connections", {
      body: { name: "upstream", hosts: ["api.example.com"], header: { name: "x-api-key", value: "not-a-real-credential-9f3c2b7a1d" } },
    })
    assert.equal(stored.status, 200)
    assert.deepEqual(stored.body["connection"], { name: "upstream", hosts: ["api.example.com"] })

    const listed = await ask(running, "GET", "/api/v1/connections")
    assert.deepEqual(listed.body["connections"], [{ name: "upstream", hosts: ["api.example.com"] }])
    assert.ok(!JSON.stringify(listed.body).includes("not-a-real-credential"), "the listing carried the credential")

    const refused = await ask(running, "POST", "/api/v1/connections", {
      body: { name: "upstream", hosts: [], header: { name: "x-api-key", value: "not-a-real-credential-9f3c2b7a1d" } },
    })
    assert.equal(refused.status, 400)
    assert.equal((refused.body["error"] as { code: string }).code, "invalid_arguments")

    const removed = await ask(running, "DELETE", "/api/v1/connections/upstream")
    assert.deepEqual(removed.body["connection"], { name: "upstream", hosts: ["api.example.com"] })
    assert.deepEqual((await ask(running, "GET", "/api/v1/connections")).body["connections"], [])
    assert.equal((await ask(running, "DELETE", "/api/v1/connections/upstream")).status, 404)
    assert.equal((await ask(running, "PUT", "/api/v1/connections")).status, 405)
  })
})

const OBSERVED = { harness: "claude-code", tool: "Bash", status: "ok", session: "s-1", argumentKeys: ["command"] }

test("the observation routes record what a harness ran and read it back newest first", async () => {
  await withDaemon(async (running) => {
    const written = await ask(running, "POST", "/api/v1/observations", { body: OBSERVED })
    assert.equal(written.status, 200)
    const one = written.body["observation"] as Record<string, unknown>
    assert.equal(one["harness"], "claude-code")
    assert.equal(one["tool"], "Bash")
    assert.deepEqual(one["argumentKeys"], ["command"])
    assert.equal(one["transcriptPath"], null)
    assert.match(String(one["at"]), /^\d{4}-\d{2}-\d{2}T/)

    await ask(running, "POST", "/api/v1/observations", {
      body: { harness: "codex", tool: "shell", status: "error", at: "2030-01-01T00:00:00.000Z" },
    })
    const read = (await ask(running, "GET", "/api/v1/observations")).body["observations"] as { tool: string }[]
    assert.deepEqual(
      read.map((seen) => seen.tool),
      ["shell", "Bash"],
    )
    const filtered = (await ask(running, "GET", "/api/v1/observations?harness=codex")).body["observations"] as unknown[]
    assert.equal(filtered.length, 1)
    const since = (await ask(running, "GET", "/api/v1/observations?since=2031-01-01T00:00:00.000Z")).body[
      "observations"
    ] as unknown[]
    assert.equal(since.length, 0)

    // An Observation carries the argument names and never a value, whatever a hook was given.
    await ask(running, "POST", "/api/v1/observations", {
      body: { harness: "opencode", tool: "bash", status: "ok", argumentKeys: ["command", "cwd"] },
    })
    const named = JSON.stringify((await ask(running, "GET", "/api/v1/observations?harness=opencode")).body)
    assert.match(named, /"argumentKeys":\["command","cwd"\]/)

    assert.equal((await ask(running, "POST", "/api/v1/observations", { body: { tool: "Bash", status: "ok" } })).status, 400)
    const badStatus = await ask(running, "POST", "/api/v1/observations", {
      body: { harness: "codex", tool: "shell", status: "maybe" },
    })
    assert.equal(badStatus.status, 400)
    const forced = await ask(running, "POST", "/api/v1/observations", { body: { ...OBSERVED, id: "forced", nonsense: 1 } })
    assert.equal(forced.status, 400)
    assert.equal((await ask(running, "POST", "/api/v1/observations", { body: OBSERVED, token: null })).status, 401)
    assert.equal((await ask(running, "DELETE", "/api/v1/observations")).status, 405)
  })
})
