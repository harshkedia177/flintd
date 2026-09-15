import type { JsonValue } from "./types.ts"

// Every credential flintd holds: the model key and the header value of each Connection.
const secrets = new Map<string, number>()
const MARK = "[redacted]"
// A shorter value is not a credential worth striking: it would cut ordinary words out of every message.
const SHORTEST_SECRET = 8
// One alternation over every secret, so a 5 MB answer is scanned once however many Connections a Library holds.
let pattern: RegExp | undefined

export function rememberSecret(value: string): void {
  if (value.length < SHORTEST_SECRET) return
  const held = secrets.get(value)
  secrets.set(value, (held ?? 0) + 1)
  if (held === undefined) pattern = undefined
}

export function forgetSecret(value: string): void {
  const held = secrets.get(value)
  if (held === undefined) return
  if (held > 1) {
    secrets.set(value, held - 1)
    return
  }
  secrets.delete(value)
  pattern = undefined
}

export function redact(written: string): string {
  if (secrets.size === 0) return written
  pattern ??= build()
  return written.replace(pattern, MARK)
}

export function redactValues<T extends JsonValue>(value: T): T {
  if (secrets.size === 0) return value
  return walk(value) as T
}

// The longest first, so a secret that holds another inside it is struck out whole.
function build(): RegExp {
  const written = [...secrets.keys()]
    .sort((left, right) => right.length - left.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(written.join("|"), "g")
}

function walk(value: JsonValue): JsonValue {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map(walk)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, held]) => [redact(key), walk(held)]))
  }
  return value
}
