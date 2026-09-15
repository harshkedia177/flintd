import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { CALL_STEP, calledTheTool, callPrompt, connected, harnessEnv, note, run, skipped, verdict, version, which } from "./smoke.ts"
import type { HarnessOutcome, SmokeContext, Step } from "./smoke.ts"

const HARNESS = "codex"
const BINARY = "codex"
const PROVIDER = "flintd-eval"

// Codex takes an OpenAI-compatible endpoint as a `[model_providers.<id>]` table with `base_url` and `env_key` in
// the user-level `~/.codex/config.toml` (developers.openai.com/codex/config-reference), so this run's meter can be
// that endpoint and `codex exec` can be driven for real.
export default async function smoke(context: SmokeContext): Promise<Omit<HarnessOutcome, "durationMs">> {
  const binary = await which(BINARY)
  if (binary === null) return skipped(HARNESS, `${BINARY} is not on this machine's PATH`)
  const steps = await connected(context, HARNESS)
  const listed = await run(BINARY, ["mcp", "list"], { cwd: context.project, env: harnessEnv(context), timeoutMs: 120_000 })
  steps.push({
    name: "codex mcp list",
    ok: listed.code === 0 && /flintd/.test(listed.stdout) && /FLINTD_TOKEN/.test(listed.stdout),
    note: note(listed, context),
  })
  steps.push(await callStep(context))
  return verdict(
    HARNESS,
    BINARY,
    await version(BINARY),
    steps,
    "codex mcp list reads back the [mcp_servers.flintd] table with bearer_token_env_var = FLINTD_TOKEN. A tool call is driven through a [model_providers.flintd-eval] table whose base_url is this run's meter, and needs EVAL_PROVIDER=openai.",
  )
}

async function callStep(context: SmokeContext): Promise<Step> {
  if (context.provider !== "openai") {
    return {
      name: CALL_STEP,
      ok: false,
      note: `this run's provider is ${context.provider}, and this table is an OpenAI-compatible endpoint`,
    }
  }
  if (context.seededTool === null) {
    return { name: CALL_STEP, ok: false, note: "no Tool reached Verified in the held-out suite, so there was none to call" }
  }
  // Appended rather than written: `flintd init` already put [mcp_servers.flintd] in this file and must keep it.
  await appendFile(
    join(context.home, ".codex", "config.toml"),
    `\n[model_providers.${PROVIDER}]\nname = "flintd evals"\nbase_url = "${context.meterBase}/v1"\nenv_key = "FLINTD_EVAL_KEY"\n`,
  )
  const said = await run(
    BINARY,
    ["exec", "--model", context.model, "-c", `model_provider="${PROVIDER}"`, "--skip-git-repo-check", callPrompt(context)],
    {
      cwd: context.project,
      env: { ...harnessEnv(context), FLINTD_EVAL_KEY: context.apiKey },
      timeoutMs: 300_000,
    },
  )
  return calledTheTool(context, said)
}
