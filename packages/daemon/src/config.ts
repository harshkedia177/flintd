import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { CONTAINER_ENGINES, ToolError, flintdHome } from "@flintd/core"
import type { ClientQuirk, ClientQuirks } from "./mcp.ts"
import type { Connection, ContainerEngineName, ModelConfig } from "@flintd/core"

export const DEFAULT_PORT = 3546
export const CONNECTIONS_FILE = "connections.json"
const TOKEN_FILE = "token"
const PORT_FILE = "port"
const PID_FILE = "pid"
export const CONFIG_FILE = "config.json"
const KEYS = [
  "port",
  "libraryDir",
  "projectLibraryDir",
  "libraryRemote",
  "projectLibraryRemote",
  "syncTimeoutMs",
  "modelTimeoutMs",
  "heldOutTimeoutMs",
  "stopGraceMs",
  "activeCap",
  "activeListLimit",
  "heldOutConcurrency",
  "findLimit",
  "duplicateThreshold",
  "duplicateBand",
  "duplicateCosine",
  "duplicateCosineBand",
  "duplicateMaxJudgments",
  "siblingThreshold",
  "siblingCosine",
  "searchCosine",
  "observerRepeats",
  "observerWindowDays",
  "observerIdleMinutes",
  "observerTimeoutMs",
  "observerMaxCandidates",
  "retireContribution",
  "retireMinCalls",
  "retireIdleDays",
  "maxFetchBytes",
  "fetchTimeoutMs",
  "callTimeoutMs",
  "maxArgsBytes",
  "maxResultBytes",
  "maxBodyBytes",
  "maxCallDepth",
  "maxLogLines",
  "maxLogBytes",
  "maxExecBytes",
  "memoryLimitBytes",
  "terminateAfterMs",
  "containerImage",
  "containerEngine",
  "containerTimeoutMs",
  "warmNodeRunners",
  "mcpClientQuirks",
  "skillExports",
  "harnesses",
  "connections",
  "model",
]
const MODEL_KEYS = ["provider", "apiKey", "model", "baseUrl", "embedModel"]
const PROJECT_DIRECTORY = ".flintd"

// What `flintd init` wrote for one harness. One key today: whether the hook may carry the transcript path of a session.
export interface HarnessSettings {
  transcripts: boolean
}

export interface DaemonConfig {
  home: string
  port: number
  libraryDir: string
  projectLibraryDir: string | null
  libraryRemote: string | null
  projectLibraryRemote: string | null
  syncTimeoutMs: number | null
  modelTimeoutMs: number | null
  heldOutTimeoutMs: number | null
  stopGraceMs: number | null
  activeCap: number | null
  activeListLimit: number | null
  heldOutConcurrency: number | null
  findLimit: number | null
  duplicateThreshold: number | null
  duplicateBand: number | null
  duplicateCosine: number | null
  duplicateCosineBand: number | null
  duplicateMaxJudgments: number | null
  siblingThreshold: number | null
  siblingCosine: number | null
  searchCosine: number | null
  observerRepeats: number | null
  observerWindowDays: number | null
  observerIdleMinutes: number | null
  observerTimeoutMs: number | null
  observerMaxCandidates: number | null
  retireContribution: number | null
  retireMinCalls: number | null
  retireIdleDays: number | null
  maxFetchBytes: number | null
  fetchTimeoutMs: number | null
  callTimeoutMs: number | null
  maxArgsBytes: number | null
  maxResultBytes: number | null
  maxBodyBytes: number | null
  maxCallDepth: number | null
  maxLogLines: number | null
  maxLogBytes: number | null
  maxExecBytes: number | null
  memoryLimitBytes: number | null
  terminateAfterMs: number | null
  containerImage: string | null
  containerEngine: ContainerEngineName | null
  containerTimeoutMs: number | null
  warmNodeRunners: number | null
  mcpClientQuirks: ClientQuirks | null
  skillExports: string[]
  harnesses: Record<string, HarnessSettings>
  connections: Connection[]
  model: ModelConfig | null
}

function flag(value: unknown, key: string, file: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== "boolean") throw configError(`The key ${key} in ${file} is true or false.`, { key })
  return value
}

export { flintdHome }

export async function readConfig(home = flintdHome()): Promise<DaemonConfig> {
  const file = join(home, CONFIG_FILE)
  const text = await readFile(file, "utf8").catch(() => "{}")
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch (cause) {
    throw configError(`The file ${file} is not valid JSON.`, {
      reason: cause instanceof Error ? cause.message : String(cause),
    })
  }
  const unknown = Object.keys(raw).filter((key) => !KEYS.includes(key))
  if (unknown.length > 0) {
    throw configError(`The file ${file} holds keys this build of flintd does not read: ${unknown.join(", ")}.`, {
      keys: unknown,
    })
  }
  const user = libraryDir(raw["libraryDir"], home, file)
  const project = await projectLibraryDir(raw["projectLibraryDir"], file)
  const model = modelSetting(raw["model"], file)
  const connections = connectionList(raw["connections"], file)
  // The config file holds the model key and every Connection value once they are set, so it earns the same mode check the token file has.
  if (model?.apiKey !== undefined || connections.length > 0) await assertPrivate(file, "config file")
  return {
    home,
    port: port(raw["port"], file),
    libraryDir: user,
    // One directory holds one Tenant, so a project Library that lands on the user Library is no second Library at all.
    projectLibraryDir: project === user ? null : project,
    libraryRemote: remote(raw["libraryRemote"], "libraryRemote", file),
    projectLibraryRemote: remote(raw["projectLibraryRemote"], "projectLibraryRemote", file),
    syncTimeoutMs: whole(raw["syncTimeoutMs"], "syncTimeoutMs", "a whole number of milliseconds for a pull or a push", file),
    modelTimeoutMs: whole(raw["modelTimeoutMs"], "modelTimeoutMs", "how long one model call may take, in milliseconds", file),
    heldOutTimeoutMs: whole(
      raw["heldOutTimeoutMs"],
      "heldOutTimeoutMs",
      "how long one Held-out run may take, in milliseconds",
      file,
    ),
    stopGraceMs: whole(
      raw["stopGraceMs"],
      "stopGraceMs",
      "how long stop() waits for a Held-out run and an embedding pass, in milliseconds",
      file,
    ),
    activeCap: whole(raw["activeCap"], "activeCap", "the largest number of Active Tools this Tenant may hold", file),
    activeListLimit: whole(
      raw["activeListLimit"],
      "activeListLimit",
      "how many Active Tools the default tool list carries",
      file,
    ),
    heldOutConcurrency: whole(
      raw["heldOutConcurrency"],
      "heldOutConcurrency",
      "how many Held-out runs may work at one time",
      file,
    ),
    findLimit: whole(raw["findLimit"], "findLimit", "how many Tools tool_find returns at most", file),
    duplicateThreshold: fraction(
      raw["duplicateThreshold"],
      "duplicateThreshold",
      "how alike a new Tool may be to an existing one before the save is refused",
      file,
    ),
    duplicateBand: fraction(
      raw["duplicateBand"],
      "duplicateBand",
      "how alike a new Tool must be to an existing one before flintd asks the model whether they are one capability",
      file,
    ),
    duplicateCosine: fraction(
      raw["duplicateCosine"],
      "duplicateCosine",
      "how alike the embeddings of a new Tool and an existing one may be before the save is refused",
      file,
    ),
    duplicateCosineBand: fraction(
      raw["duplicateCosineBand"],
      "duplicateCosineBand",
      "how alike the embeddings must be before flintd asks the model whether the two are one capability",
      file,
    ),
    duplicateMaxJudgments: whole(
      raw["duplicateMaxJudgments"],
      "duplicateMaxJudgments",
      "how many times one create may ask the model whether two Tools are one capability",
      file,
    ),
    siblingThreshold: fraction(
      raw["siblingThreshold"],
      "siblingThreshold",
      "how alike two Tools must be for a search to return one of them with the other as a sibling",
      file,
    ),
    siblingCosine: fraction(
      raw["siblingCosine"],
      "siblingCosine",
      "how alike the embeddings of two Tools must be for one to be a sibling of the other",
      file,
    ),
    searchCosine: fraction(
      raw["searchCosine"],
      "searchCosine",
      "how close an embedding must be to the query before a vector search counts it a result",
      file,
    ),
    observerRepeats: whole(
      raw["observerRepeats"],
      "observerRepeats",
      "how many sessions must repeat a pattern before the Observer proposes a Tool for it",
      file,
    ),
    observerWindowDays: whole(
      raw["observerWindowDays"],
      "observerWindowDays",
      "how many days back the Observer reads the call log and the Observations",
      file,
    ),
    observerIdleMinutes: whole(
      raw["observerIdleMinutes"],
      "observerIdleMinutes",
      "how many minutes without a call make the daemon idle enough to observe",
      file,
    ),
    observerTimeoutMs: whole(
      raw["observerTimeoutMs"],
      "observerTimeoutMs",
      "how long one whole observer run may take, in milliseconds",
      file,
    ),
    observerMaxCandidates: whole(
      raw["observerMaxCandidates"],
      "observerMaxCandidates",
      "how many candidates one observer run may send to the model",
      file,
    ),
    retireContribution: contribution(raw["retireContribution"], file),
    retireMinCalls: whole(
      raw["retireMinCalls"],
      "retireMinCalls",
      "how many calls a Tool must have before its Contribution earns a retirement proposal",
      file,
    ),
    retireIdleDays: whole(
      raw["retireIdleDays"],
      "retireIdleDays",
      "how many days without a call earn a retirement proposal",
      file,
    ),
    maxFetchBytes: whole(raw["maxFetchBytes"], "maxFetchBytes", "the largest answer a ctx.fetch may carry, in bytes", file),
    fetchTimeoutMs: whole(raw["fetchTimeoutMs"], "fetchTimeoutMs", "how long one ctx.fetch may take, in milliseconds", file),
    callTimeoutMs: whole(raw["callTimeoutMs"], "callTimeoutMs", "how long one call to a Tool may take, in milliseconds", file),
    maxArgsBytes: whole(raw["maxArgsBytes"], "maxArgsBytes", "the largest arguments a call may carry, in bytes", file),
    maxResultBytes: whole(raw["maxResultBytes"], "maxResultBytes", "the largest result a Tool may return, in bytes", file),
    maxBodyBytes: whole(raw["maxBodyBytes"], "maxBodyBytes", "the largest Body a Tool may be saved with, in bytes", file),
    maxCallDepth: whole(raw["maxCallDepth"], "maxCallDepth", "how many Tools one chain may hold, counting the one the caller ran", file),
    maxLogLines: whole(raw["maxLogLines"], "maxLogLines", "how many ctx.log lines one call may write", file),
    maxLogBytes: whole(raw["maxLogBytes"], "maxLogBytes", "the largest ctx.log line, in bytes", file),
    maxExecBytes: whole(raw["maxExecBytes"], "maxExecBytes", "the largest stdout or stderr one ctx.exec may carry, in bytes", file),
    memoryLimitBytes: whole(raw["memoryLimitBytes"], "memoryLimitBytes", "the heap one Body may use, in bytes", file),
    terminateAfterMs: whole(
      raw["terminateAfterMs"],
      "terminateAfterMs",
      "how long the main thread waits for a tier to stop a Body of its own, in milliseconds",
      file,
    ),
    containerImage: line(raw["containerImage"], "containerImage", "the image the container tier runs a Body in", file),
    containerEngine: containerEngine(raw["containerEngine"], file),
    containerTimeoutMs: whole(
      raw["containerTimeoutMs"],
      "containerTimeoutMs",
      "how long one call in the container tier may take, in milliseconds",
      file,
    ),
    warmNodeRunners: whole(
      raw["warmNodeRunners"],
      "warmNodeRunners",
      "how many Node tier children the pool holds warm when it has nothing left to run, and 0 for a fresh child per call",
      file,
      0,
    ),
    mcpClientQuirks: clientQuirks(raw["mcpClientQuirks"], file),
    skillExports: skillExports(raw["skillExports"], file),
    harnesses: harnesses(raw["harnesses"], file),
    connections,
    model,
  }
}

// The built-in quirk table is written over, so an operator can add a client or take a quirk off one that fixed it.
function clientQuirks(value: unknown, file: string): ClientQuirks | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) {
    throw configError(`The key mcpClientQuirks in ${file} is an object keyed by the MCP client's own name.`, {
      key: "mcpClientQuirks",
    })
  }
  const quirks: Record<string, ClientQuirk> = {}
  for (const [client, quirk] of Object.entries(value as Record<string, unknown>)) {
    if (typeof quirk !== "object" || quirk === null || Array.isArray(quirk)) {
      throw configError(`The client ${JSON.stringify(client)} in mcpClientQuirks of ${file} needs an object of quirks.`, {
        key: "mcpClientQuirks",
        client,
      })
    }
    const unknown = Object.keys(quirk).filter((key) => key !== "omitOutputSchema")
    if (unknown.length > 0) {
      throw configError(`The client ${JSON.stringify(client)} in mcpClientQuirks of ${file} holds quirks this build does not read: ${unknown.join(", ")}.`, {
        key: "mcpClientQuirks",
        client,
        quirks: unknown,
      })
    }
    quirks[client.toLowerCase()] = {
      omitOutputSchema: flag((quirk as { omitOutputSchema?: unknown }).omitOutputSchema, "omitOutputSchema", file),
    }
  }
  return quirks
}

// A skills directory is written by hand, and every harness documents its own with a leading ~.
function home(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
}

// A relative path in the config is read from the directory the daemon was started in, as projectLibraryDir is.
function skillExports(value: unknown, file: string): string[] {
  if (value === undefined) return []
  const given = Array.isArray(value) ? value : undefined
  if (given === undefined || given.some((one) => typeof one !== "string" || one.trim() === "")) {
    throw configError(`The "skillExports" in ${file} is a list of directories flintd writes its SKILL.md files into.`, {
      received: typeof value,
    })
  }
  return given.map((one) => resolve(process.cwd(), home((one as string).trim())))
}

// `flintd init` writes this key and the operator reads it; a harness this build does not know is left as it is.
function harnesses(value: unknown, file: string): Record<string, HarnessSettings> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) {
    throw configError(`The key harnesses in ${file} is an object keyed by the harness name.`, { key: "harnesses" })
  }
  const held: Record<string, HarnessSettings> = {}
  for (const [name, settings] of Object.entries(value as Record<string, unknown>)) {
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      throw configError(`The harness ${JSON.stringify(name)} in ${file} needs an object of settings.`, { key: "harnesses", harness: name })
    }
    const unknown = Object.keys(settings).filter((key) => key !== "transcripts")
    if (unknown.length > 0) {
      throw configError(`The harness ${JSON.stringify(name)} in ${file} holds keys this build of flintd does not read: ${unknown.join(", ")}.`, { key: "harnesses", harness: name, keys: unknown })
    }
    held[name] = { transcripts: flag((settings as { transcripts?: unknown }).transcripts, "transcripts", file) }
  }
  return held
}

export async function ensureToken(home: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const path = join(home, TOKEN_FILE)
  const existing = (await readFile(path, "utf8").catch(() => "")).trim()
  if (existing !== "") {
    await assertPrivate(path, "token file")
    return existing
  }
  const token = randomBytes(32).toString("base64url")
  // Another flintd may have written the file between the read and this line, so its token wins.
  await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" }).catch(() => undefined)
  return readToken(home)
}

// `port: 0` is a port only the running daemon knows, so it writes it beside the token for the hook and the extension.
// The pid goes beside it: `flintd stop` has nothing else to aim at, and a person who started a daemon has to be
// able to end it without hunting for a process.
export async function publishPort(home: string, port: number): Promise<void> {
  await writeFile(join(home, PORT_FILE), `${port}\n`)
  await writeFile(join(home, PID_FILE), `${process.pid}\n`)
}

export async function clearPort(home: string): Promise<void> {
  await rm(join(home, PORT_FILE), { force: true })
  await rm(join(home, PID_FILE), { force: true })
}

// The pid a running daemon published, and undefined when the file names a process that is gone: a daemon that was
// killed leaves its files behind, and a stale pid must never be a pid this stops.
export async function livePid(home: string): Promise<number | undefined> {
  const held = Number((await readFile(join(home, PID_FILE), "utf8").catch(() => "")).trim())
  if (!Number.isSafeInteger(held) || held <= 0) return undefined
  try {
    process.kill(held, 0)
    return held
  } catch {
    return undefined
  }
}

export async function livePort(home: string): Promise<number | undefined> {
  const held = Number((await readFile(join(home, PORT_FILE), "utf8").catch(() => "")).trim())
  return Number.isSafeInteger(held) && held > 0 && held <= 65535 ? held : undefined
}

export async function readToken(home: string): Promise<string> {
  const path = join(home, TOKEN_FILE)
  const token = (await readFile(path, "utf8").catch(() => "")).trim()
  if (token !== "") await assertPrivate(path, "token file")
  if (token === "") {
    throw configError(`There is no token in ${join(home, TOKEN_FILE)}. Start the daemon with \`flintd serve\` first.`, {
      home,
    })
  }
  return token
}

async function assertPrivate(path: string, what: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) === 0) return
  throw configError(
    `The ${what} ${path} is readable by other users (mode ${mode.toString(8)}). Run \`chmod 600 ${path}\`.`,
    { mode: mode.toString(8) },
  )
}

function port(value: unknown, file: string): number {
  if (value === undefined) return DEFAULT_PORT
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 65535) {
    throw configError(`The "port" in ${file} must be a whole number from 0 to 65535.`, { received: String(value) })
  }
  return value
}

async function projectLibraryDir(value: unknown, file: string): Promise<string | null> {
  const cwd = process.cwd()
  if (value === undefined) {
    const marker = join(cwd, PROJECT_DIRECTORY)
    return (await access(marker).then(
      () => true,
      () => false,
    ))
      ? join(marker, "library")
      : null
  }
  if (typeof value !== "string" || value === "") {
    throw configError(`The "projectLibraryDir" in ${file} must be the path of the project Library directory.`, {
      received: typeof value,
    })
  }
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function whole(value: unknown, key: string, what: string, file: string, least = 1): number | null {
  if (value === undefined) return null
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < least) {
    throw configError(`The ${JSON.stringify(key)} in ${file} must be ${what}.`, { received: String(value) })
  }
  return value
}

function line(value: unknown, key: string, what: string, file: string): string | null {
  if (value === undefined) return null
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`The ${JSON.stringify(key)} in ${file} must be ${what}, as one line of text.`, {
      received: String(value),
    })
  }
  return value.trim()
}

// The Library refuses an engine name it does not know; this reads the file and names the ones there are.
function containerEngine(value: unknown, file: string): ContainerEngineName | null {
  if (value === undefined) return null
  if (typeof value !== "string" || !(CONTAINER_ENGINES as readonly string[]).includes(value)) {
    throw configError(`The "containerEngine" in ${file} is one of ${CONTAINER_ENGINES.join(", ")}.`, {
      received: String(value),
    })
  }
  return value as ContainerEngineName
}

function fraction(value: unknown, key: string, what: string, file: string): number | null {
  if (value === undefined) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw configError(`The ${JSON.stringify(key)} in ${file} is ${what}: a similarity above 0 and at most 1.`, {
      received: String(value),
    })
  }
  return value
}

// A Contribution runs from -1 to 1, and the threshold that earns a retirement proposal is a negative one.
function contribution(value: unknown, file: string): number | null {
  if (value === undefined) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) {
    throw configError(`The "retireContribution" in ${file} is a Contribution between -1 and 1.`, {
      received: String(value),
    })
  }
  return value
}

// The shape of a Connection is the Library's to refuse, so this reads the file and never the meaning.
function connectionList(value: unknown, file: string): Connection[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw configError(`The "connections" in ${file} must be a list of Connections.`, { received: typeof value })
  }
  return value as Connection[]
}

// The provider and the shape of the key are createFlint's to refuse, so this reads the file and never the meaning.
function modelSetting(value: unknown, file: string): ModelConfig | null {
  if (value === undefined) return null
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configError(`The "model" in ${file} must be an object with a provider and an apiKey.`, {
      received: typeof value,
    })
  }
  const raw = value as Record<string, unknown>
  const unknown = Object.keys(raw).filter((key) => !MODEL_KEYS.includes(key))
  if (unknown.length > 0) {
    throw configError(`The "model" in ${file} holds keys this build of flintd does not read: ${unknown.join(", ")}.`, {
      keys: unknown,
    })
  }
  for (const key of MODEL_KEYS) {
    const held = raw[key]
    if (held !== undefined && (typeof held !== "string" || held === "")) {
      throw configError(`The "model.${key}" in ${file} must be a non-empty string.`, { key })
    }
  }
  return raw as unknown as ModelConfig
}

function remote(value: unknown, key: string, file: string): string | null {
  if (value === undefined) return null
  if (typeof value !== "string" || value === "") {
    throw configError(`The ${JSON.stringify(key)} in ${file} must be the git remote of that Library.`, {
      received: typeof value,
    })
  }
  return value
}

function libraryDir(value: unknown, home: string, file: string): string {
  if (value === undefined) return join(home, "library")
  if (typeof value !== "string" || value === "") {
    throw configError(`The "libraryDir" in ${file} must be the path of the Library directory.`, {
      received: typeof value,
    })
  }
  return isAbsolute(value) ? value : resolve(home, value)
}

function configError(message: string, details: Record<string, string | string[]>): ToolError {
  return new ToolError("invalid_arguments", message, details)
}
