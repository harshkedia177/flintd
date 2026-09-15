import assert from "node:assert/strict"
import test from "node:test"
import { renderSkill, renderTeachingSkill, skillName } from "../src/index.ts"
import type { Example, ToolDefinition } from "../src/index.ts"

// The Agent Skills spec: a name is 1-64 lower-case letters, digits and single inner hyphens, and a description
// is 1-1024 characters on one line.
const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER = /^---\nname: (.+)\ndescription: (.+)\n---\n/

const NESTED: ToolDefinition = {
  name: "slugify_title",
  description: "Turn a title into a URL slug.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "The title to slug.", minLength: 1, maxLength: 200 },
      style: { type: "string", enum: ["kebab", "snake"], default: "kebab", description: "Which separator to use." },
      options: {
        type: "object",
        properties: { lower: { type: "boolean", description: "Lower-case the result." } },
        required: ["lower"],
      },
      tags: { type: "array", items: { type: "string" }, minItems: 2 },
    },
    required: ["title"],
    additionalProperties: false,
  },
  result: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
}

const EXAMPLES: Example[] = [{ args: { title: "Hello There's World" }, expected: { slug: "hello-theres-world" }, grade: "exact" }]

function frontmatter(text: string): { name: string; description: string } {
  const held = FRONTMATTER.exec(text)
  assert.notEqual(held, null, `the file has no SKILL.md frontmatter block:\n${text.slice(0, 120)}`)
  const [, name, description] = held as RegExpExecArray
  return { name: name as string, description: JSON.parse(description as string) as string }
}

test("a skill file states its name and description the way every harness reads them", () => {
  const front = frontmatter(renderSkill(NESTED, EXAMPLES))
  assert.equal(front.name, "fl-slugify-title")
  assert.match(front.name, NAME_RULE)
  assert.ok(front.name.length >= 1 && front.name.length <= 64)
  assert.equal(front.description, "Turn a title into a URL slug.")
  assert.ok(front.description.length >= 1 && front.description.length <= 1024)

  const teaching = frontmatter(renderTeachingSkill())
  assert.equal(teaching.name, "flintd")
  assert.match(teaching.name, NAME_RULE)
  assert.ok(teaching.description.length >= 1 && teaching.description.length <= 1024)
})

test("a description that runs over several lines becomes one quoted line the frontmatter can hold", () => {
  const wordy = {
    ...NESTED,
    description: 'Turn a "title"\ninto a URL slug,\tand nothing else.',
  }
  const front = frontmatter(renderSkill(wordy, EXAMPLES))
  assert.equal(front.description, 'Turn a "title" into a URL slug, and nothing else.')
})

test("a skill file renders the argument schema, the result schema and the call, and the bytes never move", () => {
  const written = renderSkill(NESTED, EXAMPLES)
  assert.equal(written, renderSkill(NESTED, EXAMPLES))
  assert.equal(
    written,
    `---
name: fl-slugify-title
description: "Turn a title into a URL slug."
---

# fl_slugify_title

## When to use

Turn a title into a URL slug.

## Arguments

- \`title\` (string, required): The title to slug. At least 1 character. At most 200 characters.
- \`style\` (string, optional): Which separator to use. One of: "kebab", "snake". The default is "kebab".
- \`options\` (object, optional)
  - \`lower\` (boolean, required): Lower-case the result.
- \`tags\` (array of string, optional): At least 2 items.

## Result

- \`slug\` (string, required)

## How to call it

\`\`\`
flintd call fl_slugify_title '{"title":"Hello There'\\''s World"}'
\`\`\`

The result is the Tool's own JSON on stdout, and the id of the call is on stderr as \`call <id>\`.
A refusal is \`<code>: <message>\` on stderr with exit status 1, and the message says what to do next.
`,
  )
})

test("a Tool with no arguments and no result schema still says how it is called", () => {
  const bare: ToolDefinition = { name: "now", description: "Answer with the time.", parameters: { type: "object" } }
  const written = renderSkill(bare, [])
  assert.match(written, /\n## Arguments\n\nThis Tool takes no arguments\.\n/)
  assert.doesNotMatch(written, /## Result/)
  assert.match(written, /\nflintd call fl_now '\{\}'\n/)
})

test("a Tool name a skill name cannot hold keeps a name of its own that the rule allows", () => {
  assert.equal(skillName("word_count"), "fl-word-count")
  // The answer becomes a directory name, so no input may put a separator or a parent step into it.
  for (const name of ["a__b", "trail_", "a_b", "A_B", "a/../../b", "../../evil", "x".repeat(60)]) {
    assert.match(skillName(name), NAME_RULE)
    assert.ok(skillName(name).length <= 64, name)
  }
  // A doubled underscore and a single one must not land on the same skill directory.
  assert.notEqual(skillName("a__b"), skillName("a_b"))
})

test("the teaching skill carries a tool_create call a model can send unchanged", () => {
  const line = renderTeachingSkill()
    .split("\n")
    .find((one) => one.startsWith("flintd call tool_create "))
  assert.ok(line !== undefined)
  const quoted = line.slice(line.indexOf("'") + 1, line.lastIndexOf("'"))
  const args = JSON.parse(quoted) as { name: string; parameters_json: string; examples: unknown[] }
  assert.equal(args.name, "word_count")
  assert.deepEqual(JSON.parse(args.parameters_json), {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  })
  assert.equal(args.examples.length, 1)
  assert.match(renderTeachingSkill(), /flintd find /)
  assert.match(renderTeachingSkill(), /awaiting_approval/)
})

// The same authoring failures, answered at length in the file a harness loads beside the Tools.
test("the teaching skill names the ctx surface, the Bundle, exact Examples and the deferred Manifest Example", () => {
  const teaching = renderTeachingSkill()
  for (const said of [
    /\{ status, headers, body \}/,
    /not\*\* a Response/,
    /cheerio/,
    /await import\("<name>"\)/,
    /these pure Node builtins: node:assert, .*node:zlib/,
    /moves the Tool to the Node tier/,
    /never `args.input.text`/,
    /compared exactly after\nJSON canonicalization/,
    /manifest_json/,
    /\*\*deferred\*\*/,
  ]) {
    assert.match(teaching, said)
  }
})
