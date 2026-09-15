import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { JsonValue } from "@flintd/core"
import { providerEnv } from "../model.ts"
import { CALL_STEP, calledTheTool, callPrompt, connected, harnessEnv, note, run, skipped, verdict, version, which } from "./smoke.ts"
import type { HarnessOutcome, SmokeContext, Step } from "./smoke.ts"

const HARNESS = "opencode"
const BINARY = "opencode"

// `opencode mcp list` opens each configured server and prints its state, so "connected" is a real handshake with
// `{env:FLINTD_TOKEN}` resolved: https://opencode.ai/docs/mcp-servers/
// `opencode run` is the non-interactive mode, and `provider.<name>.options.baseURL` overrides the endpoint of a
// built-in provider without any npm package: https://opencode.ai/docs/providers/
export default async function smoke(context: SmokeContext): Promise<Omit<HarnessOutcome, "durationMs">> {
  const binary = await which(BINARY)
  if (binary === null) return skipped(HARNESS, `${BINARY} is not on this machine's PATH`)
  const steps = await connected(context, HARNESS)
  const listed = await run(BINARY, ["mcp", "list"], { cwd: context.project, env: harnessEnv(context), timeoutMs: 180_000 })
  steps.push({
    name: "opencode mcp list",
    ok: /flintd[\s\S]{0,40}connected/i.test(strip(listed.stdout)),
    note: note({ ...listed, stdout: strip(listed.stdout), stderr: strip(listed.stderr) }, context),
  })
  steps.push(await callStep(context))
  return verdict(
    HARNESS,
    BINARY,
    await version(BINARY),
    steps,
    "opencode mcp list connects to the daemon over MCP with the token OpenCode resolved from {env:FLINTD_TOKEN}. A tool call is driven through `opencode run`, with the built-in provider's options.baseURL pointed at this run's meter and its key left as an {env:...} reference.",
  )
}

async function callStep(context: SmokeContext): Promise<Step> {
  if (context.seededTool === null) {
    return { name: CALL_STEP, ok: false, note: "no Tool reached Verified in the held-out suite, so there was none to call" }
  }
  const missing = await pointAtMeter(context)
  if (missing !== null) return { name: CALL_STEP, ok: false, note: missing }
  const said = await run(
    BINARY,
    ["run", "--model", `${context.provider}/${context.model}`, callPrompt(context)],
    {
      cwd: context.project,
      env: { ...harnessEnv(context), ...providerEnv(context.provider, context.meterBase, context.apiKey) },
      timeoutMs: 300_000,
    },
  )
  return calledTheTool(context, said)
}

// The base URL goes into the config `flintd init` already wrote; the key stays an {env:...} reference, so no
// credential is ever written into the run's temporary home.
async function pointAtMeter(context: SmokeContext): Promise<string | null> {
  const file = join(context.home, ".config", "opencode", "opencode.json")
  const text = await readFile(file, "utf8").catch(() => null)
  if (text === null) return `${file} does not exist, so there was no OpenCode config to point at the meter`
  const root = JSON.parse(text) as Record<string, JsonValue>
  const providers = { ...((root["provider"] ?? {}) as Record<string, JsonValue>) }
  const key = context.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
  providers[context.provider] = {
    options: {
      baseURL: context.provider === "openai" ? `${context.meterBase}/v1` : context.meterBase,
      apiKey: `{env:${key}}`,
    },
    models: { [context.model]: {} },
  }
  await writeFile(file, `${JSON.stringify({ ...root, provider: providers }, null, 2)}\n`)
  return null
}

// OpenCode draws its list with ANSI colour, and a colour code between the name and the state would break the match.
function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, "")
}
