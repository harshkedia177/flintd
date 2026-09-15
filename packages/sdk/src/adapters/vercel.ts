import { libraryName } from "@flintd/core"
import type { CallMeta, Flint, JsonValue, ProviderSchema } from "@flintd/core"

// `dynamicTool` and `jsonSchema` come from the caller's own `ai` package: flintd imports no framework at runtime.
export interface VercelParts<T, S> {
  dynamicTool(options: { description: string; inputSchema: S; execute: (args: unknown) => Promise<JsonValue> }): T
  jsonSchema(schema: ProviderSchema): S
}

export interface VercelStep<T> {
  tools: Record<string, T>
  prepareStep(): Promise<{ activeTools: string[] }>
}

/** A tools map and a `prepareStep` for generateText: pass both, and each step reads the Library again. */
export function vercelTools<T, S>(flint: Flint, parts: VercelParts<T, S>, meta?: CallMeta): VercelStep<T> {
  // generateText reads this one object on every step, so filling it here makes a new Tool callable in the next step.
  const tools: Record<string, T> = {}

  return {
    tools,
    async prepareStep(): Promise<{ activeTools: string[] }> {
      const listed = await flint.tools("vercel")
      for (const name of Object.keys(tools)) if (!(name in listed)) delete tools[name]
      for (const [name, one] of Object.entries(listed)) {
        tools[name] = parts.dynamicTool({
          description: one.description,
          inputSchema: parts.jsonSchema(one.inputSchema),
          execute: (args) => flint.call(libraryName(name), args, meta),
        })
      }
      return { activeTools: Object.keys(listed) }
    },
  }
}

/**
 * The Library as an AI SDK tool set with no `execute`: the model asks, `callFrom(flint, "vercel", call)` answers.
 * `tools("vercel")` alone carries a JSON Schema, and the AI SDK needs it inside `jsonSchema()`, which this does.
 */
export async function vercelToolSet<S>(
  flint: Flint,
  jsonSchema: (schema: ProviderSchema) => S,
): Promise<Record<string, { description: string; inputSchema: S }>> {
  return Object.fromEntries(
    Object.entries(await flint.tools("vercel")).map(([name, one]) => [
      name,
      { description: one.description, inputSchema: jsonSchema(one.inputSchema) },
    ]),
  )
}
