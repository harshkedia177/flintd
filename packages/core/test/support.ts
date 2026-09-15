import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before } from "node:test"
import { createFlint, ToolError } from "../src/index.ts"
import type { Flint, FlintOptions, JsonValue } from "../src/index.ts"

// No test reads or writes the operator's own flintd home: every Connection a test makes lives in a temporary one.
process.env["FLINTD_HOME"] = join(tmpdir(), `flintd-home-${randomUUID()}`)

export interface Pair {
  user: string
  project: string
}

export type LibraryOptions = Omit<FlintOptions, "dir" | "userDir" | "projectDir">

export async function temporaryLibrary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "flintd-"))
}

export async function withFlint(
  run: (flint: Flint, dir: string) => Promise<void>,
  options: Omit<FlintOptions, "dir"> = {},
): Promise<void> {
  const dir = await temporaryLibrary()
  const flint = createFlint({ dir, ...options })
  await flint.start()
  try {
    await run(flint, dir)
  } finally {
    await flint.stop()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

// A Flint over a Library that already exists, so one test can write with one set of limits and read with another.
export async function withOpenFlint(options: FlintOptions, run: (flint: Flint) => Promise<void>): Promise<void> {
  const flint = createFlint(options)
  await flint.start()
  try {
    await run(flint)
  } finally {
    await flint.stop()
  }
}

export async function withLibraries(
  run: (flint: Flint, dirs: Pair) => Promise<void>,
  options: LibraryOptions = {},
): Promise<void> {
  const dirs: Pair = { user: await temporaryLibrary(), project: await temporaryLibrary() }
  const flint = createFlint({ userDir: dirs.user, projectDir: dirs.project, ...options })
  await flint.start()
  try {
    await run(flint, dirs)
  } finally {
    await flint.stop()
    await rm(dirs.user, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await rm(dirs.project, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

// Opening a Library costs a `git init`, so the tests that save nothing share one for the whole file.
export function sharedLibrary(
  prepare: (flint: Flint) => Promise<void> = async () => undefined,
  options: LibraryOptions = {},
): (run: (flint: Flint, dir: string) => Promise<void>) => Promise<void> {
  let open: { flint: Flint; dir: string } | undefined
  before(async () => {
    const dir = await temporaryLibrary()
    const flint = createFlint({ dir, ...options })
    await flint.start()
    await prepare(flint)
    open = { flint, dir }
  })
  after(async () => {
    if (open === undefined) return
    await open.flint.stop()
    await rm(open.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return async (run) => {
    if (open === undefined) throw new Error("the shared Library is not open")
    await run(open.flint, open.dir)
  }
}

export function sharedLibraries(
  prepare: (flint: Flint) => Promise<void>,
): (run: (flint: Flint, dirs: Pair) => Promise<void>) => Promise<void> {
  let open: { flint: Flint; dirs: Pair } | undefined
  before(async () => {
    const dirs: Pair = { user: await temporaryLibrary(), project: await temporaryLibrary() }
    const flint = createFlint({ userDir: dirs.user, projectDir: dirs.project })
    await flint.start()
    await prepare(flint)
    open = { flint, dirs }
  })
  after(async () => {
    if (open === undefined) return
    await open.flint.stop()
    await rm(open.dirs.user, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await rm(open.dirs.project, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return async (run) => {
    if (open === undefined) throw new Error("the shared Libraries are not open")
    await run(open.flint, open.dirs)
  }
}

// The bound is the "this never happened" guard, not the assertion. A test that waits on more than one Held-out run
// gives its own, because a loaded lane can leave a run waiting for a core far longer than the run itself takes.
export async function waitFor(ready: () => boolean | Promise<boolean>, what: string, withinMs = 5000): Promise<void> {
  const deadline = Date.now() + withinMs
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(what)
    await new Promise((wake) => setTimeout(wake, 5))
  }
}

export async function verified(flint: Flint, ...names: string[]): Promise<void> {
  await verifiedWithin(flint, 5000, ...names)
}

export async function verifiedWithin(flint: Flint, withinMs: number, ...names: string[]): Promise<void> {
  const states = async (): Promise<(string | undefined)[]> => {
    const held = await flint.library()
    return names.map((name) => held.find((one) => one.name === name)?.state)
  }
  await waitFor(
    async () => (await states()).every((one) => one === "verified"),
    `the Held-out runs never verified ${names.join(", ")}`,
    withinMs,
  )
}

export async function refusal(action: () => Promise<unknown>): Promise<ToolError> {
  try {
    await action()
  } catch (cause) {
    if (cause instanceof ToolError) return cause
    throw cause
  }
  throw new Error("the call returned a result where a ToolError was expected")
}

export function creation(overrides: { [key: string]: JsonValue } = {}): { [key: string]: JsonValue } {
  return {
    name: "word_count",
    description: "Count the words in a piece of text.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }),
    execute_source: "const words = args.text.trim().split(/\\s+/).filter(Boolean)\nreturn { count: words.length }",
    examples: [{ args: { text: "one two three" }, expected: { count: 3 } }],
    ...overrides,
  }
}

// A Body that fails on one argument, so a Tool can earn clean calls and still carry a failure.
export const BRITTLE_SOURCE = [
  "if (args.text === 'boom') throw new Error('the Body refused that text')",
  "return { count: args.text.trim().split(/\\s+/).filter(Boolean).length }",
].join("\n")

export const SHA256_SOURCE = `const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits))
const bytes = []
for (let position = 0; position < args.text.length; position += 1) {
  const unit = args.text.charCodeAt(position)
  if (unit < 0x80) bytes.push(unit)
  else if (unit < 0x800) bytes.push(0xc0 | (unit >> 6), 0x80 | (unit & 63))
  else if (unit >= 0xd800 && unit <= 0xdbff) {
    position += 1
    const point = 0x10000 + ((unit - 0xd800) << 10) + (args.text.charCodeAt(position) - 0xdc00)
    bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63))
  } else bytes.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 63), 0x80 | (unit & 63))
}
const bits = bytes.length * 8
bytes.push(0x80)
while (bytes.length % 64 !== 56) bytes.push(0)
for (let shift = 7; shift >= 0; shift -= 1) bytes.push(Math.floor(bits / Math.pow(2, shift * 8)) & 0xff)
const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const w = new Array(64)
for (let block = 0; block < bytes.length; block += 64) {
  for (let index = 0; index < 16; index += 1) {
    const at = block + index * 4
    w[index] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]
  }
  for (let index = 16; index < 64; index += 1) {
    const low = w[index - 15]
    const high = w[index - 2]
    const s0 = rotate(low, 7) ^ rotate(low, 18) ^ (low >>> 3)
    const s1 = rotate(high, 17) ^ rotate(high, 19) ^ (high >>> 10)
    w[index] = (w[index - 16] + s0 + w[index - 7] + s1) | 0
  }
  let [a, b, c, d, e, f, g, seventh] = h
  for (let index = 0; index < 64; index += 1) {
    const S1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
    const choice = (e & f) ^ (~e & g)
    const t1 = (seventh + S1 + choice + K[index] + w[index]) | 0
    const S0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
    const majority = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (S0 + majority) | 0
    seventh = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  const round = [a, b, c, d, e, f, g, seventh]
  for (let index = 0; index < 8; index += 1) h[index] = (h[index] + round[index]) | 0
}
return h.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("")`

export function sha256Creation(): { [key: string]: JsonValue } {
  return {
    name: "sha256_hex",
    description: "Return the SHA-256 digest of a piece of text as lower-case hexadecimal.",
    parameters_json: JSON.stringify({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }),
    execute_source: SHA256_SOURCE,
    examples: [
      { args: { text: "abc" }, expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
      { args: { text: "" }, expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    ],
  }
}
