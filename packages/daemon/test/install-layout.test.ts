import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HARNESSES } from "../src/harness.ts"

const DAEMON = fileURLToPath(new URL("..", import.meta.url))
const PACKAGES = fileURLToPath(new URL("../..", import.meta.url))

interface Run {
  code: number
  out: string
  err: string
}

interface Installed {
  home: string
  hooks: string
  shim: string
  init(...args: string[]): Promise<Run>
}

const started = process.cwd()

// The published daemon is `<package>/dist/src`, and the published hook binary is the `.js` its own manifest names.
// Neither shape exists in this workspace, so an install that never runs `flintd init` is where init used to break.
async function withInstall(run: (installed: Installed) => Promise<void>): Promise<void> {
  // macOS reaches its temporary directory through a symlink, and a resolved package is always a real path.
  const root = await realpath(await mkdtemp(join(tmpdir(), "flintd-install-")))
  const home = join(root, "home")
  const pkg = join(root, "pkgs", "flintd")
  const modules = join(pkg, "node_modules")
  const hooks = join(modules, "@flintd", "hooks")
  await mkdir(home, { recursive: true })
  await cp(join(DAEMON, "src"), join(pkg, "dist", "src"), { recursive: true })
  await cp(join(DAEMON, "bin"), join(pkg, "dist", "bin"), { recursive: true })
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "flintd",
      version: "0.1.0",
      type: "module",
      exports: { ".": "./dist/src/index.ts" },
      bin: { flintd: "./dist/bin/flintd.ts" },
    }),
  )
  // A published package may carry a manifest of its own under dist/, and the walk to a package root must pass it.
  await writeFile(join(pkg, "dist", "package.json"), JSON.stringify({ type: "module" }))
  for (const entry of await readdir(join(DAEMON, "node_modules"))) {
    if (entry.startsWith(".")) continue
    const from = join(DAEMON, "node_modules", entry)
    if (entry.startsWith("@")) {
      await mkdir(join(modules, entry), { recursive: true })
      for (const held of await readdir(from)) await symlink(join(from, held), join(modules, entry, held))
      continue
    }
    await mkdir(modules, { recursive: true })
    await symlink(from, join(modules, entry))
  }
  await rm(hooks, { recursive: true, force: true })
  await mkdir(join(hooks, "dist", "bin"), { recursive: true })
  await mkdir(join(hooks, "dist", "src"), { recursive: true })
  await writeFile(
    join(hooks, "package.json"),
    JSON.stringify({
      name: "@flintd/hooks",
      version: "0.1.0",
      type: "module",
      exports: { ".": "./dist/src/index.js" },
      bin: { "flintd-hook": "./dist/bin/flintd-hook.js" },
    }),
  )
  await writeFile(
    join(hooks, "dist", "src", "index.js"),
    `export * from ${JSON.stringify(pathToFileURL(join(PACKAGES, "hooks", "src", "index.ts")).href)}\n`,
  )
  await writeFile(join(hooks, "dist", "bin", "flintd-hook.js"), "#!/usr/bin/env node\n")
  // An install puts @flintd/pi beside the daemon and never under it, which is where the extension has to be found.
  await symlink(join(PACKAGES, "pi"), join(modules, "@flintd", "pi"))
  const shim = join(modules, ".bin", "flintd-hook")
  await mkdir(join(modules, ".bin"), { recursive: true })
  await writeFile(shim, "#!/bin/sh\n")

  const { main } = (await import(pathToFileURL(join(pkg, "dist", "src", "cli.ts")).href)) as {
    main(argv: string[]): Promise<number>
  }
  const heldHome = process.env["HOME"]
  const heldFlintd = process.env["FLINTD_HOME"]
  process.env["HOME"] = home
  process.env["FLINTD_HOME"] = join(home, ".flintd")
  process.chdir(home)
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
    await run({ home, hooks, shim, init })
  } finally {
    process.chdir(started)
    if (heldHome === undefined) delete process.env["HOME"]
    else process.env["HOME"] = heldHome
    if (heldFlintd === undefined) delete process.env["FLINTD_HOME"]
    else process.env["FLINTD_HOME"] = heldFlintd
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

test("every harness connects from an installed layout, where the daemon runs out of dist", async () => {
  await withInstall(async ({ home, shim, init }) => {
    for (const harness of HARNESSES) {
      const planned = await init("--harness", harness, "--dry-run")
      assert.equal(planned.code, 0, `${harness}: ${planned.err}`)
      assert.equal(planned.err, "", `${harness} refused a dry run`)
      assert.match(planned.out, /^nothing written$/m)

      const written = await init("--harness", harness)
      assert.equal(written.code, 0, `${harness}: ${written.err}`)
      const checked = await init("--harness", harness, "--check")
      // pi cannot load an extension whose own dependencies are missing, so its check says so until they are there.
      assert.equal(checked.code, harness === "pi" ? 1 : 0, `${harness} is not configured: ${checked.out}`)
    }
    const hooks = (JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }).hooks
    assert.equal((hooks["PostToolUse"]?.[0] as { hooks: { command: string }[] }).hooks[0]?.command, `'${shim}' 'claude-code'`)
    // The extension is the one @flintd/pi resolves to, which no path relative to the daemon reaches once installed.
    const extension = JSON.parse(
      await readFile(join(home, ".pi", "agent", "extensions", "flintd", "package.json"), "utf8"),
    ) as { name: string }
    assert.equal(extension.name, "@flintd/pi")
  })
})

test("with no package manager shim, the recorded command is the binary the hooks manifest names", async () => {
  await withInstall(async ({ home, hooks, shim, init }) => {
    await rm(shim)
    assert.equal((await init("--harness", "claude-code")).code, 0)
    const settings = (JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }).hooks
    assert.equal(
      (settings["PostToolUse"]?.[0] as { hooks: { command: string }[] }).hooks[0]?.command,
      `'${process.execPath}' '${join(hooks, "dist", "bin", "flintd-hook.js")}' 'claude-code'`,
    )
  })
})
