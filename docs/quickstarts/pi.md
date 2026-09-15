# pi

pi speaks no MCP. `@flintd/pi` is an extension that holds an MCP client of its own, registers the seven meta tools
and every Active Tool at session start, and re-registers on every change the daemon announces.

## Connect

```
flintd serve                        # in its own terminal
flintd init --harness pi            # --scope project for this repository alone
npm install                         # in the extension directory init names
```

**pi needs no `FLINTD_TOKEN`.** The extension reads the port from `<flintd home>/config.json` and the token from
`<flintd home>/token` itself, so `init` prints no export line for it.

Restart `flintd serve` after the first `init`: the daemon reads `config.json` at start, and that is where the skills
directory lands.

## What it writes

| Scope | Extension | Skills directory |
| --- | --- | --- |
| user (default) | `~/.pi/agent/extensions/flintd/` (`package.json`, `src/index.ts`, `src/settings.ts`) | `~/.pi/agent/skills` |
| project | `<repo>/.pi/extensions/flintd/` | `<repo>/.pi/skills` |

pi loads the extension as a directory with its own `node_modules`, so the copied files alone are not a connected pi:
run `npm install` in that directory. `--check` reports `installed, dependencies missing` until you do.

`init` copies the extension that sits beside the daemon. A global install of the `flintd` package alone does not
carry it; then `init` says so and the path is `pi install npm:@flintd/pi`.

pi has no hook surface, so no Observation is written for it and the Observer works from flintd's own call log.

## Confirm

```
$ flintd init --harness pi --check
configured	extension	/Users/me/.pi/agent/extensions/flintd/package.json
...
configured	skills directory and transcripts	/Users/me/.flintd/config.json
```

It exits 1 when anything is missing.

## The first Tool

Ask for one in plain words: *"write a flint tool that counts the words in a text, with an example, then call it"*.
The extension registers the seven meta tools under their own names and every Active Tool as `fl_<name>`, and it
re-registers when the daemon says the list changed. A harness that cannot unregister a tool disables it instead, and
a call that still reaches a Tool that left the list is answered `not_found`, which tells the model to run
`tool_find`.

Then, from your own terminal:

```
flintd tools list
flintd tools show word_count
```
