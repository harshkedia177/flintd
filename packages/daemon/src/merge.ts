import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { ToolError } from "@flintd/core"
import { Document, parseDocument } from "yaml"

export interface Plan {
  what: string
  path: string
  next(current: string | undefined): string | Promise<string>
  // The mode a file this plan creates is given. A file that is already there keeps the mode it has.
  mode?: number
}

export type EditAction = "create" | "change" | "unchanged" | "incomplete"

export interface Edit {
  what: string
  path: string
  action: EditAction
}

const TEMP_SUFFIX = ".flintd-tmp"
const BACKUP_SUFFIX = ".bak"

export function jsonFile(
  what: string,
  path: string,
  mutate: (root: Record<string, unknown>, file: string) => void,
  mode?: number,
): Plan {
  return {
    what,
    path,
    ...(mode === undefined ? {} : { mode }),
    next(current) {
      const root = current === undefined || current.trim() === "" ? {} : object(current, path)
      mutate(root, path)
      return `${JSON.stringify(root, null, 2)}\n`
    },
  }
}

// The YAML goes through a Document rather than a parse and a re-serialize, so a comment an operator wrote survives.
export function yamlFile(what: string, path: string, mutate: (set: (keys: string[], value: unknown) => void) => void): Plan {
  return {
    what,
    path,
    next(current) {
      const document: Document = current === undefined || current.trim() === "" ? new Document({}) : parseDocument(current)
      if (document.errors.length > 0) throw unreadable(path, document.errors[0]?.message ?? "it is not valid YAML")
      mutate((keys, value) => document.setIn(keys, value))
      return document.toString()
    },
  }
}

// One TOML table is written by line rather than by a parser, so every other table, and every comment, is left as
// it is. The block flintd owns runs to the next header that is not one of its own children.
export function tomlTable(what: string, path: string, table: string, entries: Record<string, string>): Plan {
  const header = `[${table}]`
  const own = Object.entries(entries).map(([key, value]) => `${key} = ${value}`)
  return {
    what,
    path,
    next(current) {
      if (current === undefined || current.trim() === "") return ending(`${header}\n${own.join("\n")}`)
      const lines = current.split("\n")
      const start = lines.findIndex((line) => line.trim() === header)
      if (start === -1) return ending(`${ending(current)}\n${header}\n${own.join("\n")}`)
      let end = start + 1
      while (end < lines.length && (!opensSection(lines[end] as string) || isChild(lines[end] as string, table))) end += 1
      let firstChild = start + 1
      while (firstChild < end && !isChild(lines[firstChild] as string, table)) firstChild += 1
      const body = written(lines.slice(start + 1, firstChild), entries)
      // A `[<table>.<child>]` section, and an array of them, belongs to the operator: it is copied out line for line.
      const children = lines.slice(firstChild, end)
      return ending([...lines.slice(0, start + 1), ...body, ...children, ...lines.slice(end)].join("\n"))
    },
  }
}

// flintd owns its own keys in its own table and nothing else in it: another key, and every comment, stays where it is.
function written(body: string[], entries: Record<string, string>): string[] {
  const left = new Set(Object.keys(entries))
  const kept = body.map((line) => {
    const key = [...left].find((name) => new RegExp(`^\\s*${name}\\s*=`).test(line))
    if (key === undefined) return line
    left.delete(key)
    return `${key} = ${entries[key] as string}`
  })
  const added = [...left].map((key) => `${key} = ${entries[key] as string}`)
  if (added.length === 0) return kept
  let last = kept.length
  while (last > 0 && (kept[last - 1] as string).trim() === "") last -= 1
  return [...kept.slice(0, last), ...added, ...kept.slice(last)]
}

function opensSection(line: string): boolean {
  return line.trim().startsWith("[")
}

function isChild(line: string, table: string): boolean {
  const held = line.trim()
  return held.startsWith(`[${table}.`) || held.startsWith(`[[${table}.`)
}

export function sourceFile(what: string, path: string, source: string | { copy: string }): Plan {
  return {
    what,
    path,
    async next() {
      return typeof source === "string" ? source : readFile(source.copy, "utf8")
    },
  }
}

export interface Prepared {
  edit: Edit
  write(): Promise<void>
}

// Every plan is read and merged before any of them is written, so a file that has to be refused costs nothing.
export async function preparePlan(plan: Plan): Promise<Prepared> {
  const current = await readFile(plan.path, "utf8").catch(() => undefined)
  const next = await plan.next(current)
  const action: EditAction = current === next ? "unchanged" : current === undefined ? "create" : "change"
  const edit = { what: plan.what, path: plan.path, action }
  return {
    edit,
    async write(): Promise<void> {
      if (action === "unchanged") return
      await mkdir(dirname(plan.path), { recursive: true })
      // The mode travels with the content: the flintd config file may hold a model key, and a copy would widen it.
      const mode = current === undefined ? plan.mode : (await stat(plan.path)).mode & 0o777
      // One backup, kept: the first init is the run that changed a file somebody else wrote, and a later one must not bury it.
      if (current !== undefined) {
        const backup = `${plan.path}${BACKUP_SUFFIX}`
        await writeFile(backup, current, { flag: "wx", ...(mode === undefined ? {} : { mode }) }).catch(() => undefined)
      }
      const temporary = `${plan.path}${TEMP_SUFFIX}`
      try {
        await writeFile(temporary, next, mode === undefined ? {} : { mode })
        await rename(temporary, plan.path)
      } catch (cause) {
        await rm(temporary, { force: true })
        throw new ToolError("store_error", `flintd could not write ${plan.path}: ${message(cause)}`, { path: plan.path })
      }
    },
  }
}

// One newline at the end, always, so a second init reads back what the first one wrote.
function ending(text: string): string {
  return text.replace(/\n*$/, "\n")
}

function object(text: string, path: string): Record<string, unknown> {
  let held: unknown
  try {
    held = JSON.parse(text)
  } catch (cause) {
    throw unreadable(path, message(cause))
  }
  if (typeof held !== "object" || held === null || Array.isArray(held)) {
    throw unreadable(path, "it does not hold a JSON object")
  }
  return held as Record<string, unknown>
}

function unreadable(path: string, reason: string): ToolError {
  return new ToolError("invalid_arguments", `flintd will not write over ${path}, because ${reason}. Fix the file first.`, {
    path,
  })
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
