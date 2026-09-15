#!/usr/bin/env node
// node:sqlite and Node's own type stripping each write an ExperimentalWarning, and a CLI that prints one on every
// run is noise an operator cannot act on. The entry is imported after the filter, so nothing loads before it.
process.removeAllListeners("warning")
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") process.stderr.write(`${warning.stack ?? warning.message}\n`)
})

const { main } = await import("../src/cli.ts")

process.exitCode = await main(process.argv.slice(2))
