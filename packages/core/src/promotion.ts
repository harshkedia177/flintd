import { callable, pushLibrary } from "./library.ts"
import type { OpenLibrary, Winner } from "./library.ts"
import type { Tool } from "./types.ts"

export const DEFAULT_ACTIVE_CAP = 50
export const DEFAULT_ACTIVE_LIST_LIMIT = 30
const CLEAN_CALLS = 5
const SPREAD = 2

export interface CapFull {
  cap: number
  lowest: string | null
}

export type Promotion = "promoted" | "blocked" | "unchanged"

// The cap counts the union with the project winner per name, so a shadowed Tool counts once and never twice.
export function actives(libraries: readonly OpenLibrary[]): Winner[] {
  return callable(libraries)
    .filter(({ tool }) => tool.state === "active")
    .sort((left, right) => right.tool.contribution - left.tool.contribution || left.tool.name.localeCompare(right.tool.name))
}

// Five clean calls, and evidence that more than one turn of one agent used the Tool: two sessions, two UTC calendar days, or two harnesses.
export function earned(library: OpenLibrary, name: string): boolean {
  const counted = library.store.earned(name)
  if (counted.successes < CLEAN_CALLS) return false
  return counted.sessions >= SPREAD || counted.days >= SPREAD || counted.harnesses >= SPREAD
}

export function capFull(libraries: readonly OpenLibrary[], cap: number): CapFull | undefined {
  const held = actives(libraries)
  if (held.length < cap) return undefined
  return { cap, lowest: held[held.length - 1]?.tool.name ?? null }
}

export function capMessage(name: string, full: CapFull): string {
  const lowest =
    full.lowest === null
      ? ""
      : ` The lowest-contribution Active Tool is ${JSON.stringify(full.lowest)}; retire it with tool_retire to make room.`
  return `The Tool ${JSON.stringify(name)} earned promotion, and the Active cap of ${full.cap} Tools is full, so it stays Verified.${lowest}`
}

// The transition alone: what earned it, the calls or one Approval, is the caller's to decide.
export async function promote(
  libraries: readonly OpenLibrary[],
  library: OpenLibrary,
  name: string,
  cap: number,
): Promise<Promotion> {
  const done = await library.queue.serialize<Promotion>(async () => {
    const indexed = library.store.get(name)
    if (indexed === undefined || indexed.state !== "verified") return "unchanged"
    // A person edited the directory; the file channel owns it until the next start() takes that edit.
    if (await library.store.changed(name)) return "unchanged"
    // Active rests on Verified, and Verified rests on the Held-out evidence of this Version, not of an older one.
    const evidence = await library.store.readHeldOut(name)
    if (evidence?.status !== "passed") return "unchanged"
    if (capFull(libraries, cap) !== undefined) return "blocked"
    const held = await library.store.readTool(name)
    const tool: Tool = {
      ...held,
      state: "active",
      provenance: {
        channel: "flintd",
        session: null,
        harness: null,
        model: null,
        excerpt: null,
        createdAt: new Date().toISOString(),
      },
    }
    const written = await library.store.write(
      {
        tool,
        examples: await library.store.readExamples(name),
        body: await library.store.readBody(name),
        stats: library.store.stats(name),
        heldOut: evidence,
      },
      "activate",
    )
    library.store.upsert(tool)
    library.store.setDigest(name, written.digest, written.version)
    return "promoted"
  })
  if (done === "promoted") void pushLibrary(library)
  return done
}
