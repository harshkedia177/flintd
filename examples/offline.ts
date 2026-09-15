import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError, createFlint } from "@flintd/core"

const PARAMETERS = JSON.stringify({
  type: "object",
  properties: { value: { type: "string" }, separator: { type: "string", enum: [",", ";"] } },
  required: ["value"],
  additionalProperties: false,
})

const EXAMPLES = [
  { args: { value: "a,b,c" }, expected: ["a", "b", "c"] },
  { args: { value: "a;b", separator: ";" }, expected: ["a", "b"] },
]

function definition(execute_source: string): Record<string, unknown> {
  return {
    name: "split_list",
    description: "Split a delimited string into a list of trimmed parts.",
    parameters_json: PARAMETERS,
    execute_source,
    examples: EXAMPLES,
  }
}

const dir = await mkdtemp(join(tmpdir(), "flintd-offline-"))
const flint = createFlint({ dir })
await flint.start()

try {
  console.log(`Library: ${dir}`)
  console.log(`Meta tools: ${(await flint.tools()).map((tool) => tool.name).join(", ")}`)

  const refused = await expectRefusal(
    definition("return args.value.split(args.separator || ';').map((part) => part.trim())"),
  )
  console.log(`\nFirst attempt refused: ${refused.code}`)
  console.log(`  example ${String(refused.details["index"])} expected ${JSON.stringify(refused.details["expected"])}`)
  console.log(`  it returned ${JSON.stringify(refused.details["actual"])}`)
  assert.equal(refused.code, "example_failed")
  assert.equal((await flint.status()).tools, 0, "a failing Example must save nothing")

  const created = await flint.call(
    "tool_create",
    definition("return args.value.split(args.separator || ',').map((part) => part.trim())"),
  )
  console.log(`\nSecond attempt saved: ${JSON.stringify(created)}`)
  assert.equal((await flint.status()).tools, 1)

  const direct = await flint.call("split_list", { value: "one, two , three" })
  console.log(`split_list("one, two , three") -> ${JSON.stringify(direct)}`)
  assert.deepEqual(direct, ["one", "two", "three"])

  const dispatched = await flint.call("tool_run", { name: "split_list", args: { value: "x;y", separator: ";" } })
  console.log(`tool_run split_list -> ${JSON.stringify(dispatched)}`)
  assert.deepEqual(dispatched, ["x", "y"])

  const read = await flint.call("tool_read", { name: "split_list" })
  console.log(`tool_read -> ${JSON.stringify(read)}`)

  const held = (read as { held_out: { status: string } }).held_out
  console.log(`Held-out status with no model configured: ${held.status}`)
  assert.equal(held.status, "unavailable")
  assert.equal((await flint.status()).model.configured, false)

  console.log("\nNo API key was used and the Body reached no network.")
} finally {
  await flint.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

async function expectRefusal(args: Record<string, unknown>): Promise<ToolError> {
  try {
    await flint.call("tool_create", args)
  } catch (cause) {
    if (cause instanceof ToolError) return cause
    throw cause
  }
  throw new Error("tool_create saved a Tool whose Example does not pass")
}
