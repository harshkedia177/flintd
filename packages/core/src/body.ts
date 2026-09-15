import { parse } from "acorn"
import type { AnyNode, FunctionDeclaration, Program } from "acorn"
import { ToolError } from "./errors.ts"

const DECLARATION_HEADER = "async function execute(args, ctx) {\n"
const MODULE_HEADER = "export async function execute(args, ctx) {"
const MODULE_FOOTER = "}\n"
const DECLARATION_PATTERN = /^(export\s+(default\s+)?)?(async\s+)?function\s+execute\b/
const PARAMETERS = ["args", "ctx"]

const SHAPE_ADVICE =
  "Send only the statements that go inside `async function execute(args, ctx)`. Do not close the function and do not add anything after it."

export function parseBody(source: unknown, maxBytes: number): string {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new ToolError("invalid_source", `The Body must be a non-empty string. ${SHAPE_ADVICE}`, {
      received: typeof source,
    })
  }
  const bytes = Buffer.byteLength(source, "utf8")
  if (bytes > maxBytes) {
    throw new ToolError(
      "invalid_source",
      `The Body is ${bytes} bytes. Keep it under ${maxBytes} bytes, or split the work across more than one Tool.`,
      { bytes, maximum: maxBytes },
    )
  }
  if (DECLARATION_PATTERN.test(source.trim())) return innerOfDeclaration(source.trim(), 0, countLines(source))
  refuseDeclarationOnly(requireSingleNode(parseProgram(DECLARATION_HEADER + source + "\n}", 1, countLines(source))))
  return normalize(source)
}

// A specifier that is not a literal string comes back as null, because flintd checks each one against the Bundle before it saves.
export function bodyImports(inner: string): (string | null)[] {
  const program = parseProgram(DECLARATION_HEADER + inner + "\n}", 1, countLines(inner))
  const found: (string | null)[] = []
  collectImports(program, found)
  return found
}

function collectImports(node: unknown, found: (string | null)[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectImports(child, found)
    return
  }
  if (node === null || typeof node !== "object") return
  const entry = node as { type?: unknown; source?: { type?: unknown; value?: unknown } }
  if (entry.type === "ImportExpression") {
    const source = entry.source
    found.push(source?.type === "Literal" && typeof source.value === "string" ? source.value : null)
  }
  for (const key of Object.keys(node)) collectImports((node as Record<string, unknown>)[key], found)
}

export function bodyModule(inner: string): string {
  return MODULE_HEADER + inner + MODULE_FOOTER
}

export function bodyOfModule(moduleText: string): string {
  return innerOfDeclaration(moduleText.trim(), 0, countLines(moduleText))
}

function innerOfDeclaration(source: string, lineOffset: number, lineCap: number): string {
  const declaration = executeDeclaration(requireSingleNode(parseProgram(source, lineOffset, lineCap)))
  if (declaration === undefined) {
    throw new ToolError("invalid_source", `The Body must define \`execute\`. ${SHAPE_ADVICE}`)
  }
  const names = declaration.params.map((parameter) => (parameter.type === "Identifier" ? parameter.name : ""))
  if (names.length > PARAMETERS.length || names.some((name, at) => name !== PARAMETERS[at])) {
    throw new ToolError(
      "invalid_source",
      "`execute` must take (args, ctx). Rename its parameters, or leave out the ones it does not use.",
      { parameters: names },
    )
  }
  return normalize(source.slice(declaration.body.start + 1, declaration.body.end - 1))
}

function refuseDeclarationOnly(wrapped: AnyNode): void {
  if (wrapped.type !== "FunctionDeclaration" || wrapped.body.body.length !== 1) return
  const only = wrapped.body.body[0]
  const initialiser = only?.type === "VariableDeclaration" && only.declarations.length === 1 ? only.declarations[0]?.init : undefined
  const declaresFunction =
    only?.type === "FunctionDeclaration" ||
    initialiser?.type === "ArrowFunctionExpression" ||
    initialiser?.type === "FunctionExpression"
  if (!declaresFunction) return
  throw new ToolError(
    "invalid_source",
    `The Body declares a function and returns nothing. ${SHAPE_ADVICE} To send \`execute\` itself, write it as \`async function execute(args, ctx) { ... }\`.`,
  )
}

function normalize(inner: string): string {
  return `\n${inner.replace(/^(\r?\n)+/, "").replace(/(\r?\n)+$/, "")}\n`
}

function countLines(source: string): number {
  return source.split("\n").length
}

function executeDeclaration(node: AnyNode): FunctionDeclaration | undefined {
  const candidate =
    node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration" ? node.declaration : node
  if (candidate === null || candidate === undefined || candidate.type !== "FunctionDeclaration") return undefined
  return candidate.id !== null && candidate.id.name === "execute" ? candidate : undefined
}

function parseProgram(source: string, lineOffset: number, lineCap: number): Program {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true })
  } catch (cause) {
    const reported = syntaxErrorLine(cause)
    const line = reported === undefined ? undefined : Math.min(Math.max(1, reported - lineOffset), lineCap)
    const reason = cause instanceof Error ? cause.message.replace(/\s*\(\d+:\d+\)$/, "") : String(cause)
    throw new ToolError(
      "invalid_source",
      `The Body does not parse${line === undefined ? "" : ` on line ${line}`}: ${reason}. Fix the syntax and send it again.`,
      line === undefined ? {} : { line },
    )
  }
}

function requireSingleNode(program: Program): AnyNode {
  const first = program.body[0]
  if (program.body.length !== 1 || first === undefined) {
    throw new ToolError("invalid_source", `The Body closes \`execute\` early or puts statements outside it. ${SHAPE_ADVICE}`, {
      topLevelStatements: program.body.length,
    })
  }
  return first
}

function syntaxErrorLine(cause: unknown): number | undefined {
  if (cause instanceof Error && "loc" in cause) {
    const loc = (cause as { loc?: { line?: number } }).loc
    if (typeof loc?.line === "number") return loc.line
  }
  return undefined
}
