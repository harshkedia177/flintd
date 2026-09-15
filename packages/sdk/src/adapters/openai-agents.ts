import { libraryName } from "@flintd/core"
import type { CallMeta, Flint, ProviderSchema } from "@flintd/core"

// The framework's own `tool()`, taken as an argument: flintd type-checks against it and imports nothing at runtime.
export type AgentsTool<T> = (options: {
  name: string
  description: string
  parameters: ProviderSchema
  strict: boolean
  execute: (args: unknown) => Promise<unknown>
  isEnabled: (run: unknown) => Promise<boolean>
}) => T

// The SDK resolves isEnabled for every tool of a turn within microseconds, and a run is many turns. This is long
// enough that one turn costs one list read, and short enough that the next turn reads the Library again.
const ROUND_MS = 250

/** The Library as OpenAI Agents function tools, each turn asking the Library once whether they are still exported. */
export async function openaiAgentsTools<T>(flint: Flint, tool: AgentsTool<T>, meta?: CallMeta): Promise<T[]> {
  const reads = new WeakMap<object, { read: Promise<Set<string>>; at: number }>()

  async function exported(): Promise<Set<string>> {
    return new Set((await flint.tools("openai")).map((one) => one.name))
  }

  function listed(run: unknown): Promise<Set<string>> {
    if (typeof run !== "object" || run === null) return exported()
    const held = reads.get(run)
    const now = Date.now()
    if (held !== undefined && now - held.at < ROUND_MS) return held.read
    const read = exported()
    reads.set(run, { read, at: now })
    // A read that failed belongs to the turn that made it: the next turn asks again rather than inheriting it.
    void read.catch(() => {
      if (reads.get(run)?.read === read) reads.delete(run)
    })
    return read
  }

  return (await flint.tools("openai")).map((one) =>
    tool({
      name: one.name,
      description: one.description,
      parameters: one.parameters,
      strict: one.strict,
      execute: (args) => flint.call(libraryName(one.name), args, meta),
      isEnabled: async (run) => (await listed(run)).has(one.name),
    }),
  )
}
