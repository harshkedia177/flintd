#!/usr/bin/env node
// A harness reads what a hook prints, so a Node warning on stdout or stderr is noise in someone else's turn. The
// entry is imported after the filter, so nothing loads before it.
process.removeAllListeners("warning")
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") process.stderr.write(`${warning.stack ?? warning.message}\n`)
})

const { runHook } = await import("../src/run.ts")

await runHook(process.argv.slice(2))
// Nothing this hook started may outlive it: a harness that never closes the pipe must not hold the turn open.
process.exit(0)
