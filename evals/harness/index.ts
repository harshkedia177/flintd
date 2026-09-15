import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { JsonValue, ModelProvider } from "@flintd/core"
import claudeCode from "./claude-code.ts"
import codex from "./codex.ts"
import hermes from "./hermes.ts"
import openclaw from "./openclaw.ts"
import opencode from "./opencode.ts"
import pi from "./pi.ts"
import { ownHome } from "./smoke.ts"
import type { HarnessOutcome, Smoke, SmokeContext } from "./smoke.ts"

export type { HarnessOutcome, HarnessStatus } from "./smoke.ts"

const SMOKES: Record<string, Smoke> = {
  "claude-code": claudeCode,
  codex,
  opencode,
  hermes,
  openclaw,
  pi,
}

export interface HarnessOptions {
  root: string
  url: string
  port: number
  token: string
  dir: string
  seededTool: string | null
  seededArgs: Record<string, JsonValue>
  provider: ModelProvider
  meterBase: string
  apiKey: string
  model: string
  calls: () => Promise<number>
  overBudget: () => string | null
  say: (line: string) => void
  // Everything decided so far, after each harness, so a run that is killed still leaves the harnesses it drove.
  onHarness: (outcomes: HarnessOutcome[]) => Promise<void>
}

export async function runHarnesses(options: HarnessOptions): Promise<HarnessOutcome[]> {
  const outcomes: HarnessOutcome[] = []
  for (const [name, smoke] of Object.entries(SMOKES)) {
    const over = options.overBudget()
    if (over !== null) {
      outcomes.push({ harness: name, status: "skipped", binary: null, version: null, reason: over, steps: [], durationMs: 0 })
      await options.onHarness(outcomes)
      continue
    }
    const home = join(options.dir, name, "home")
    const project = join(options.dir, name, "project")
    await mkdir(home, { recursive: true })
    await mkdir(project, { recursive: true })
    const context: SmokeContext = {
      root: options.root,
      url: options.url,
      token: options.token,
      dir: join(options.dir, name),
      flintdHome: await ownHome(join(options.dir, name, "flintd"), options.port, options.token),
      home,
      project,
      seededTool: options.seededTool,
      seededArgs: options.seededArgs,
      provider: options.provider,
      meterBase: options.meterBase,
      apiKey: options.apiKey,
      model: options.model,
      callsBefore: await options.calls(),
      calls: options.calls,
    }
    const started = Date.now()
    const outcome = await smoke(context).catch((cause: unknown) => ({
      harness: name,
      status: "fail" as const,
      binary: null,
      version: null,
      reason: cause instanceof Error ? cause.message : String(cause),
      steps: [],
    }))
    const failed = outcome.steps.filter((step) => !step.ok).map((step) => step.name)
    options.say(
      `  ${outcome.status.padEnd(9)} ${name.padEnd(12)} ${outcome.version ?? "-"}` +
        `${failed.length === 0 ? "" : `  not proved: ${failed.join(", ")}`}`,
    )
    outcomes.push({ ...outcome, durationMs: Date.now() - started })
    await options.onHarness(outcomes)
  }
  return outcomes
}
