import { providerEnv } from "../model.ts"
import { CALL_STEP, calledTheTool, callPrompt, connected, harnessEnv, note, run, skipped, verdict, version, which } from "./smoke.ts"
import type { HarnessOutcome, SmokeContext, Step } from "./smoke.ts"

const HARNESS = "hermes"
const BINARY = "hermes"

// `hermes mcp test` connects and prints the tools it discovered, which is the one harness command in this lane
// that proves the tool list itself: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
// `hermes chat -q` is the one-shot mode, and `OPENAI_BASE_URL` is honoured for the `openai-api` provider and for
// that one only: https://hermes-agent.nousresearch.com/docs/user-guide/cli
// and https://hermes-agent.nousresearch.com/docs/integrations/providers
export default async function smoke(context: SmokeContext): Promise<Omit<HarnessOutcome, "durationMs">> {
  const binary = await which(BINARY)
  if (binary === null) return skipped(HARNESS, `${BINARY} is not on this machine's PATH`)
  const steps = await connected(context, HARNESS)
  const tested = await run(BINARY, ["mcp", "test", "flintd"], {
    cwd: context.project,
    env: harnessEnv(context),
    timeoutMs: 180_000,
  })
  const said = `${tested.stdout}${tested.stderr}`
  steps.push({
    name: "hermes mcp test flintd",
    ok: /Connected/.test(said) && /tool_find/.test(said) && /tool_run/.test(said),
    note: note(tested, context),
  })
  steps.push(await callStep(context))
  return verdict(
    HARNESS,
    BINARY,
    await version(BINARY),
    steps,
    "This lane runs `hermes mcp test flintd` and holds the step to what that command prints: a connection with ${FLINTD_TOKEN} resolved, and the meta tools by name, tool_find and tool_run among them. A Hermes that does not carry that subcommand reports what it said instead. A tool call is driven through `hermes chat -q` against the openai-api provider, whose endpoint OPENAI_BASE_URL points at this run's meter.",
  )
}

async function callStep(context: SmokeContext): Promise<Step> {
  if (context.provider !== "openai") {
    return {
      name: CALL_STEP,
      ok: false,
      note: `Hermes honours OPENAI_BASE_URL for its openai-api provider and for no other, and this run's provider is ${context.provider}`,
    }
  }
  if (context.seededTool === null) {
    return { name: CALL_STEP, ok: false, note: "no Tool reached Verified in the held-out suite, so there was none to call" }
  }
  const said = await run(
    BINARY,
    ["chat", "--provider", "openai-api", "--model", context.model, "-q", callPrompt(context)],
    {
      cwd: context.project,
      env: { ...harnessEnv(context), ...providerEnv("openai", context.meterBase, context.apiKey) },
      timeoutMs: 300_000,
    },
  )
  return calledTheTool(context, said)
}
