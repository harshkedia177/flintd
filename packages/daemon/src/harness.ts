import { access, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { ToolError } from "@flintd/core"
import { hermesManifest, hermesPlugin, openClawHook, openClawHookDoc, openCodePlugin } from "@flintd/hooks"
import type { HookCommand } from "@flintd/hooks"
import { jsonFile, sourceFile, tomlTable, yamlFile } from "./merge.ts"
import type { Plan } from "./merge.ts"

export const HARNESSES = ["claude-code", "codex", "opencode", "hermes", "openclaw", "pi"] as const

export type HarnessName = (typeof HARNESSES)[number]

export const SCOPES = ["user", "project"] as const

export type Scope = (typeof SCOPES)[number]

export interface HarnessPlan {
  // The directory this harness reads a SKILL.md from, which becomes an entry in `skillExports`.
  skillsDir: string
  plans: Plan[]
  notes: string[]
  // What a written harness still needs before it can load what init wrote, for a harness that has such a step.
  ready?: Ready
}

export interface Ready {
  what: string
  path: string
  reason: string
  ok(): Promise<boolean>
}

export interface HarnessSetup {
  scope: Scope
  cwd: string
  mcpUrl: string
}

const SERVER = "flintd"
const HOOK_BINARY = "flintd-hook"
const TOKEN_VARIABLE = "FLINTD_TOKEN"
// No harness config ever carries the token itself: every one of the five reads an environment variable for it.
const BEARER = `Bearer \${${TOKEN_VARIABLE}}`
const OPENCODE_BEARER = `Bearer {env:${TOKEN_VARIABLE}}`
const TOOL_RUN_NOTE = `This harness reads the MCP tool list once, so a Tool promoted while you work is reached with tool_find and then tool_run, not as fl_<name>.`

export function isHarness(value: unknown): value is HarnessName {
  return (HARNESSES as readonly unknown[]).includes(value)
}

export function isScope(value: unknown): value is Scope {
  return (SCOPES as readonly unknown[]).includes(value)
}

export async function harnessPlan(harness: HarnessName, setup: HarnessSetup): Promise<HarnessPlan> {
  const project = setup.scope === "project"
  const hook = await hookCommand()
  switch (harness) {
    case "claude-code":
      return {
        skillsDir: project ? join(setup.cwd, ".claude", "skills") : join(homedir(), ".claude", "skills"),
        plans: [
          jsonFile("MCP server flintd", project ? join(setup.cwd, ".mcp.json") : join(homedir(), ".claude.json"), (root, file) => {
            at(root, ["mcpServers"], file)[SERVER] = { type: "http", url: setup.mcpUrl, headers: { Authorization: BEARER } }
          }),
          jsonFile(
            "hooks",
            project
              ? join(setup.cwd, ".claude", "settings.local.json")
              : join(homedir(), ".claude", "settings.json"),
            (root, file) => claudeHooks(at(root, ["hooks"], file), shell(hook, harness)),
          ),
        ],
        notes: [
          `Claude Code expands \${${TOKEN_VARIABLE}} in this file, so the token stays in ${TOKEN_VARIABLE}.`,
          ...(project
            ? ["The hook command names this machine's own paths, so the project scope writes .claude/settings.local.json and never the settings.json a team shares."]
            : []),
        ],
      }
    case "codex":
      return {
        skillsDir: project ? join(setup.cwd, ".agents", "skills") : join(homedir(), ".agents", "skills"),
        plans: [
          tomlTable(
            "MCP server flintd",
            project ? join(setup.cwd, ".codex", "config.toml") : join(homedir(), ".codex", "config.toml"),
            `mcp_servers.${SERVER}`,
            { url: JSON.stringify(setup.mcpUrl), bearer_token_env_var: JSON.stringify(TOKEN_VARIABLE) },
          ),
          jsonFile(
            "hooks",
            project ? join(setup.cwd, ".codex", "hooks.json") : join(homedir(), ".codex", "hooks.json"),
            (root, file) => claudeHooks(at(root, ["hooks"], file), shell(hook, harness)),
          ),
        ],
        notes: [
          `Codex reads the token from ${TOKEN_VARIABLE} at connect time through bearer_token_env_var, so no token is written here.`,
          TOOL_RUN_NOTE,
        ],
      }
    case "opencode":
      return {
        skillsDir: project ? join(setup.cwd, ".opencode", "skills") : join(homedir(), ".config", "opencode", "skills"),
        plans: [
          jsonFile(
            "MCP server flintd",
            project ? join(setup.cwd, "opencode.json") : join(homedir(), ".config", "opencode", "opencode.json"),
            (root, file) => {
              root["$schema"] ??= "https://opencode.ai/config.json"
              at(root, ["mcp"], file)[SERVER] = {
                type: "remote",
                url: setup.mcpUrl,
                enabled: true,
                headers: { Authorization: OPENCODE_BEARER },
              }
            },
          ),
          sourceFile(
            "plugin",
            project
              ? join(setup.cwd, ".opencode", "plugins", "flintd.js")
              : join(homedir(), ".config", "opencode", "plugins", "flintd.js"),
            openCodePlugin(hook),
          ),
        ],
        notes: [
          "OpenCode refuses a tool that carries an outputSchema, and the daemon already takes it off for this client.",
          "OpenCode's plugin hooks carry no failure of their own, so a tool call it forwards is recorded as ok.",
        ],
      }
    case "hermes":
      return {
        skillsDir: project ? join(setup.cwd, ".hermes", "skills") : join(homedir(), ".hermes", "skills"),
        plans: [
          yamlFile("MCP server flintd", join(homedir(), ".hermes", "config.yaml"), (set) => {
            set(["mcp_servers", SERVER, "url"], setup.mcpUrl)
            set(["mcp_servers", SERVER, "headers", "Authorization"], BEARER)
          }),
          sourceFile("hook plugin", join(homedir(), ".hermes", "plugins", "flintd", "plugin.yaml"), hermesManifest()),
          sourceFile("hook plugin", join(homedir(), ".hermes", "plugins", "flintd", "__init__.py"), hermesPlugin(hook)),
        ],
        notes: [
          `Hermes resolves \${${TOKEN_VARIABLE}} in a header at connect time, and reads ~/.hermes/.env as well as the environment.`,
          ...(project ? ["Hermes keeps one MCP config, so the project scope writes the same ~/.hermes/config.yaml."] : []),
        ],
      }
    case "openclaw":
      return {
        skillsDir: project ? join(setup.cwd, ".agents", "skills") : join(homedir(), ".agents", "skills"),
        plans: [
          jsonFile("MCP server flintd", join(homedir(), ".openclaw", "openclaw.json"), (root, file) => {
            at(root, ["mcp", "servers"], file)[SERVER] = {
              url: setup.mcpUrl,
              transport: "streamable-http",
              enabled: true,
              headers: { Authorization: BEARER },
            }
            at(root, ["hooks", "internal"], file)["enabled"] = true
            at(root, ["hooks", "internal", "entries"], file)[SERVER] = { enabled: true }
          }),
          sourceFile("hook", join(homedir(), ".openclaw", "hooks", "flintd", "HOOK.md"), openClawHookDoc()),
          sourceFile("hook", join(homedir(), ".openclaw", "hooks", "flintd", "handler.ts"), openClawHook(hook)),
        ],
        notes: [
          "OpenClaw documents no tool-call hook event, so this hook records the start and the reset of a conversation and no tool call.",
          TOOL_RUN_NOTE,
        ],
      }
    case "pi":
      return piPlan(setup)
  }
}

async function piPlan(setup: HarnessSetup): Promise<HarnessPlan> {
  const skillsDir =
    setup.scope === "project" ? join(setup.cwd, ".pi", "skills") : join(homedir(), ".pi", "agent", "skills")
  const into =
    setup.scope === "project"
      ? join(setup.cwd, ".pi", "extensions", "flintd")
      : join(homedir(), ".pi", "agent", "extensions", "flintd")
  const source = await piSource()
  if (source === undefined) {
    return {
      skillsDir,
      plans: [],
      // Nothing was written, so `--check` has to fail: a note a person reads is no answer to an exit code a script reads.
      ready: {
        what: "the flintd extension for pi",
        path: into,
        reason: "install it with `pi install npm:@flintd/pi`, then run this again",
        ok: async () => false,
      },
      notes: [
        `The flintd extension for pi is not beside this daemon. Install it with \`pi install npm:@flintd/pi\`, then run this again.`,
      ],
    }
  }
  return {
    skillsDir,
    plans: source.files.map((relative) =>
      sourceFile("extension", join(into, relative), { copy: join(source.dir, relative) }),
    ),
    // pi loads the extension as a directory with its own node_modules, so copied files alone are not a connected pi.
    ready: {
      what: "extension dependencies",
      path: into,
      reason: "run `npm install` there",
      ok: () => exists(join(into, "node_modules", "@modelcontextprotocol", "client")),
    },
    notes: [
      `pi speaks no MCP: the extension holds an MCP client of its own, and it reads the port and the token from the flintd home.`,
      `The extension needs its own dependencies: run \`npm install\` in ${into}.`,
    ],
  }
}

// The extension is another package's to build, so init copies what is on disk beside this daemon and nothing else.
// @flintd/pi is no dependency of the daemon, so an install is resolved and a workspace checkout is found beside it.
async function piSource(): Promise<{ dir: string; files: string[] } | undefined> {
  const pi =
    (await resolvePackage("@flintd/pi")) ??
    (await packageRoot(fileURLToPath(new URL("../../pi", import.meta.url)), "@flintd/pi"))
  if (pi === undefined) return undefined
  const files = ["package.json", join("src", "index.ts"), join("src", "settings.ts")]
  for (const file of files) {
    if (!(await exists(join(pi.dir, file)))) return undefined
  }
  return { dir: pi.dir, files }
}

function claudeHooks(hooks: Record<string, unknown>, command: string): void {
  // PreToolUse is left alone on purpose: an Observation carries the result status, and a call recorded twice would count twice.
  for (const event of ["PostToolUse", "SessionStart", "Stop"]) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const others = groups.filter((group) => !ours(group))
    hooks[event] = [...others, { hooks: [{ type: "command", command }] }]
  }
}

// The recorded command names this machine's Node and this checkout, and both move. Every group that runs the hook
// binary at all is flintd's own, so a stale one is replaced rather than left to spawn a path that is gone.
function ours(group: unknown): boolean {
  if (typeof group !== "object" || group === null) return false
  const held = (group as { hooks?: unknown }).hooks
  return (
    Array.isArray(held) &&
    held.some((one) => {
      const command = (one as { command?: unknown })?.command
      return typeof command === "string" && command.includes(HOOK_BINARY)
    })
  )
}

// A key that holds something other than an object is the operator's, and replacing it would be silent loss.
function at(root: Record<string, unknown>, path: string[], file: string): Record<string, unknown> {
  let held = root
  const walked: string[] = []
  for (const key of path) {
    walked.push(key)
    const found = held[key]
    if (found === undefined) held[key] = {}
    else if (typeof found !== "object" || found === null || Array.isArray(found)) {
      throw new ToolError(
        "invalid_arguments",
        `flintd will not write over ${walked.join(".")} in ${file}, because it does not hold an object. Fix the file first.`,
        { path: file, key: walked.join(".") },
      )
    }
    held = held[key] as Record<string, unknown>
  }
  return held
}

// Single quotes, because a shell expands $ and a backtick inside double quotes and a home directory may hold either.
function shell(hook: HookCommand, harness: HarnessName): string {
  return [hook.command, ...hook.args, harness].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ")
}

// The package manager's own shim is preferred: it survives a Node that moved, which the recorded execPath does not.
// npm keeps it beside @flintd/hooks and pnpm beside the daemon; with neither, the binary is the one the manifest names.
async function hookCommand(): Promise<HookCommand> {
  const hooks = await resolvePackage("@flintd/hooks")
  const declared = (hooks?.manifest["bin"] as Record<string, string> | undefined)?.[HOOK_BINARY]
  if (hooks === undefined || declared === undefined) {
    throw new ToolError(
      "not_found",
      `flintd cannot find ${HOOK_BINARY} in the package @flintd/hooks. Install @flintd/hooks beside the daemon, then run this again.`,
      { binary: HOOK_BINARY },
    )
  }
  const beside = fileURLToPath(new URL("..", import.meta.url))
  for (const dir of [...binDirs(hooks.dir), join(beside, "node_modules", ".bin")]) {
    const shim = join(dir, HOOK_BINARY)
    if (await exists(shim)) return { command: shim, args: [] }
  }
  const script = join(hooks.dir, declared)
  if (!(await exists(script))) {
    throw new ToolError("not_found", `The flintd hook binary is not at ${script}. Reinstall @flintd/hooks, then run this again.`, {
      path: script,
    })
  }
  return { command: process.execPath, args: [script] }
}

function binDirs(dir: string): string[] {
  const found: string[] = []
  for (let at = dir; dirname(at) !== at; at = dirname(at)) {
    if (basename(at) === "node_modules") found.push(join(at, ".bin"))
  }
  return found
}

interface ResolvedPackage {
  dir: string
  manifest: Record<string, unknown>
}

async function resolvePackage(name: string): Promise<ResolvedPackage | undefined> {
  let entry: string
  try {
    entry = fileURLToPath(import.meta.resolve(name))
  } catch {
    return undefined
  }
  return packageRoot(dirname(entry), name)
}

// A published package resolves to a file under dist/, and dist/ may carry a manifest of its own, so the walk up
// stops at the one that carries the name and not at the first package.json it meets.
async function packageRoot(from: string, name: string): Promise<ResolvedPackage | undefined> {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = await readManifest(join(dir, "package.json"))
    if (manifest?.["name"] === name) return { dir, manifest }
    if (dirname(dir) === dir) return undefined
  }
}

async function readManifest(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

