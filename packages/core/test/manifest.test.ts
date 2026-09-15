import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { JsonValue } from "../src/index.ts"
import { creation, refusal, sharedLibrary, withFlint } from "./support.ts"

const shared = sharedLibrary()

function manifested(manifest: Record<string, JsonValue>, overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return creation({ manifest_json: JSON.stringify(manifest), ...overrides })
}

async function read(flint: { call(name: string, args: unknown): Promise<JsonValue> }, name: string): Promise<Record<string, JsonValue>> {
  return (await flint.call("tool_read", { name })) as Record<string, JsonValue>
}

describe("the Manifest", { concurrency: true }, () => {

  test("a Manifest flintd cannot read is refused, and the message says what a Manifest holds", async () => {
    await shared(async (flint) => {
      const refusals: [Record<string, JsonValue>, RegExp][] = [
        [{ network: ["api.example.com"] }, /holds only fs, hosts, connections, exec/],
        [{ fs: "/etc" }, /absolute path/],
        [{ fs: "../elsewhere" }, /not one directory inside the Library/],
        [{ fs: "." }, /not one directory inside the Library/],
        [{ fs: "tools" }, /belongs to flintd itself/],
        [{ fs: "work:space" }, /holds a ":"/],
        [{ fs: "index.sqlite-wal" }, /belongs to flintd itself/],
        [{ hosts: ["*.example.com"] }, /not a hostname/],
        [{ hosts: ["https://api.example.com"] }, /not a hostname/],
        [{ connections: ["Not A Name"] }, /not a Connection name/],
        [{ exec: "yes" }, /"exec" is true or false/],
      ]
      for (const [manifest, message] of refusals) {
        const error = await refusal(() => flint.call("tool_create", manifested(manifest, { name: "never_saved" })))
        assert.equal(error.code, "invalid_manifest", JSON.stringify(manifest))
        assert.match(error.message, message)
      }
      assert.equal((await flint.library()).length, 0)
    })
  })

  test("manifest_json that is not JSON is refused before anything runs", async () => {
    await shared(async (flint) => {
      const error = await refusal(() =>
        flint.call("tool_create", creation({ name: "never_saved", manifest_json: "{ fs: workspace }" })),
      )
      assert.equal(error.code, "invalid_manifest")
      assert.match(error.message, /not valid JSON/)
    })
  })

  test("the Manifest picks the tier, and tool_read shows it", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", creation({ name: "pure_tool" }))
      await flint.call("tool_create", manifested({ fs: "workspace" }, { name: "files_tool" }))
      await flint.call("tool_create", manifested({ hosts: ["api.example.com"] }, { name: "hosts_tool" }))

      const tiers = Object.fromEntries((await flint.library()).map((one) => [one.name, one.tier]))
      assert.deepEqual(tiers, { pure_tool: "quickjs", files_tool: "quickjs", hosts_tool: "quickjs" })
      assert.equal((await read(flint, "files_tool"))["tier"], "quickjs")
    })
  })

  test("a Body that imports a Node builtin picks the Node tier", async () => {
    await withFlint(async (flint) => {
      await flint.call(
        "tool_create",
        creation({
          name: "node_tool",
          execute_source: "const { createHash } = await import('node:crypto')\nreturn { count: createHash === undefined ? 0 : 3 }",
        }),
      )
      assert.equal((await flint.library()).find((one) => one.name === "node_tool")?.tier, "node")
      assert.equal((await read(flint, "node_tool"))["tier"], "node")
    })
  })

  // The capability-off proof of a container-tier Body runs in the Node tier, so the save needs no engine and the
  // grant, which is where the capability is, is what a machine with no engine refuses.
  test("with no container engine a Manifest that asks for exec saves as a Draft, and the grant is refused", async () => {
    await withFlint(
      async (flint) => {
        const created = (await flint.call("tool_create", manifested({ exec: true }, { name: "exec_tool" }))) as Record<string, JsonValue>
        assert.equal(created["state"], "draft")
        assert.equal(created["tier"], "container")

        const decided = await flint.approve((await flint.approvals())[0]?.id ?? "")
        assert.equal(decided.status, "pending")
        assert.match(decided.message ?? "", /no container engine flintd can use/)
        assert.match(decided.message ?? "", /Install Docker/)
        assert.equal((await refusal(() => flint.call("exec_tool", { text: "one two" }))).code, "awaiting_approval")
        assert.deepEqual((await flint.status()).tiers.container, { available: false, engine: "none", version: null })
      },
      { containerEngine: "none" },
    )
  })

  test("ctx.exec outside the container tier is refused with the way to reach it", async () => {
    await shared(async (flint) => {
      const source = [
        "try { await ctx.exec('echo hi') } catch (cause) {",
        "  return { refused: cause.message.includes('a command runs only in the container tier') }",
        "}",
        "return { refused: false }",
      ].join("\n")
      await flint.call("tool_create", creation({ name: "no_exec_tool", execute_source: source, examples: [{ args: { text: "x" }, expected: { refused: true } }] }))
      assert.equal((await flint.library()).find((one) => one.name === "no_exec_tool")?.tier, "quickjs")
    })
  })

  test("a Body may import only what flintd ships, and a bare import is refused with the list", async () => {
    await shared(async (flint) => {
      const bare = await refusal(() =>
        flint.call("tool_create", creation({ name: "never_saved", execute_source: "await import('left-pad')\nreturn { count: 1 }" })),
      )
      assert.equal(bare.code, "invalid_source")
      assert.match(bare.message, /imports "left-pad"/)
      assert.match(bare.message, /node:crypto/)

      const shut = await refusal(() =>
        flint.call("tool_create", creation({ name: "never_saved", execute_source: "await import('node:fs')\nreturn { count: 1 }" })),
      )
      assert.equal(shut.code, "invalid_source")

      const worked = await refusal(() =>
        flint.call("tool_create", creation({ name: "never_saved", execute_source: "await import(args.text)\nreturn { count: 1 }" })),
      )
      assert.equal(worked.code, "invalid_source")
      assert.match(worked.message, /worked out while it runs/)
    })
  })

  test("a Manifest change is a Version like a Body change: the Tool goes back to Draft and asks again", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", creation())
      assert.equal((await flint.approvals()).length, 0)

      const changed = (await flint.call("tool_update", {
        name: "word_count",
        manifest_json: JSON.stringify({ fs: "workspace" }),
      })) as Record<string, JsonValue>
      assert.equal(changed["state"], "draft")
      assert.deepEqual((changed["approval"] as Record<string, JsonValue>)["status"], "pending")

      const waiting = (await flint.approvals())
      assert.equal(waiting.length, 1)
      assert.equal(waiting[0]?.version, changed["version"])
      assert.match(waiting[0]?.summary ?? "", /read and write files under "workspace"/)
      assert.deepEqual((await read(flint, "word_count"))["manifest"], { fs: "workspace" })
    })
  })
})
