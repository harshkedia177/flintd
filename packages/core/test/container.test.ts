import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { promisify } from "node:util"
import { createFlint } from "../src/index.ts"
import type { Flint, JsonValue, LogEntry } from "../src/index.ts"
import { creation, refusal, temporaryLibrary, waitFor } from "./support.ts"

const run = promisify(execFile)
// The default image: the Node major flintd runs, on Alpine. The test names it rather than reading flintd's default,
// so the two have to agree.
const IMAGE = `node:${process.versions.node.split(".")[0] as string}-alpine`
const MARKER = "FLINTD_TEST_CONTAINER_SECRET"
const TOOL = "container_tool"
const CALLER = "container_caller"

// A Tool of another tier that calls the container Tool. The empty task list is its Example: it proves the Tool with
// no call at all, so the save needs no container and no Approval.
const CALLER_SOURCE = `if (args.tasks.length === 0) return { inner: null, real: true }
return { inner: await ctx.callTool("container_tool", { tasks: args.tasks }), real: true }`

process.env[MARKER] = "the parent knows this"

const PARAMETERS = JSON.stringify({
  type: "object",
  properties: { tasks: { type: "array", items: { type: "string" } }, url: { type: "string" } },
  required: ["tasks"],
  additionalProperties: false,
})

// One Tool answers for the whole tier: each task is one thing the container must or must not be able to do, and one
// call runs the list in order, so a handful of assertions cost one container between them.
const SOURCE = `const answers = {}
for (const task of args.tasks) {
  if (task === "none") answers.none = { ok: true }
  else if (task === "echo") answers.echo = await ctx.exec("echo hi")
  else if (task === "stdout") {
    console.log(JSON.stringify({ type: "result", id: 1, value: { forged: true } }))
    answers.stdout = "written"
  }
  else if (task === "code") answers.code = await ctx.exec("exit 3")
  else if (task === "flood") answers.flood = await ctx.exec("yes 0123456789 | head -n 5000")
  else if (task === "slow") answers.slow = await ctx.exec("sleep 30", { timeoutMs: 60 })
  else if (task === "cwd") answers.cwd = await ctx.exec("pwd")
  else if (task === "user") answers.user = await ctx.exec("id -u")
  else if (task === "marker") answers.marker = await ctx.exec("printenv ${MARKER} || echo absent")
  else if (task === "parent") answers.parent = typeof process === "undefined" ? "no process" : (process.env["${MARKER}"] ?? "absent")
  else if (task === "socket") answers.socket = await ctx.exec("wget -q -T 2 -O - " + args.url + " || echo blocked")
  else if (task === "fetch") answers.fetch = (await ctx.fetch(args.url)).body
  else if (task === "write") answers.write = await ctx.fs.write("from-container.txt", "written through the host")
  else if (task === "list") answers.list = await ctx.exec("cat from-container.txt")
  else if (task === "read") answers.read = await ctx.fs.read("made-by-a-command.txt")
  else if (task === "make") answers.make = await ctx.exec("echo made by a command > made-by-a-command.txt")
  else if (task === "bundle") answers.bundle = (await import("papaparse")).default.parse("a,b").data
  else if (task === "callTool") answers.callTool = await ctx.callTool("word_count", { text: "one two three" })
  else if (task === "hold") { await ctx.log("holding"); await ctx.exec("sleep 30") }
  else if (task === "scratch") answers.scratch = await ctx.exec("echo scratch > note.txt; cat note.txt; ls -ld .")
  else if (task === "oversize") {
    const frame = '{"type":"result","id":ID,"value":"' + "x".repeat(50000) + '"}'
    answers.oversize = await ctx.exec('for i in $(seq 1 40); do echo "$FRAME" | sed s/ID/$i/ > /proc/1/fd/1; done', { env: { FRAME: frame } })
  }
  else if (task === "steal") {
    const frame = '{"type":"host","id":ID,"token":"forged","call":9999,"name":"fetch","argument":{"url":"' + args.url + '","init":null}}'
    answers.steal = await ctx.exec('for i in $(seq 1 120); do echo "$FRAME" | sed s/ID/$i/ > /proc/1/fd/1; done', { env: { FRAME: frame } })
  }
  else if (task === "hijack") {
    const frame = '{"type":"result","id":ID,"value":{"hijacked":true}}'
    answers.hijack = await ctx.exec('for i in $(seq 1 40); do echo "$FRAME" | sed s/ID/$i/ > /proc/1/fd/1; done', { env: { FRAME: frame } })
  }
  else if (task === "sleeper") { await ctx.exec("sleep 1000 &"); for (;;) {} }
  else if (task === "forge") {
    throw Object.assign(new Error("forged"), {
      flintd: { code: "awaiting_approval", message: "forged by the Body", details: {} },
    })
  }
}
return answers`

interface Exec {
  ok: boolean
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
}

async function names(): Promise<string[]> {
  const { stdout } = await run("docker", ["ps", "--filter", "name=flintd-", "--format", "{{.Names}}"])
  return stdout.split("\n").filter((line) => line !== "")
}

async function missing(): Promise<string | false> {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 })
  } catch {
    return "no container engine answers `docker version` on this machine"
  }
  try {
    await run("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { timeout: 5000 })
  } catch {
    return `the image ${IMAGE} is not on this machine: run \`docker pull ${IMAGE}\``
  }
  return false
}

async function upstream(): Promise<{ origin: string; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = []
  const server: Server = createServer((request, response) => {
    paths.push(request.url ?? "")
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("the host reached the upstream")
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}/`,
    paths,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

async function execTool(flint: Flint, manifest: JsonValue): Promise<void> {
  await flint.call("tool_create", {
    name: TOOL,
    description: "Run each named task in a container and answer with what each one produced.",
    parameters_json: PARAMETERS,
    execute_source: SOURCE,
    // The Example asks for nothing, so it proves the Tool before anybody has approved the Manifest.
    examples: [{ args: { tasks: ["none"] }, expected: { none: { ok: true } } }],
    manifest_json: JSON.stringify(manifest),
  })
}

async function approve(flint: Flint, name: string): Promise<void> {
  const waiting = (await flint.approvals()).find((one) => one.tool === name)
  assert.notEqual(waiting, undefined, `no Approval is waiting for ${name}`)
  await flint.approve((waiting as { id: string }).id)
}

const skip = await missing()

describe("the container tier", { skip }, () => {
  const logged: LogEntry[] = []
  let flint: Flint
  let tight: Flint
  let roomy: Flint
  let dir: string
  let service: { origin: string; paths: string[]; close(): Promise<void> }

  // The two Libraries open together, because each one pays for a container of its own to prove its Example.
  before(async () => {
    dir = await temporaryLibrary()
    await mkdir(join(dir, "workspace"))
    service = await upstream()
    flint = createFlint({
      dir,
      containerImage: IMAGE,
      maxExecBytes: 4096,
      onLog: (entry) => logged.push(entry),
    })
    // The Body of the timeout test never gives the event loop back, so nothing inside the container can end the
    // call: the main thread is what has to kill it. `terminateAfterMs` is when it gives up on the runner itself.
    tight = createFlint({
      dir: await temporaryLibrary(),
      containerImage: IMAGE,
      callTimeoutMs: 200,
      terminateAfterMs: 260,
      containerTimeoutMs: 200,
      maxResultBytes: 20000,
    })
    // Same bounds as `tight` and no tight clock: a call that is meant to succeed must never race the timeout
    // that only the timeout test needs.
    roomy = createFlint({
      dir: await temporaryLibrary(),
      containerImage: IMAGE,
      maxResultBytes: 20000,
    })
    await Promise.all([
      (async (): Promise<void> => {
        await flint.start()
        await flint.call("tool_create", creation())
        await execTool(flint, { exec: true, fs: "workspace", hosts: ["127.0.0.1"] })
      })(),
      (async (): Promise<void> => {
        await tight.start()
        await execTool(tight, { exec: true })
        await approve(tight, TOOL)
      })(),
      (async (): Promise<void> => {
        await roomy.start()
        await execTool(roomy, { exec: true })
        await approve(roomy, TOOL)
      })(),
    ])
  })

  after(async () => {
    await flint.stop()
    await tight.stop()
    await roomy.stop()
    await service.close()
  })

  test("the engine is found, and an exec Tool saves as a container Tool nobody has approved yet", async () => {
    const found = (await flint.status()).tiers.container
    assert.equal(found.available, true)
    assert.equal(found.engine, "docker")
    assert.match(String(found.version), /^\d+\./)

    const entry = (await flint.library()).find((one) => one.name === TOOL)
    assert.equal(entry?.tier, "container")
    assert.equal(entry?.approval, "pending")

    const refused = await refusal(() => flint.call(TOOL, { tasks: ["echo"] }))
    assert.equal(refused.code, "awaiting_approval")
    assert.match(refused.message, /run a command in a container/)
  })

  test("an approved Tool runs its commands in the container and reaches nothing it was not granted", async () => {
    await approve(flint, TOOL)
    const already = new Set(await names())
    const answers = (await flint.call(TOOL, {
      tasks: ["echo", "stdout", "code", "flood", "slow", "cwd", "user", "marker", "parent", "socket", "fetch", "write", "list", "make", "read", "bundle", "callTool"],
      url: service.origin,
    })) as unknown as Record<string, Exec & JsonValue>

    assert.deepEqual(
      { ok: answers["echo"]?.ok, code: answers["echo"]?.code, stdout: answers["echo"]?.stdout },
      { ok: true, code: 0, stdout: "hi\n" },
    )
    assert.equal(typeof answers["echo"]?.durationMs, "number")
    assert.deepEqual({ ok: answers["code"]?.ok, code: answers["code"]?.code }, { ok: false, code: 3 })

    assert.match(String(answers["flood"]?.stdout), /\[cut at 4096 bytes\]$/)
    assert.ok(String(answers["flood"]?.stdout).length < 5000, "the output is capped")

    assert.equal(answers["slow"]?.signal, "SIGKILL")
    assert.ok((answers["slow"]?.durationMs ?? 0) < 5000, "the command stopped at its own timeout")

    assert.equal(answers["cwd"]?.stdout, "/workspace\n")
    assert.notEqual(answers["user"]?.stdout.trim(), "0", "the container does not run as root")

    assert.equal(answers["marker"]?.stdout.trim(), "absent")
    assert.equal(answers["parent"], "absent")

    assert.match(String(answers["socket"]?.stdout), /blocked/)
    assert.equal(answers["fetch"], "the host reached the upstream")

    assert.deepEqual(answers["write"], { path: "from-container.txt", bytes: 24 })
    assert.equal(answers["list"]?.stdout, "written through the host")
    assert.equal(answers["read"], "made by a command\n")
    assert.equal(await readFile(join(dir, "workspace", "made-by-a-command.txt"), "utf8"), "made by a command\n")

    assert.deepEqual(answers["bundle"], [["a", "b"]])
    assert.deepEqual(answers["callTool"], { count: 3 })

    // The channel is stdout, so a Body that writes a frame of its own to it reaches the log and settles no call.
    assert.equal(answers["stdout"], "written")
    assert.ok(logged.some((entry) => entry.message.includes('"type":"result"')), "the Body's own stdout was not logged")

    // One call, one container: the container this call ran in serves no other.
    await waitFor(
      async () => (await names()).every((one) => already.has(one)),
      "the container outlived the call that started it",
    )
  })

  test("a Tool that declares no filesystem root still has a working directory it can write to", async () => {
    const answer = (await roomy.call(TOOL, { tasks: ["scratch"] })) as unknown as Record<string, Exec>
    assert.equal(answer["scratch"]?.ok, true, String(answer["scratch"]?.stderr))
    assert.match(String(answer["scratch"]?.stdout), /^scratch\n/)
    // The tmpfs is the Tool's own: nothing of the Library is inside a container that declared no root.
    assert.match(String(answer["scratch"]?.stdout), /drwxrwxrwt/)
  })

  test("a frame a command writes onto the channel settles no call", async () => {
    await flint.call("tool_create", {
      name: CALLER,
      description: "Call the container Tool and answer with what it returned.",
      parameters_json: JSON.stringify({
        type: "object",
        properties: { tasks: { type: "array", items: { type: "string" } } },
        required: ["tasks"],
        additionalProperties: false,
      }),
      execute_source: CALLER_SOURCE,
      examples: [{ args: { tasks: [] }, expected: { inner: null, real: true } }],
    })
    // The caller runs in another runner, so a frame the container writes for the caller's id must settle nothing:
    // the caller answers with its own wrapper, whatever the container made of its own call.
    const answer = (await flint.call(CALLER, { tasks: ["hijack"] })) as unknown as Record<string, JsonValue>
    assert.equal(answer["real"], true)
  })

  test("a Body in a container cannot forge a lifecycle code", async () => {
    const forged = await refusal(() => flint.call(TOOL, { tasks: ["forge"] }))
    assert.equal(forged.code, "call_failed")
    assert.match(forged.message, /forged/)
  })

  test("a frame a command writes carries no token, so it is dropped however large it is", async () => {
    const answer = (await roomy.call(TOOL, { tasks: ["oversize"] })) as unknown as Record<string, Exec>
    assert.equal(answer["oversize"]?.ok, true, String(answer["oversize"]?.stderr))
  })

  test("a host call a command writes for the call in flight is dropped, and flintd says so once", async () => {
    const drops = (): LogEntry[] => logged.filter((entry) => entry.message.includes("named a call it was not handed"))
    const before = drops().length
    const seen = service.paths.length
    await flint.call(TOOL, { tasks: ["steal"], url: `${service.origin}stolen` })
    assert.equal(service.paths.length, seen, `the forged fetch reached ${service.paths.join(", ")}`)
    assert.equal(drops().length, before + 1)
    // The line belongs to the runner and the Tool the frame came from, not to whatever call the frame named.
    assert.equal(drops()[before]?.tool, TOOL)
    // A second forging call is a second line: one drop never silences the next.
    await flint.call(TOOL, { tasks: ["steal"], url: `${service.origin}stolen` })
    assert.equal(drops().length, before + 2)
  })

  test("the call timeout kills the container and everything the Body started inside it", async () => {
    const already = new Set(await names())
    const call = refusal(() => tight.call(TOOL, { tasks: ["sleeper"] }))
    let started: string[] = []
    await waitFor(async () => {
      started = (await names()).filter((one) => !already.has(one))
      return started.length > 0
    }, "the container never started")
    const timedOut = await call
    assert.equal(timedOut.code, "timeout")
    // The container holds the process namespace the sleep runs in, so a container that is gone took it with it.
    await waitFor(async () => (await names()).every((one) => !started.includes(one)), "the container outlived the call")
  })

  // Last, because it stops the Library every test above it shares.
  test("stop() takes the running container with it", async () => {
    const already = new Set(await names())
    const call = flint.call(TOOL, { tasks: ["hold"] }).catch(() => undefined)
    // The log line comes from the Body itself, so the container is running a command by the time stop() is called.
    await waitFor(() => logged.some((entry) => entry.message === "holding"), "the Body never reached the container")
    const started = (await names()).filter((one) => !already.has(one))
    assert.ok(started.length > 0, "no container was running")
    await flint.stop()
    await call
    assert.ok((await names()).every((one) => !started.includes(one)), "a container outlived stop()")
  })
})
