import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { bodyModule, bodyOfModule } from "./body.ts"
import { flintdHome } from "./connections.ts"
import { ToolError, causeMessage } from "./errors.ts"
import {
  abortMerge,
  branchName,
  checkoutOurs,
  clean,
  commit,
  commitMerge,
  ensureRepository,
  fastForward,
  fetchOrigin,
  log,
  lsTree,
  mergeBase,
  mergeNoCommit,
  pushOrigin,
  remoteUrl,
  revision,
  setRemote,
  show,
  stage,
  statusEntries,
  tracked,
  unmergedPaths,
  unpushed,
  unstage,
} from "./git.ts"
import { LOCK_FILE } from "./lock.ts"
import { openIndex } from "./sqlite-index.ts"
import type {
  CallLogEntry,
  CallRecord,
  Earned,
  IndexedTool,
  Reported,
  StoredEmbedding,
  ToolIndex,
  UpsertTool,
} from "./sqlite-index.ts"
import { assertToolName, isToolName } from "./validate.ts"
import { APPROVAL_STATUSES } from "./types.ts"
import type {
  Approval,
  ApprovalKey,
  ApprovalStatus,
  CallOutcome,
  Channel,
  Example,
  HeldOut,
  Observation,
  ObservationSearch,
  Operation,
  Tool,
  ToolStats,
} from "./types.ts"

const TOOLS_DIRECTORY = "tools"
const INDEX_FILE = "index.sqlite"
const DEFINITION_FILE = "tool.json"
const BODY_FILE = "body.js"
const EXAMPLES_FILE = "examples.json"
const STATS_FILE = "stats.json"
const HELD_OUT_FILE = "held-out.json"
const TEMP_SUFFIX = ".tmp"
const APPROVAL_LOG = "approvals.jsonl"
const APPROVAL_LOG_MAX_BYTES = 1_000_000
const IGNORE_RULES = [`${INDEX_FILE}*`, `${LOCK_FILE}*`, `${TOOLS_DIRECTORY}/*/*${TEMP_SUFFIX}`]
const VERSION_ID_PATTERN = /^[0-9a-f]{7,40}$/
const TOOL_FILES = [DEFINITION_FILE, BODY_FILE, EXAMPLES_FILE, STATS_FILE, HELD_OUT_FILE]
// The commit grammar, in one place: every Version subject a flintd build writes, and every one it reads back.
const SUBJECT_PATTERN = /^(create|update|restore|retire|verify|activate)\(([a-z][a-z0-9_]*)\): (agent|observer|file|flintd)$/

export type { CallLogEntry, CallRecord, Earned, IndexedTool, Reported, StoredEmbedding, UpsertTool } from "./sqlite-index.ts"

export interface ToolRecord {
  tool: Tool
  examples: Example[]
  body: string
  stats: ToolStats
  heldOut: HeldOut | null
}

export interface Written {
  version: string
  digest: string
}

export interface VersionEntry {
  id: string
  timestamp: string
  operation: Operation | null
  channel: Channel | null
  subject: string
}

export interface StorePlan {
  remote: string | undefined
  syncTimeoutMs: number
}

export interface StoreOpened {
  remote: string | null
  error: string | null
}

export interface StoreSync {
  push(): Promise<void>
  pull(): Promise<void>
  ahead(): Promise<boolean>
  stale(cause: unknown): boolean
}

// The seam every caller uses for Tools and Versions. One implementation today: a git repository with a SQLite index.
export interface Store {
  readonly dir: string
  readonly sync: StoreSync | undefined
  // Where an index this Library could not open was moved to, or null when it opened.
  readonly movedIndex: string | null
  open(plan: StorePlan): Promise<StoreOpened>
  close(): Promise<void>

  listTools(): Promise<string[]>
  readTool(name: string): Promise<Tool>
  readBody(name: string): Promise<string>
  readExamples(name: string): Promise<Example[]>
  readStats(name: string): Promise<ToolStats>
  readHeldOut(name: string): Promise<HeldOut | null>
  writeFiles(record: ToolRecord): Promise<void>
  write(record: ToolRecord, operation: Operation): Promise<Written>
  commit(name: string, operation: Operation, channel: Channel): Promise<Written>

  changed(name: string): Promise<boolean>
  changedTools(): Promise<Set<string>>
  digests(): Promise<Map<string, string>>
  known(name: string): Promise<boolean>

  versions(name: string, before: string | undefined, limit: number): Promise<VersionEntry[]>
  currentVersion(name: string): Promise<string | null>
  resolveVersion(name: string, id: unknown): Promise<string>
  versionTool(name: string, id: string): Promise<Tool>
  versionBody(name: string, id: string): Promise<string>
  versionExamples(name: string, id: string): Promise<Example[]>

  get(name: string): IndexedTool | undefined
  all(): IndexedTool[]
  upsert(tool: UpsertTool): void
  setEmbedding(name: string, stamp: string, vector: Float32Array): void
  embeddings(): StoredEmbedding[]
  setDigest(name: string, digest: string, version: string | null): void
  recordCall(record: CallRecord): void
  // The call ledger from `since`, oldest first, which is what the Observer reads for repetition.
  callLog(since: string, limit: number): CallLogEntry[]
  recordObservation(observation: Observation): void
  observations(query: ObservationSearch): Observation[]
  reportOutcome(id: string, outcome: CallOutcome, note: string | null): Reported | undefined
  earned(name: string): Earned
  stats(name: string): ToolStats
  seedCounters(name: string, stats: ToolStats): void
  putApproval(approval: Approval): Approval
  approval(name: string, key: ApprovalKey): Approval | undefined
  approvalById(id: string): Approval | undefined
  approvals(): Approval[]
  decideApproval(id: string, status: ApprovalStatus, decidedBy: string, note: string | null): Approval | undefined
  clearLiveApproval(name: string): void
  forget(name: string): void
}

function toolPath(name: string): string {
  return `${TOOLS_DIRECTORY}/${assertToolName(name)}`
}

function toolOfPath(path: string): string | undefined {
  const [root, name] = path.split("/")
  return root === TOOLS_DIRECTORY && name !== undefined && isToolName(name) ? name : undefined
}

function versionSubject(operation: Operation, name: string, channel: Channel): string {
  return `${operation}(${name}): ${channel}`
}

async function markReview(dir: string, name: string): Promise<void> {
  const tool = await readJson<Tool>(dir, name, DEFINITION_FILE)
  if (tool.needs_review === true) return
  await guard(`mark ${name} for review`, () =>
    replace(toolDirectory(dir, name), DEFINITION_FILE, json({ ...tool, needs_review: true })),
  )
}

export function createStore(dir: string): Store {
  let index: ToolIndex | undefined
  let remote: Remote | null = null
  let moved: string | null = null

  function indexed(): ToolIndex {
    if (index === undefined) throw new ToolError("store_error", `The Library at ${dir} is not open.`, { dir })
    return index
  }

  const sync: StoreSync = {
    async push(): Promise<void> {
      if (remote !== null) await pushOrigin(dir, remote.branch, remote.timeoutMs)
    },
    async pull(): Promise<void> {
      if (remote !== null) await pull(dir, remote)
    },
    async ahead(): Promise<boolean> {
      return remote !== null && (await unpushed(dir, remote.branch))
    },
    stale: rejected,
  }

  return {
    dir,
    sync,

    get movedIndex(): string | null {
      return moved
    },

    async open(plan: StorePlan): Promise<StoreOpened> {
      await guard("open", () => mkdir(join(dir, TOOLS_DIRECTORY), { recursive: true }))
      await ensureRepository(dir)
      const found = await openRemote(dir, plan.remote, plan.syncTimeoutMs)
      let error: string | null = null
      if (found !== null) {
        // The pull runs before the .gitignore is written, so an untracked file never blocks a merge into an empty Library.
        await pull(dir, found).catch((cause: unknown) => {
          error = `pull from ${found.url}: ${causeMessage(cause)}`
        })
      }
      await ensureIgnoreRules(dir)
      const opened = openIndex(join(dir, INDEX_FILE))
      index = opened.index
      moved = opened.moved
      // git carries no Approval, so a rebuilt index takes back the decisions a person made from the log outside it.
      if (opened.moved !== null) {
        const decided = recordedDecisions(dir)
        for (const approval of decided) opened.index.putApproval(approval)
        // A decision says what a person allowed, never which pair a Tool declares now. The scan that follows says that.
        for (const name of new Set(decided.map((one) => one.tool))) opened.index.clearLiveApproval(name)
      }
      remote = found
      return { remote: found?.url ?? null, error }
    },

    async close(): Promise<void> {
      index?.close()
      index = undefined
    },

    async listTools(): Promise<string[]> {
      const entries = await guard("list its Tools", () => readdir(join(dir, TOOLS_DIRECTORY), { withFileTypes: true }))
      return entries
        .filter((entry) => entry.isDirectory() && isToolName(entry.name))
        .map((entry) => entry.name)
        .sort()
    },

    async readTool(name: string): Promise<Tool> {
      return readJson<Tool>(dir, name, DEFINITION_FILE)
    },

    async readBody(name: string): Promise<string> {
      const path = join(toolDirectory(dir, name), BODY_FILE)
      return bodyOfModule(await guard(`read the Body of ${name}`, () => readFile(path, "utf8"), name))
    },

    async readExamples(name: string): Promise<Example[]> {
      return readJson<Example[]>(dir, name, EXAMPLES_FILE)
    },

    async readStats(name: string): Promise<ToolStats> {
      return readJson<ToolStats>(dir, name, STATS_FILE)
    },

    async readHeldOut(name: string): Promise<HeldOut | null> {
      const path = join(toolDirectory(dir, name), HELD_OUT_FILE)
      const text = await readFile(path, "utf8").catch(() => null)
      return text === null ? null : parseJson<HeldOut>(text, HELD_OUT_FILE, name)
    },

    async writeFiles(record: ToolRecord): Promise<void> {
      const directory = toolDirectory(dir, record.tool.name)
      await guard(`write ${record.tool.name}`, async () => {
        await mkdir(directory, { recursive: true })
        await replace(directory, DEFINITION_FILE, json(record.tool))
        await replace(directory, BODY_FILE, bodyModule(record.body))
        await replace(directory, EXAMPLES_FILE, json(record.examples))
        await replace(directory, STATS_FILE, json(record.stats))
        if (record.heldOut === null) await rm(join(directory, HELD_OUT_FILE), { force: true })
        else await replace(directory, HELD_OUT_FILE, json(record.heldOut))
      })
    },

    async commit(name: string, operation: Operation, channel: Channel): Promise<Written> {
      const written = await commit(dir, committedPaths(name), versionSubject(operation, name, channel), toolPath(name))
      return { version: written.version, digest: written.tree }
    },

    async write(record: ToolRecord, operation: Operation): Promise<Written> {
      const name = record.tool.name
      await this.writeFiles(record)
      try {
        return await this.commit(name, operation, record.tool.provenance.channel)
      } catch (cause) {
        if (!(await rollback(dir, name, operation === "create"))) throw cause
        throw new ToolError(
          "store_error",
          `The Library refused the ${operation} of ${name} and could not undo it, so tools/${name} still holds the change and no Version records it. Put the directory back with git before the next write.`,
          { name, reason: causeMessage(cause) },
        )
      }
    },

    async changed(name: string): Promise<boolean> {
      return toolChanged(dir, name)
    },

    async changedTools(): Promise<Set<string>> {
      const names = new Set<string>()
      let renamed = false
      for (const entry of await statusEntries(dir, TOOLS_DIRECTORY)) {
        // A rename carries the path it came from as the next entry, and that path no longer has a directory.
        if (renamed) {
          renamed = false
          continue
        }
        renamed = entry.startsWith("R") || entry.startsWith("C")
        const [root, name] = entry.slice(3).split("/")
        if (root === TOOLS_DIRECTORY && name !== undefined) names.add(name)
      }
      return names
    },

    async digests(): Promise<Map<string, string>> {
      const lines = await lsTree(dir, `HEAD:${TOOLS_DIRECTORY}`).catch(() => [])
      const found = new Map<string, string>()
      for (const line of lines) {
        const [entry = "", name = ""] = line.split("\t")
        const digest = entry.split(" ")[2]
        if (name !== "" && digest !== undefined) found.set(name, digest)
      }
      return found
    },

    async known(name: string): Promise<boolean> {
      return tracked(dir, toolPath(name))
    },

    async versions(name: string, before: string | undefined, limit: number): Promise<VersionEntry[]> {
      return listVersions(dir, name, before, limit)
    },

    async currentVersion(name: string): Promise<string | null> {
      const [entry] = await listVersions(dir, name, undefined, 1)
      return entry?.id ?? null
    },

    async resolveVersion(name: string, id: unknown): Promise<string> {
      if (typeof id !== "string" || !VERSION_ID_PATTERN.test(id)) {
        throw new ToolError(
          "invalid_arguments",
          "A Version id is one of the ids tool_history returns. Call tool_history to list the Versions of this Tool.",
          { received: typeof id === "string" ? id : typeof id },
        )
      }
      const full = await revision(dir, `${id}^{commit}`).catch(() => "")
      const [entry] = full === "" ? [] : await listVersions(dir, name, full, 1)
      if (entry === undefined || entry.id !== full) {
        throw new ToolError(
          "invalid_arguments",
          `${JSON.stringify(id)} is not a Version of the Tool ${JSON.stringify(name)}. Call tool_history to list its Versions.`,
          { name, version: id },
        )
      }
      return full
    },

    async versionTool(name: string, id: string): Promise<Tool> {
      return parseJson<Tool>(await show(dir, id, filePath(name, DEFINITION_FILE)), DEFINITION_FILE, name)
    },

    async versionBody(name: string, id: string): Promise<string> {
      return bodyOfModule(await show(dir, id, filePath(name, BODY_FILE)))
    },

    async versionExamples(name: string, id: string): Promise<Example[]> {
      return parseJson<Example[]>(await show(dir, id, filePath(name, EXAMPLES_FILE)), EXAMPLES_FILE, name)
    },

    get: (name) => indexed().get(name),
    all: () => indexed().all(),
    upsert: (tool) => indexed().upsert(tool),
    setEmbedding: (name, stamp, vector) => indexed().setEmbedding(name, stamp, vector),
    embeddings: () => indexed().embeddings(),
    setDigest: (name, digest, version) => indexed().setDigest(name, digest, version),
    recordCall: (record) => indexed().recordCall(record),
    callLog: (since, limit) => indexed().callLog(since, limit),
    recordObservation: (observation) => indexed().recordObservation(observation),
    observations: (query) => indexed().observations(query),
    reportOutcome: (id, outcome, note) => indexed().reportOutcome(id, outcome, note),
    earned: (name) => indexed().earned(name),
    stats: (name) => indexed().stats(name),
    seedCounters: (name, stats) => indexed().seedCounters(name, stats),
    putApproval: (approval) => indexed().putApproval(approval),
    approval: (name, key) => indexed().approval(name, key),
    approvalById: (id) => indexed().approvalById(id),
    approvals: () => indexed().approvals(),
    decideApproval: (id, status, decidedBy, note) => {
      const decided = indexed().decideApproval(id, status, decidedBy, note)
      if (decided !== undefined) recordDecision(dir, decided)
      return decided
    },
    clearLiveApproval: (name) => indexed().clearLiveApproval(name),
    forget: (name) => indexed().remove(name),
  }
}


// An Approval is a person's decision and git never carries it, so every decision is appended outside every Library,
// and a rebuilt index reads them back. The file holds no Body and no credential, only what was decided about which pair.
function decisionLog(): string {
  return join(flintdHome(), APPROVAL_LOG)
}

function decisionKey(library: string, approval: Approval): string {
  return [library, approval.tool.toLowerCase(), approval.manifestHash, approval.bodyDigest].join("\u0000")
}

function recordDecision(library: string, approval: Approval): void {
  const path = decisionLog()
  mkdirSync(flintdHome(), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify({ library, approval })}\n`, { mode: 0o600 })
  if (statSync(path).size > APPROVAL_LOG_MAX_BYTES) compactDecisions(path)
}

function readDecisions(path: string): Map<string, { line: string; entry: { library: string; approval: Approval } }> {
  const text = (() => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return ""
    }
  })()
  const held = new Map<string, { line: string; entry: { library: string; approval: Approval } }>()
  for (const line of text.split("\n")) {
    if (line === "") continue
    let entry: { library: string; approval: Approval }
    try {
      entry = JSON.parse(line) as { library: string; approval: Approval }
    } catch {
      continue
    }
    if (typeof entry?.library !== "string" || !isApproval(entry.approval)) continue
    held.set(decisionKey(entry.library, entry.approval), { line, entry })
  }
  return held
}

// The last decision about a pair is the decision, so the log is rewritten to one line each once it passes its bound.
function compactDecisions(path: string): void {
  const kept = [...readDecisions(path).values()].map((held) => held.line)
  const temporary = `${path}.${process.pid}${TEMP_SUFFIX}`
  writeFileSync(temporary, kept.length === 0 ? "" : `${kept.join("\n")}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function recordedDecisions(library: string): Approval[] {
  return [...readDecisions(decisionLog()).values()]
    .filter((held) => held.entry.library === library)
    .map((held) => held.entry.approval)
}

// The log is a file on the operator's machine, so every field a row is built from is checked before it is written back.
function isApproval(value: unknown): value is Approval {
  if (value === null || typeof value !== "object") return false
  const one = value as Record<string, unknown>
  const strings = ["id", "tool", "manifestHash", "bodyDigest", "summary", "status", "requestedAt"]
  if (!strings.every((field) => typeof one[field] === "string" && one[field] !== "")) return false
  if (!(APPROVAL_STATUSES as readonly string[]).includes(String(one["status"]))) return false
  return isToolName(String(one["tool"])) && typeof one["manifest"] === "object" && one["manifest"] !== null
}

const REJECTED_PATTERN = /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i

interface Remote {
  url: string
  branch: string
  timeoutMs: number
}

async function openRemote(dir: string, wanted: string | undefined, timeoutMs: number): Promise<Remote | null> {
  if (wanted !== undefined) await setRemote(dir, wanted)
  const url = await remoteUrl(dir)
  return url === null ? null : { url: withoutCredential(url), branch: await branchName(dir), timeoutMs }
}

async function pull(dir: string, remote: Remote): Promise<void> {
  await fetchOrigin(dir, remote.timeoutMs)
  const theirs = await revision(dir, `refs/remotes/origin/${remote.branch}`).catch(() => null)
  if (theirs === null) return
  const ours = await revision(dir, "HEAD").catch(() => null)
  if (ours === theirs) return
  if (ours === null) {
    await fastForward(dir, theirs)
    return
  }
  const base = await mergeBase(dir, ours, theirs)
  if (base === theirs) return
  if (base === ours) {
    await fastForward(dir, theirs)
    return
  }
  await divide(dir, theirs)
}

// A push the remote refuses because it holds work this Library has not seen; any other failure is the network or the URL.
function rejected(cause: unknown): boolean {
  return cause instanceof ToolError && REJECTED_PATTERN.test(String(cause.details["reason"] ?? ""))
}

// A remote may carry a password, and its URL reaches status(), the CLI and every sync failure message.
function withoutCredential(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username === "" && parsed.password === "") return url
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    return url
  }
}

// Both sides changed the same Tool: the files stay as this Library gated them, and the Tool is flagged so a person picks the Version that wins.
async function divide(dir: string, theirs: string): Promise<void> {
  try {
    await mergeNoCommit(dir, theirs)
    const conflicted = await unmergedPaths(dir)
    if (conflicted.length === 0) {
      await commitMerge(dir, "sync: origin")
      return
    }
    await checkoutOurs(dir, conflicted)
    const review = [...new Set(conflicted.map(toolOfPath).filter((name) => name !== undefined))].sort()
    for (const name of review) await markReview(dir, name)
    await stage(dir, [...conflicted, ...review.map(toolPath)])
    await commitMerge(dir, `review(${review.join(", ")}): sync`)
  } catch (cause) {
    await abortMerge(dir)
    throw cause
  }
}

async function ensureIgnoreRules(dir: string): Promise<void> {
  await guard("open", async () => {
    const ignore = join(dir, ".gitignore")
    const rules = await readFile(ignore, "utf8").catch(() => "")
    // The index and the lock belong to one running flintd, so neither may ever reach a commit.
    const wanted = IGNORE_RULES.filter((rule) => !rules.split("\n").includes(rule))
    if (wanted.length === 0) return
    await writeFile(ignore, `${rules}${rules === "" || rules.endsWith("\n") ? "" : "\n"}${wanted.join("\n")}\n`)
  })
}

async function listVersions(
  dir: string,
  name: string,
  from: string | undefined,
  limit: number,
): Promise<VersionEntry[]> {
  const entries = await log(dir, toolPath(name), from, limit)
  return entries.map((entry) => {
    const parts = SUBJECT_PATTERN.exec(entry.subject)
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      operation: (parts?.[1] as Operation | undefined) ?? null,
      channel: (parts?.[3] as Channel | undefined) ?? null,
      subject: entry.subject,
    }
  })
}

async function toolChanged(dir: string, name: string): Promise<boolean> {
  return (await statusEntries(dir, toolPath(name))).length > 0
}

async function rollback(dir: string, name: string, created: boolean): Promise<boolean> {
  const paths = committedPaths(name)
  if (created) {
    // The Tool must leave the working tree even when git refuses to unstage it, or the next start() indexes it.
    await rm(toolDirectory(dir, name), { recursive: true, force: true }).catch(() => undefined)
    await unstage(dir, paths).catch(() => undefined)
  } else {
    await unstage(dir, paths).catch(() => undefined)
    // git checkout needs the index lock, which is exactly what a failed write may not have, so HEAD is read and written back.
    await restoreFromHead(dir, name).catch(() => undefined)
    await clean(dir, [toolPath(name)]).catch(() => undefined)
  }
  return toolChanged(dir, name).catch(() => true)
}

async function restoreFromHead(dir: string, name: string): Promise<void> {
  const directory = toolDirectory(dir, name)
  for (const file of TOOL_FILES) {
    const text = await show(dir, "HEAD", filePath(name, file)).catch(() => undefined)
    if (text === undefined) await rm(join(directory, file), { force: true })
    else await writeFile(join(directory, file), text)
  }
}

// A reader never sees half a file: the write lands beside it and rename puts it in place in one step.
async function replace(directory: string, file: string, text: string): Promise<void> {
  const temp = join(directory, `${file}${TEMP_SUFFIX}`)
  await writeFile(temp, text)
  await rename(temp, join(directory, file))
}

function filePath(name: string, file: string): string {
  return `${toolPath(name)}/${file}`
}

function committedPaths(name: string): string[] {
  return [toolPath(name), ".gitignore"]
}

function toolDirectory(dir: string, name: string): string {
  return join(dir, TOOLS_DIRECTORY, assertToolName(name))
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readJson<T>(dir: string, name: string, file: string): Promise<T> {
  const text = await guard(`read ${file} of ${name}`, () => readFile(join(toolDirectory(dir, name), file), "utf8"), name)
  return parseJson<T>(text, file, name)
}

function parseJson<T>(text: string, file: string, name: string): T {
  try {
    return JSON.parse(text) as T
  } catch (cause) {
    throw new ToolError("store_error", `The file ${file} of the Tool ${name} is not valid JSON.`, {
      reason: causeMessage(cause),
    })
  }
}

async function guard<T>(what: string, action: () => Promise<T>, missing?: string): Promise<T> {
  try {
    return await action()
  } catch (cause) {
    if (cause instanceof ToolError) throw cause
    if (missing !== undefined && isMissing(cause)) {
      throw new ToolError("not_found", `There is no Tool named ${JSON.stringify(missing)} in the Library.`, {
        name: missing,
      })
    }
    throw new ToolError("store_error", `The Library could not ${what}.`, { reason: causeMessage(cause) })
  }
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ENOENT"
}
