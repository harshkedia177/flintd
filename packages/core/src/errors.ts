import { redact, redactValues } from "./redact.ts"
import type { JsonValue, ToolErrorCode } from "./types.ts"

export class ToolError extends Error {
  readonly code: ToolErrorCode
  readonly details: Record<string, JsonValue>

  constructor(code: ToolErrorCode, message: string, details: Record<string, JsonValue> = {}) {
    // Every refusal a model or an operator reads is built here, so this is the one place a credential has to leave.
    super(redact(message))
    this.name = "ToolError"
    this.code = code
    this.details = redactValues(details)
  }

  toJSON(): { code: ToolErrorCode; message: string; details: Record<string, JsonValue> } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

// One sentence for one refusal: the QuickJS tier raises it from the VM, and the pool raises it for a frame that passed no tier's own check.
export function tooLarge(toolName: string, size: number, maximum: number): ToolError {
  return new ToolError(
    "result_too_large",
    `${toolName} returned about ${size} bytes and the limit is ${maximum}. Return less: a summary, a count, or the first page of the data, and add an argument that selects the part the caller needs.`,
    { tool: toolName, size, maximum },
  )
}

export function causeMessage(cause: unknown): string {
  return redact(cause instanceof Error ? cause.message : String(cause))
}
