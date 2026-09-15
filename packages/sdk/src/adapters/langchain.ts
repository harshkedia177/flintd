import { libraryName } from "@flintd/core"
import type { CallMeta, Flint, JsonSchema, JsonValue } from "@flintd/core"

// LangChain's own `tool()`, taken as an argument: flintd type-checks against it and imports nothing at runtime.
export type LangchainTool<T> = (
  run: (args: unknown) => Promise<JsonValue>,
  options: { name: string; description: string; schema: JsonSchema },
) => T

/** A `wrapModelCall` middleware body: every model call carries the Library as it stands at that moment. */
export function langchainModelCall<T extends object, R extends { tools?: unknown[] }, A>(
  flint: Flint,
  tool: LangchainTool<T>,
  meta?: CallMeta,
): (request: R, handler: (request: R) => Promise<A>) => Promise<A> {
  // The request carries what the last call left in it, so this call takes its own tools out before it puts them back.
  const mine = new WeakSet<object>()

  return async (request, handler) => {
    const kept = (request.tools ?? []).filter((one) => !(typeof one === "object" && one !== null && mine.has(one)))
    const flintd = (await flint.tools("openai")).map((one) => {
      const made = tool((args) => flint.call(libraryName(one.name), args, meta), {
        name: one.name,
        description: one.description,
        schema: one.parameters,
      })
      mine.add(made)
      return made
    })
    return handler({ ...request, tools: [...kept, ...flintd] })
  }
}
