import { existsSync, renameSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ToolError, causeMessage } from "./errors.ts"
import { manifestHash } from "./manifest.ts"
import type {
  Approval,
  ApprovalKey,
  ApprovalStatus,
  CallOutcome,
  JsonSchema,
  Manifest,
  Observation,
  ObservationSearch,
  ObservationStatus,
  Tier,
  ToolErrorCode,
  ToolState,
  ToolStats,
} from "./types.ts"

const TENANT = "default"
// The decided pairs one Tool keeps, so a Library that is edited for years cannot grow this table without limit.
const APPROVALS_PER_TOOL = 20

const SCHEMA = `CREATE TABLE IF NOT EXISTS tools (
  tenant TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  description TEXT NOT NULL,
  parameters TEXT NOT NULL,
  result TEXT,
  state TEXT NOT NULL,
  tier TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest TEXT NOT NULL,
  session TEXT,
  embedding BLOB,
  embed_stamp TEXT,
  calls INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  last_call_at TEXT,
  contribution REAL NOT NULL DEFAULT 0,
  digest TEXT NOT NULL DEFAULT '',
  version TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  downgraded TEXT,
  PRIMARY KEY (tenant, name_lower)
) STRICT;
CREATE TABLE IF NOT EXISTS calls (
  id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  version TEXT,
  session TEXT,
  harness TEXT,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  parent_call_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  outcome TEXT,
  note TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
) STRICT;
CREATE INDEX IF NOT EXISTS calls_of_tool ON calls (tenant, name_lower);
CREATE TABLE IF NOT EXISTS approvals (
  tenant TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  manifest TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  requester TEXT,
  requested_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  live INTEGER NOT NULL DEFAULT 0,
  touched_at TEXT NOT NULL,
  PRIMARY KEY (tenant, name_lower, manifest_hash, body_digest)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS approval_id ON approvals (tenant, id);
CREATE TABLE IF NOT EXISTS observations (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  harness TEXT NOT NULL,
  session TEXT,
  tool TEXT NOT NULL,
  argument_keys TEXT NOT NULL,
  status TEXT NOT NULL,
  transcript_path TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
) STRICT;
CREATE INDEX IF NOT EXISTS observations_at ON observations (tenant, at);`

const TOOL_COLUMNS = [
  "tenant",
  "name",
  "name_lower",
  "description",
  "parameters",
  "result",
  "state",
  "tier",
  "manifest_hash",
  "manifest",
  "session",
  "embedding",
  "embed_stamp",
  "calls",
  "errors",
  "score",
  "tokens_in",
  "tokens_out",
  "last_call_at",
  "contribution",
  "digest",
  "version",
  "needs_review",
  "downgraded",
]

const APPROVAL_COLUMNS = [
  "tenant",
  "name_lower",
  "manifest_hash",
  "body_digest",
  "id",
  "name",
  "version",
  "manifest",
  "summary",
  "status",
  "requester",
  "requested_at",
  "decided_by",
  "decided_at",
  "note",
  "live",
  "touched_at",
]

const OBSERVATION_COLUMNS = [
  "tenant",
  "id",
  "harness",
  "session",
  "tool",
  "argument_keys",
  "status",
  "transcript_path",
  "at",
]

const CALL_COLUMNS = [
  "id",
  "tenant",
  "name_lower",
  "version",
  "session",
  "harness",
  "duration_ms",
  "error_code",
  "parent_call_id",
  "input_tokens",
  "output_tokens",
  "outcome",
  "note",
  "at",
]

// The running ledger of one Tool, so a rebuild can seed it from stats.json and every call after that adds to what the repository proved.
const LEDGER = `calls = calls + 1, errors = errors + ?, score = score + ?,
  tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, last_call_at = ?,
  contribution = CAST(score + ? AS REAL) / (calls + 1)`

export interface IndexedTool {
  name: string
  description: string
  parameters: JsonSchema
  result: JsonSchema | undefined
  state: ToolState
  tier: Tier
  manifestHash: string
  manifest: Manifest
  // The session of the Tool's Provenance, so a reader can tell whose Draft it is without opening tool.json.
  session: string | null
  calls: number
  errors: number
  lastCallAt: string | null
  contribution: number
  digest: string
  version: string | null
  needs_review: boolean
  // Why this Tool sits below the state its own Version declares, or null when it sits where it was declared.
  downgraded: string | null
}

export interface CallRecord {
  id: string
  name: string
  version: string | null
  session: string | null
  harness: string | null
  durationMs: number
  errorCode: ToolErrorCode | null
  // The call whose Body asked for this one through ctx.callTool, or null for a call a caller made itself.
  parentCallId: string | null
  inputTokens: number | null
  outputTokens: number | null
  at: string
}

// One line of the call ledger, for the Observer: which Tool one session ran, when, and whether it failed.
export interface CallLogEntry {
  name: string
  session: string | null
  harness: string | null
  errorCode: string | null
  at: string
}

export interface Reported {
  name: string
  contribution: number
}

export interface Earned {
  successes: number
  sessions: number
  // Distinct UTC calendar days the clean calls fall on, and distinct harness names among them.
  days: number
  harnesses: number
}

export interface UpsertTool {
  name: string
  description: string
  parameters: JsonSchema
  result?: JsonSchema
  manifest: Manifest
  tier: Tier
  state: ToolState
  needs_review: boolean
  downgraded?: string | null
  provenance?: { session: string | null } | null
}

export interface StoredEmbedding {
  name: string
  stamp: string
  vector: Float32Array
}

export interface ToolIndex {
  upsert(tool: UpsertTool): void
  get(name: string): IndexedTool | undefined
  all(): IndexedTool[]
  setEmbedding(name: string, stamp: string, vector: Float32Array): void
  embeddings(): StoredEmbedding[]
  recordCall(record: CallRecord): void
  callLog(since: string, limit: number): CallLogEntry[]
  recordObservation(observation: Observation): void
  observations(query: ObservationSearch): Observation[]
  reportOutcome(id: string, outcome: CallOutcome, note: string | null): Reported | undefined
  earned(name: string): Earned
  stats(name: string): ToolStats
  seedCounters(name: string, stats: ToolStats): void
  setDigest(name: string, digest: string, version: string | null): void
  putApproval(approval: Approval): Approval
  approval(name: string, key: ApprovalKey): Approval | undefined
  approvalById(id: string): Approval | undefined
  // The live rows only: the pair each Tool declares now, which is what a person is asked to decide.
  approvals(): Approval[]
  decideApproval(id: string, status: ApprovalStatus, decidedBy: string, note: string | null): Approval | undefined
  clearLiveApproval(name: string): void
  remove(name: string): void
  close(): void
}

export interface OpenedIndex {
  index: ToolIndex
  // Where an index that would not open was moved to, or null when it opened.
  moved: string | null
}

export function openIndex(file: string): OpenedIndex {
  let refused: unknown
  try {
    return { index: openDatabase(file), moved: null }
  } catch (cause) {
    refused = cause
  }
  // The index is rebuilt from the repository, so one this build cannot read is moved aside, never deleted.
  const moved = `${file}.broken-${new Date().toISOString()}`
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${moved}${suffix}`)
    }
  } catch (cause) {
    throw new ToolError(
      "store_error",
      `The Library index at ${file} did not open, and flintd could not move it aside to rebuild it. Move it away by hand and start again.`,
      { reason: causeMessage(refused), move: causeMessage(cause) },
    )
  }
  try {
    return { index: openDatabase(file), moved }
  } catch (cause) {
    throw new ToolError("store_error", `The Library index at ${file} did not open.`, { reason: causeMessage(cause) })
  }
}

function openDatabase(file: string): ToolIndex {
  const database = new DatabaseSync(file)
  try {
    database.exec(SCHEMA)
    if (
      !matches(database, "tools", TOOL_COLUMNS) ||
      !matches(database, "calls", CALL_COLUMNS) ||
      !matches(database, "approvals", APPROVAL_COLUMNS) ||
      !matches(database, "observations", OBSERVATION_COLUMNS)
    ) {
      throw new Error(`The index at ${file} does not carry the columns this build of flintd writes.`)
    }
    const upsert = database.prepare(
      `INSERT INTO tools (tenant, name, name_lower, description, parameters, result, state, tier, manifest_hash,
                          manifest, session, calls, errors, last_call_at, needs_review, downgraded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)
       ON CONFLICT (tenant, name_lower)
       DO UPDATE SET name = excluded.name, description = excluded.description, parameters = excluded.parameters,
                     result = excluded.result, state = excluded.state, tier = excluded.tier,
                     manifest_hash = excluded.manifest_hash, manifest = excluded.manifest,
                     session = excluded.session, needs_review = excluded.needs_review,
                     downgraded = excluded.downgraded`,
    )
    const setVector = database.prepare(
      `UPDATE tools SET embedding = ?, embed_stamp = ? WHERE tenant = ? AND name_lower = ?`,
    )
    const vectors = database.prepare(
      `SELECT name, embed_stamp, embedding FROM tools WHERE tenant = ? AND embedding IS NOT NULL`,
    )
    const selectOne = database.prepare(`SELECT * FROM tools WHERE tenant = ? AND name_lower = ?`)
    const selectAll = database.prepare(`SELECT * FROM tools WHERE tenant = ? ORDER BY name`)
    const insertCall = database.prepare(
      `INSERT INTO calls (id, tenant, name_lower, version, session, harness, duration_ms, error_code,
                          parent_call_id, input_tokens, output_tokens, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const addCall = database.prepare(`UPDATE tools SET ${LEDGER} WHERE tenant = ? AND name_lower = ?`)
    const callOf = database.prepare(`SELECT name_lower, outcome, error_code FROM calls WHERE tenant = ? AND id = ?`)
    const setOutcome = database.prepare(`UPDATE calls SET outcome = ?, note = ? WHERE tenant = ? AND id = ?`)
    const addScore = database.prepare(
      `UPDATE tools SET score = score + ?,
         contribution = CASE WHEN calls = 0 THEN 0 ELSE CAST(score + ? AS REAL) / calls END
       WHERE tenant = ? AND name_lower = ?`,
    )
    const earned = database.prepare(
      `SELECT COUNT(*) AS successes, COUNT(DISTINCT session) AS sessions,
              COUNT(DISTINCT substr(at, 1, 10)) AS days, COUNT(DISTINCT harness) AS harnesses FROM calls
       WHERE tenant = ? AND name_lower = ? AND error_code IS NULL`,
    )
    const middle = database.prepare(
      `SELECT duration_ms FROM calls WHERE tenant = ? AND name_lower = ? ORDER BY duration_ms LIMIT 1 OFFSET ?`,
    )
    const sinceCalls = database.prepare(
      `SELECT name_lower, session, harness, error_code, at FROM calls
       WHERE tenant = ? AND at >= ? ORDER BY at LIMIT ?`,
    )
    const seed = database.prepare(
      `UPDATE tools SET calls = ?, errors = ?, score = ?, tokens_in = ?, tokens_out = ?, last_call_at = ?,
         contribution = ?
       WHERE tenant = ? AND name_lower = ?`,
    )
    const setCurrent = database.prepare(
      `UPDATE tools SET digest = ?, version = ? WHERE tenant = ? AND name_lower = ?`,
    )
    const remove = database.prepare(`DELETE FROM tools WHERE tenant = ? AND name_lower = ?`)
    const removeCalls = database.prepare(`DELETE FROM calls WHERE tenant = ? AND name_lower = ?`)
    const addApproval = database.prepare(
      `INSERT INTO approvals (tenant, name_lower, manifest_hash, body_digest, id, name, version, manifest, summary,
                              status, requester, requested_at, decided_by, decided_at, note, live, touched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (tenant, name_lower, manifest_hash, body_digest)
       DO UPDATE SET version = excluded.version, name = excluded.name, live = 1, touched_at = excluded.touched_at`,
    )
    const approvalOf = database.prepare(
      `SELECT * FROM approvals WHERE tenant = ? AND name_lower = ? AND manifest_hash = ? AND body_digest = ?`,
    )
    const approvalOfId = database.prepare(`SELECT * FROM approvals WHERE tenant = ? AND id = ?`)
    const allApprovals = database.prepare(
      `SELECT * FROM approvals WHERE tenant = ? AND live = 1 ORDER BY requested_at, name`,
    )
    const decide = database.prepare(
      `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE tenant = ? AND id = ?`,
    )
    // A new Manifest or a new Body is a new request, so the row of every other pair of this Tool stops being the live one.
    const demoteOther = database.prepare(
      `UPDATE approvals SET live = 0
       WHERE tenant = ? AND name_lower = ? AND NOT (manifest_hash = ? AND body_digest = ?)`,
    )
    const clearLive = database.prepare(`UPDATE approvals SET live = 0 WHERE tenant = ? AND name_lower = ?`)
    // The decided pairs are kept so a restore finds its own, and the oldest of them go once the Tool holds too many.
    const trimApprovals = database.prepare(
      `DELETE FROM approvals WHERE tenant = ? AND name_lower = ? AND live = 0 AND rowid NOT IN
         (SELECT rowid FROM approvals WHERE tenant = ? AND name_lower = ? ORDER BY touched_at DESC, rowid DESC LIMIT ?)`,
    )
    const removeApprovals = database.prepare(`DELETE FROM approvals WHERE tenant = ? AND name_lower = ?`)
    const addObservation = database.prepare(
      `INSERT INTO observations (tenant, id, harness, session, tool, argument_keys, status, transcript_path, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const seenObservations = database.prepare(
      `SELECT id, harness, session, tool, argument_keys, status, transcript_path, at FROM observations
       WHERE tenant = ? AND (? IS NULL OR at >= ?) AND (? IS NULL OR harness = ?)
       ORDER BY at DESC, id DESC LIMIT ?`,
    )

    function row(name: string): IndexedTool | undefined {
      const found = guard(() => selectOne.get(TENANT, name.toLowerCase()))
      return found === undefined ? undefined : toIndexed(found, name)
    }

    // The call and the counters it moves land together, or neither lands: a row that disagreed would name the wrong Tool as the lowest Active one.
    function together(write: () => void): void {
      database.exec("BEGIN")
      try {
        write()
        database.exec("COMMIT")
      } catch (cause) {
        database.exec("ROLLBACK")
        throw cause
      }
    }

    return {
      upsert: (tool) =>
        guard(() =>
          upsert.run(
            TENANT,
            tool.name,
            tool.name.toLowerCase(),
            tool.description,
            JSON.stringify(tool.parameters),
            tool.result === undefined ? null : JSON.stringify(tool.result),
            tool.state,
            tool.tier,
            manifestHash(tool.manifest),
            JSON.stringify(tool.manifest),
            tool.provenance?.session ?? null,
            tool.needs_review ? 1 : 0,
            tool.downgraded ?? null,
          ),
        ),
      get: row,
      all: () => guard(() => selectAll.all(TENANT)).map((found) => toIndexed(found, String(found["name"]))),
      setEmbedding: (name, stamp, vector) =>
        guard(() =>
          setVector.run(
            new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
            stamp,
            TENANT,
            name.toLowerCase(),
          ),
        ),
      embeddings: () =>
        guard(() => vectors.all(TENANT)).flatMap((found) => {
          const vector = floats(found["embedding"])
          const stamp = found["embed_stamp"]
          return vector === undefined || typeof stamp !== "string" ? [] : [{ name: String(found["name"]), stamp, vector }]
        }),
      recordCall: (record) =>
        guard(() => {
          const key = record.name.toLowerCase()
          const failed = record.errorCode !== null
          together(() => {
            insertCall.run(
              record.id,
              TENANT,
              key,
              record.version,
              record.session,
              record.harness,
              record.durationMs,
              record.errorCode,
              record.parentCallId,
              record.inputTokens,
              record.outputTokens,
              record.at,
            )
            addCall.run(
              failed ? 1 : 0,
              failed ? -1 : 1,
              record.inputTokens ?? 0,
              record.outputTokens ?? 0,
              record.at,
              failed ? -1 : 1,
              TENANT,
              key,
            )
          })
        }),
      callLog: (since, limit) => guard(() => sinceCalls.all(TENANT, since, limit)).map(toCallLogEntry),
      recordObservation: (observation) =>
        guard(() =>
          addObservation.run(
            TENANT,
            observation.id,
            observation.harness,
            observation.session,
            observation.tool,
            JSON.stringify(observation.argumentKeys),
            observation.status,
            observation.transcriptPath,
            observation.at,
          ),
        ),
      observations: (query) =>
        guard(() =>
          seenObservations.all(TENANT, query.since, query.since, query.harness, query.harness, query.limit),
        ).map(toObservation),
      reportOutcome: (id, outcome, note) =>
        guard(() => {
          const call = callOf.get(TENANT, id) as Record<string, unknown> | undefined
          const key = call === undefined ? undefined : call["name_lower"]
          if (call === undefined || typeof key !== "string") return undefined
          const moved = worth(outcome) - worth(verdict(call))
          together(() => {
            setOutcome.run(outcome, note, TENANT, id)
            if (moved !== 0) addScore.run(moved, moved, TENANT, key)
          })
          const tool = selectOne.get(TENANT, key) as Record<string, unknown> | undefined
          return tool === undefined ? undefined : { name: String(tool["name"]), contribution: Number(tool["contribution"]) }
        }),
      earned: (name) => {
        const found = guard(() => earned.get(TENANT, name.toLowerCase())) as Record<string, unknown>
        return {
          successes: Number(found["successes"]),
          sessions: Number(found["sessions"]),
          days: Number(found["days"]),
          harnesses: Number(found["harnesses"]),
        }
      },
      stats: (name) => {
        const key = name.toLowerCase()
        const tool = guard(() => selectOne.get(TENANT, key)) as Record<string, unknown> | undefined
        const calls = Number(tool?.["calls"] ?? 0)
        const median =
          calls === 0
            ? undefined
            : (guard(() => middle.get(TENANT, key, Math.floor(calls / 2))) as Record<string, unknown> | undefined)
        const lastCallAt = tool?.["last_call_at"]
        return {
          calls,
          errors: Number(tool?.["errors"] ?? 0),
          lastCallAt: typeof lastCallAt === "string" ? lastCallAt : null,
          p50Ms: median === undefined ? null : Number(median["duration_ms"]),
          tokens: { input: Number(tool?.["tokens_in"] ?? 0), output: Number(tool?.["tokens_out"] ?? 0) },
          contribution: Number(tool?.["contribution"] ?? 0),
        }
      },
      seedCounters: (name, stats) =>
        guard(() =>
          seed.run(
            stats.calls,
            stats.errors,
            Math.round(stats.contribution * stats.calls),
            stats.tokens.input,
            stats.tokens.output,
            stats.lastCallAt,
            stats.contribution,
            TENANT,
            name.toLowerCase(),
          ),
        ),
      setDigest: (name, digest, version) =>
        guard(() => setCurrent.run(digest, version, TENANT, name.toLowerCase())),
      putApproval: (approval) =>
        guard(() => {
          const name = approval.tool.toLowerCase()
          together(() => {
            demoteOther.run(TENANT, name, approval.manifestHash, approval.bodyDigest)
            addApproval.run(
              TENANT,
              name,
              approval.manifestHash,
              approval.bodyDigest,
              approval.id,
              approval.tool,
              approval.version,
              JSON.stringify(approval.manifest),
              approval.summary,
              approval.status,
              approval.requester,
              approval.requestedAt,
              approval.decidedBy,
              approval.decidedAt,
              approval.note,
              new Date().toISOString(),
            )
            trimApprovals.run(TENANT, name, TENANT, name, APPROVALS_PER_TOOL)
          })
          return toApproval(approvalOf.get(TENANT, name, approval.manifestHash, approval.bodyDigest) as Record<string, unknown>)
        }),
      approval: (name, key) => {
        const found = guard(() => approvalOf.get(TENANT, name.toLowerCase(), key.manifestHash, key.bodyDigest))
        return found === undefined ? undefined : toApproval(found)
      },
      approvalById: (id) => {
        const found = guard(() => approvalOfId.get(TENANT, id))
        return found === undefined ? undefined : toApproval(found)
      },
      approvals: () => guard(() => allApprovals.all(TENANT)).map(toApproval),
      clearLiveApproval: (name) => guard(() => clearLive.run(TENANT, name.toLowerCase())),
      decideApproval: (id, status, decidedBy, note) =>
        guard(() => {
          decide.run(status, decidedBy, new Date().toISOString(), note, TENANT, id)
          const found = approvalOfId.get(TENANT, id)
          return found === undefined ? undefined : toApproval(found)
        }),
      // The calls go with the Tool: a new Tool that takes a name back must not inherit what the old one earned.
      remove: (name) =>
        guard(() => {
          const key = name.toLowerCase()
          together(() => {
            removeCalls.run(TENANT, key)
            removeApprovals.run(TENANT, key)
            remove.run(TENANT, key)
          })
        }),
      close: () => database.close(),
    }
  } catch (cause) {
    database.close()
    throw cause
  }
}

// An outcome report replaces the call's own verdict, which is what makes a second report on one call replace the first.
function verdict(call: Record<string, unknown>): CallOutcome {
  const reported = call["outcome"]
  if (reported === "positive" || reported === "negative") return reported
  return call["error_code"] === null ? "positive" : "negative"
}

function worth(outcome: CallOutcome): number {
  return outcome === "positive" ? 1 : -1
}

function matches(database: DatabaseSync, table: string, columns: readonly string[]): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all()
  return rows.length === columns.length && columns.every((column, at) => rows[at]?.["name"] === column)
}

function guard<T>(query: () => T): T {
  try {
    return query()
  } catch (cause) {
    if (cause instanceof ToolError) throw cause
    throw new ToolError("store_error", "The Library index refused the query.", { reason: causeMessage(cause) })
  }
}

// A row written by another build, or a vector of a length no float fills, is no embedding this build can use.
function floats(stored: unknown): Float32Array | undefined {
  if (!(stored instanceof Uint8Array) || stored.byteLength === 0 || stored.byteLength % 4 !== 0) return undefined
  return new Float32Array(Uint8Array.from(stored).buffer)
}

function toApproval(row: Record<string, unknown>): Approval {
  const version = row["version"]
  const decidedBy = row["decided_by"]
  const decidedAt = row["decided_at"]
  const note = row["note"]
  const requester = row["requester"]
  return {
    id: String(row["id"]),
    tool: String(row["name"]),
    version: typeof version === "string" ? version : null,
    manifestHash: String(row["manifest_hash"]),
    bodyDigest: String(row["body_digest"]),
    manifest: JSON.parse(String(row["manifest"])) as Manifest,
    summary: String(row["summary"]),
    status: String(row["status"]) as ApprovalStatus,
    requester: typeof requester === "string" ? requester : null,
    requestedAt: String(row["requested_at"]),
    decidedBy: typeof decidedBy === "string" ? decidedBy : null,
    decidedAt: typeof decidedAt === "string" ? decidedAt : null,
    note: typeof note === "string" ? note : null,
  }
}

function toCallLogEntry(row: Record<string, unknown>): CallLogEntry {
  const session = row["session"]
  const harness = row["harness"]
  const errorCode = row["error_code"]
  return {
    name: String(row["name_lower"]),
    session: typeof session === "string" ? session : null,
    harness: typeof harness === "string" ? harness : null,
    errorCode: typeof errorCode === "string" ? errorCode : null,
    at: String(row["at"]),
  }
}

function toObservation(row: Record<string, unknown>): Observation {
  const session = row["session"]
  const transcriptPath = row["transcript_path"]
  const keys: unknown = JSON.parse(String(row["argument_keys"]))
  return {
    id: String(row["id"]),
    harness: String(row["harness"]),
    session: typeof session === "string" ? session : null,
    tool: String(row["tool"]),
    argumentKeys: Array.isArray(keys) ? keys.map(String) : [],
    status: row["status"] as ObservationStatus,
    transcriptPath: typeof transcriptPath === "string" ? transcriptPath : null,
    at: String(row["at"]),
  }
}

function toIndexed(row: Record<string, unknown>, name: string): IndexedTool {
  const lastCallAt = row["last_call_at"]
  const version = row["version"]
  const session = row["session"]
  return {
    name: String(row["name"]),
    description: String(row["description"]),
    parameters: schemaOf(row["parameters"], name),
    result: typeof row["result"] === "string" ? schemaOf(row["result"], name) : undefined,
    state: String(row["state"]) as ToolState,
    tier: String(row["tier"]) as Tier,
    manifestHash: String(row["manifest_hash"]),
    manifest: manifestOf(row["manifest"]),
    session: typeof session === "string" ? session : null,
    calls: Number(row["calls"]),
    errors: Number(row["errors"]),
    lastCallAt: typeof lastCallAt === "string" ? lastCallAt : null,
    contribution: Number(row["contribution"] ?? 0),
    digest: String(row["digest"] ?? ""),
    version: typeof version === "string" ? version : null,
    needs_review: Number(row["needs_review"] ?? 0) !== 0,
    downgraded: typeof row["downgraded"] === "string" ? row["downgraded"] : null,
  }
}

// A row flintd wrote always holds a Manifest; a row that somehow does not reads as the empty one, which asks for nothing.
function manifestOf(stored: unknown): Manifest {
  try {
    return JSON.parse(String(stored)) as Manifest
  } catch {
    return {}
  }
}

function schemaOf(stored: unknown, name: string): JsonSchema {
  try {
    return JSON.parse(String(stored)) as JsonSchema
  } catch (cause) {
    throw new ToolError(
      "store_error",
      `The Library index holds an argument schema for the Tool ${name} that is not JSON. Delete index.sqlite and start again; the index is rebuilt from the Library.`,
      { name, reason: causeMessage(cause) },
    )
  }
}
