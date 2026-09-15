import { providerEnv } from "../model.ts"
import { CALL_STEP, calledTheTool, callPrompt, connected, harnessEnv, note, run, skipped, verdict, version, which } from "./smoke.ts"
import type { HarnessOutcome, SmokeContext, Step } from "./smoke.ts"

const HARNESS = "claude-code"
const BINARY = "claude"

// Claude Code speaks the Anthropic Messages API and reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from the
// environment ("Anthropic auth is strictly ANTHROPIC_API_KEY", `claude --help`), so it can be pointed at the meter
// and driven for real — but only on a run whose provider is anthropic.
export default async function smoke(context: SmokeContext): Promise<Omit<HarnessOutcome, "durationMs">> {
  const binary = await which(BINARY)
  if (binary === null) return skipped(HARNESS, `${BINARY} is not on this machine's PATH`)
  const steps = await connected(context, HARNESS)
  const listed = await run(BINARY, ["mcp", "list"], { cwd: context.project, env: harnessEnv(context), timeoutMs: 180_000 })
  steps.push({ name: "claude mcp list", ok: /flintd:.*Connected/.test(listed.stdout), note: note(listed, context) })
  steps.push(await callStep(context))
  return verdict(
    HARNESS,
    BINARY,
    await version(BINARY),
    steps,
    "claude mcp list connects to the daemon over MCP with the token Claude Code read from FLINTD_TOKEN. A tool call is driven through ANTHROPIC_BASE_URL pointed at this run's meter, and needs the whole run on EVAL_PROVIDER=anthropic: the meter holds one key and one upstream, and the cost table prices one model.",
  )
}

async function callStep(context: SmokeContext): Promise<Step> {
  if (context.provider !== "anthropic") {
    return {
      name: CALL_STEP,
      ok: false,
      note:
        `this run's provider is ${context.provider}, and Claude Code speaks the Anthropic Messages API. ` +
        `The meter forwards one provider's key to one upstream and the run prices one model, so driving this ` +
        `harness needs the whole run on EVAL_PROVIDER=anthropic, not a second upstream inside this one.`,
    }
  }
  if (context.seededTool === null) {
    return { name: CALL_STEP, ok: false, note: "no Tool reached Verified in the held-out suite, so there was none to call" }
  }
  const said = await run(
    BINARY,
    [
      "-p",
      callPrompt(context),
      "--model",
      context.model,
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "mcp__flintd__tool_run mcp__flintd__tool_read",
    ],
    {
      cwd: context.project,
      env: { ...harnessEnv(context), ...providerEnv("anthropic", context.meterBase, context.apiKey) },
      timeoutMs: 300_000,
    },
  )
  return calledTheTool(context, said)
}
