# OpenCode

## Connect

```
flintd serve                                  # in its own terminal
export FLINTD_TOKEN="$(cat ~/.flintd/token)"  # in the terminal that starts OpenCode
flintd init --harness opencode                # --scope project for this repository alone
```

Restart `flintd serve` after the first `init`: the daemon reads `config.json` at start, and that is where the skills
directory lands.

## What it writes

| Scope | MCP server | Plugin | Skills directory |
| --- | --- | --- | --- |
| user (default) | `~/.config/opencode/opencode.json`, `mcp.flintd` = `{type: "remote", url, enabled, headers}` | `~/.config/opencode/plugins/flintd.js` | `~/.config/opencode/skills` |
| project | `<repo>/opencode.json` | `<repo>/.opencode/plugins/flintd.js` | `<repo>/.opencode/skills` |

The `Authorization` header is written as `Bearer {env:FLINTD_TOKEN}`, which is OpenCode's own substitution, so no
token value is written to a file.

The plugin forwards one Observation per tool call: the harness, the session, the tool name, the **names** of its
arguments and the status. No argument value is sent. **OpenCode's documented plugin hooks carry no failure of their
own, so a tool call it forwards is recorded `ok`.**

OpenCode refuses a tool that carries an `outputSchema`, and the daemon takes it off the list for this client
through the quirk table. Nothing to set: `mcpClientQuirks` ships with `{"opencode": {"omitOutputSchema": true}}`.

## Confirm

```
flintd init --harness opencode --check   # exits 1 when anything is missing
opencode mcp list                        # the flintd server as OpenCode sees it
```

## The first Tool

Ask for one in plain words: *"write a flint tool that counts the words in a text, with an example, then call it"*.
The seven meta tools and every Active Tool as `fl_<name>` are in the session. Then, from your own terminal:

```
flintd tools list
flintd tools show word_count
```

## Transcripts

`flintd init --harness opencode --transcripts yes` lets the Observer read the transcripts of this harness. The
default is no. Read [the Observer](../observer.md) before you answer yes; the answer takes effect at the next
`flintd serve`.
