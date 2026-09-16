import assert from "node:assert/strict"
import { gzipSync } from "node:zlib"
import { createServer } from "node:http"
import type { IncomingHttpHeaders, Server } from "node:http"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"
import { ToolError, createFlint } from "../src/index.ts"
import type { Flint, JsonValue } from "../src/index.ts"
import { refusal, temporaryLibrary } from "./support.ts"

const VALUE = "not-a-real-credential-9f3c2b7a1d"
const HEADER = "x-api-key"

const PARAMETERS = JSON.stringify({
  type: "object",
  properties: { url: { type: "string" }, init_json: { type: "string" }, log: { type: "boolean" } },
  required: ["url"],
  additionalProperties: false,
})

// An empty URL is the Example: it proves the Tool with no capability at all, so the save needs no Approval first.
const FETCH_SOURCE = `if (args.url === "") return { refused: null }
try {
  const init = args.init_json === undefined ? undefined : JSON.parse(args.init_json)
  const answer = await ctx.fetch(args.url, init)
  if (args.log === true) await ctx.log("upstream said " + JSON.stringify(answer.body))
  return answer
} catch (cause) {
  return { refused: cause.message }
}`

const DIGEST_FETCH_SOURCE = `const { createHash } = await import("node:crypto")
if (args.url === "") return { refused: null }
if (args.log === true) {
  try {
    const direct = await fetch(args.url)
    return { reached: true, status: direct.status }
  } catch (cause) {
    return { reached: false, why: String(cause.cause?.code ?? cause.code ?? cause.message) }
  }
}
try {
  const answer = await ctx.fetch(args.url)
  return { status: answer.status, digest: createHash("sha256").update("abc").digest("hex").slice(0, 8) }
} catch (cause) {
  return { refused: cause.message }
}`

const TWICE_SOURCE = `if (args.url === "") return { refused: null }
const first = await ctx.fetch(args.url + "/deny")
try {
  await ctx.fetch(args.url + "/echo")
  return { refused: null }
} catch (cause) {
  return { first: first.status, refused: cause.message }
}`

interface Upstream {
  origin: string
  seen: IncomingHttpHeaders[]
  beforeDeny: (() => Promise<void>) | undefined
  close(): Promise<void>
}

async function upstream(): Promise<Upstream> {
  const seen: IncomingHttpHeaders[] = []
  const open = new Set<{ destroy(): void }>()
  const held: Upstream = {
    origin: "",
    seen,
    beforeDeny: undefined,
    async close(): Promise<void> {
      for (const waiting of open) waiting.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      seen.push(request.headers)
      const path = (request.url ?? "/").split("?")[0]
      if (path === "/slow") {
        open.add(response)
        return
      }
      if (path === "/deny") await held.beforeDeny?.()
      if (path === "/text") {
        response.writeHead(200, { "content-type": "text/plain", "set-cookie": "session=abc" })
        response.end("hello")
        return
      }
      if (path === "/stall") {
        response.writeHead(200, { "content-type": "text/plain" })
        response.write("the first chunk")
        open.add(response)
        return
      }
      if (path === "/big") {
        response.writeHead(200, { "content-type": "text/plain" })
        response.end("x".repeat(8192))
        return
      }
      // A few hundred bytes on the wire that become 64 KB in the reader.
      if (path === "/gzip") {
        const packed = gzipSync(Buffer.from("x".repeat(65536), "utf8"))
        response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" })
        response.end(packed)
        return
      }
      if (path === "/moved") {
        response.writeHead(302, { location: "/echo" })
        response.end()
        return
      }
      if (path === "/denyredirect") {
        await held.beforeDeny?.()
        response.writeHead(302, { location: "/echo" })
        response.end()
        return
      }
      if (path === "/away") {
        response.writeHead(302, { location: `http://localhost:${port(server)}/echo` })
        response.end()
        return
      }
      const body =
        path === "/leak"
          ? { echo: request.headers[HEADER] ?? null }
          : { ok: true, saw: Object.keys(request.headers).sort() }
      // A gateway that reflects what it received puts the credential in a header as readily as in a body.
      const reflected = path === "/leak" ? { etag: String(request.headers[HEADER] ?? "none") } : {}
      response.writeHead(200, { "content-type": "application/json", ...reflected })
      response.end(JSON.stringify(body))
    })()
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()))
  held.origin = `http://127.0.0.1:${port(server)}`
  return held
}

function port(server: Server): number {
  const address = server.address()
  return typeof address === "object" && address !== null ? address.port : 0
}

async function fetchTool(flint: Flint, name: string, source = FETCH_SOURCE, manifest?: JsonValue): Promise<void> {
  await flint.call("tool_create", {
    name,
    description: `Ask an upstream service for an answer, in the ${name.replace(/_/g, " ")} way.`,
    parameters_json: PARAMETERS,
    execute_source: source,
    examples: [{ args: { url: "" }, expected: { refused: null } }],
    manifest_json: JSON.stringify(manifest ?? { hosts: ["127.0.0.1"], connections: ["upstream"] }),
  })
}

async function approve(flint: Flint, name: string): Promise<void> {
  const waiting = (await flint.approvals()).find((one) => one.tool === name)
  assert.ok(waiting !== undefined, `no Approval was raised for ${name}`)
  await flint.approve(waiting.id)
}

describe("the Proxy", () => {
  let service: Upstream
  let flint: Flint
  let tight: Flint
  // Two bounds, because one test needs a size cap on a response that must arrive, and another needs a clock on a
  // response that never will. Sharing a 200 ms clock made a slow runner refuse the big body for the wrong reason.
  let capped: Flint
  let logged: string[] = []
  const dirs: string[] = []
  const files: string[] = []

  async function open(options: Record<string, unknown> = {}): Promise<Flint> {
    const dir = await temporaryLibrary()
    const file = join(tmpdir(), `flintd-connections-${randomUUID()}.json`)
    dirs.push(dir)
    files.push(file)
    const started = createFlint({
      dir,
      connectionsFile: file,
      onLog: (entry) => logged.push(entry.message),
      ...options,
    })
    await started.start()
    await started.connections.add({ name: "upstream", hosts: ["127.0.0.1"], header: { name: HEADER, value: VALUE } })
    return started
  }

  before(async () => {
    service = await upstream()
    flint = await open()
    tight = await open({ fetchTimeoutMs: 200, maxFetchBytes: 2048, callTimeoutMs: 4000 })
    capped = await open({ maxFetchBytes: 2048, callTimeoutMs: 8000 })
    await fetchTool(flint, "fetch_tool")
    await approve(flint, "fetch_tool")
    await fetchTool(tight, "tight_tool")
    await approve(tight, "tight_tool")
    await fetchTool(capped, "capped_tool")
    await approve(capped, "capped_tool")
  })

  after(async () => {
    await flint.stop()
    await tight.stop()
    await capped.stop()
    await service.close()
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    for (const file of files) await rm(file, { force: true })
  })

  test("a declared host is reached with the Connection header, and the Body never sees the value", async () => {
    const answer = (await flint.call("fetch_tool", { url: `${service.origin}/echo` })) as {
      status: number
      headers: Record<string, string>
      body: { ok: boolean; saw: string[] }
    }
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.ok(answer.body.saw.includes(HEADER), answer.body.saw.join(" "))
    assert.equal(service.seen.at(-1)?.[HEADER], VALUE)
    assert.ok(!JSON.stringify(answer).includes(VALUE), "the Body was given the credential")
  })

  test("a host the Manifest does not declare is refused by name, and so is a scheme that is not http", async () => {
    const other = (await flint.call("fetch_tool", {
      url: `http://localhost:${service.origin.split(":").at(-1) ?? ""}/echo`,
    })) as { refused: string }
    assert.match(other.refused, /tried to reach localhost, and its Manifest does not declare it/)
    assert.match(other.refused, /Add "localhost" to "hosts"/)
    const scheme = (await flint.call("fetch_tool", { url: "file:///etc/passwd" })) as { refused: string }
    assert.match(scheme.refused, /asked for "file", and flintd carries http and https only/)
  })

  test("a header the Body sets is dropped where a Connection carries one of its own", async () => {
    const answer = (await flint.call("fetch_tool", {
      url: `${service.origin}/echo`,
      init_json: JSON.stringify({
        method: "POST",
        headers: { [HEADER]: "the Body's own key", authorization: "Bearer forged", accept: "application/json" },
        body: "{}",
      }),
    })) as { status: number }
    assert.equal(answer.status, 200)
    const saw = service.seen.at(-1)
    assert.equal(saw?.[HEADER], VALUE)
    assert.equal(saw?.["authorization"], undefined)
    assert.equal(saw?.["accept"], "application/json")
  })

  // A Body holds no credential of flintd's, but a caller can put one in its arguments, and a Tool is not the way
  // out for it. The trio goes whether a Connection applies to the target or not.
  test("a credential the Body carries is never forwarded, and a header flintd cannot send is refused by name", async () => {
    const answer = (await flint.call("fetch_tool", {
      url: `${service.origin}/echo`,
      init_json: JSON.stringify({
        headers: { authorization: "Bearer the caller's own", cookie: "session=abc", "proxy-authorization": "Basic x" },
      }),
    })) as { body: { saw: string[] } }
    assert.ok(!answer.body.saw.includes("authorization"), answer.body.saw.join(" "))
    assert.ok(!answer.body.saw.includes("cookie"), answer.body.saw.join(" "))
    assert.ok(!answer.body.saw.includes("proxy-authorization"), answer.body.saw.join(" "))

    const named = (await flint.call("fetch_tool", {
      url: `${service.origin}/echo`,
      init_json: JSON.stringify({ headers: { "bad name": "x" } }),
    })) as { refused: string }
    assert.match(named.refused, /passed the header name "bad name", which is not an HTTP header name/)
    const valued = (await flint.call("fetch_tool", {
      url: `${service.origin}/echo`,
      init_json: JSON.stringify({ headers: { "x-note": "a\r\nx-smuggled: b" } }),
    })) as { refused: string }
    assert.match(valued.refused, /header value for "x-note" that holds a control character/)
  })

  test("the answer carries the allowed headers only, and text comes back as text", async () => {
    const answer = (await flint.call("fetch_tool", { url: `${service.origin}/text` })) as {
      headers: Record<string, string>
      body: JsonValue
    }
    assert.equal(answer.body, "hello")
    assert.equal(answer.headers["content-type"], "text/plain")
    assert.equal(answer.headers["set-cookie"], undefined)
  })

  test("a redirect is followed to a declared host and refused to one that is not", async () => {
    const followed = (await flint.call("fetch_tool", { url: `${service.origin}/moved` })) as {
      status: number
      body: { ok: boolean }
    }
    assert.equal(followed.status, 200)
    assert.equal(followed.body.ok, true)
    assert.equal(service.seen.at(-1)?.[HEADER], VALUE)
    const away = (await flint.call("fetch_tool", { url: `${service.origin}/away` })) as { refused: string }
    assert.match(away.refused, /tried to reach localhost, and its Manifest does not declare it/)
  })

  test("the Proxy holds the answer to a size and gives up on an upstream that never answers", async () => {
    const large = (await capped.call("capped_tool", { url: `${service.origin}/big` })) as { refused: string }
    assert.match(large.refused, /sent capped_tool more than 2048 bytes/)
    // The cap counts what the reader yields, which is what undici has already inflated, not what crossed the wire.
    const packed = (await capped.call("capped_tool", { url: `${service.origin}/gzip` })) as { refused: string }
    assert.match(packed.refused, /sent capped_tool more than 2048 bytes/)
    const slow = (await tight.call("tight_tool", { url: `${service.origin}/slow` })) as { refused: string }
    assert.match(slow.refused, /did not answer tight_tool within 200 ms/)
    // An upstream that sends its headers and then stops is the same timeout, with the same guidance.
    const stalled = (await tight.call("tight_tool", { url: `${service.origin}/stall` })) as { refused: string }
    assert.match(stalled.refused, /did not answer tight_tool within 200 ms/)
    assert.match(stalled.refused, /Ask for less at a time/)
  })

  test("a Connection the Manifest names and this flintd does not hold is named in the refusal", async () => {
    await fetchTool(flint, "typo_tool", FETCH_SOURCE, { hosts: ["127.0.0.1"], connections: ["nowhere"] })
    await approve(flint, "typo_tool")
    const refused = (await flint.call("typo_tool", { url: "http://api.example.com/" })) as { refused: string }
    assert.match(refused.refused, /The Manifest names the Connection "nowhere", and this flintd holds none by that name/)
    assert.match(refused.refused, /flintd connect/)
  })

  // A Manifest declares hostnames, so telling a model to declare "[::1]" would send it round a loop it cannot leave.
  test("an IPv6 literal is refused without advice a Manifest would refuse in turn", async () => {
    const refused = (await flint.call("fetch_tool", { url: "http://[::1]:9/echo" })) as { refused: string }
    assert.match(refused.refused, /a Manifest declares hostnames, not IPv6 literals/)
    assert.ok(!refused.refused.includes('Add "[::1]"'), refused.refused)
  })

  test("a credential an upstream sends back is redacted from the result, the log and the Provenance", async () => {
    logged = []
    const answer = (await flint.call(
      "fetch_tool",
      { url: `${service.origin}/leak`, log: true },
      { excerpt: `the operator pasted ${VALUE} into the chat` },
    )) as { headers: Record<string, string>; body: { echo: string } }
    assert.equal(answer.body.echo, "[redacted]")
    // A reflected header is the same leak as a reflected body, and the Body must read neither.
    assert.equal(answer.headers["etag"], "[redacted]")
    assert.ok(
      logged.some((line) => line.includes("[redacted]")),
      logged.join(" | "),
    )
    assert.ok(!logged.join(" ").includes(VALUE), "a log line carried the credential")

    await flint.call(
      "tool_update",
      { name: "fetch_tool", description: "Ask an upstream service for an answer, and say what it answered." },
      { excerpt: `the operator pasted ${VALUE} into the chat` },
    )
    const [dir] = dirs
    const written = await readFile(join(dir as string, "tools", "fetch_tool", "tool.json"), "utf8")
    assert.ok(written.includes("[redacted]"), written)
    assert.ok(!written.includes(VALUE), "the Provenance excerpt carried the credential")
  })

  test("a credential a key of an error carries is redacted, the way a value of one is", async () => {
    const error = new ToolError("invalid_arguments", "The header is not usable.", { [VALUE]: VALUE, header: VALUE })
    assert.deepEqual(error.details, { "[redacted]": "[redacted]", header: "[redacted]" })
  })

  test("a Manifest nobody has approved reaches no host at all", async () => {
    await fetchTool(flint, "waiting_tool")
    const refused = await refusal(() => flint.call("waiting_tool", { url: `${service.origin}/echo` }))
    assert.equal(refused.code, "awaiting_approval")
    assert.match(refused.message, /reach the hosts 127.0.0.1/)
  })

  // The Approval is read again at every request, so a decision taken back while a Body runs stops the next one.
  test("an Approval taken back during a call stops the fetch that comes after it", async () => {
    await fetchTool(flint, "twice_tool", TWICE_SOURCE)
    await approve(flint, "twice_tool")
    const waiting = (await flint.approvals()).find((one) => one.tool === "twice_tool")
    service.beforeDeny = async (): Promise<void> => {
      await flint.deny(waiting?.id ?? "", "the operator changed their mind")
    }
    try {
      const answer = (await flint.call("twice_tool", { url: service.origin })) as { first: number; refused: string }
      assert.equal(answer.first, 200)
      assert.match(answer.refused, /no longer in force/)
    } finally {
      service.beforeDeny = undefined
    }
  })

  test("an Approval taken back part way through a redirect chain stops the next hop", async () => {
    await fetchTool(flint, "hop_tool")
    await approve(flint, "hop_tool")
    const waiting = (await flint.approvals()).find((one) => one.tool === "hop_tool")
    service.beforeDeny = async (): Promise<void> => {
      await flint.deny(waiting?.id ?? "", "the operator changed their mind")
    }
    try {
      const answer = (await flint.call("hop_tool", { url: `${service.origin}/denyredirect` })) as { refused: string }
      assert.match(answer.refused, /no longer in force/)
    } finally {
      service.beforeDeny = undefined
    }
  })

  test("no Connection value reaches status, the Library listing or tool_read", async () => {
    assert.deepEqual((await flint.connections.list()), [{ name: "upstream", hosts: ["127.0.0.1"] }])
    const read = await flint.call("tool_read", { name: "fetch_tool", include_source: true })
    const surfaces = JSON.stringify([(await flint.status()), (await flint.library()), read, (await flint.approvals())])
    assert.ok(!surfaces.includes(VALUE), "a surface carried the credential")
    assert.ok(surfaces.includes("upstream"), "the Connection name is what a Tool declares, so it stays visible")
  })

  test("a Connection is written to the flintd home, never to the Library, and is gone once it is removed", async () => {
    const [file] = files
    const stored = JSON.parse(await readFile(file as string, "utf8")) as { name: string }[]
    assert.deepEqual(
      stored.map((one) => one.name),
      ["upstream"],
    )
    const dir = dirs[0] as string
    assert.equal(await readFile(join(dir, "connections.json"), "utf8").catch(() => null), null)

    await flint.connections.add({ name: "spare", hosts: ["example.com"], header: { name: "authorization", value: "Bearer 1234567890" } })
    assert.deepEqual(await flint.connections.remove("spare"), { name: "spare", hosts: ["example.com"] })
    assert.deepEqual((await flint.connections.list()), [{ name: "upstream", hosts: ["127.0.0.1"] }])
    const gone = await refusal(() => flint.connections.remove("spare"))
    assert.equal(gone.code, "not_found")
  })

  test("a Connection is refused unless it names one header, at least one host and a credential", async () => {
    const short = await refusal(() => flint.connections.add({ name: "tiny", hosts: ["example.com"], header: { name: "authorization", value: "abc" } }))
    assert.match(short.message, /must be between 8 and 4096 characters/)
    const nohost = await refusal(() => flint.connections.add({ name: "empty", hosts: [], header: { name: "authorization", value: "Bearer 1234567890" } }))
    assert.match(nohost.message, /needs between 1 and 20 hosts/)
  })

  test(
    "the Node tier reaches the network through the same Proxy and never through a socket of its own",
    async () => {
      await fetchTool(flint, "digest_fetch_tool", DIGEST_FETCH_SOURCE)
      await approve(flint, "digest_fetch_tool")
      assert.equal((await flint.library()).find((one) => one.name === "digest_fetch_tool")?.tier, "node")
      const answer = (await flint.call("digest_fetch_tool", { url: `${service.origin}/echo` })) as { status: number }
      assert.equal(answer.status, 200)
      assert.equal(service.seen.at(-1)?.[HEADER], VALUE)
      const refused = (await flint.call("digest_fetch_tool", { url: "http://example.com/" })) as { refused: string }
      assert.match(refused.refused, /tried to reach example.com, and its Manifest does not declare it/)

      // The global is deleted before the Body loads, so the fetch of a Body never reaches the host the Proxy would allow.
      const before = service.seen.length
      const direct = (await flint.call("digest_fetch_tool", { url: `${service.origin}/echo`, log: true })) as {
        reached: boolean
        why: string
      }
      assert.deepEqual(direct, { reached: false, why: "fetch is not defined" })
      assert.equal(service.seen.length, before)
    },
  )
})
