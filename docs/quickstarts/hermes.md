# Hermes

## Connect

```
flintd serve                                  # in its own terminal
export FLINTD_TOKEN="$(cat ~/.flintd/token)"  # in the terminal that starts Hermes
flintd init --harness hermes                  # --scope project moves the skills directory only
```

Restart `flintd serve` after the first `init`: the daemon reads `config.json` at start, and that is where the skills
directory lands.

## What it writes

| What | Where |
| --- | --- |
| MCP server | `~/.hermes/config.yaml`: `mcp_servers.flintd` with `url` and `headers.Authorization` |
| Hook plugin | `~/.hermes/plugins/flintd/plugin.yaml` and `~/.hermes/plugins/flintd/__init__.py` |
| Skills directory | `~/.hermes/skills`, or `<repo>/.hermes/skills` with `--scope project` |

**Hermes keeps one MCP config**, so `--scope project` writes the same `~/.hermes/config.yaml` and only the skills
directory follows the project.

The header is written as `Bearer ${FLINTD_TOKEN}`. Hermes resolves `${VAR}` in a header at connect time, from the
environment and from `~/.hermes/.env`, so no token value is written to a file.

The plugin's `post_tool_call` posts one Observation per tool call: the harness, the session, the tool name, the
**names** of its arguments and the status. No argument value is sent.

## Confirm

```
flintd init --harness hermes --check     # exits 1 when anything is missing
hermes mcp test flintd                   # a live connection, and the seven meta tools by name
```

## The first Tool

Ask for one in plain words: *"write a flint tool that counts the words in a text, with an example, then call it"*.
The seven meta tools and every Active Tool as `fl_<name>` are in the session. Then, from your own terminal:

```
flintd tools list
flintd tools show word_count
```

## Transcripts

`flintd init --harness hermes --transcripts yes` lets the Observer read the transcripts of this harness. The default
is no. Read [the Observer](../observer.md) before you answer yes; the answer takes effect at the next
`flintd serve`.
