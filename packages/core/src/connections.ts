import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { ToolError } from "./errors.ts"
import { CONNECTION_NAME, HOSTNAME } from "./manifest.ts"
import { forgetSecret, rememberSecret } from "./redact.ts"
import { isPlainObject } from "./validate.ts"
import type { Connection, ConnectionSummary, Connections } from "./types.ts"

const MAX_CONNECTIONS = 100
const MAX_HOSTS = 20
const MAX_VALUE_LENGTH = 4096
// A credential shorter than this cannot be redacted from a log line without cutting ordinary words out of it.
const SHORTEST_VALUE = 8
export const CONTROL = /[\u0000-\u001f\u007f]/
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/

export interface ConnectionStore extends Connections {
  all(): readonly Connection[]
  close(): void
}

export function flintdHome(): string {
  const override = process.env["FLINTD_HOME"]
  return override === undefined || override === "" ? join(homedir(), ".flintd") : resolve(override)
}

// The Connections live in the flintd home, never in a Library: a Library is a git repository and a credential is never committed.
export async function openConnections(file: string, configured: readonly Connection[]): Promise<ConnectionStore> {
  const fromConfig = configured.map((one) => assertConnection(one, "the flintd config file"))
  let held = merge(fromConfig, await load(file))
  for (const one of held) rememberSecret(one.header.value)

  async function rewrite(next: Connection[]): Promise<void> {
    const kept = next.filter((one) => !names(fromConfig).has(one.name))
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
    for (const one of held) forgetSecret(one.header.value)
    held = merge(fromConfig, kept)
    for (const one of held) rememberSecret(one.header.value)
  }

  return {
    all: () => held,

    list: async () => held.map((one) => ({ name: one.name, hosts: [...one.hosts] })),

    async add(value: unknown): Promise<ConnectionSummary> {
      const connection = assertConnection(value, "a Connection")
      if (names(fromConfig).has(connection.name)) {
        throw refuse(
          `The Connection ${JSON.stringify(connection.name)} comes from the flintd config file. Change it there, or give this one another name.`,
          connection.name,
        )
      }
      // The file on disk wins over what this process read at start, so two flintds never lose one another's writes.
      const stored = (await load(file)).filter((one) => one.name !== connection.name)
      if (stored.length >= MAX_CONNECTIONS) {
        throw refuse(`This flintd holds ${stored.length} Connections and the limit is ${MAX_CONNECTIONS}.`, connection.name)
      }
      await rewrite([...stored, connection])
      return { name: connection.name, hosts: [...connection.hosts] }
    },

    async remove(name: unknown): Promise<ConnectionSummary> {
      const wanted = assertConnectionName(name)
      if (names(fromConfig).has(wanted)) {
        throw refuse(
          `The Connection ${JSON.stringify(wanted)} comes from the flintd config file. Take it out of the file, then start flintd again.`,
          wanted,
        )
      }
      const stored = await load(file)
      const found = stored.find((one) => one.name === wanted)
      if (found === undefined) {
        throw new ToolError(
          "not_found",
          `This flintd holds no Connection named ${JSON.stringify(wanted)}. Run \`flintd connect --list\` to see the ones it holds.`,
          { name: wanted },
        )
      }
      await rewrite(stored.filter((one) => one !== found))
      return { name: found.name, hosts: [...found.hosts] }
    },

    close(): void {
      for (const one of held) forgetSecret(one.header.value)
      held = []
    },
  }
}

// The Connection a Tool may use for this host: one its Manifest names, whose hosts carry the target.
export function connectionFor(
  connections: readonly Connection[],
  declared: readonly string[],
  hostname: string,
): Connection | undefined {
  return connections.find((one) => declared.includes(one.name) && one.hosts.includes(hostname))
}

export function declaredConnections(connections: readonly Connection[], declared: readonly string[]): Connection[] {
  return connections.filter((one) => declared.includes(one.name))
}

export function missingConnections(connections: readonly Connection[], declared: readonly string[]): string[] {
  return declared.filter((name) => !connections.some((one) => one.name === name))
}

function merge(fromConfig: readonly Connection[], stored: readonly Connection[]): Connection[] {
  return [...fromConfig, ...stored.filter((one) => !names(fromConfig).has(one.name))]
}

function names(connections: readonly Connection[]): Set<string> {
  return new Set(connections.map((one) => one.name))
}

async function load(file: string): Promise<Connection[]> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return []
  await assertPrivate(file)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw refuse(`The file ${file} holds the Connections of this flintd, and it is not valid JSON.`, null)
  }
  if (!Array.isArray(raw)) throw refuse(`The file ${file} must hold a JSON list of Connections.`, null)
  const found: Connection[] = []
  for (const entry of raw) {
    const connection = assertConnection(entry, file)
    if (!found.some((one) => one.name === connection.name)) found.push(connection)
  }
  return found
}

async function assertPrivate(file: string): Promise<void> {
  const mode = (await stat(file)).mode & 0o777
  if ((mode & 0o077) === 0) return
  throw refuse(
    `The Connections file ${file} holds credentials and is readable by other users (mode ${mode.toString(8)}). Run \`chmod 600 ${file}\`.`,
    null,
  )
}

function assertConnection(value: unknown, where: string): Connection {
  if (!isPlainObject(value)) {
    throw refuse(`A Connection in ${where} is an object with a name, a list of hosts and one header.`, null)
  }
  const name = assertConnectionName(value["name"])
  const hosts = assertHosts(value["hosts"], name)
  const header = value["header"]
  if (!isPlainObject(header) || typeof header["name"] !== "string" || typeof header["value"] !== "string") {
    throw refuse(
      `The Connection ${JSON.stringify(name)} needs a header: { "name": "authorization", "value": "Bearer ..." }.`,
      name,
    )
  }
  if (!HEADER_NAME.test(header["name"])) {
    throw refuse(
      `The header name ${JSON.stringify(header["name"])} of the Connection ${JSON.stringify(name)} is not an HTTP header name, such as "authorization" or "x-api-key".`,
      name,
    )
  }
  const written = header["value"]
  if (written.length < SHORTEST_VALUE || written.length > MAX_VALUE_LENGTH) {
    throw refuse(
      `The header value of the Connection ${JSON.stringify(name)} is the credential itself, and it must be between ${SHORTEST_VALUE} and ${MAX_VALUE_LENGTH} characters.`,
      name,
    )
  }
  // A newline in a value would let one header become two on the wire.
  if (CONTROL.test(written)) {
    throw refuse(`The header value of the Connection ${JSON.stringify(name)} holds a control character.`, name)
  }
  return { name, hosts, header: { name: header["name"].toLowerCase(), value: written } }
}

function assertConnectionName(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_NAME.test(value)) {
    throw refuse(
      `A Connection name is lower-case letters, digits, underscores and hyphens, starting with a letter, and this one is ${JSON.stringify(String(value))}.`,
      null,
    )
  }
  return value
}

function assertHosts(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HOSTS) {
    throw refuse(
      `The Connection ${JSON.stringify(name)} needs between 1 and ${MAX_HOSTS} hosts: the exact hostnames its credential may be sent to.`,
      name,
    )
  }
  const hosts: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || !HOSTNAME.test(entry)) {
      throw refuse(
        `The host ${JSON.stringify(String(entry))} of the Connection ${JSON.stringify(name)} is not a hostname. Write the exact lower-case host, with no scheme, no port and no path.`,
        name,
      )
    }
    if (!hosts.includes(entry)) hosts.push(entry)
  }
  return hosts
}

function refuse(message: string, name: string | null): ToolError {
  return new ToolError("invalid_arguments", message, name === null ? {} : { name })
}
