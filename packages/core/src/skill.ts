import { createHash } from "node:crypto"
import { exportName } from "./formats.ts"
import { BUNDLE, BUNDLE_NODE_ONLY } from "./bundle.ts"
import { NODE_BUILTINS } from "./manifest.ts"
import type { Example, JsonSchema, ToolDefinition } from "./types.ts"

export const TEACHING_SKILL = "flintd"
// The Agent Skills spec holds a skill name to lower-case letters, digits and single inner hyphens, at most 64.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME_MAX = 64
const DESCRIPTION_MAX = 1024
const TAG_LENGTH = 8

const BOUNDS: [keyof JsonSchema, (value: number) => string][] = [
  ["minimum", (value) => `At least ${value}.`],
  ["maximum", (value) => `At most ${value}.`],
  ["minLength", (value) => `At least ${many(value, "character")}.`],
  ["maxLength", (value) => `At most ${many(value, "character")}.`],
  ["minItems", (value) => `At least ${many(value, "item")}.`],
  ["maxItems", (value) => `At most ${many(value, "item")}.`],
]

const TEACHING_DESCRIPTION =
  "Find, run and write Tools through the flintd command line: a Library of tested, versioned Tools this machine " +
  "holds. Use it before writing a throwaway script, when a task repeats, or when a capability is missing."

// A skill name becomes a directory name and holds no underscore, so `_` becomes `-` and what still breaks the rule gets a digest.
export function skillName(toolName: string): string {
  const direct = `fl-${toolName.replaceAll("_", "-")}`
  if (SKILL_NAME.test(direct) && direct.length <= SKILL_NAME_MAX) return direct
  const tag = createHash("sha256").update(toolName).digest("hex").slice(0, TAG_LENGTH)
  const stem = direct
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SKILL_NAME_MAX - TAG_LENGTH - 1)
    .replace(/^-+|-+$/g, "")
  return `${stem}-${tag}`
}

export function renderSkill(tool: ToolDefinition, examples: readonly Example[]): string {
  const called = exportName(tool.name)
  const lines = [
    frontmatter(skillName(tool.name), tool.description),
    "",
    `# ${called}`,
    "",
    "## When to use",
    "",
    oneLine(tool.description),
    "",
    "## Arguments",
    "",
    ...members(tool.parameters, "This Tool takes no arguments."),
    "",
  ]
  if (tool.result !== undefined) lines.push("## Result", "", ...members(tool.result, `The result is ${plainType(tool.result)}.`), "")
  lines.push(
    "## How to call it",
    "",
    "```",
    `flintd call ${called} ${shellQuote(JSON.stringify(examples[0]?.args ?? {}))}`,
    "```",
    "",
    "The result is the Tool's own JSON on stdout, and the id of the call is on stderr as `call <id>`.",
    "A refusal is `<code>: <message>` on stderr with exit status 1, and the message says what to do next.",
    "",
  )
  return lines.join("\n")
}

export function renderTeachingSkill(): string {
  return `${frontmatter(TEACHING_SKILL, TEACHING_DESCRIPTION)}

# flintd

flintd holds a Library of Tools an agent writes for itself. A Tool is saved only after every Example it carries
runs and matches, it keeps every Version it ever had, and it reaches nothing outside its own process until its
Manifest asks and a human approves.

Each skill named \`fl-<tool>\` beside this one is one Active Tool of that Library. flintd writes them from the
Library itself, so the set is always what the Library holds; never edit one by hand.

## Find a Tool before you write one

\`\`\`
flintd find "count the words in a piece of text"
\`\`\`

Each line is a name, a Library, a state, a match score, a contribution and a one-line description. Run the one
that fits, with the \`fl_\` name:

\`\`\`
flintd call fl_word_count '{"text":"one two three"}'
\`\`\`

Read the argument schema first with \`flintd tools show word_count\` when the skill file for it is not open.

## Write a Tool when none fits

Send the name, the one-sentence description, the argument schema as a JSON string, the body of
\`async function execute(args, ctx)\`, and at least one Example. Every Example runs before anything is saved, and
the first failure comes back with the result the body actually produced.

### What the body gets

\`args\` holds exactly the top-level properties of the argument schema: a schema that declares \`text\` gives the body
\`args.text\`, never \`args.input.text\`. \`ctx\` holds these and nothing else:

| \`ctx\` | What it is |
| --- | --- |
| \`toolName\` | the name of the Tool running |
| \`log(message)\` | one line to the daemon log, never part of the result |
| \`callTool(name, args)\` | run another Tool of the Library |
| \`fetch(url, init)\` | the Proxy, where the Manifest declares \`hosts\` |
| \`fs.read(path)\`, \`fs.write(path, text)\`, \`fs.list(dir)\` | files under the Manifest root, where the Manifest declares \`fs\` |
| \`exec(command, options)\` | one command line in a container, where the Manifest declares \`exec\` |

\`await ctx.fetch(url, init)\` answers \`{ status, headers, body }\`. It is **not** a Response: there is no \`.ok\` and no
\`.json()\`, and \`body\` is already the parsed JSON when the answer says JSON. \`setTimeout\` and \`clearTimeout\` are
plain names, not fields of \`ctx\`.

### What the body may import

\`await import("<name>")\` is the only import form, and it reaches two lists:

- the Bundle: ${BUNDLE.join(", ")}
- these pure Node builtins: ${NODE_BUILTINS.join(", ")}

A builtin, or ${BUNDLE_NODE_ONLY.join(", ")}, moves the Tool to the Node tier, which is a child process rather than a
VM; every other Bundle package runs in either tier. Any other name is refused at the save, and so is an import whose
name the body works out while it runs.

### Write the Examples as exact JSON

An Example is \`{"args": <the arguments>, "expected": <the exact result>}\`. \`args\` carries the same keys the argument
schema declares, at the same nesting, and \`expected\` is the value the body really returns, compared exactly after
JSON canonicalization. An Example whose \`args\` do not match the schema is refused before the body runs.

### Declare a Manifest for what the Tool must reach

A body reaches no file, no host and no command until \`manifest_json\` asks for it:
\`{"fs": "workspace", "hosts": ["api.example.com"], "connections": ["github"], "exec": false}\`. Ask for the least that
works. An Example that needs what the Manifest asks for cannot run before a person decides, so flintd saves it as
**deferred**, the Tool stays a Draft, and the Approval runs every Example again with the Manifest in force. Write
those Examples anyway: an Example that dodges the capability proves nothing.

\`\`\`
flintd call tool_create '{"name":"word_count","description":"Count the words in a piece of text.","parameters_json":"{\\"type\\":\\"object\\",\\"properties\\":{\\"text\\":{\\"type\\":\\"string\\"}},\\"required\\":[\\"text\\"],\\"additionalProperties\\":false}","execute_source":"return { count: args.text.trim().split(/\\\\s+/).filter(Boolean).length }","examples":[{"args":{"text":"one two three"},"expected":{"count":3}}]}'
\`\`\`

The new Tool is a Draft: yours to call at once, and findable by everyone after flintd's own model writes held-out
Examples for it and they pass. Five clean calls spread over more than one turn make it Active, and an Active Tool
gets a skill file of its own here.

## When a call answers awaiting_approval

\`awaiting_approval\` means the Tool's Manifest asks for a directory, a host, a Connection or a container, and no
human has decided yet. Nothing ran. Tell the person you are working with to run \`flintd approvals list\` and then
\`flintd approvals approve <tool>\`, and call the Tool again after they do. Do not try another Tool to get around
it, and never widen a Manifest to make the refusal go away.

## Where this list comes from

\`flintd status\` says which Libraries this daemon holds and how many Tools are Active. The skills here are the
Active Tools in contribution order, and flintd rewrites the directory whenever a Tool is promoted, retired, or
has its description or argument schema changed.
`
}

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${yamlString(oneLine(description).slice(0, DESCRIPTION_MAX))}\n---`
}

// A JSON string is a valid YAML double-quoted scalar, so JSON.stringify is the quoting rule for both.
function yamlString(value: string): string {
  return JSON.stringify(value)
}

function many(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function members(schema: JsonSchema, empty: string): string[] {
  const lines: string[] = []
  properties(schema, "", lines)
  return lines.length > 0 ? lines : [empty]
}

function properties(schema: JsonSchema, indent: string, lines: string[]): void {
  const required = new Set(schema.required ?? [])
  for (const [name, member] of Object.entries(schema.properties ?? {})) {
    const need = required.has(name) ? "required" : "optional"
    lines.push(`${indent}- \`${name}\` (${plainType(member)}, ${need})${detail(member)}`)
    const nested = member.type === "array" ? member.items : member
    if (nested?.properties !== undefined) properties(nested, `${indent}  `, lines)
  }
}

function plainType(schema: JsonSchema): string {
  if (schema.type === undefined) return "any JSON value"
  if (schema.type !== "array") return schema.type
  return schema.items?.type === undefined ? "array" : `array of ${schema.items.type}`
}

function detail(schema: JsonSchema): string {
  const said: string[] = []
  if (schema.description !== undefined) said.push(oneLine(schema.description))
  if (schema.enum !== undefined) said.push(`One of: ${schema.enum.map((one) => JSON.stringify(one)).join(", ")}.`)
  for (const [keyword, say] of BOUNDS) {
    const bound = schema[keyword]
    if (typeof bound === "number") said.push(say(bound))
  }
  if (schema.default !== undefined) said.push(`The default is ${JSON.stringify(schema.default)}.`)
  return said.length === 0 ? "" : `: ${said.join(" ")}`
}

// The arguments go to a shell inside single quotes, and a single quote in the JSON would end that quoting early.
function shellQuote(json: string): string {
  return `'${json.replaceAll("'", "'\\''")}'`
}
