import assert from "node:assert/strict"
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"
import type { Flint, JsonValue } from "../src/index.ts"
import { refusal, withFlint } from "./support.ts"

const ROOT = "workspace"

const FILE_SOURCE = `if (args.op === "none") return null
if (args.op === "read") return { text: await ctx.fs.read(args.path) }
if (args.op === "write") return await ctx.fs.write(args.path, args.text)
return { entries: await ctx.fs.list(args.path) }`

const NO_ROOT =
  'pure_tool asked for a file, and nothing grants it a filesystem root. A Tool reaches a file only when its Manifest declares "fs" and one person has approved that Manifest.'

const REACHING_SOURCE = `try {
  if (args.op === "fs") await ctx.fs.read(args.path)
  else if (args.op === "fetch") await ctx.fetch(args.path)
  else await ctx.callTool(args.path, {})
} catch (cause) { return { refused: cause.message } }
return { refused: null }`

const PARAMETERS = JSON.stringify({
  type: "object",
  properties: { op: { type: "string" }, path: { type: "string" }, text: { type: "string" } },
  required: ["op", "path"],
  additionalProperties: false,
})

const CREATION = {
  name: "file_tool",
  description: "Read, write and list the files of the workspace directory.",
  parameters_json: PARAMETERS,
  execute_source: FILE_SOURCE,
  manifest_json: JSON.stringify({ fs: ROOT }),
  examples: [{ args: { op: "read", path: "notes/today.md" }, expected: { text: "one two three" } }],
}

// An Example that needs what the Manifest asks for cannot run until a person grants it, so the save keeps it as
// deferred and the grant is what runs it: one create, then the decision.
async function withFiles(run: (flint: Flint, root: string) => Promise<void>, options = {}): Promise<void> {
  await withFlint(async (flint, dir) => {
    const root = join(dir, ROOT)
    await mkdir(join(root, "notes"), { recursive: true })
    await writeFile(join(root, "notes", "today.md"), "one two three")
    const created = (await flint.call("tool_create", CREATION)) as { state: string; deferred?: number[] }
    assert.equal(created.state, "draft")
    assert.deepEqual(created.deferred, [0])
    await flint.approve((await flint.approvals())[0]?.id ?? "")
    await run(flint, root)
  }, options)
}

function ran(flint: Flint, args: Record<string, JsonValue>): Promise<JsonValue> {
  return flint.call("file_tool", args)
}

describe("the file helpers", { concurrency: true }, () => {

  test("ctx.fs reads, writes and lists inside the Manifest root", async () => {
    await withFiles(async (flint) => {
      assert.deepEqual(await ran(flint, { op: "read", path: "notes/today.md" }), { text: "one two three" })
      assert.deepEqual(await ran(flint, { op: "write", path: "notes/later.md", text: "four" }), {
        path: "notes/later.md",
        bytes: 4,
      })
      assert.deepEqual(await ran(flint, { op: "read", path: "notes/later.md" }), { text: "four" })
      assert.deepEqual(await ran(flint, { op: "list", path: "notes" }), {
        entries: [
          { name: "later.md", kind: "file" },
          { name: "today.md", kind: "file" },
        ],
      })
      assert.deepEqual(await ran(flint, { op: "list", path: "." }), { entries: [{ name: "notes", kind: "directory" }] })
    })
  })

  test("every path that leads out of the Manifest root is refused, and so is every directory flintd owns", async () => {
    await withFiles(async (flint, root) => {
      await symlink(join(root, "..", "tools"), join(root, "own"))
      await symlink("/etc/hosts", join(root, "away"))
      await symlink(join(root, "notes", "gone.md"), join(root, "dangling"))
      const refused: [Record<string, JsonValue>, RegExp][] = [
        [{ op: "read", path: "../tools/file_tool/tool.json" }, /outside the filesystem root/],
        [{ op: "read", path: "/etc/hosts" }, /absolute path/],
        [{ op: "read", path: "own/file_tool/tool.json" }, /outside the filesystem root/],
        [{ op: "read", path: "away" }, /outside the filesystem root/],
        [{ op: "read", path: "dangling" }, /no such file inside its Manifest root/],
        [{ op: "list", path: "own" }, /outside the filesystem root/],
        [{ op: "write", path: "own/stolen.txt", text: "x" }, /outside the filesystem root/],
        [{ op: "write", path: "../tools/stolen.txt", text: "x" }, /outside the filesystem root/],
        [{ op: "write", path: "away", text: "x" }, /outside the filesystem root/],
      ]
      for (const [args, message] of refused) {
        const error = await refusal(() => ran(flint, args))
        assert.equal(error.code, "call_failed", JSON.stringify(args))
        assert.match(error.message, message, JSON.stringify(args))
      }
    })
  })

  // A dangling symlink resolves to nothing, so the write path falls back to the parent directory and the name; the
  // open is what refuses to follow the link, and the file it points at is never made.
  test("a write onto a symlink lands on no file outside the Manifest root", async () => {
    await withFiles(async (flint, root) => {
      const away = join(root, "..", "stolen.txt")
      await symlink(away, join(root, "notes", "escape.txt"))
      const refused = await refusal(() => ran(flint, { op: "write", path: "notes/escape.txt", text: "taken" }))
      assert.equal(refused.code, "call_failed")
      await assert.rejects(() => access(away), "the write followed the symlink out of the Manifest root")
    })
  })

  // The Library is flintd's own directory, so a root that resolves to it reaches nothing, however it got there.
  test("a Manifest root that is a symlink to the Library reaches nothing at all", async () => {
    await withFlint(async (flint, dir) => {
      await symlink(dir, join(dir, ROOT))
      const pure = { ...CREATION, examples: [{ args: { op: "none", path: "." }, expected: null }] }
      await flint.call("tool_create", pure)
      await flint.approve((await flint.approvals())[0]?.id ?? "")
      for (const args of [
        { op: "list", path: "." },
        { op: "read", path: "tools/file_tool/tool.json" },
        { op: "write", path: "tools/file_tool/body.js", text: "taken" },
      ]) {
        const error = await refusal(() => ran(flint, args))
        assert.match(error.message, /leads outside the Library directory, or into a directory flintd owns/)
      }
      assert.doesNotMatch(await readFile(join(dir, "tools", "file_tool", "body.js"), "utf8"), /taken/)
    })
  })

  test("a read and a write are both bounded, and the message says the bound", async () => {
    await withFiles(
      async (flint, root) => {
        await writeFile(join(root, "notes", "big.md"), "x".repeat(300))
        const read = await refusal(() => ran(flint, { op: "read", path: "notes/big.md" }))
        assert.match(read.message, /is 300 bytes and file_tool may read 200/)
        const written = await refusal(() => ran(flint, { op: "write", path: "notes/big.md", text: "y".repeat(300) }))
        assert.match(written.message, /tried to write 300 bytes .* and the limit is 200/)
      },
      { maxResultBytes: 200 },
    )
  })

  test("a Tool whose Manifest declares nothing reaches no file and no host, and cannot call itself", async () => {
    await withFlint(async (flint) => {
      await flint.call("tool_create", {
        name: "pure_tool",
        description: "Try to reach what its Manifest never asked for.",
        parameters_json: PARAMETERS,
        execute_source: REACHING_SOURCE,
        examples: [
          { args: { op: "fs", path: "notes/today.md" }, expected: { refused: NO_ROOT } },
        ],
      })
      const reached = (await flint.call("pure_tool", { op: "fetch", path: "https://example.com" })) as {
        refused: string
      }
      assert.match(reached.refused, /pure_tool tried to reach example.com, and its Manifest does not declare it/)
      const looped = (await flint.call("pure_tool", { op: "callTool", path: "pure_tool" })) as { refused: string }
      assert.match(looped.refused, /The Tool chain pure_tool -> pure_tool calls pure_tool again/)
    })
  })
})
