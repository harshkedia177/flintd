import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const BIN = new URL("../bin/flintd.ts", import.meta.url).pathname

test("the CLI never sends the local token to a daemon that is not on this machine", async () => {
  const home = await mkdtemp(join(tmpdir(), "flintd-home-"))
  try {
    // The second URL is a hostname that only begins with the loopback address; it belongs to somebody else.
    for (const url of ["https://elsewhere.example", "https://127.0.0.1.attacker.example"]) {
      const refused = await cli(home, ["status", "--url", url])
      assert.equal(refused.code, 1, url)
      assert.match(refused.err, /Pass --token, or set FLINTD_TOKEN/)
    }
    // A real loopback address takes the local token, and this home holds none.
    const local = await cli(home, ["status", "--url", "http://[::1]:3546"])
    assert.equal(local.code, 1)
    assert.match(local.err, /There is no token/)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

function cli(home: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, ...args], {
      env: { ...process.env, FLINTD_HOME: home },
    })
    let err = ""
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
    child.on("close", (code) => done({ code: code ?? 0, err }))
  })
}
