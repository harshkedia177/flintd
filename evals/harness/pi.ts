import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { providerEnv } from "../model.ts"
import { CALL_STEP, calledTheTool, callPrompt, flintdInit, harnessEnv, installed, note, run, skipped, verdict, version } from "./smoke.ts"
import type { HarnessOutcome, Ran, SmokeContext, Step } from "./smoke.ts"

const HARNESS = "pi"
const BINARY = "pi"
const PACKAGE = "@earendil-works/pi-coding-agent"

// pi speaks no MCP: `flintd init` copies the extension of `packages/pi` into the pi extension directory, and the
// extension itself opens the MCP connection at session start. See packages/pi/README.md.
// `pi -p` is the non-interactive mode, and `~/.pi/agent/models.json` registers an OpenAI-compatible provider with a
// baseUrl and a `$VAR` key: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md
// and https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
export default async function smoke(context: SmokeContext): Promise<Omit<HarnessOutcome, "durationMs">> {
  const binary = await installed(BINARY, PACKAGE, context.dir)
  if (binary === null) {
    return skipped(HARNESS, `${BINARY} is not on this machine's PATH and \`npm install --prefix\` of ${PACKAGE} did not produce it`)
  }
  const extension = join(context.home, ".pi", "agent", "extensions", "flintd")
  // `flintd init` copies the extension and then asks for its dependencies, so the install comes between the two
  // halves of the handshake: `--check` is not complete until the extension's own node_modules is there.
  const written = await flintdInit(context, HARNESS)
  const deps = await dependencies(extension)
  const checked = await flintdInit(context, HARNESS, ["--check"])
  const steps: Step[] = [
    { name: "flintd init", ok: written.code === 0, note: note(written, context) },
    { name: "the extension's dependencies", ok: deps.code === 0, note: note(deps, context) },
    { name: "flintd init --check", ok: checked.code === 0, note: note(checked, context) },
  ]
  steps.push(await callStep(context, binary))
  return verdict(
    HARNESS,
    binary,
    await version(binary),
    steps,
    "flintd init copies the pi extension and prints the npm install line for it. A tool call is driven through `pi -p` against a provider registered in the run's own models.json, whose baseUrl is this run's meter.",
  )
}

async function callStep(context: SmokeContext, binary: string): Promise<Step> {
  if (context.seededTool === null) {
    return { name: CALL_STEP, ok: false, note: "no Tool reached Verified in the held-out suite, so there was none to call" }
  }
  await writeModels(context)
  const said = await run(
    binary,
    ["-p", callPrompt(context), "--provider", "flintd-meter", "--model", context.model],
    {
      cwd: context.project,
      env: { ...harnessEnv(context), ...providerEnv(context.provider, context.meterBase, context.apiKey) },
      timeoutMs: 300_000,
    },
  )
  const step = await calledTheTool(context, said)
  return step.ok ? step : { ...step, note: `${step.note} ${note(said, context)}` }
}

// The extension is a package of its own with an MCP client in it, and pi loads it as a directory with its own
// node_modules. The install writes only under the run's temporary home, and the devDependencies are left out.
async function dependencies(extension: string): Promise<Ran> {
  return run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefix", extension], {
    env: { HOME: extension, npm_config_cache: join(extension, "cache") },
    timeoutMs: 600_000,
  })
}

// The key is a `$VAR` reference pi resolves from the environment, so no credential is written into the temporary home.
async function writeModels(context: SmokeContext): Promise<void> {
  const dir = join(context.home, ".pi", "agent")
  await mkdir(dir, { recursive: true })
  const provider = {
    baseUrl: context.provider === "openai" ? `${context.meterBase}/v1` : context.meterBase,
    api: "openai-completions",
    apiKey: `$${context.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}`,
    models: [{ id: context.model }],
  }
  await writeFile(join(dir, "models.json"), `${JSON.stringify({ providers: { "flintd-meter": provider } }, null, 2)}\n`)
}
