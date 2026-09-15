import { readFile } from "node:fs/promises"
import { isIP } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const CONFIG_FILE = "config.json"
const TOKEN_FILE = "token"
const PORT_FILE = "port"
const DEFAULT_PORT = 3546

export interface HookSettings {
  url: string
  token: string
  // The operator's answer to the transcript question for this harness, from the flintd config file.
  transcripts: boolean
}

export function flintdHome(): string {
  const override = given(process.env["FLINTD_HOME"])
  return override === undefined ? join(homedir(), ".flintd") : resolve(override)
}

export async function hookSettings(harness: string, home = flintdHome()): Promise<HookSettings> {
  const config = await object(join(home, CONFIG_FILE))
  const harnesses = config["harnesses"]
  const named = typeof harnesses === "object" && harnesses !== null ? (harnesses as Record<string, unknown>)[harness] : undefined
  const transcripts = typeof named === "object" && named !== null ? (named as Record<string, unknown>)["transcripts"] : undefined
  return {
    url: reachable(given(process.env["FLINTD_URL"])) ?? `http://127.0.0.1:${whole(config["port"]) ?? (await chosen(home)) ?? DEFAULT_PORT}`,
    token: given(process.env["FLINTD_TOKEN"]) ?? (await token(join(home, TOKEN_FILE))),
    transcripts: transcripts === true,
  }
}

// An empty variable is one the operator exported before the daemon wrote the file, so it says nothing at all.
function given(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value
}

function reachable(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  let held: URL
  try {
    held = new URL(url)
  } catch {
    throw new Error(`FLINTD_URL is not a URL: ${url}`)
  }
  // The token opens every route of the daemon, and any process in the session can set this variable, so the hook
  // posts to a daemon on this machine and to nothing else.
  if ((held.protocol === "http:" || held.protocol === "https:") && loopback(held.hostname)) return url
  throw new Error(`FLINTD_URL must name a daemon on the loopback address, never ${held.protocol}//${held.host}.`)
}

function loopback(host: string): boolean {
  if (host === "localhost") return true
  // A hostname is not an address: "127.0.0.1.attacker.example" starts with 127. and belongs to somebody else.
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  const kind = isIP(address)
  if (kind === 4) return address.startsWith("127.")
  return kind === 6 && address === "::1"
}

// `port: 0` leaves the daemon to pick one, and the port file beside the token is where it writes what it picked.
async function chosen(home: string): Promise<number | undefined> {
  return whole(Number(await text(join(home, PORT_FILE))))
}

async function token(path: string): Promise<string> {
  const held = await text(path)
  if (held === "") throw new Error(`there is no token in ${path}, so start the daemon with \`flintd serve\` first`)
  return held
}

async function object(path: string): Promise<Record<string, unknown>> {
  const read = await readFile(path, "utf8").catch(() => "")
  if (read.trim() === "") return {}
  let held: unknown
  try {
    held = JSON.parse(read)
  } catch {
    return {}
  }
  return typeof held === "object" && held !== null && !Array.isArray(held) ? (held as Record<string, unknown>) : {}
}

async function text(path: string): Promise<string> {
  return (await readFile(path, "utf8").catch(() => "")).trim()
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65535 ? value : undefined
}
