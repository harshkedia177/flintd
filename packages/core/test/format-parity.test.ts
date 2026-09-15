import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { formatTools } from "../src/formats.ts"
import type { ToolDefinition, ToolFormat } from "../src/types.ts"

// The Python client mirrors this emitter. One fixture file holds the input and the answer both of them must give,
// so a conversion that lands in one language and not the other fails here or in python/tests/test_parity.py.
const FIXTURES = new URL("../../../python/tests/parity.json", import.meta.url)
const FORMATS: ToolFormat[] = ["anthropic", "openai", "openai-chat", "gemini"]

interface Parity {
  tools: ToolDefinition[]
  expected: Record<string, unknown>
}

test("the four shapes the Python client also emits are the ones in the parity fixtures", () => {
  const held = JSON.parse(readFileSync(FIXTURES, "utf8")) as Parity
  assert.ok(held.tools.length > 0)
  for (const format of FORMATS) {
    assert.deepEqual(formatTools(held.tools, format), held.expected[format], format)
  }
})
