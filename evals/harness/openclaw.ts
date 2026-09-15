import { CALL_STEP, connected, harnessEnv, installed, note, run, skipped, verdict, version } from "./smoke.ts"
import type { HarnessOutcome, SmokeContext } from "./smoke.ts"

const HARNESS = "openclaw"
const BINARY = "openclaw"
const PACKAGE = "openclaw"

// OpenClaw documents `mcp list` and `mcp show`, `--json` for bounded reporting commands, and no non-interactive
// prompt mode at all: https://docs.openclaw.ai/cli. The install line is `npm install openclaw`, and this lane runs
// it under a prefix of its own: https://docs.openclaw.ai/install
export default async function smoke(context: SmokeContext): Promise<Omit<HarnessOutcome, "durationMs">> {
  const binary = await installed(BINARY, PACKAGE, context.dir)
  if (binary === null) {
    return skipped(HARNESS, `${BINARY} is not on this machine's PATH and \`npm install --prefix\` of ${PACKAGE} did not produce it`)
  }
  const steps = await connected(context, HARNESS)
  const listed = await run(binary, ["mcp", "list"], { cwd: context.project, env: harnessEnv(context), timeoutMs: 180_000 })
  steps.push({ name: "openclaw mcp list", ok: listed.code === 0 && /flintd/.test(listed.stdout), note: note(listed, context) })
  steps.push({
    name: CALL_STEP,
    ok: false,
    note: "no command in OpenClaw's CLI reference is a documented prompt-and-exit mode: there is no `run`, no `-p`, no `--print` and no `exec`, and nothing it does list is documented as one, so no script can make it call a Tool",
  })
  return verdict(
    HARNESS,
    binary,
    await version(binary),
    steps,
    "openclaw mcp list reads back the mcp.servers.flintd entry. OpenClaw's CLI reference lists no non-interactive prompt mode, so a tool call cannot be driven from a script and this harness stops at the handshake.",
  )
}
