import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const SETTINGS_FILE = "pi.json"
const CONFIG_FILE = "config.json"
const TOKEN_FILE = "token"
const PORT_FILE = "port"
const DEFAULT_PORT = 3546
const KEYS = ["url", "token", "tokenFile"]
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"]

export interface Settings {
  url: string
  token: string
}

function flintdHome(): string {
  const override = process.env["FLINTD_HOME"]
  return override === undefined || override === "" ? join(homedir(), ".flintd") : resolve(override)
}

export async function settings(): Promise<Settings> {
  const home = flintdHome()
  const path = join(home, SETTINGS_FILE)
  const own = await object(path)
  for (const key of Object.keys(own)) {
    if (!KEYS.includes(key)) throw new Error(`${key} in ${path} is not a key this extension reads: ${KEYS.join(", ")}.`)
  }
  const held = text(own, "token", path)
  if (held !== undefined) await assertPrivate(path, "settings file")
  const given = text(own, "url", path)
  return {
    url: given === undefined ? `http://127.0.0.1:${await port(home)}/mcp` : reachable(given, path),
    token: held ?? (await token(home, text(own, "tokenFile", path))),
  }
}

async function object(path: string): Promise<Record<string, unknown>> {
  const read = await readFile(path, "utf8").catch(() => undefined)
  if (read === undefined) return {}
  let held: unknown
  try {
    held = JSON.parse(read)
  } catch {
    throw new Error(`${path} is not valid JSON.`)
  }
  if (held === null || typeof held !== "object" || Array.isArray(held)) {
    throw new Error(`${path} must hold a JSON object.`)
  }
  return held as Record<string, unknown>
}

function text(from: Record<string, unknown>, key: string, path: string): string | undefined {
  const held = from[key]
  if (held === undefined) return undefined
  if (typeof held !== "string" || held === "") throw new Error(`${key} in ${path} must be a string with a value.`)
  return held
}

function reachable(url: string, path: string): string {
  let held: URL
  try {
    held = new URL(url)
  } catch {
    throw new Error(`url in ${path} is not a URL: ${url}`)
  }
  if (held.protocol === "https:") return url
  // The bearer token rides every request, so cleartext is for the loopback address and nothing else.
  if (held.protocol === "http:" && LOOPBACK.includes(held.hostname)) return url
  throw new Error(`url in ${path} must be https, or http on the loopback address, never ${held.protocol}//${held.host}.`)
}

async function port(home: string): Promise<number> {
  const path = join(home, CONFIG_FILE)
  const held = (await object(path))["port"]
  if (held !== undefined && (typeof held !== "number" || !Number.isSafeInteger(held) || held < 0 || held > 65535)) {
    throw new Error(`The "port" in ${path} must be a whole number from 0 to 65535.`)
  }
  if (held !== undefined && held !== 0) return held
  // `port: 0` leaves the daemon to pick one, and the port file beside the token is where it writes what it picked.
  const chosen = Number((await readFile(join(home, PORT_FILE), "utf8").catch(() => "")).trim())
  if (Number.isSafeInteger(chosen) && chosen > 0 && chosen <= 65535) return chosen
  if (held === 0) {
    throw new Error(`The "port" in ${path} is 0, so only a running daemon knows it. Start it with \`flintd serve\` first.`)
  }
  return DEFAULT_PORT
}

async function token(home: string, file: string | undefined): Promise<string> {
  const path = file === undefined ? join(home, TOKEN_FILE) : isAbsolute(file) ? file : resolve(home, file)
  const held = (await readFile(path, "utf8").catch(() => "")).trim()
  if (held === "") throw new Error(`There is no token in ${path}. Start the daemon with \`flintd serve\` first.`)
  await assertPrivate(path, "token file")
  return held
}

// The same guard the daemon puts on the file it wrote: a token another user can read is a token to replace.
async function assertPrivate(path: string, what: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) === 0) return
  throw new Error(`The ${what} ${path} is readable by other users (mode ${mode.toString(8)}). Run \`chmod 600 ${path}\`.`)
}
