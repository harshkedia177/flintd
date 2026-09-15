import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { Type } from "@google/genai"
import { dynamicTool, jsonSchema } from "ai"
import { fakeModel } from "../../core/test/fake-model.ts"
import { googleAdkToolset, langchainModelCall, openaiAgentsTools, vercelToolSet, vercelTools } from "../src/index.ts"
import { creation, embeddedWith } from "./support.ts"
import type { Schema } from "@google/genai"
import type { PrepareStepFunction, ToolSet } from "ai"
import type { FlintClient, JsonValue } from "../src/index.ts"
import type { Session } from "./support.ts"

const CASES = [{ args: { text: "one two" }, confident: true, expected: { count: 2 } }]
const NAMES = ["step_one", "step_two", "step_three", "step_four"]
const META = ["tool_create", "tool_update", "tool_read", "tool_find", "tool_run", "tool_retire", "tool_history"]

let session: Session
let flint: FlintClient

before(async () => {
  session = await embeddedWith({ model: fakeModel({ cases: CASES }) })
  flint = session.client
  for (const name of NAMES) await flint.call("tool_create", creation({ name }))
  await verified(NAMES)
})

after(async () => {
  await session.close()
})

test("the Vercel step map gains a Tool that became callable during the run", async () => {
  const step = vercelTools(flint, { dynamicTool, jsonSchema })
  // The AI SDK's own types: the map is a ToolSet and the hook is a prepareStep, or generateText would not take them.
  const tools: ToolSet = step.tools
  const prepareStep: PrepareStepFunction<ToolSet> = step.prepareStep

  const first = await prepareStep({} as Parameters<PrepareStepFunction<ToolSet>>[0])
  assert.deepEqual((first as { activeTools: string[] }).activeTools.slice(0, META.length), META)
  assert.equal("fl_step_one" in tools, false)

  await active("step_one")

  const second = (await step.prepareStep()).activeTools
  assert.equal(second.includes("fl_step_one"), true)
  assert.equal("fl_step_one" in tools, true)
  assert.deepEqual(await step.tools["fl_step_one"]?.execute?.({ text: "one two" }, options()), { count: 2 })
})

test("the Vercel tool set carries a schema the AI SDK can read, and callFrom answers its calls", async () => {
  const set: ToolSet = await vercelToolSet(flint, jsonSchema)
  assert.deepEqual(set["tool_find"]?.inputSchema, jsonSchema((await flint.tools("vercel"))["tool_find"]!.inputSchema))
  assert.equal(typeof set["fl_step_one"], "object")
})

test("an OpenAI Agents function tool asks the Library once per turn, not once per tool", async () => {
  let reads = 0
  const counted = { ...flint, tools: ((format?: never) => { reads += 1; return flint.tools(format as never) }) } as FlintClient
  const tools = await openaiAgentsTools(counted, (options) => options)
  const one = tools.find((tool) => tool.name === "fl_step_two")
  assert.equal(one, undefined)

  await active("step_two")

  const built = await openaiAgentsTools(counted, (options) => options)
  const enabled = built.find((tool) => tool.name === "fl_step_two")
  assert.equal(enabled?.strict, true)
  assert.deepEqual(await enabled?.execute({ text: "one two" }), { count: 2 })

  // One turn, one list: the SDK resolves isEnabled for every tool of a turn and they all read the same answer.
  const run = { name: "one run" }
  reads = 0
  const answers = await Promise.all(built.map((tool) => tool.isEnabled(run)))
  assert.equal(reads, 1)
  assert.equal(answers.every((one) => one), true)

  // The next turn of the same run reads again, so a Tool retired between two turns is not offered in the second.
  await flint.call("tool_retire", { name: "step_two" })
  await new Promise((wake) => setTimeout(wake, 300))
  assert.equal(await enabled?.isEnabled(run), false)
  assert.equal(reads, 2)
})

test("the LangChain middleware puts the Library into each model call and takes its last one back out", async () => {
  const own = { name: "caller_tool" }
  const wrap = langchainModelCall(flint, (run, options) => ({ ...options, run }))
  const seen: string[][] = []
  let request: { tools: unknown[] } = { tools: [own] }
  const handler = async (asked: { tools?: unknown[] }): Promise<string> => {
    request = { tools: asked.tools ?? [] }
    seen.push(request.tools.map((one) => (one as { name: string }).name))
    return "answered"
  }

  assert.equal(await wrap(request, handler), "answered")
  await active("step_three")
  assert.equal(await wrap(request, handler), "answered")

  assert.equal(seen[0]?.[0], "caller_tool")
  assert.equal(seen[0]?.includes("fl_step_three"), false)
  assert.equal(seen[1]?.includes("fl_step_three"), true)
  // One more tool than the call before it: the middleware took its own tools out before it put them back.
  assert.equal(seen[1]?.length, (seen[0]?.length ?? 0) + 1)
})

test("the ADK toolset resolves the Library at every invocation, as genai schemas", async () => {
  const toolset = googleAdkToolset(flint, { BaseToolset: FakeToolset, FunctionTool: FakeFunctionTool, Type })
  const first = (await toolset.getTools()).map((tool) => tool.options.name)
  assert.deepEqual(first.slice(0, META.length), META)
  assert.equal(first.includes("fl_step_four"), false)

  await active("step_four")

  const one = (await toolset.getTools()).find((tool) => tool.options.name === "fl_step_four")
  assert.deepEqual(await one?.options.execute({ text: "one two" }), { count: 2 })
  // A genai Schema spells a type with its own enum and holds no `additionalProperties`.
  assert.deepEqual(one?.options.parameters, {
    type: Type.OBJECT,
    properties: { text: { type: Type.STRING } },
    required: ["text"],
  })
})

// What the AI SDK hands a tool beside its arguments. A dynamic tool reads none of it, and the type asks for all of it.
function options(): Parameters<NonNullable<ReturnType<typeof dynamicTool>["execute"]>>[1] {
  return { toolCallId: "call_1", messages: [], context: {} }
}

// The fake carries the genai Schema the real FunctionTool asks for, so tsc proves what the adapter builds fits it.
interface AdkOptions {
  name: string
  description: string
  parameters: Schema
  execute: (args: unknown) => Promise<JsonValue>
}

class FakeFunctionTool {
  readonly options: AdkOptions

  constructor(options: AdkOptions) {
    this.options = options
  }
}

class FakeToolset {
  async getTools(): Promise<FakeFunctionTool[]> {
    throw new Error("the adapter answers this with the Library")
  }

  async close(): Promise<void> {
    throw new Error("the adapter answers this")
  }
}

// Five clean calls, the last from a second session, is what carries a Verified Tool into the exported list.
async function active(name: string): Promise<void> {
  for (const [at, sessionId] of ["one", "one", "one", "one", "two"].entries()) {
    await flint.call(name, { text: `call number ${at}` }, { sessionId })
  }
}

async function verified(names: string[]): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    const library = await flint.library()
    if (names.every((name) => library.find((one) => one.name === name)?.state === "verified")) return
    if (Date.now() > deadline) throw new Error(`the Held-out runs never verified ${names.join(", ")}`)
    await new Promise((wake) => setTimeout(wake, 10))
  }
}
