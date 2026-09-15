import { createFlint as createEmbeddedFlint } from "@flintd/core"
import type { Flint, FlintOptions } from "@flintd/core"
import { createRemoteFlint } from "./remote.ts"
import type { FlintClient, RemoteOptions } from "./remote.ts"

export { ToolError, EXPORT_PREFIX, callFrom, exportName, formatTools, libraryName } from "@flintd/core"
export { googleAdkToolset } from "./adapters/google-adk.ts"
export { langchainModelCall } from "./adapters/langchain.ts"
export { openaiAgentsTools } from "./adapters/openai-agents.ts"
export { vercelToolSet, vercelTools } from "./adapters/vercel.ts"
export type { AdkParts, AdkSchema } from "./adapters/google-adk.ts"
export type { LangchainTool } from "./adapters/langchain.ts"
export type { AgentsTool } from "./adapters/openai-agents.ts"
export type { VercelParts, VercelStep } from "./adapters/vercel.ts"
export type * from "@flintd/core"
export type { FlintClient, RemoteOptions } from "./remote.ts"

export function createFlint(options: FlintOptions): Flint
export function createFlint(options: RemoteOptions): FlintClient
export function createFlint(options: FlintOptions | RemoteOptions): Flint | FlintClient {
  if ("url" in options) return createRemoteFlint(options)
  return createEmbeddedFlint(options)
}
