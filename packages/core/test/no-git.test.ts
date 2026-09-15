import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createFlint } from "../src/index.ts"
import { refusal } from "./support.ts"

// This file holds one test because it writes process.env.PATH, which every other test in the same file would share.
test("a machine without git on the PATH says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flintd-"))
  const path = process.env["PATH"] ?? ""
  try {
    process.env["PATH"] = join(dir, "no-such-directory")
    const error = await refusal(() => createFlint({ dir }).start())
    assert.equal(error.code, "store_error")
    assert.match(error.message, /git is not on the PATH/)
  } finally {
    process.env["PATH"] = path
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
