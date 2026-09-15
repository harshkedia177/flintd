import { randomUUID } from "node:crypto"
import { ToolError } from "./errors.ts"
import { OBSERVATION_STATUSES } from "./types.ts"
import type { Observation, ObservationInput, ObservationQuery, ObservationSearch, ObservationStatus } from "./types.ts"

const MAX_HARNESS = 64
const MAX_TOOL = 200
const MAX_SESSION = 128
const MAX_KEYS = 64
const MAX_KEY = 128
// The caps of one recorded tool call, so a reader that builds its own rows holds them to the same size.
export const OBSERVATION_CAPS = { tool: MAX_TOOL, keys: MAX_KEYS, key: MAX_KEY } as const
const MAX_PATH = 4096
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

const FIELDS = ["harness", "tool", "status", "session", "argumentKeys", "transcriptPath", "at"]

export function assertObservation(given: unknown, now: string): Observation {
  const input = object(given)
  const unknown = Object.keys(input).filter((key) => !FIELDS.includes(key))
  if (unknown.length > 0) {
    throw refuse(`An Observation holds no field named ${unknown.join(", ")}. flintd mints the id itself.`, {
      fields: unknown.join(", "),
    })
  }
  return {
    id: randomUUID(),
    harness: line(input.harness, "harness", MAX_HARNESS),
    tool: line(input.tool, "tool", MAX_TOOL),
    status: status(input.status),
    session: optional(input.session, "session", MAX_SESSION),
    argumentKeys: keys(input.argumentKeys),
    transcriptPath: optional(input.transcriptPath, "transcriptPath", MAX_PATH),
    at: stamp(input.at, now),
  }
}

export function assertObservationQuery(given: unknown): ObservationSearch {
  const query = object(given) as ObservationQuery
  return {
    since: query.since === undefined ? null : stamp(query.since, ""),
    harness: query.harness === undefined ? null : line(query.harness, "harness", MAX_HARNESS),
    limit: limit(query.limit),
  }
}

function object(given: unknown): ObservationInput {
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    throw refuse("An Observation is a JSON object.", { received: typeof given })
  }
  return given as ObservationInput
}

function line(value: unknown, field: string, most: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > most) {
    throw refuse(`The ${field} of an Observation is one line of text of at most ${most} characters.`, { field })
  }
  return value.trim()
}

function optional(value: unknown, field: string, most: number): string | null {
  if (value === undefined || value === null) return null
  return line(value, field, most)
}

function status(value: unknown): ObservationStatus {
  if (!(OBSERVATION_STATUSES as readonly unknown[]).includes(value)) {
    throw refuse(`The status of an Observation is one of ${OBSERVATION_STATUSES.join(", ")}.`, {
      received: String(value),
    })
  }
  return value as ObservationStatus
}

// Names only. A value never reaches this row, because a tool argument carries the file, the command and the secret.
function keys(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw refuse("The argumentKeys of an Observation are a list of argument names.", {})
  return value.slice(0, MAX_KEYS).map((key) => line(key, "argument key", MAX_KEY))
}

function stamp(value: unknown, now: string): string {
  if (value === undefined) return now
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw refuse("The time of an Observation is an ISO 8601 timestamp.", { received: String(value) })
  }
  return new Date(value).toISOString()
}

function limit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw refuse("The limit of an Observation query is a whole number of at least 1.", { received: String(value) })
  }
  return Math.min(value as number, MAX_LIMIT)
}

function refuse(message: string, details: Record<string, string>): ToolError {
  return new ToolError("invalid_arguments", message, details)
}
