export const HOOK_HARNESSES = ["claude-code", "codex", "opencode", "hermes", "openclaw"] as const

export type HookHarness = (typeof HOOK_HARNESSES)[number]

export interface HookObservation {
  harness: string
  tool: string
  status: "ok" | "error"
  session: string | null
  argumentKeys: string[]
  transcriptPath: string | null
}

const MAX_KEYS = 64
const MAX_KEY = 128
const MAX_LINE = 4096

// Claude Code and Codex document the same stdin record; the other three are read by a wrapper init writes for them.
const ADAPTERS: Record<HookHarness, (payload: Record<string, unknown>) => Omit<HookObservation, "harness">> = {
  "claude-code": native,
  codex: native,
  opencode: own,
  hermes: own,
  openclaw: own,
}

export function isHookHarness(value: unknown): value is HookHarness {
  return (HOOK_HARNESSES as readonly unknown[]).includes(value)
}

export function adapt(harness: HookHarness, payload: unknown, transcripts: boolean): HookObservation | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined
  const read = ADAPTERS[harness](payload as Record<string, unknown>)
  if (read.tool === "") return undefined
  return { ...read, harness, transcriptPath: transcripts ? read.transcriptPath : null }
}

function native(payload: Record<string, unknown>): Omit<HookObservation, "harness"> {
  return {
    tool: line(payload["tool_name"] ?? payload["hook_event_name"], MAX_KEY),
    status: failed(payload["tool_response"]) ? "error" : "ok",
    session: blank(line(payload["session_id"], MAX_KEY)),
    argumentKeys: keys(payload["tool_input"]),
    transcriptPath: blank(line(payload["transcript_path"], MAX_LINE)),
  }
}

function own(payload: Record<string, unknown>): Omit<HookObservation, "harness"> {
  return {
    tool: line(payload["tool"], MAX_KEY),
    status: payload["status"] === "error" || failed(payload["result"]) ? "error" : "ok",
    session: blank(line(payload["session"], MAX_KEY)),
    argumentKeys: keys(payload["args"]),
    transcriptPath: blank(line(payload["transcript_path"], MAX_LINE)),
  }
}

// The argument names and never a value: a tool argument carries the file, the command and, now and then, the secret.
function keys(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  return Object.keys(value).slice(0, MAX_KEYS).map((key) => key.slice(0, MAX_KEY))
}

function failed(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false
  const held = response as Record<string, unknown>
  return held["success"] === false || held["is_error"] === true || typeof held["error"] === "string"
}

function line(value: unknown, most: number): string {
  return typeof value === "string" ? value.trim().slice(0, most) : ""
}

function blank(value: string): string | null {
  return value === "" ? null : value
}
