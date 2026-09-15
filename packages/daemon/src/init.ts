import { ToolError } from "@flintd/core"
import { harnessPlan } from "./harness.ts"
import type { HarnessName, Scope } from "./harness.ts"
import { jsonFile, preparePlan } from "./merge.ts"
import type { Edit } from "./merge.ts"

export interface InitOptions {
  harness: HarnessName
  scope: Scope
  // The answer to the transcript question, which is off unless the operator says otherwise.
  transcripts: boolean
  home: string
  cwd: string
  port: number
  mode: "write" | "check" | "dry-run"
}

export interface InitReport {
  harness: HarnessName
  scope: Scope
  transcripts: boolean
  skillsDir: string
  mcpUrl: string
  edits: Edit[]
  notes: string[]
}

const CONFIG_FILE = "config.json"

export async function runInit(options: InitOptions): Promise<InitReport> {
  if (options.port === 0) {
    throw new ToolError(
      "invalid_arguments",
      "The config names port 0, so the daemon picks a free port at each start and no harness config can name it. Start `flintd serve` and run this again, or set a port in the config file.",
      { port: 0 },
    )
  }
  const mcpUrl = `http://127.0.0.1:${options.port}/mcp`
  const harness = await harnessPlan(options.harness, { scope: options.scope, cwd: options.cwd, mcpUrl })
  // Every one of the six reads a SKILL.md, so the skills directory is exported whether or not the harness speaks MCP.
  const config = jsonFile(
    "skills directory and transcripts",
    `${options.home}/${CONFIG_FILE}`,
    (root) => {
      const exports = Array.isArray(root["skillExports"]) ? (root["skillExports"] as unknown[]) : []
      root["skillExports"] = exports.includes(harness.skillsDir) ? exports : [...exports, harness.skillsDir]
      const harnesses = named(root, "harnesses")
      named(harnesses, options.harness)["transcripts"] = options.transcripts
    },
    0o600,
  )
  // Read and merge every file before writing any of them, so a file that has to be refused leaves the rest alone.
  const prepared = []
  for (const plan of [...harness.plans, config]) prepared.push(await preparePlan(plan))
  if (options.mode === "write") {
    for (const one of prepared) await one.write()
  }
  const edits: Edit[] = prepared.map((one) => one.edit)
  const ready = harness.ready
  if (ready !== undefined && !(await ready.ok())) {
    edits.push({ what: ready.what, path: `${ready.path} — ${ready.reason}`, action: "incomplete" })
  }
  return {
    harness: options.harness,
    scope: options.scope,
    transcripts: options.transcripts,
    skillsDir: harness.skillsDir,
    mcpUrl,
    edits,
    notes: harness.notes,
  }
}

function named(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const held = root[key]
  if (typeof held !== "object" || held === null || Array.isArray(held)) root[key] = {}
  return root[key] as Record<string, unknown>
}
