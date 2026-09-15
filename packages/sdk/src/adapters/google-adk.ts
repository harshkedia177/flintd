import { libraryName } from "@flintd/core"
import type { CallMeta, Flint, GeminiSchema, JsonValue } from "@flintd/core"

// A genai `Schema`, written without importing genai: `Y` is that package's own `Type` enum, which the caller passes.
export interface AdkSchema<Y extends Record<string, string>> {
  type?: Y[keyof Y]
  description?: string
  title?: string
  properties?: Record<string, AdkSchema<Y>>
  required?: string[]
  items?: AdkSchema<Y>
  enum?: string[]
  minimum?: number
  maximum?: number
  // A genai Schema spells a count the way proto JSON spells an int64, and the Gemini subset already wrote it as one.
  minItems?: string
  maxItems?: string
  minLength?: string
  maxLength?: string
  default?: unknown
}

// ADK's own classes and genai's `Type`, taken as arguments: flintd type-checks against them and imports neither.
export interface AdkParts<S extends abstract new (...args: never[]) => object, T, Y extends Record<string, string>> {
  BaseToolset: S
  FunctionTool: new (options: {
    name: string
    description: string
    parameters: AdkSchema<Y>
    execute: (args: unknown) => Promise<JsonValue>
  }) => T
  Type: Y
}

/** The Library as one ADK toolset: an agent resolves `getTools` per invocation, so the list is never stale. */
export function googleAdkToolset<
  S extends abstract new (...args: never[]) => object,
  T,
  Y extends Record<string, string>,
>(flint: Flint, adk: AdkParts<S, T, Y>, meta?: CallMeta): InstanceType<S> {
  class FlintToolset extends (adk.BaseToolset as unknown as new (...args: unknown[]) => object) {
    async getTools(): Promise<T[]> {
      return (await flint.tools("gemini")).map(
        (one) =>
          new adk.FunctionTool({
            name: one.name,
            description: one.description,
            parameters: schema(one.parameters, adk.Type),
            execute: (args) => flint.call(libraryName(one.name), args, meta),
          }),
      )
    }

    async close(): Promise<void> {
      // The Library belongs to whoever opened it, so a toolset over it closes nothing.
    }
  }

  return new FlintToolset([]) as InstanceType<S>
}

// The Gemini subset, with the type spelled the way the genai SDK's enum spells it: "object" is Type.OBJECT.
function schema<Y extends Record<string, string>>(source: GeminiSchema, types: Y): AdkSchema<Y> {
  const kept: Record<string, unknown> = { ...source }
  if (source.type !== undefined) kept["type"] = types[source.type.toUpperCase()]
  if (source.properties !== undefined) {
    kept["properties"] = Object.fromEntries(
      Object.entries(source.properties).map(([name, one]) => [name, schema(one, types)]),
    )
  }
  if (source.items !== undefined) kept["items"] = schema(source.items, types)
  return kept as AdkSchema<Y>
}
