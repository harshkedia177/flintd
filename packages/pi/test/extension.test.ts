import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { fakeModel } from "../../core/test/fake-model.ts"
import { ask, creation, withDaemon } from "../../daemon/test/support.ts"
import type { Running } from "../../daemon/test/support.ts"
import flintd from "../src/index.ts"

// The daemon test support points FLINTD_HOME at a temporary home of its own; the extension reads this one.
const HOME = mkdtempSync(join(tmpdir(), "flintd-pi-"))
process.env["FLINTD_HOME"] = HOME

const META = ["tool_create", "tool_update", "tool_read", "tool_find", "tool_run", "tool_retire", "tool_history"]
const CASES = [{ args: { text: "one two" }, confident: false }]
const SESSION = "pi-session-a"
// The harness the daemon reads off this client's own name, so a call it makes is no spread by harness.
const HARNESS = "mcp pi"
const CHANGE_TIMEOUT_MS = 4000
const SCOPED = JSON.stringify({ fs: "workspace" })

const LETTER_COUNT = {
  name: "letter_count",
  description: "Count the letters of a piece of text, ignoring the spaces between the words.",
  execute_source: "return { letters: args.text.replace(/\\s+/g, '').length }",
  examples: [{ args: { text: "one two" }, expected: { letters: 6 } }],
}

interface Fake {
  pi: ExtensionAPI
  tools: Map<string, ToolDefinition>
  registered: number
  active(): string[]
  said: string[]
  start(sessionId: string): Promise<void>
}

function fakePi(options: { failRegister?: boolean } = {}): Fake {
  const tools = new Map<string, ToolDefinition>()
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  const said: string[] = []
  let active = ["bash"]
  const state: Fake = {
    pi: {} as ExtensionAPI,
    tools,
    registered: 0,
    said,
    active: () => [...active],
    start: async (sessionId) => {
      const ctx = {
        hasUI: true,
        ui: { notify: (message: string) => void said.push(message) },
        sessionManager: { getSessionId: () => sessionId },
      }
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx)
    },
  }
  state.pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => {
      state.registered += 1
      if (options.failRegister === true) throw new Error("pi refused the registration")
      tools.set(tool.name, tool)
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => void (active = [...names]),
  } as unknown as ExtensionAPI
  return state
}

async function run(fake: Fake, name: string, args: unknown): Promise<{ text: string; details: unknown }> {
  const tool = fake.tools.get(name)
  assert.ok(tool !== undefined, `${name} is not registered`)
  const ctx = undefined as unknown as ExtensionContext
  const result = await tool.execute("call-1", args as never, undefined, undefined, ctx)
  const first = result.content[0]
  return { text: first !== undefined && first.type === "text" ? first.text : "", details: result.details }
}

async function refused(fake: Fake, name: string, args: unknown): Promise<string> {
  return run(fake, name, args).then(
    (answered) => `no refusal: ${answered.text}`,
    (raised: Error) => raised.message,
  )
}

async function until(what: () => boolean, said: string): Promise<void> {
  const deadline = Date.now() + CHANGE_TIMEOUT_MS
  while (!what()) {
    assert.ok(Date.now() < deadline, said)
    await new Promise((woken) => setTimeout(woken, 10))
  }
}

async function listed(running: Running): Promise<string[]> {
  const answer = await ask(running, "GET", "/api/v1/tools")
  return (answer.body["tools"] as unknown as { name: string }[]).map((tool) => tool.name)
}

// Five clean calls of one session and one harness: the count a Tool needs, with none of the spread it needs.
async function fiveFromOneSession(running: Running, name: string): Promise<void> {
  for (const at of [0, 1, 2, 3, 4]) {
    const body = { name, args: { text: `call number ${at}` }, meta: { sessionId: "one", harness: HARNESS } }
    const answer = await ask(running, "POST", "/api/v1/call", { body })
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
  }
}

// The settings file holds a token, so it is written the way the daemon writes the one it owns.
function settings(held: { [key: string]: string }, mode = 0o600): void {
  const path = join(HOME, "pi.json")
  writeFileSync(path, JSON.stringify(held))
  chmodSync(path, mode)
}

test("the pi extension registers the daemon's tools and follows the list while the session runs", async (t) => {
  await withDaemon(
    async (running) => {
      settings({ url: `${running.url}/mcp`, token: running.token })
      const fake = fakePi()
      flintd(fake.pi)
      await fake.start(SESSION)

      await t.test("the seven meta tools are registered at session start, with their argument schemas", async () => {
        assert.deepEqual([...fake.tools.keys()], META)
        assert.deepEqual(fake.said, [])
        const create = fake.tools.get("tool_create") as ToolDefinition
        assert.equal((create.parameters as { type: string }).type, "object")
        assert.equal(create.label, "tool_create")
        assert.ok(create.description.length > 0)
        assert.deepEqual(fake.active(), ["bash", ...META])
      })

      await t.test("the session the extension names reaches the daemon, so its call is the one that promotes", async () => {
        await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args: creation() } })
        await fiveFromOneSession(running, "word_count")
        assert.deepEqual(await listed(running), META, "five calls of one session are the count without the spread")
        assert.ok(!fake.tools.has("fl_word_count"))

        fake.pi.setActiveTools(fake.active().filter((name) => name !== "tool_history"))
        const ran = await run(fake, "tool_run", { name: "word_count", args: { text: "one two three" } })
        assert.equal(ran.text, JSON.stringify({ count: 3 }))
        await until(() => fake.tools.has("fl_word_count"), "the promotion never reached the extension")
        assert.ok(!fake.active().includes("tool_history"), "a tool the operator turned off stays off")
      })

      await t.test("the promoted Tool is first-class as fl_<name>, and its execute runs the call", async () => {
        const tool = fake.tools.get("fl_word_count") as ToolDefinition
        assert.equal((tool.parameters as { properties: { text: unknown } }).properties.text !== undefined, true)
        const ran = await run(fake, "fl_word_count", { text: "one two three four" })
        assert.equal(ran.text, JSON.stringify({ count: 4 }))
        assert.deepEqual(ran.details, { count: 4 })
        assert.ok(fake.active().includes("fl_word_count"))
        assert.ok(fake.active().includes("bash"), "a tool of another extension keeps its place")
      })

      await t.test("a Manifest nobody decided on reaches the model with the line that grants it", async () => {
        const args = { ...creation(), ...LETTER_COUNT, manifest_json: SCOPED }
        await ask(running, "POST", "/api/v1/call", { body: { name: "tool_create", args } })
        const refusal = await refused(fake, "tool_run", { name: "letter_count", args: { text: "one two" } })
        assert.match(refusal, /^awaiting_approval: /)
        assert.match(refusal, /flintd approvals approve letter_count/)
      })

      await t.test("a retirement deactivates the Tool, and a connection that failed to register sees none of it", async () => {
        const broken = fakePi({ failRegister: true })
        flintd(broken.pi)
        await broken.start("pi-session-broken")
        assert.equal(broken.registered, 1, "it threw on the first registration this connection made")
        assert.match(String(broken.said[0]), /^flintd is not connected: pi refused the registration$/)

        await ask(running, "POST", "/api/v1/tools/word_count/retire", { body: {} })
        await until(() => !fake.active().includes("fl_word_count"), "the retirement never reached the extension")
        assert.ok(fake.tools.has("fl_word_count"), "the registration stays; the active set is what changes")
        assert.match(await refused(fake, "fl_word_count", { text: "one two" }), /^not_found: /)
        assert.equal(broken.registered, 1, "the closed connection was told nothing about the change")
      })

      await t.test("a refusal reaches the model as the daemon wrote it", async () => {
        assert.match(await refused(fake, "tool_read", { name: "nothing_here" }), /^not_found: /)
        assert.match(await refused(fake, "tool_create", { name: "no" }), /^invalid_arguments: /)
      })

      await t.test("port 0 in the config sends the extension to the port the running daemon published", async () => {
        const config = join(HOME, "config.json")
        const port = join(HOME, "port")
        writeFileSync(config, JSON.stringify({ port: 0 }))
        writeFileSync(port, `${new URL(running.url).port}\n`)
        try {
          // No url in the settings file, so the address is built from the flintd home alone, as an operator leaves it.
          settings({ token: running.token })
          const reader = fakePi()
          flintd(reader.pi)
          await reader.start("pi-session-published")
          assert.deepEqual(reader.said, [])
          assert.deepEqual([...reader.tools.keys()].slice(0, META.length), META)
        } finally {
          rmSync(config, { force: true })
          rmSync(port, { force: true })
          settings({ url: `${running.url}/mcp`, token: running.token })
        }
      })
    },
    { model: fakeModel({ cases: CASES }) },
  )
})

test("a session start that cannot reach the daemon says so and leaves pi running", async (t) => {
  const started = async (held: { [key: string]: string }, mode?: number): Promise<Fake> => {
    settings(held, mode)
    const fake = fakePi()
    flintd(fake.pi)
    await fake.start(SESSION)
    assert.equal(fake.tools.size, 0)
    assert.equal(fake.said.length, 1)
    return fake
  }

  await t.test("a token nobody wrote names the file it is missing from", async () => {
    const fake = await started({ url: "http://127.0.0.1:1/mcp" })
    assert.match(String(fake.said[0]), /There is no token in .*token\. Start the daemon with `flintd serve` first\./)
  })

  await t.test("a settings file other users can read is refused, because it holds the token", async () => {
    const fake = await started({ url: "http://127.0.0.1:1/mcp", token: "a-token" }, 0o644)
    assert.match(String(fake.said[0]), /pi\.json is readable by other users \(mode 644\)\. Run `chmod 600 /)
  })

  await t.test("a token file other users can read is refused, the way the daemon refuses it", async () => {
    const path = join(HOME, "token")
    writeFileSync(path, "a-token-from-a-file\n")
    chmodSync(path, 0o644)
    try {
      const fake = await started({ url: "http://127.0.0.1:1/mcp" })
      assert.match(String(fake.said[0]), /The token file .*token is readable by other users \(mode 644\)\./)
    } finally {
      rmSync(path, { force: true })
    }
  })

  await t.test("a key the extension does not read is refused by name", async () => {
    const fake = await started({ url: "http://127.0.0.1:1/mcp", token: "a-token", nickname: "flint" })
    assert.match(String(fake.said[0]), /nickname in .*pi\.json is not a key this extension reads/)
  })

  await t.test("a url that would send the token in cleartext to another host is refused", async () => {
    const fake = await started({ url: "http://flintd.example.com/mcp", token: "a-token" })
    assert.match(String(fake.said[0]), /url in .*must be https, or http on the loopback address/)
  })

  await t.test("a port the daemon would refuse to start on is named, not replaced by the default", async () => {
    const path = join(HOME, "config.json")
    writeFileSync(path, JSON.stringify({ port: "3546" }))
    try {
      const fake = await started({ token: "a-token" })
      assert.match(String(fake.said[0]), /The "port" in .*config\.json must be a whole number from 0 to 65535\./)
    } finally {
      rmSync(path, { force: true })
    }
  })

  await t.test("port 0 with no daemon to publish one is named, never replaced by the default", async () => {
    const path = join(HOME, "config.json")
    const port = join(HOME, "port")
    writeFileSync(path, JSON.stringify({ port: 0 }))
    try {
      const alone = await started({ token: "a-token" })
      assert.match(String(alone.said[0]), /The "port" in .*config\.json is 0, so only a running daemon knows it\./)
    } finally {
      rmSync(path, { force: true })
      rmSync(port, { force: true })
    }
  })

  await t.test("a daemon that is not there is one message, not a crash", async () => {
    const fake = await started({ url: "http://127.0.0.1:1/mcp", token: "a-token-no-daemon-holds" })
    assert.match(String(fake.said[0]), /^flintd is not connected: /)
  })
})
