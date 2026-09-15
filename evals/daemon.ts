import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import type { ModelProvider } from "@flintd/core"

const START_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 15_000
const LISTENING = /^flintd listening on (\S+)$/

export const WORKSPACE = "workspace"

export interface DaemonOptions {
  root: string
  home: string
  port: number
  provider: ModelProvider
  apiKey: string
  model: string
  baseUrl: string
  seeds: Record<string, string>
}

export interface EvalDaemon {
  url: string
  port: number
  token: string
  home: string
  libraryDir: string
  errors(): string
  config(): Promise<string>
  stop(): Promise<void>
}

// A fresh daemon in a throw-away home on a port the kernel picks, so an eval run never meets the operator's own Library.
export async function startDaemon(options: DaemonOptions): Promise<EvalDaemon> {
  const libraryDir = join(options.home, "library")
  await mkdir(join(libraryDir, WORKSPACE), { recursive: true, mode: 0o700 })
  // A seed may name a directory of its own, because the fs prompts quote a tree and not a flat list of files.
  for (const [name, text] of Object.entries(options.seeds)) {
    const file = join(libraryDir, WORKSPACE, name)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, text)
  }
  await writeFile(
    join(options.home, "config.json"),
    `${JSON.stringify(
      {
        // A concrete port, not 0: `flintd init` writes the configured port into every harness config it touches.
        port: options.port,
        // A reasoning model takes longer over one Held-out generation than the daemon's own default allows.
        modelTimeoutMs: 180_000,
        heldOutTimeoutMs: 600_000,
        // The Observer reads a harness's Observations only where the operator answered yes, and this run is the operator.
        harnesses: { "claude-code": { transcripts: true } },
        model: { provider: options.provider, apiKey: options.apiKey, model: options.model, baseUrl: options.baseUrl },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )

  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(options.root, "packages/daemon/bin/flintd.ts"), "serve"],
    { cwd: options.home, env: { ...process.env, FLINTD_HOME: options.home }, stdio: ["ignore", "pipe", "pipe"] },
  )
  const said: string[] = []
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    said.push(chunk)
    if (said.length > 200) said.shift()
  })

  let url: string
  let token: string
  try {
    url = await listening(child)
    token = (await readFile(join(options.home, "token"), "utf8")).trim()
  } catch (cause) {
    // The home holds the operator's key, and a start that never returns a daemon leaves nobody else to remove it.
    child.kill("SIGKILL")
    await rm(options.home, { recursive: true, force: true })
    throw new Error(`${causeText(cause)}\n${said.join("")}`)
  }

  return {
    url,
    port: options.port,
    token,
    home: options.home,
    libraryDir,
    errors: () => said.join(""),
    config: () => readFile(join(options.home, "config.json"), "utf8").catch(() => ""),
    async stop(): Promise<void> {
      await ended(child)
      await rm(options.home, { recursive: true, force: true })
    },
  }
}

// The kernel names a free port and then lets go of it. A port taken in that gap makes the daemon refuse to start, loudly.
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once("error", fail)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") return fail(new Error("the probe bound no port"))
      probe.close(() => done(address.port))
    })
  })
}

function listening(child: ChildProcess): Promise<string> {
  return new Promise((done, fail) => {
    const deadline = setTimeout(() => fail(new Error(`the daemon did not listen within ${START_TIMEOUT_MS} ms`)), START_TIMEOUT_MS)
    const settle = (run: () => void): void => {
      clearTimeout(deadline)
      run()
    }
    child.once("exit", (code) => settle(() => fail(new Error(`the daemon exited with ${code} before it listened`))))
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    lines.on("line", (line) => {
      const found = LISTENING.exec(line)
      if (found !== null) settle(() => done(found[1] as string))
    })
  })
}

function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const hard = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS)
    child.once("exit", () => {
      clearTimeout(hard)
      done()
    })
    child.kill("SIGTERM")
  })
}

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
