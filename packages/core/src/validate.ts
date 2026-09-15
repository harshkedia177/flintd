import { ToolError } from "./errors.ts"
import type { JsonSchema, JsonValue, Patterns, SchemaType } from "./types.ts"

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const NAME_MAX_LENGTH = 60
const DESCRIPTION_MAX_LENGTH = 1000

export const EXPORT_PREFIX = "fl_"

export const ENFORCED_KEYWORDS = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
] as const

const ANNOTATION_KEYWORDS = ["title", "description", "default", "examples"] as const

const SCHEMA_TYPES: readonly SchemaType[] = ["object", "array", "string", "number", "integer", "boolean", "null"]

// A regex longer than this is not a constraint a reader can check, and every character of it is a step the tier pays for.
const MAX_PATTERN_LENGTH = 256
// A schema that nests deeper than this constrains nothing a reader can hold in mind, and the walk over it recurses.
const MAX_SCHEMA_DEPTH = 32
// An argument set and a result are walked, canonicalized and structured-cloned into a tier, and all three recurse,
// so past this the refusal has to come before the walk or the stack goes first and takes the process with it.
const MAX_VALUE_DEPTH = 64

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value, 0))
}

function canonicalize(value: JsonValue, depth: number): JsonValue {
  if (depth > MAX_VALUE_DEPTH) throw tooDeep("invalid_arguments", "This value", MAX_VALUE_DEPTH)
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, depth + 1))
  if (isPlainObject(value)) {
    // Assigning "__proto__" writes the prototype and no own key, so the entries are built rather than assigned.
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key] as JsonValue, depth + 1)]),
    )
  }
  return value
}

function tooDeep(code: "invalid_schema" | "invalid_arguments" | "invalid_result", what: string, maximum: number): ToolError {
  return new ToolError(
    code,
    `${what} nests more than ${maximum} levels deep. Flatten it: name the inner part as its own field, or send the deep part as a JSON string.`,
    { maximum },
  )
}

// The bound on every JSON value flintd quotes back: into a stored Held-out failure, and into a refusal a model reads.
export const MAX_STORED_BYTES = 4096

// A refusal that names a value carries it whole or says it was cut, so what the model reads is never a silent half.
export function quoteJson(value: JsonValue): string {
  const written = canonicalJson(value)
  if (Buffer.byteLength(written, "utf8") <= MAX_STORED_BYTES) return written
  return `${capBytes(written, MAX_STORED_BYTES)} (cut to the first ${MAX_STORED_BYTES} bytes)`
}

// A byte of the form 10xxxxxx continues a character, so a cut that lands inside one takes that character with it.
export function capBytes(text: string, maximum: number): string {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.byteLength <= maximum) return text
  let end = maximum
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString("utf8")
}

export function isPlainObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isToolName(name: string): boolean {
  return NAME_PATTERN.test(name) && name.length <= NAME_MAX_LENGTH
}

export function assertToolName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new ToolError("invalid_name", "A Tool name must be a non-empty string.", { received: typeof name })
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ToolError(
      "invalid_name",
      `The Tool name ${JSON.stringify(name)} is not allowed. Start with a lower-case letter and use only lower-case letters, digits and underscores, for example "word_count".`,
      { name },
    )
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new ToolError(
      "invalid_name",
      `The Tool name ${JSON.stringify(name)} is ${name.length} characters. Use a shorter name of at most ${NAME_MAX_LENGTH} characters.`,
      { name, length: name.length, maximum: NAME_MAX_LENGTH },
    )
  }
  if (name.startsWith(EXPORT_PREFIX)) {
    throw new ToolError(
      "invalid_name",
      `The prefix ${JSON.stringify(EXPORT_PREFIX)} is reserved for the names flintd exports to a harness. Choose a name without it.`,
      { name },
    )
  }
  return name
}

export function assertDescription(description: unknown): string {
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new ToolError(
      "invalid_description",
      "A Tool needs a description that tells a model when to call it. Write one sentence.",
      { received: typeof description },
    )
  }
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new ToolError(
      "invalid_description",
      `The description is ${description.length} characters. Shorten it to at most ${DESCRIPTION_MAX_LENGTH}.`,
      { length: description.length, maximum: DESCRIPTION_MAX_LENGTH },
    )
  }
  return description
}

export function assertParametersSchema(value: unknown): JsonSchema {
  const problems: string[] = []
  checkSchema(value, "", problems, 0, "the argument schema")
  if (isPlainObject(value) && value["type"] !== "object") {
    problems.push("the argument schema must have \"type\": \"object\" at its root.")
  }
  if (problems.length > 0) {
    throw new ToolError("invalid_schema", `The argument schema is not usable: ${problems.join(" ")}`, { problems })
  }
  return value as JsonSchema
}

// A result is any JSON value, so this schema has no root type it must declare; an empty object promises nothing.
export function assertResultSchema(value: unknown): JsonSchema {
  const problems: string[] = []
  checkSchema(value, "", problems, 0, "the result schema")
  if (problems.length > 0) {
    throw new ToolError("invalid_schema", `The result schema is not usable: ${problems.join(" ")}`, { problems })
  }
  return value as JsonSchema
}

function checkSchema(value: unknown, path: string, problems: string[], depth: number, root: string): void {
  if (depth > MAX_SCHEMA_DEPTH) throw tooDeep("invalid_schema", `The schema at ${schemaLabel(path, root)}`, MAX_SCHEMA_DEPTH)
  if (!isPlainObject(value)) {
    problems.push(`${schemaLabel(path, root)} must be a JSON Schema object, and this one is ${describeValue(value)}. ${howToWrite(value)}`)
    return
  }
  for (const key of Object.keys(value)) {
    if (!(ENFORCED_KEYWORDS as readonly string[]).includes(key) && !(ANNOTATION_KEYWORDS as readonly string[]).includes(key)) {
      problems.push(
        `${schemaLabel(path, root)} uses "${key}", which flintd does not check, so it would constrain nothing. Remove it, or use one of: ${ENFORCED_KEYWORDS.join(", ")}.`,
      )
    }
  }
  const type = value["type"]
  if (type !== undefined && !(typeof type === "string" && (SCHEMA_TYPES as readonly string[]).includes(type))) {
    problems.push(`${schemaLabel(path, root)} has type ${JSON.stringify(type)}. Use one of: ${SCHEMA_TYPES.join(", ")}.`)
  }
  const properties = value["properties"]
  if (properties !== undefined) {
    if (!isPlainObject(properties)) {
      problems.push(`${schemaLabel(path, root)} has a "properties" that is not an object.`)
    } else {
      for (const key of Object.keys(properties)) checkSchema(properties[key], child(path, key), problems, depth + 1, root)
    }
  }
  const required = value["required"]
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")) {
      problems.push(`${schemaLabel(path, root)} has a "required" that is not a list of property names.`)
    } else if (isPlainObject(properties)) {
      for (const entry of required) {
        if (!Object.hasOwn(properties, entry as string)) problems.push(`${schemaLabel(path, root)} requires "${String(entry)}", which it does not declare in "properties".`)
      }
    }
  }
  const additional = value["additionalProperties"]
  if (additional !== undefined && typeof additional !== "boolean") {
    problems.push(
      `${schemaLabel(path, root)} has an "additionalProperties" that is not true or false. Write true or false, and declare the shape of a value under "properties".`,
    )
  }
  const items = value["items"]
  if (items !== undefined) checkSchema(items, `${path}[]`, problems, depth + 1, root)
  const enumeration = value["enum"]
  if (enumeration !== undefined && (!Array.isArray(enumeration) || enumeration.length === 0)) {
    problems.push(`${schemaLabel(path, root)} has an "enum" that is not a non-empty list.`)
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
    const bound = value[key]
    if (bound !== undefined && typeof bound !== "number") problems.push(`${schemaLabel(path, root)} has a "${key}" that is not a number.`)
  }
  checkPattern(value["pattern"], type, path, problems, root)
}

function howToWrite(value: unknown): string {
  if (Array.isArray(value)) return 'Declare a list as {"type": "array", "items": {"type": "string"}}.'
  if (typeof value === "string") return 'Write a type as a schema object: {"type": "string"}, not "string".'
  return 'Write the schema as an object, for example {"type": "string"}.'
}

// The regex is never compiled here: a model wrote it, and it runs only in the tier, bounded there.
function checkPattern(pattern: unknown, type: unknown, path: string, problems: string[], root: string): void {
  if (pattern === undefined) return
  if (typeof pattern !== "string") {
    problems.push(`${schemaLabel(path, root)} has a "pattern" that is not a string. Write the regular expression as a JSON string.`)
    return
  }
  // A `pattern` on anything but a string is the stray keyword every other one is refused for: nothing would check it.
  if (type !== undefined && type !== "string") {
    problems.push(
      `${schemaLabel(path, root)} uses "pattern" on ${JSON.stringify(type)}, and flintd checks a pattern on a string only, so it would constrain nothing. Remove it, or make the type "string".`,
    )
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    problems.push(
      `${schemaLabel(path, root)} has a "pattern" of ${pattern.length} characters, and the limit is ${MAX_PATTERN_LENGTH}. Write a shorter regular expression, or check the shape in the Body.`,
    )
  }
}

// Spreadable into a ToolCall, and empty when no schema holds a `pattern`, which is what almost every Tool answers.
export function patternsOf(parameters: JsonSchema, result: JsonSchema | undefined): { patterns?: Patterns } {
  const args = holdsPattern(parameters, 0) ? { args: parameters } : undefined
  const returned = result !== undefined && holdsPattern(result, 0) ? { result } : undefined
  if (args === undefined && returned === undefined) return {}
  return { patterns: { ...args, ...returned } }
}

function holdsPattern(schema: JsonSchema, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false
  if (typeof schema.pattern === "string") return true
  if (schema.items !== undefined && holdsPattern(schema.items, depth + 1)) return true
  return Object.values(schema.properties ?? {}).some((member) => holdsPattern(member, depth + 1))
}

// `subject` is what the caller is checking, so one validator words a refusal about a result as being about a result.
export function validateArguments(schema: JsonSchema, value: unknown, subject: Subject = "the arguments"): string[] {
  assertDepth(value, subject)
  const problems: string[] = []
  checkValue(schema, value, "", problems, 0, subject)
  return problems
}

type Step = { leave: object } | { held: unknown; depth: number }

// A stack of its own, not the call stack: a value deep enough to refuse is deep enough to take the process down first.
export function assertDepth(value: unknown, subject: Subject): void {
  const result = subject === "the result"
  const path = new Set<object>()
  const steps: Step[] = [{ held: value, depth: 0 }]
  while (steps.length > 0) {
    const step = steps.pop() as Step
    if ("leave" in step) {
      path.delete(step.leave)
      continue
    }
    if (step.depth > MAX_VALUE_DEPTH) {
      throw tooDeep(result ? "invalid_result" : "invalid_arguments", result ? "The result" : "The arguments", MAX_VALUE_DEPTH)
    }
    const held = step.held
    if (!Array.isArray(held) && !isPlainObject(held)) continue
    const container = held as object
    if (path.has(container)) {
      throw new ToolError(
        result ? "invalid_result" : "invalid_arguments",
        `${result ? "The result" : "The arguments"} must be JSON, and this one refers to itself. Write the repeated part once, under a key of its own.`,
        {},
      )
    }
    path.add(container)
    steps.push({ leave: container })
    const children = Array.isArray(held) ? held : Object.keys(held).map((key) => held[key])
    for (const child of children) steps.push({ held: child, depth: step.depth + 1 })
  }
}

export type Subject = "the arguments" | "the result"

function checkValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  problems: string[],
  depth: number,
  subject: Subject,
): void {
  if (schema.enum !== undefined && !schema.enum.some((option) => sameJson(value, option))) {
    problems.push(`${label(path, subject)} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}.`)
    return
  }
  const type = schema.type
  if (type === undefined) return
  if (!matchesType(type, value)) {
    problems.push(`${label(path, subject)} must be ${describeType(type)}, not ${describeValue(value)}.`)
    return
  }
  if (type === "object") checkObject(schema, value as { [key: string]: JsonValue }, path, problems, depth, subject)
  else if (type === "array") checkArray(schema, value as JsonValue[], path, problems, depth, subject)
  else if (type === "string") checkString(schema, value as string, path, problems, subject)
  else if (type === "number" || type === "integer") checkNumber(schema, value as number, path, problems, subject)
}

function checkObject(
  schema: JsonSchema,
  value: { [key: string]: JsonValue },
  path: string,
  problems: string[],
  depth: number,
  subject: Subject,
): void {
  const properties = schema.properties ?? {}
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) problems.push(`${child(path, key)} is required.`)
  }
  for (const key of Object.keys(value)) {
    // An own-property check, not a lookup: "constructor" and "toString" are on every object, and neither is a declared property.
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (property !== undefined) {
      checkValue(property, value[key], child(path, key), problems, depth + 1, subject)
    } else if (schema.additionalProperties !== true) {
      const allowed = Object.keys(properties)
      const named = allowed.length === 0 ? "" : ` It declares: ${allowed.join(", ")}.`
      problems.push(
        subject === "the result"
          ? `${child(path, key)} is not a key the result schema declares.${named}`
          : `${child(path, key)} is not an argument this Tool accepts.${allowed.length > 0 ? ` It accepts: ${allowed.join(", ")}.` : ""}`,
      )
    }
  }
}

function checkArray(
  schema: JsonSchema,
  value: JsonValue[],
  path: string,
  problems: string[],
  depth: number,
  subject: Subject,
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    problems.push(`${label(path, subject)} must hold at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}, and it holds ${value.length}.`)
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    problems.push(`${label(path, subject)} must hold at most ${schema.maxItems} items, and it holds ${value.length}.`)
  }
  if (schema.items === undefined) return
  for (let position = 0; position < value.length; position += 1) {
    checkValue(schema.items, value[position], `${path}[${position}]`, problems, depth + 1, subject)
  }
}

function checkString(schema: JsonSchema, value: string, path: string, problems: string[], subject: Subject): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    problems.push(`${label(path, subject)} must be at least ${schema.minLength} characters, and it is ${value.length}.`)
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    problems.push(`${label(path, subject)} must be at most ${schema.maxLength} characters, and it is ${value.length}.`)
  }
}

function checkNumber(schema: JsonSchema, value: number, path: string, problems: string[], subject: Subject): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    problems.push(`${label(path, subject)} must be ${schema.minimum} or more, and it is ${value}.`)
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    problems.push(`${label(path, subject)} must be ${schema.maximum} or less, and it is ${value}.`)
  }
}

function matchesType(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    case "boolean":
      return typeof value === "boolean"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "null":
      return value === null
  }
}

function describeType(type: SchemaType): string {
  if (type === "object") return "an object"
  if (type === "array") return "an array"
  if (type === "integer") return "an integer"
  return `a ${type}`
}

export function describeValue(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "missing"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return "an object"
  if (typeof value === "number" && !Number.isFinite(value)) return "a number that is not finite"
  return `a ${typeof value}`
}

function sameJson(value: unknown, option: JsonValue): boolean {
  return canonicalJson(value as JsonValue) === canonicalJson(option)
}

function label(path: string, subject: Subject): string {
  return path === "" ? subject : path
}

function schemaLabel(path: string, root: string): string {
  return path === "" ? root : `the schema for ${path}`
}

function child(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`
}
