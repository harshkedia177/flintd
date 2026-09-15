import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { META_TOOL_NAMES, TEACHING_SKILL, ToolError, isToolName, renderSkill, renderTeachingSkill, skillName } from "@flintd/core"
import type { Example, Flint } from "@flintd/core"

const SKILL_FILE = "SKILL.md"
const SENTINEL = ".flintd"
const SENTINEL_TEXT = "flintd wrote this skill directory from its Library and rewrites it. Do not edit it by hand.\n"
const SKILL_PREFIX = "fl-"
const DEBOUNCE_MS = 500

export interface ExportChange {
  skill: string
  action: "written" | "removed" | "refused"
}

export interface ExportReport {
  dir: string
  skills: number
  changes: ExportChange[]
  // One line for each Tool this pass could not render. Its file, if it has one, is left as it was.
  problems: string[]
}

export interface ExportStatus {
  dir: string
  skills: number
  at: string | null
  error: string | null
}

export interface ExportWatch {
  status(): ExportStatus[]
  stop(): Promise<void>
}

type Reader = Pick<Flint, "tools" | "call">

export async function exportSkills(flint: Reader, dir: string, dryRun = false): Promise<ExportReport> {
  const listed = await flint.tools()
  const wanted = new Map<string, string>([[TEACHING_SKILL, renderTeachingSkill()]])
  const keep = new Set<string>()
  const problems: string[] = []
  for (const tool of listed) {
    if (META_TOOL_NAMES.has(tool.name)) continue
    // A remote client reads this list off the wire, so a name that is not a Tool name never reaches a path.
    if (!isToolName(tool.name)) {
      problems.push(`${JSON.stringify(tool.name)} is not the name of a Tool`)
      continue
    }
    const held = await examples(flint, tool.name)
    if (held.problem !== undefined) {
      problems.push(`${tool.name}: ${held.problem}`)
      keep.add(skillName(tool.name))
      continue
    }
    if (held.examples === undefined) continue
    wanted.set(skillName(tool.name), renderSkill(tool, held.examples))
  }
  const changes: ExportChange[] = []
  for (const [skill, text] of wanted) {
    const path = join(dir, skill)
    const current = await readFile(join(path, SKILL_FILE), "utf8").catch(() => null)
    const mine = (await readFile(join(path, SENTINEL), "utf8").catch(() => null)) !== null
    // A skill flintd did not write is never written over, for the same reason it is never removed.
    if (current !== null && !mine) {
      changes.push({ skill, action: "refused" })
      continue
    }
    if (current === text && mine) continue
    changes.push({ skill, action: "written" })
    if (dryRun) continue
    await mkdir(path, { recursive: true })
    await writeFile(join(path, SKILL_FILE), text)
    await writeFile(join(path, SENTINEL), SENTINEL_TEXT)
  }
  for (const skill of await stale(dir, wanted, keep)) {
    changes.push({ skill, action: "removed" })
    if (!dryRun) await rm(join(dir, skill), { recursive: true, force: true })
  }
  return { dir, skills: wanted.size, changes: changes.sort(order), problems }
}

export async function startExports(
  flint: Flint,
  dirs: readonly string[],
  say: (message: string) => void,
  debounceMs = DEBOUNCE_MS,
): Promise<ExportWatch> {
  const state = new Map<string, ExportStatus>(dirs.map((dir) => [dir, { dir, skills: 0, at: null, error: null }]))
  let pending = Promise.resolve()
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const run = async (): Promise<void> => {
    for (const dir of dirs) {
      const held = state.get(dir) as ExportStatus
      let next: ExportStatus
      try {
        const report = await exportSkills(flint, dir)
        const problem = report.problems.length === 0 ? null : report.problems.join("; ")
        next = { dir, skills: report.skills, at: new Date().toISOString(), error: problem }
      } catch (cause) {
        next = { ...held, error: cause instanceof Error ? cause.message : String(cause) }
      }
      // An export nobody can finish is the operator's to fix, and never a reason to stop serving Tools.
      if (next.error !== null && next.error !== held.error) say(`skill export ${dir}: ${next.error}`)
      state.set(dir, next)
    }
  }

  await run()
  const off = flint.onChange(() => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      pending = pending.then(run).catch(() => undefined)
    }, debounceMs)
    timer.unref()
  })

  return {
    status: () => dirs.map((dir) => ({ ...(state.get(dir) as ExportStatus) })),
    async stop(): Promise<void> {
      stopped = true
      off()
      if (timer !== undefined) clearTimeout(timer)
      await pending
    },
  }
}

// A Tool retired between the list and this read is gone, and its skill goes with it. Any other failure leaves
// the file that is already there, because a skill file is an instruction and a wrong one is worse than none.
async function examples(flint: Reader, name: string): Promise<{ examples?: Example[]; problem?: string }> {
  try {
    const held = (await flint.call("tool_read", { name, include_examples: true })) as { examples?: Example[] }
    return { examples: Array.isArray(held.examples) ? held.examples : [] }
  } catch (cause) {
    if (cause instanceof ToolError && cause.code === "not_found") return {}
    return { problem: cause instanceof Error ? cause.message : String(cause) }
  }
}

// Only a directory flintd marked is ever removed, so a hand-written skill beside the export outlives every run.
async function stale(dir: string, wanted: ReadonlyMap<string, string>, keep: ReadonlySet<string>): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const gone: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SKILL_PREFIX)) continue
    if (wanted.has(entry.name) || keep.has(entry.name)) continue
    const marked = await readFile(join(dir, entry.name, SENTINEL), "utf8").catch(() => null)
    if (marked !== null) gone.push(entry.name)
  }
  return gone
}

function order(one: ExportChange, other: ExportChange): number {
  return one.action === other.action ? one.skill.localeCompare(other.skill) : one.action.localeCompare(other.action)
}
