import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { parse as parseYaml } from "yaml"
import { main } from "../src/cli.ts"
import { readConfig } from "../src/config.ts"

interface Run {
  code: number
  out: string
  err: string
}

const started = process.cwd()

async function withHome(run: (home: string, project: string, init: (...args: string[]) => Promise<Run>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "flintd-init-"))
  const home = join(root, "home")
  const project = join(root, "project")
  const flintdHome = join(home, ".flintd")
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  const heldHome = process.env["HOME"]
  const heldFlintd = process.env["FLINTD_HOME"]
  process.env["HOME"] = home
  process.env["FLINTD_HOME"] = flintdHome
  process.chdir(project)
  // macOS resolves the temporary directory through a symlink, and init writes the path the daemon is started in.
  const real = process.cwd()
  const init = async (...args: string[]): Promise<Run> => {
    const out: string[] = []
    const err: string[] = []
    const toOut = process.stdout.write.bind(process.stdout)
    const toErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = (chunk: string | Uint8Array): boolean => (out.push(String(chunk)), true)
    process.stderr.write = (chunk: string | Uint8Array): boolean => (err.push(String(chunk)), true)
    try {
      const code = await main(["init", ...args])
      return { code, out: out.join(""), err: err.join("") }
    } finally {
      process.stdout.write = toOut
      process.stderr.write = toErr
    }
  }
  try {
    await run(home, real, init)
  } finally {
    process.chdir(started)
    if (heldHome === undefined) delete process.env["HOME"]
    else process.env["HOME"] = heldHome
    if (heldFlintd === undefined) delete process.env["FLINTD_HOME"]
    else process.env["FLINTD_HOME"] = heldFlintd
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

test("init writes the MCP entry, the hooks and the skills directory each harness documents", async () => {
  await withHome(async (home, _project, init) => {
    const claude = await init("--harness", "claude-code")
    assert.equal(claude.code, 0)
    const claudeMcp = (await json(join(home, ".claude.json")))["mcpServers"] as Record<string, Record<string, unknown>>
    assert.deepEqual(claudeMcp["flintd"], {
      type: "http",
      url: "http://127.0.0.1:3546/mcp",
      headers: { Authorization: "Bearer ${FLINTD_TOKEN}" },
    })
    const claudeHooks = (await json(join(home, ".claude", "settings.json")))["hooks"] as Record<string, unknown[]>
    assert.deepEqual(Object.keys(claudeHooks).sort(), ["PostToolUse", "SessionStart", "Stop"])
    const command = String(
      ((claudeHooks["PostToolUse"]?.[0] as { hooks: { command: string }[] }).hooks[0] as { command: string }).command,
    )
    // The package manager's shim is the recorded command, and every argument is single quoted.
    assert.match(command, /^'.*flintd-hook' 'claude-code'$/)

    assert.equal((await init("--harness", "codex")).code, 0)
    const toml = await readFile(join(home, ".codex", "config.toml"), "utf8")
    assert.match(toml, /^\[mcp_servers\.flintd]\nurl = "http:\/\/127\.0\.0\.1:3546\/mcp"\nbearer_token_env_var = "FLINTD_TOKEN"\n$/)
    const codexHooks = (await json(join(home, ".codex", "hooks.json")))["hooks"] as Record<string, unknown[]>
    assert.equal(codexHooks["PostToolUse"]?.length, 1)

    assert.equal((await init("--harness", "opencode")).code, 0)
    const openCode = await json(join(home, ".config", "opencode", "opencode.json"))
    assert.deepEqual((openCode["mcp"] as Record<string, unknown>)["flintd"], {
      type: "remote",
      url: "http://127.0.0.1:3546/mcp",
      enabled: true,
      headers: { Authorization: "Bearer {env:FLINTD_TOKEN}" },
    })
    assert.match(
      await readFile(join(home, ".config", "opencode", "plugins", "flintd.js"), "utf8"),
      /tool\.execute\.after/,
    )

    assert.equal((await init("--harness", "hermes")).code, 0)
    const hermes = parseYaml(await readFile(join(home, ".hermes", "config.yaml"), "utf8")) as Record<string, Record<string, Record<string, unknown>>>
    assert.deepEqual(hermes["mcp_servers"]?.["flintd"], {
      url: "http://127.0.0.1:3546/mcp",
      headers: { Authorization: "Bearer ${FLINTD_TOKEN}" },
    })
    const hermesPlugin = await readFile(join(home, ".hermes", "plugins", "flintd", "__init__.py"), "utf8")
    assert.match(hermesPlugin, /register_hook\("post_tool_call"/)
    // Names only, the way every other wrapper sends them.
    assert.match(hermesPlugin, /dict\.fromkeys\(params\)/)

    assert.equal((await init("--harness", "openclaw")).code, 0)
    const openClaw = await json(join(home, ".openclaw", "openclaw.json"))
    assert.deepEqual(((openClaw["mcp"] as Record<string, Record<string, unknown>>)["servers"] as Record<string, unknown>)["flintd"], {
      url: "http://127.0.0.1:3546/mcp",
      transport: "streamable-http",
      enabled: true,
      headers: { Authorization: "Bearer ${FLINTD_TOKEN}" },
    })
    assert.match(await readFile(join(home, ".openclaw", "hooks", "flintd", "HOOK.md"), "utf8"), /"events": \["command:new", "command:reset"]/)

    assert.equal((await init("--harness", "pi")).code, 0)
    assert.equal(
      (await json(join(home, ".pi", "agent", "extensions", "flintd", "package.json")))["name"],
      "@flintd/pi",
    )

    const config = await json(join(home, ".flintd", "config.json"))
    assert.deepEqual(config["skillExports"], [
      join(home, ".claude", "skills"),
      join(home, ".agents", "skills"),
      join(home, ".config", "opencode", "skills"),
      join(home, ".hermes", "skills"),
      join(home, ".pi", "agent", "skills"),
    ])
  })
})

test("the project scope writes into the project directory and not the home directory", async () => {
  await withHome(async (home, project, init) => {
    assert.equal((await init("--harness", "claude-code", "--scope", "project")).code, 0)
    const mcp = (await json(join(project, ".mcp.json")))["mcpServers"] as Record<string, unknown>
    assert.ok(mcp["flintd"] !== undefined)
    await assert.rejects(readFile(join(home, ".claude.json"), "utf8"))
    assert.deepEqual((await json(join(home, ".flintd", "config.json")))["skillExports"], [
      join(project, ".claude", "skills"),
    ])
  })
})

test("init merges into a config that is already there and drops nothing", async () => {
  await withHome(async (home, _project, init) => {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ numStartups: 4, mcpServers: { other: { type: "http", url: "http://example.test/mcp" } } }),
    )
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }] } }),
    )
    await mkdir(join(home, ".codex"), { recursive: true })
    await writeFile(join(home, ".codex", "config.toml"), '# mine\nmodel = "gpt-5"\n\n[mcp_servers.other]\nurl = "http://example.test/mcp"\n')
    await mkdir(join(home, ".hermes"), { recursive: true })
    await writeFile(join(home, ".hermes", "config.yaml"), "# mine\nmodel: hermes-4\nmcp_servers:\n  other:\n    url: http://example.test/mcp\n")

    assert.equal((await init("--harness", "claude-code")).code, 0)
    assert.equal((await init("--harness", "codex")).code, 0)
    assert.equal((await init("--harness", "hermes")).code, 0)

    const claude = await json(join(home, ".claude.json"))
    assert.equal(claude["numStartups"], 4)
    assert.deepEqual(Object.keys(claude["mcpServers"] as object).sort(), ["flintd", "other"])
    const settings = await json(join(home, ".claude", "settings.json"))
    assert.equal(settings["model"], "opus")
    assert.equal((settings["hooks"] as Record<string, unknown[]>)["PostToolUse"]?.length, 2)

    const toml = await readFile(join(home, ".codex", "config.toml"), "utf8")
    assert.match(toml, /# mine\nmodel = "gpt-5"/)
    assert.match(toml, /\[mcp_servers\.other]/)
    assert.match(toml, /\[mcp_servers\.flintd]/)

    const yaml = await readFile(join(home, ".hermes", "config.yaml"), "utf8")
    assert.match(yaml, /# mine/)
    const parsed = parseYaml(yaml) as Record<string, Record<string, unknown>>
    assert.equal(parsed["model"], "hermes-4")
    assert.deepEqual(Object.keys(parsed["mcp_servers"] as object).sort(), ["flintd", "other"])

    // The file somebody else wrote is kept once, so the first init is never the run that lost it.
    assert.match(await readFile(join(home, ".claude.json.bak"), "utf8"), /example\.test/)
  })
})

test("a second init changes nothing and --check says so", async () => {
  await withHome(async (home, _project, init) => {
    for (const harness of ["claude-code", "codex", "opencode", "hermes", "openclaw", "pi"]) {
      assert.equal((await init("--harness", harness)).code, 0)
      const again = await init("--harness", harness)
      assert.equal(again.code, 0)
      assert.equal(again.out.match(/^(create|change)\t/gm), null, `${harness} wrote again`)
      const checked = await init("--harness", harness, "--check")
      assert.match(checked.out, /^configured\t/m)
      // pi cannot load an extension whose own dependencies are missing, so its check says so until they are there.
      assert.equal(checked.code, harness === "pi" ? 1 : 0, `${harness} is not configured`)
    }
    const waiting = await init("--harness", "pi", "--check")
    assert.match(waiting.out, /^installed, dependencies missing\textension dependencies\t.*npm install/m)
    await mkdir(join(home, ".pi", "agent", "extensions", "flintd", "node_modules", "@modelcontextprotocol", "client"), {
      recursive: true,
    })
    assert.equal((await init("--harness", "pi", "--check")).code, 0)
  })
})

test("a TOML table flintd does not own survives, keys and sub-tables and all", async () => {
  await withHome(async (home, _project, init) => {
    await mkdir(join(home, ".codex"), { recursive: true })
    await writeFile(
      join(home, ".codex", "config.toml"),
      '# mine\nmodel = "gpt-5"\n\n[mcp_servers.flintd]\n# a note\nurl = "http://old"\nstartup_timeout_sec = 20\n\n[mcp_servers.flintd.env]\nKEEP = "me"\n\n[profiles.work]\nx = 1\n',
    )
    assert.equal((await init("--harness", "codex")).code, 0)
    const toml = await readFile(join(home, ".codex", "config.toml"), "utf8")
    assert.match(toml, /\[mcp_servers\.flintd\.env]\nKEEP = "me"/)
    assert.match(toml, /# a note/)
    assert.match(toml, /startup_timeout_sec = 20/)
    assert.match(toml, /url = "http:\/\/127\.0\.0\.1:3546\/mcp"/)
    assert.match(toml, /bearer_token_env_var = "FLINTD_TOKEN"/)
    assert.match(toml, /\[profiles\.work]\nx = 1/)
    assert.ok(!toml.includes("http://old"))

    assert.equal((await init("--harness", "codex")).code, 0)
    assert.equal(await readFile(join(home, ".codex", "config.toml"), "utf8"), toml)
  })
})

test("a hook group flintd wrote before is replaced, not left beside the new one", async () => {
  await withHome(async (home, _project, init) => {
    assert.equal((await init("--harness", "claude-code")).code, 0)
    const settings = join(home, ".claude", "settings.json")
    const held = await json(settings)
    const hooks = held["hooks"] as Record<string, { hooks: { command: string }[] }[]>
    // A node that moved, or a checkout that moved, is what makes the recorded command go stale.
    const group = hooks["PostToolUse"]?.[0] as { hooks: { command: string }[] }
    group.hooks[0] = { ...(group.hooks[0] as { command: string }), command: "'/old/node' '/old/flintd-hook' 'claude-code'" }
    await writeFile(settings, JSON.stringify(held))

    assert.equal((await init("--harness", "claude-code")).code, 0)
    const after = (await json(settings))["hooks"] as Record<string, { hooks: { command: string }[] }[]>
    assert.equal(after["PostToolUse"]?.length, 1)
    assert.ok(!JSON.stringify(after).includes("/old/node"))
  })
})

test("the project scope keeps a machine's own hook path out of the settings a team shares", async () => {
  await withHome(async (_home, project, init) => {
    assert.equal((await init("--harness", "claude-code", "--scope", "project")).code, 0)
    const local = (await json(join(project, ".claude", "settings.local.json")))["hooks"] as Record<string, unknown[]>
    assert.equal(local["PostToolUse"]?.length, 1)
    await assert.rejects(readFile(join(project, ".claude", "settings.json"), "utf8"))
  })
})

test("a run that has to refuse one file writes none of them", async () => {
  await withHome(async (home, _project, init) => {
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(join(home, ".claude", "settings.json"), "{ this is not JSON")
    const refused = await init("--harness", "claude-code")
    assert.equal(refused.code, 1)
    assert.match(refused.err, /invalid_arguments: flintd will not write over/)
    // The MCP file would have been written first, and a half-connected harness is worse than none.
    await assert.rejects(readFile(join(home, ".claude.json"), "utf8"))
    await assert.rejects(readFile(join(home, ".flintd", "config.json"), "utf8"))
    assert.equal(await readFile(join(home, ".claude", "settings.json"), "utf8"), "{ this is not JSON")
    await assert.rejects(readFile(join(home, ".claude", "settings.json.bak"), "utf8"))
  })
})

test("a key that holds something other than an object is refused, never replaced", async () => {
  await withHome(async (home, _project, init) => {
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: [{ legacy: true }] }))
    const refused = await init("--harness", "claude-code")
    assert.equal(refused.code, 1)
    assert.match(refused.err, /mcpServers/)
    assert.deepEqual((await json(join(home, ".claude.json")))["mcpServers"], [{ legacy: true }])
  })
})

test("the one backup is the original, and a later run never writes over it", async () => {
  await withHome(async (home, _project, init) => {
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: { url: "http://first" } } }))
    assert.equal((await init("--harness", "claude-code")).code, 0)
    const backup = join(home, ".claude.json.bak")
    assert.match(await readFile(backup, "utf8"), /http:\/\/first/)

    const held = await json(join(home, ".claude.json"))
    ;(held["mcpServers"] as Record<string, unknown>)["other"] = { url: "http://second" }
    delete (held["mcpServers"] as Record<string, unknown>)["flintd"]
    await writeFile(join(home, ".claude.json"), JSON.stringify(held))
    assert.equal((await init("--harness", "claude-code")).code, 0)
    assert.match(await readFile(backup, "utf8"), /http:\/\/first/)
    assert.ok(!(await readFile(backup, "utf8")).includes("http://second"))
  })
})

test("--check exits 1 and names what is missing when a harness was never connected", async () => {
  await withHome(async (home, _project, init) => {
    const checked = await init("--harness", "openclaw", "--check")
    assert.equal(checked.code, 1)
    assert.match(checked.out, new RegExp(`^missing\tMCP server flintd\t${join(home, ".openclaw", "openclaw.json")}$`, "m"))
    await assert.rejects(readFile(join(home, ".openclaw", "openclaw.json"), "utf8"))
  })
})

test("--dry-run says what it would write and writes nothing", async () => {
  await withHome(async (home, _project, init) => {
    const planned = await init("--harness", "hermes", "--dry-run")
    assert.equal(planned.code, 0)
    assert.match(planned.out, /^create\tMCP server flintd\t/m)
    assert.match(planned.out, /^nothing written$/m)
    await assert.rejects(readFile(join(home, ".hermes", "config.yaml"), "utf8"))
    await assert.rejects(readFile(join(home, ".flintd", "config.json"), "utf8"))
  })
})

test("transcripts are off unless the operator says yes, and the answer is kept per harness", async () => {
  await withHome(async (home, _project, init) => {
    assert.match((await init("--harness", "codex")).out, /^transcripts off$/m)
    assert.match((await init("--harness", "hermes", "--transcripts", "yes")).out, /^transcripts on$/m)
    const harnesses = (await json(join(home, ".flintd", "config.json")))["harnesses"] as Record<string, Record<string, unknown>>
    assert.equal(harnesses["codex"]?.["transcripts"], false)
    assert.equal(harnesses["hermes"]?.["transcripts"], true)
    // The answer is remembered, so a later init with no flag does not turn it off again.
    assert.match((await init("--harness", "hermes")).out, /^transcripts on$/m)
    assert.match((await init("--harness", "hermes", "--transcripts", "no")).out, /^transcripts off$/m)
  })
})

test("init never writes the bearer token to stdout or into a harness config", async () => {
  await withHome(async (home, _project, init) => {
    const token = "a-token-nobody-may-see"
    await mkdir(join(home, ".flintd"), { recursive: true })
    await writeFile(join(home, ".flintd", "token"), `${token}\n`, { mode: 0o600 })
    for (const harness of ["claude-code", "codex", "opencode", "hermes", "openclaw", "pi"]) {
      const ran = await init("--harness", harness)
      assert.equal(ran.code, 0)
      assert.ok(!ran.out.includes(token), `${harness} printed the token`)
    }
    for (const path of [
      join(home, ".claude.json"),
      join(home, ".codex", "config.toml"),
      join(home, ".config", "opencode", "opencode.json"),
      join(home, ".hermes", "config.yaml"),
      join(home, ".openclaw", "openclaw.json"),
      join(home, ".flintd", "config.json"),
    ]) {
      assert.ok(!(await readFile(path, "utf8")).includes(token), `${path} holds the token`)
    }
  })
})

test("a private file stays private: init keeps the mode of the file and of the backup it makes", async () => {
  await withHome(async (home, _project, init) => {
    await mkdir(join(home, ".flintd"), { recursive: true })
    await writeFile(join(home, ".flintd", "config.json"), JSON.stringify({ model: { provider: "anthropic", apiKey: "sk-x" } }), {
      mode: 0o600,
    })
    assert.equal((await init("--harness", "codex")).code, 0)
    assert.equal((await stat(join(home, ".flintd", "config.json"))).mode & 0o777, 0o600)
    assert.equal((await stat(join(home, ".flintd", "config.json.bak"))).mode & 0o777, 0o600)
    // A config file the daemon would refuse to read is a config file init broke.
    assert.equal((await readConfig(join(home, ".flintd"))).harnesses["codex"]?.transcripts, false)
  })
})

test("init refuses a harness name and a scope it does not know", async () => {
  await withHome(async (_home, _project, init) => {
    assert.equal((await init("--harness", "emacs")).code, 2)
    assert.equal((await init("--harness", "codex", "--scope", "global")).code, 2)
    assert.equal((await init("--harness", "codex", "--transcripts", "maybe")).code, 2)
  })
})
