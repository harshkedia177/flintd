import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ToolError } from "@flintd/core"
import { DEFAULT_PORT, ensureToken, flintdHome, readConfig, readToken } from "../src/config.ts"

test("the first start writes a token that only its owner can read, and keeps it after that", async () => {
  await withHome(async (home) => {
    const token = await ensureToken(home)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    const file = await stat(join(home, "token"))
    assert.equal(file.mode & 0o777, 0o600)
    assert.equal(await ensureToken(home), token)
    assert.equal(await readToken(home), token)
  })
})

test("the client quirk table is read by client name, and an unknown quirk is refused", async () => {
  await withHome(async (home) => {
    assert.equal((await readConfig(home)).mcpClientQuirks, null)

    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ mcpClientQuirks: { OpenCode: { omitOutputSchema: false }, other: {} } }),
    )
    assert.deepEqual((await readConfig(home)).mcpClientQuirks, {
      opencode: { omitOutputSchema: false },
      other: { omitOutputSchema: false },
    })

    await writeFile(join(home, "config.json"), JSON.stringify({ mcpClientQuirks: { opencode: { omitResultSchema: true } } }))
    await assert.rejects(readConfig(home), /does not read: omitResultSchema/)

    await writeFile(join(home, "config.json"), JSON.stringify({ mcpClientQuirks: ["opencode"] }))
    await assert.rejects(readConfig(home), /keyed by the MCP client's own name/)
  })
})

test("the config names the skills directories an export writes into, and refuses any other shape", async () => {
  await withHome(async (home) => {
    assert.deepEqual((await readConfig(home)).skillExports, [])

    // The contract's own example is written with a leading ~, and every harness documents its directory that way.
    await writeFile(join(home, "config.json"), JSON.stringify({ skillExports: ["~/.agents/skills", "~", "/tmp/one", "two"] }))
    assert.deepEqual((await readConfig(home)).skillExports, [
      join(homedir(), ".agents", "skills"),
      homedir(),
      "/tmp/one",
      join(process.cwd(), "two"),
    ])

    for (const held of [{ skillExports: "/tmp/one" }, { skillExports: [""] }, { skillExports: [3] }]) {
      await writeFile(join(home, "config.json"), JSON.stringify(held))
      await assert.rejects(readConfig(home), /is a list of directories/)
    }
  })
})

test("a token other users can read is refused rather than used", async () => {
  await withHome(async (home) => {
    await ensureToken(home)
    await chmod(join(home, "token"), 0o644)
    await assert.rejects(readToken(home), /chmod 600/)
    await assert.rejects(ensureToken(home), /chmod 600/)
  })
})

test("a home without a token tells the operator to start the daemon", async () => {
  await withHome(async (home) => {
    await assert.rejects(readToken(home), (cause: unknown) => {
      assert.ok(cause instanceof ToolError)
      assert.match(cause.message, /flintd serve/)
      return true
    })
  })
})

// Every `createFlint` option an operator may want to move is a key here, and each one is refused by its own name
// when it holds the wrong kind of value.
test("the config file carries every limit createFlint takes, and refuses a value of the wrong kind", async () => {
  await withHome(async (home) => {
    const limits = {
      modelTimeoutMs: 5000,
      heldOutTimeoutMs: 60000,
      stopGraceMs: 500,
      memoryLimitBytes: 32 * 1024 * 1024,
      terminateAfterMs: 31000,
      duplicateCosine: 0.95,
      duplicateCosineBand: 0.8,
      siblingCosine: 0.9,
      searchCosine: 0.4,
    }
    await writeFile(join(home, "config.json"), JSON.stringify(limits))
    const config = await readConfig(home)
    for (const [key, value] of Object.entries(limits)) {
      assert.equal((config as unknown as Record<string, unknown>)[key], value, key)
    }

    await writeFile(join(home, "config.json"), JSON.stringify({ modelTimeoutMs: 0 }))
    await assert.rejects(readConfig(home), /"modelTimeoutMs" in .* must be how long one model call may take/)
    await writeFile(join(home, "config.json"), JSON.stringify({ searchCosine: 2 }))
    await assert.rejects(readConfig(home), /"searchCosine" in .* is how close an embedding must be/)
  })
})

test("the config file names the port and the Library, and every other key is refused", async () => {
  await withHome(async (home) => {
    const fallback = await readConfig(home)
    assert.equal(fallback.port, DEFAULT_PORT)
    assert.equal(fallback.libraryDir, join(home, "library"))

    await writeFile(join(home, "config.json"), JSON.stringify({ port: 4000, libraryDir: "tools-of-mine" }))
    const config = await readConfig(home)
    assert.equal(config.port, 4000)
    assert.equal(config.libraryDir, join(home, "tools-of-mine"))

    await writeFile(join(home, "config.json"), JSON.stringify({ port: 70000 }))
    await assert.rejects(readConfig(home), /whole number from 0 to 65535/)

    await writeFile(join(home, "config.json"), JSON.stringify({ prot: 4000 }))
    await assert.rejects(readConfig(home), /does not read: prot/)

    await writeFile(join(home, "config.json"), "{")
    await assert.rejects(readConfig(home), /not valid JSON/)
  })
})

test("the config names the project Library and a remote per Library, and a working directory with .flintd brings one", async () => {
  await withHome(async (home) => {
    const file = join(home, "config.json")
    assert.equal((await readConfig(home)).projectLibraryDir, null)

    await writeFile(
      file,
      JSON.stringify({
        projectLibraryDir: "of-this-project",
        libraryRemote: "git@example.invalid:me/tools.git",
        projectLibraryRemote: "/srv/tools.git",
        syncTimeoutMs: 4000,
      }),
    )
    const config = await readConfig(home)
    assert.equal(config.projectLibraryDir, join(process.cwd(), "of-this-project"))
    assert.equal(config.libraryRemote, "git@example.invalid:me/tools.git")
    assert.equal(config.projectLibraryRemote, "/srv/tools.git")
    assert.equal(config.syncTimeoutMs, 4000)

    await writeFile(file, JSON.stringify({ libraryRemote: 7 }))
    await assert.rejects(readConfig(home), /"libraryRemote".*must be the git remote/)

    await writeFile(file, JSON.stringify({ syncTimeoutMs: 0 }))
    await assert.rejects(readConfig(home), /"syncTimeoutMs".*whole number of milliseconds/)

    await rm(file, { force: true })
    const project = await mkdtemp(join(tmpdir(), "flintd-project-"))
    await mkdir(join(project, ".flintd"))
    const before = process.cwd()
    process.chdir(project)
    try {
      assert.equal((await readConfig(home)).projectLibraryDir, join(process.cwd(), ".flintd", "library"))
    } finally {
      process.chdir(before)
      await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

test("the config names how many Node tier children stay warm, takes 0 for a fresh child per call, and refuses less", async () => {
  await withHome(async (home) => {
    const file = join(home, "config.json")
    assert.equal((await readConfig(home)).warmNodeRunners, null)

    await writeFile(file, JSON.stringify({ warmNodeRunners: 2 }))
    assert.equal((await readConfig(home)).warmNodeRunners, 2)

    await writeFile(file, JSON.stringify({ warmNodeRunners: 0 }))
    assert.equal((await readConfig(home)).warmNodeRunners, 0)

    await writeFile(file, JSON.stringify({ warmNodeRunners: -1 }))
    await assert.rejects(readConfig(home), /"warmNodeRunners".*holds warm/)
  })
})

test("the config names the container tier's image, engine and timeout, and refuses an engine it cannot drive", async () => {
  await withHome(async (home) => {
    const file = join(home, "config.json")
    const fallback = await readConfig(home)
    assert.deepEqual(
      [fallback.containerImage, fallback.containerEngine, fallback.containerTimeoutMs, fallback.maxExecBytes],
      [null, null, null, null],
    )

    await writeFile(
      file,
      JSON.stringify({
        containerImage: "node:26-alpine",
        containerEngine: "none",
        containerTimeoutMs: 60000,
        maxExecBytes: 2048,
      }),
    )
    const config = await readConfig(home)
    assert.equal(config.containerImage, "node:26-alpine")
    assert.equal(config.containerEngine, "none")
    assert.equal(config.containerTimeoutMs, 60000)
    assert.equal(config.maxExecBytes, 2048)

    await writeFile(file, JSON.stringify({ containerEngine: "podman" }))
    await assert.rejects(readConfig(home), /"containerEngine" in .* is one of docker, none/)

    await writeFile(file, JSON.stringify({ containerImage: "  " }))
    await assert.rejects(readConfig(home), /"containerImage".*as one line of text/)
  })
})

test("FLINTD_HOME moves the flintd home directory", async () => {
  await withHome(async (home) => {
    const before = process.env["FLINTD_HOME"]
    process.env["FLINTD_HOME"] = home
    try {
      assert.equal(flintdHome(), home)
    } finally {
      if (before === undefined) delete process.env["FLINTD_HOME"]
      else process.env["FLINTD_HOME"] = before
    }
  })
})

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "flintd-home-"))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

test("a config holding the model key is refused when other users can read it", async () => {
  await withHome(async (home) => {
    const file = join(home, "config.json")
    await writeFile(file, JSON.stringify({ model: { provider: "anthropic", apiKey: "sk-secret" } }), { mode: 0o600 })
    const config = await readConfig(home)
    assert.deepEqual(config.model, { provider: "anthropic", apiKey: "sk-secret" })

    await chmod(file, 0o644)
    // The refusal names the file it read, not the token file beside it.
    await assert.rejects(readConfig(home), /^ToolError: The config file .*config\.json is readable by other users/)

    // A config with no key is read whatever its mode: there is nothing in it to keep.
    await writeFile(file, JSON.stringify({ port: 0 }), { mode: 0o644 })
    assert.equal((await readConfig(home)).model, null)
  })
})

test("the model key is read as an object and every other shape under it is refused by name", async () => {
  await withHome(async (home) => {
    const file = join(home, "config.json")
    const write = async (value: unknown): Promise<void> => {
      await writeFile(file, JSON.stringify({ model: value }), { mode: 0o600 })
    }
    await write("anthropic")
    await assert.rejects(readConfig(home), /must be an object with a provider and an apiKey/)
    await write({ provider: "anthropic", apiKey: "k", temperature: "1" })
    await assert.rejects(readConfig(home), /holds keys this build of flintd does not read: temperature/)
    await write({ provider: "anthropic", apiKey: "" })
    await assert.rejects(readConfig(home), /"model\.apiKey" in .* must be a non-empty string/)
  })
})
