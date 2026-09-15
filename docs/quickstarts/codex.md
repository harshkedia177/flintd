# Codex

## Connect

```
flintd serve                                  # in its own terminal
export FLINTD_TOKEN="$(cat ~/.flintd/token)"  # in the terminal that starts Codex
flintd init --harness codex                   # --scope project for this repository alone
```

Restart `flintd serve` after the first `init`: the daemon reads `config.json` at start, and that is where the skills
directory lands.

## What it writes

| Scope | MCP server | Hooks | Skills directory |
| --- | --- | --- | --- |
| user (default) | `~/.codex/config.toml`, `[mcp_servers.flintd]` with `url` and `bearer_token_env_var` | `~/.codex/hooks.json`: `PostToolUse`, `SessionStart`, `Stop` | `~/.agents/skills` |
| project | `<repo>/.codex/config.toml` | `<repo>/.codex/hooks.json` | `<repo>/.agents/skills` |

`bearer_token_env_var = "FLINTD_TOKEN"` is the mechanism Codex documents for a Streamable HTTP server: it reads the
variable at connect time, so no token value is written to a file. The TOML merge keeps everything else in the file,
comments, sub-tables and arrays of tables included, and rewrites only `url` and `bearer_token_env_var`.

The hooks run `flintd-hook codex`, which posts one Observation per tool call: the harness, the session, the tool
name, the **names** of its arguments and the status. No argument value is sent.

## Confirm

```
flintd init --harness codex --check      # exits 1 when anything is missing
codex mcp list                           # the flintd server as Codex sees it
```

## The first Tool

**Codex reads the MCP tool list once per session and ignores `tools/list_changed`.** A Tool that becomes Active
while you work never appears as `fl_<name>` for it. The seven meta tools are the whole surface here:

1. `tool_find` with what you want: *"count the words in a text"*.
2. `tool_run` with the name it answered and the arguments.

`tool_create` writes the Tool in the first place, and `tool_run` calls it in the same session. The skills directory
is the second path to the same place: `~/.agents/skills` holds one `SKILL.md` per Active Tool and one that teaches
the CLI, and Codex reads that directory and its parents.

## Transcripts

`flintd init --harness codex --transcripts yes` lets the Observer read the transcripts of this harness. The default
is no. Read [the Observer](../observer.md) before you answer yes; the answer takes effect at the next
`flintd serve`.
