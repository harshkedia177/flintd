import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { Flint, JsonValue } from "../src/index.ts"
import { refusal, sharedLibrary } from "./support.ts"


const PARAMETERS = JSON.stringify({ type: "object", properties: {}, additionalProperties: false })

interface Packaged {
  name: string
  description: string
  source: string
  expected: JsonValue
}

// One import and one real operation for each package the Bundle holds.
const PACKAGES: Packaged[] = [
  {
    name: "zod_tool",
    description: "Check a value against a zod schema and answer what zod made of it.",
    source: `const { z } = await import("zod")
const schema = z.object({ count: z.coerce.number().int() })
return { parsed: schema.parse({ count: "7" }), refused: schema.safeParse({ count: "x" }).success }`,
    expected: { parsed: { count: 7 }, refused: false },
  },
  {
    name: "date_fns_tool",
    description: "Move a date by a number of days with date-fns.",
    source: `const { addDays, differenceInCalendarDays } = await import("date-fns")
const moved = addDays(new Date(0), 40)
return { moved: moved.toISOString(), apart: differenceInCalendarDays(moved, new Date(0)) }`,
    expected: { moved: "1970-02-10T00:00:00.000Z", apart: 40 },
  },
  {
    name: "yaml_tool",
    description: "Read a YAML document and write one back.",
    source: `const yaml = await import("yaml")
const read = yaml.parse("name: flintd\\ntools:\\n  - one\\n  - two\\n")
return { read, written: yaml.stringify({ ok: true }) }`,
    expected: { read: { name: "flintd", tools: ["one", "two"] }, written: "ok: true\n" },
  },
  {
    name: "marked_tool",
    description: "Turn a piece of Markdown into HTML with marked.",
    source: `const { marked } = await import("marked")
return { html: marked.parse("# heading\\n\\ntext with *stress*.\\n").trim() }`,
    expected: { html: "<h1>heading</h1>\n<p>text with <em>stress</em>.</p>" },
  },
  {
    name: "lodash_tool",
    description: "Group and chunk a list with lodash-es.",
    source: `const { chunk, groupBy, sumBy } = await import("lodash-es")
const rows = [{ kind: "a", n: 1 }, { kind: "b", n: 2 }, { kind: "a", n: 3 }]
return { chunks: chunk([1, 2, 3, 4, 5], 2), kinds: Object.keys(groupBy(rows, "kind")), total: sumBy(rows, "n") }`,
    expected: { chunks: [[1, 2], [3, 4], [5]], kinds: ["a", "b"], total: 6 },
  },
  {
    name: "papaparse_tool",
    description: "Read a CSV table with papaparse and write one back.",
    source: `const Papa = (await import("papaparse")).default
const read = Papa.parse("name,count\\nalpha,2\\nbeta,5\\n", { header: true, skipEmptyLines: true })
return { rows: read.data, written: Papa.unparse([{ a: 1, b: 2 }]) }`,
    expected: { rows: [{ name: "alpha", count: "2" }, { name: "beta", count: "5" }], written: "a,b\r\n1,2" },
  },
  {
    name: "jsonpath_tool",
    description: "Select values out of a JSON document with jsonpath-plus.",
    source: `const { JSONPath } = await import("jsonpath-plus")
const json = { items: [{ price: 3 }, { price: 8 }, { price: 12 }] }
return { dear: JSONPath({ path: "$.items[?(@.price > 5)].price", json }) }`,
    expected: { dear: [8, 12] },
  },
]

const CHEERIO: Packaged = {
  name: "cheerio_tool",
  description: "Read the text and the links out of a piece of HTML with cheerio.",
  source: `const { load } = await import("cheerio")
const page = load("<ul><li><a href='/one'>One</a></li><li><a href='/two'>Two</a></li></ul>")
return { texts: page("a").map((_, node) => page(node).text()).get(), hrefs: page("a").map((_, node) => page(node).attr("href")).get() }`,
  expected: { texts: ["One", "Two"], hrefs: ["/one", "/two"] },
}

async function bundleTool(flint: Flint, packaged: Packaged): Promise<void> {
  await flint.call("tool_create", {
    name: packaged.name,
    description: packaged.description,
    parameters_json: PARAMETERS,
    execute_source: packaged.source,
    examples: [{ args: {}, expected: packaged.expected }],
  })
}

async function tierOf(flint: Flint, name: string): Promise<string | undefined> {
  return (await flint.library()).find((one) => one.name === name)?.tier
}

describe("the Bundle", () => {
  const ready = sharedLibrary()

  for (const packaged of PACKAGES) {
    test(`${packaged.name.replace(/_tool$/, "")} imports and works in the QuickJS tier`, async () => {
      await ready(async (flint) => {
        await bundleTool(flint, packaged)
        assert.equal(await tierOf(flint, packaged.name), "quickjs")
        assert.deepEqual(await flint.call(packaged.name, {}), packaged.expected)
      })
    })
  }

  test("cheerio imports and works, and selects the Node tier because it needs Buffer", async () => {
    await ready(async (flint) => {
      await bundleTool(flint, CHEERIO)
      assert.equal(await tierOf(flint, CHEERIO.name), "node")
      assert.deepEqual(await flint.call(CHEERIO.name, {}), CHEERIO.expected)
    })
  })

  test("an import the Bundle does not hold is refused at save with the name and the list", async () => {
    await ready(async (flint) => {
      const refused = await refusal(() =>
        flint.call("tool_create", {
          name: "left_pad_tool",
          description: "Try to reach a package this build of flintd does not ship.",
          parameters_json: PARAMETERS,
          execute_source: `const pad = await import("left-pad")\nreturn pad.default("x", 3)`,
          examples: [{ args: {}, expected: "  x" }],
        }),
      )
      assert.equal(refused.code, "invalid_source")
      assert.match(refused.message, /imports "left-pad"/)
      assert.match(refused.message, /The Bundle holds: cheerio, date-fns, jsonpath-plus, lodash-es, marked, papaparse, yaml, zod/)
      assert.equal((await flint.library()).some((one) => one.name === "left_pad_tool"), false)
    })
  })

  test("an import whose name is worked out while the Body runs is refused at save", async () => {
    await ready(async (flint) => {
      const refused = await refusal(() =>
        flint.call("tool_create", {
          name: "computed_import_tool",
          description: "Try to import a package whose name the source never shows.",
          parameters_json: PARAMETERS,
          execute_source: `const held = await import("ya" + "ml")\nreturn held.parse("a: 1")`,
          examples: [{ args: {}, expected: { a: 1 } }],
        }),
      )
      assert.equal(refused.code, "invalid_source")
      assert.match(refused.message, /worked out while it runs/)
    })
  })
})
