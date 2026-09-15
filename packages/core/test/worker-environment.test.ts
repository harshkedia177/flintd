import assert from "node:assert/strict"
import test from "node:test"
import { creation, withFlint } from "./support.ts"

// This file holds one test because it writes process.env, and the executor Worker reads it when it starts.
test("a secret in the parent environment never reaches the Worker that runs a Body", async () => {
  process.env["FLINTD_TEST_SECRET"] = "never-beside-a-body"
  try {
    await withFlint(async (flint) => {
      await flint.call("tool_create", creation())
      assert.deepEqual(await flint.call("word_count", { text: "one two" }), { count: 2 })
    })
  } finally {
    delete process.env["FLINTD_TEST_SECRET"]
  }
})
