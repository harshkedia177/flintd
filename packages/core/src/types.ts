import type { ModelAdapter } from "./model.ts"

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// The last four are the daemon's: packages/core never throws them, and they are here only so the HTTP status map stays exhaustive.
export const TOOL_ERROR_CODES = [
  "invalid_name",
  "invalid_description",
  "invalid_schema",
  "invalid_source",
  "invalid_arguments",
  "invalid_examples",
  "invalid_result",
  "example_failed",
  "exists",
  "duplicate",
  "not_found",
  "not_implemented",
  "invalid_manifest",
  "awaiting_approval",
  "recursive_call",
  "call_failed",
  "unserializable_result",
  "result_too_large",
  "timeout",
  "worker_unavailable",
  "store_error",
  "dir_in_use",
  "internal_error",
  "unauthorized",
  "forbidden",
  "method_not_allowed",
  "request_too_large",
  // The one code no daemon sends: a client raises it when no daemon answered at all.
  "transport_failed",
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

export const TOOL_STATES = ["draft", "verified", "active", "retired"] as const

export type ToolState = (typeof TOOL_STATES)[number]

export const OBSERVATION_STATUSES = ["ok", "error"] as const

// `flintd` is flintd's own channel: a Version it wrote for itself, such as the Held-out verification of a Draft.
export type Channel = "agent" | "observer" | "file" | "flintd"

export type LibraryKind = "user" | "project"

export type Operation = "create" | "update" | "restore" | "retire" | "verify" | "activate"

export type ExampleGrade = "exact" | "assertion"

export type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"

export interface JsonSchema {
  type?: SchemaType
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: JsonValue[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  title?: string
  description?: string
  default?: JsonValue
  examples?: JsonValue[]
}

// The `pattern` constraints of one Tool, carried into the tier because a model's own regex is compiled only where the tier's interrupt, or the pool's terminateAfterMs, can stop it.
export interface Patterns {
  args?: JsonSchema
  result?: JsonSchema
}

export interface Example {
  args: JsonValue
  expected: JsonValue
  grade: ExampleGrade
  // Set when the Example could not run because the Manifest was waiting for its Approval. The grant runs it.
  status?: "deferred"
}

export type HeldOutStatus = "pending" | "passed" | "failed" | "unavailable"

export interface HeldOutFailure {
  index: number
  args: JsonValue
  grade: ExampleGrade
  expected: JsonValue
  actual: JsonValue
  reason: string
}

export interface HeldOutExample extends Example {
  judgment: string | null
}

export interface HeldOut {
  status: "passed" | "failed"
  examples: HeldOutExample[]
  grades: { exact: number; assertion: number }
  failures: HeldOutFailure[]
  reason: string | null
}

export type ModelProvider = "anthropic" | "openai"

export interface ModelConfig {
  provider: ModelProvider
  apiKey: string
  model?: string
  baseUrl?: string
  embedModel?: string
}

export const CONTAINER_ENGINES = ["docker", "none"] as const

export type ContainerEngineName = (typeof CONTAINER_ENGINES)[number]

// `available` false means a Tool that asks for "exec" cannot run, and the refusal names what is missing.
export interface ContainerStatus {
  available: boolean
  engine: string
  version: string | null
}

export interface TierStatus {
  container: ContainerStatus
}

export interface ModelStatus {
  configured: boolean
  provider?: ModelProvider
  model?: string
}

export const TIERS = ["quickjs", "node", "container"] as const

export type Tier = (typeof TIERS)[number]

// An empty Manifest is a pure Tool: no Approval, and no host function installed in its tier.
export interface Manifest {
  fs?: string
  hosts?: string[]
  connections?: string[]
  exec?: boolean
}

export interface Connection {
  name: string
  hosts: string[]
  header: { name: string; value: string }
}

// What every surface may show: the value is write-only and leaves flintd only as a header on the wire.
export interface ConnectionSummary {
  name: string
  hosts: string[]
}

export interface Connections {
  list(): Promise<ConnectionSummary[]>
  add(connection: unknown): Promise<ConnectionSummary>
  remove(name: string): Promise<ConnectionSummary>
}

export const APPROVAL_STATUSES = ["pending", "approved", "denied"] as const

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

// An Approval names the Body as well as the Manifest: a decision is about the code a person read, not the Manifest alone.
export interface ApprovalKey {
  manifestHash: string
  bodyDigest: string
}

export interface Approval extends ApprovalKey {
  id: string
  tool: string
  version: string | null
  manifest: Manifest
  summary: string
  status: ApprovalStatus
  requester: string | null
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  note: string | null
}

export interface ApprovalEntry extends Approval {
  library: LibraryKind
}

export type ApprovalAnswer = "approve" | "deny" | "defer"

export interface ApprovalDecision extends ApprovalEntry {
  promotion: "promoted" | "blocked" | "unchanged"
  message: string | null
}

export interface Provenance {
  channel: Channel
  session: string | null
  harness: string | null
  model: string | null
  excerpt: string | null
  createdAt: string
}

export interface Tool {
  name: string
  description: string
  parameters: JsonSchema
  // The optional JSON Schema for the result. A Tool that declares one is held to it at every call.
  result?: JsonSchema
  manifest: Manifest
  tier: Tier
  state: ToolState
  needs_review: boolean
  provenance: Provenance
}

export interface ToolStats {
  calls: number
  errors: number
  lastCallAt: string | null
  p50Ms: number | null
  tokens: { input: number; output: number }
  contribution: number
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  result?: JsonSchema
}

export interface CallMeta {
  sessionId?: string
  harness?: string
  model?: string
  excerpt?: string
  library?: LibraryKind
  // The counts the caller reports. flintd stores them as given and estimates nothing.
  tokens?: { input?: number; output?: number }
}

export type CallOutcome = "positive" | "negative"

export interface CallResult {
  id: string | null
  result: JsonValue
}

export interface CallReport {
  id: string
  tool: string
  library: LibraryKind
  outcome: CallOutcome
  contribution: number
}

export interface FlintOptions {
  dir?: string
  userDir?: string
  projectDir?: string
  userRemote?: string
  projectRemote?: string
  model?: ModelConfig | ModelAdapter
  syncTimeoutMs?: number
  modelTimeoutMs?: number
  heldOutTimeoutMs?: number
  callTimeoutMs?: number
  terminateAfterMs?: number
  maxArgsBytes?: number
  maxResultBytes?: number
  maxBodyBytes?: number
  maxFetchBytes?: number
  fetchTimeoutMs?: number
  maxCallDepth?: number
  maxLogLines?: number
  maxLogBytes?: number
  memoryLimitBytes?: number
  maxExecBytes?: number
  // The container tier: the image a Body runs in, the engine that runs it, and the clock one such call gets.
  containerImage?: string
  containerEngine?: ContainerEngineName
  containerTimeoutMs?: number
  // How many Node tier children the pool holds warm when it has nothing left to run; 0 is a fresh child per call.
  warmNodeRunners?: number
  // Where the Connections are kept. The default is the flintd home, which is never a Library and never a repository.
  connectionsFile?: string
  connections?: Connection[]
  activeCap?: number
  activeListLimit?: number
  heldOutConcurrency?: number
  findLimit?: number
  duplicateThreshold?: number
  duplicateBand?: number
  duplicateCosine?: number
  duplicateCosineBand?: number
  duplicateMaxJudgments?: number
  siblingThreshold?: number
  siblingCosine?: number
  searchCosine?: number
  // The Observer: how many sessions a pattern needs, how far back it looks, and the bound on one whole run.
  observerRepeats?: number
  observerWindowDays?: number
  observerTimeoutMs?: number
  observerMaxCandidates?: number
  // A retirement proposal: the Contribution and the call count that earn one, and the days of idleness that do.
  retireContribution?: number
  retireMinCalls?: number
  retireIdleDays?: number
  // The harnesses the operator answered yes to for transcripts. The Observer reads no other harness at all, and
  // reads this at every run, so a function here is how a daemon lets the operator's answer change while it runs.
  transcriptHarnesses?: string[] | (() => string[])
  stopGraceMs?: number
  // What the call ledger reads for "now", in milliseconds since the epoch. The default is Date.now.
  clock?: () => number
  onLog?(entry: LogEntry): void
  onApproval?(request: ApprovalEntry): Promise<ApprovalAnswer> | ApprovalAnswer
}

export interface LogEntry {
  tool: string
  // The call the line came from, or null for a line flintd wrote outside a call.
  callId: string | null
  message: string
}

export interface InvalidTool {
  name: string
  code: ToolErrorCode
  message: string
  library: LibraryKind
}

export interface LibraryEntry {
  name: string
  description: string
  state: ToolState
  // Why the Tool sits below the state its own Version declares, or null.
  downgraded: string | null
  calls: number
  errors: number
  lastCallAt: string | null
  contribution: number
  library: LibraryKind
  needs_review: boolean
  tier: Tier
  manifest: Manifest
  approval: ApprovalStatus | null
}

export interface FindSibling {
  name: string
  state: ToolState
  library: LibraryKind
}

export interface FindEntry {
  name: string
  description: string
  state: ToolState
  contribution: number
  library: LibraryKind
  score: number
  siblings: FindSibling[]
}

export interface LibraryStatus {
  library: LibraryKind
  dir: string
  tools: number
  retired: number
  remote: string | null
  error: string | null
  // Where an index flintd could not open was moved to, present only when this start moved one aside and rebuilt it.
  movedIndex?: string
}

export interface ReviewEntry {
  name: string
  library: LibraryKind
}

export interface FlintStatus {
  running: boolean
  dir: string
  tools: number
  retired: number
  active: number
  activeCap: number
  invalid: InvalidTool[]
  review: ReviewEntry[]
  model: ModelStatus
  tiers: TierStatus
  libraries: LibraryStatus[]
  observer: ObserverStatus
}

// What a harness hook saw one of the harness's own tools do. Argument names only: no value ever reaches this row.
export interface Observation {
  id: string
  harness: string
  session: string | null
  tool: string
  argumentKeys: string[]
  status: ObservationStatus
  // Where the harness keeps the transcript of that session, or null when the operator did not turn transcripts on.
  transcriptPath: string | null
  at: string
}

export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number]

export interface ObservationInput {
  harness: string
  tool: string
  status: ObservationStatus
  session?: string | null
  argumentKeys?: string[]
  transcriptPath?: string | null
  at?: string
}

export interface ObservationQuery {
  since?: string
  harness?: string
  limit?: number
}

// The query with every default filled in, which is what the index binds to its statement.
export interface ObservationSearch {
  since: string | null
  harness: string | null
  limit: number
}

// One step of a pattern the Observer found: a tool name and the names of its arguments. No argument value.
export interface ObserverStep {
  tool: string
  argumentKeys: string[]
}

export interface ObserverCandidate {
  // The steps written as `tool(key, key)` and joined by ` -> `. This is the whole of what flintd keeps of a pattern.
  pattern: string
  steps: ObserverStep[]
  sessions: number
  harnesses: string[]
  firstAt: string
  lastAt: string
}

export interface ObserverDraft {
  pattern: string
  name: string
  version: string
  library: LibraryKind
}

export interface ObserverRefusal {
  pattern: string
  name: string | null
  code: ToolErrorCode
  reason: string
}

export type RetirementReason = "contribution" | "idle"

// What the operator needs to decide a retirement. Nothing here retires anything: a retirement is never automatic.
export interface RetirementProposal {
  name: string
  library: LibraryKind
  state: ToolState
  reason: RetirementReason
  calls: number
  errors: number
  contribution: number
  lastCallAt: string | null
  idleDays: number | null
}

export interface ObserverRun {
  at: string
  dryRun: boolean
  modelConfigured: boolean
  windowFrom: string
  candidates: ObserverCandidate[]
  drafts: ObserverDraft[]
  refusals: ObserverRefusal[]
  retirements: RetirementProposal[]
  transcripts: { read: number; skipped: number }
}

export interface ObserverStatus {
  running: boolean
  lastRunAt: string | null
  candidates: number
  drafts: number
  refusals: number
  retirements: number
}

export interface Observer {
  run(options?: { dryRun?: boolean }): Promise<ObserverRun>
  // The Tools whose Contribution or idleness earns a retirement proposal. The operator retires with tool_retire.
  proposals(): Promise<RetirementProposal[]>
}

// Every answer is a promise, because a remote one crosses a socket to reach the same daemon an embedded one reads in process.
export interface Flint {
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<FlintStatus>
  library(): Promise<LibraryEntry[]>
  tools(): Promise<ToolDefinition[]>
  // The same list in one provider's own shape, names carrying the `fl_` export prefix.
  tools<F extends ToolFormat>(format: F): Promise<ToolFormats[F]>
  find(query: string, limit?: number): Promise<FindEntry[]>
  call(name: string, args: unknown, meta?: CallMeta): Promise<JsonValue>
  callWithId(name: string, args: unknown, meta?: CallMeta): Promise<CallResult>
  report(callId: string, outcome: CallOutcome, note?: string): Promise<CallReport>
  approvals(): Promise<ApprovalEntry[]>
  // Runs the watcher whenever the model-facing tool list changes, and answers with the call that takes it off again.
  onChange(watcher: () => void): () => void
  // Runs the watcher for each Approval that starts waiting, so a developer's own code can decide it with approve().
  onApproval(watcher: (request: ApprovalEntry) => void): () => void
  // What a harness hook saw, newest first. Read-only: the observer of ticket 18 reads it and nothing here writes a Tool.
  observations(query?: ObservationQuery): Promise<Observation[]>
  observe(observation: ObservationInput): Promise<Observation>
  // The Observer: it reads the call log and what a consented harness recorded, and proposes through the observer Channel.
  observer: Observer
  approve(id: string, note?: string): Promise<ApprovalDecision>
  deny(id: string, note?: string): Promise<ApprovalDecision>
  connections: Connections
}

// The shapes a provider wants its tool list in. `fl_` is the export spelling: meta tools keep their own names.
export type ToolFormat = "anthropic" | "openai" | "openai-chat" | "gemini" | "vercel" | "mcp"

// A schema as a provider's own type takes it: the keywords flintd stores, open the way every provider's type is open.
export type ProviderSchema = JsonSchema & { [keyword: string]: unknown }

export type ObjectSchema = ProviderSchema & { type: "object" }

export interface AnthropicTool {
  name: string
  description: string
  input_schema: ObjectSchema
}

export interface OpenAiTool {
  type: "function"
  name: string
  description: string
  parameters: ProviderSchema
  strict: boolean
}

export interface OpenAiChatTool {
  type: "function"
  function: { name: string; description: string; parameters: ProviderSchema; strict: boolean }
}

// The OpenAPI 3.03 subset a genai `Schema` holds; `type` keeps the JSON Schema spelling, because the SDK spells it with a TypeScript enum.
export type GeminiSchema = Omit<
  JsonSchema,
  "enum" | "additionalProperties" | "examples" | "items" | "maxItems" | "maxLength" | "minItems" | "minLength" | "properties"
> & {
  enum?: string[]
  maxItems?: string
  maxLength?: string
  minItems?: string
  minLength?: string
  properties?: Record<string, GeminiSchema>
  items?: GeminiSchema
  [keyword: string]: unknown
}

export interface GeminiTool {
  name: string
  description: string
  parameters: GeminiSchema
  response?: GeminiSchema
}

// `inputSchema` is a JSON Schema. The AI SDK wants it inside `jsonSchema()`, which `vercelTools` does for you.
export interface VercelTool {
  description: string
  inputSchema: ProviderSchema
  outputSchema?: ProviderSchema
}

export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface McpTool {
  name: string
  description: string
  inputSchema: ObjectSchema
  outputSchema?: ObjectSchema
  annotations?: ToolAnnotations
}

export interface ToolFormats {
  anthropic: AnthropicTool[]
  openai: OpenAiTool[]
  "openai-chat": OpenAiChatTool[]
  gemini: GeminiTool[]
  vercel: Record<string, VercelTool>
  mcp: McpTool[]
}

// What a refusal looks like in a provider's own tool result: the code the model acts on and the sentence that says how.
export interface ToolErrorPayload {
  code: ToolErrorCode
  message: string
}

export interface AnthropicToolResult {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: true
}

export interface OpenAiToolResult {
  type: "function_call_output"
  call_id: string
  output: string
}

export interface OpenAiChatToolResult {
  role: "tool"
  tool_call_id: string
  content: string
}

export interface GeminiToolResult {
  functionResponse: { id?: string; name: string; response: { output: JsonValue } | { error: ToolErrorPayload } }
}

// The AI SDK has one tool-result part and no tool-error part: `output.type` is what says a call was refused.
export interface VercelToolResult {
  type: "tool-result"
  toolCallId: string
  toolName: string
  output: { type: "json"; value: JsonValue } | { type: "error-json"; value: JsonValue }
}

export interface McpToolResult {
  content: { type: "text"; text: string }[]
  structuredContent?: JsonValue
  isError?: true
}

export interface ToolResults {
  anthropic: AnthropicToolResult
  openai: OpenAiToolResult
  "openai-chat": OpenAiChatToolResult
  gemini: GeminiToolResult
  vercel: VercelToolResult
  mcp: McpToolResult
}
