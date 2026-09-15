# Claude Code

## Connect

```
flintd serve                                  # in its own terminal
export FLINTD_TOKEN="$(cat ~/.flintd/token)"  # in the terminal that starts Claude Code
flintd init --harness claude-code             # --scope project for this repository alone
```

Restart `flintd serve` after the first `init`: the daemon reads `config.json` at start, and that is where the skills
directory lands.

## What it writes

| Scope | MCP server | Hooks | Skills directory |
| --- | --- | --- | --- |
| user (default) | `~/.claude.json`, `mcpServers.flintd` = `{type: "http", url, headers: {Authorization}}` | `~/.claude/settings.json`, `hooks.PostToolUse`, `hooks.SessionStart`, `hooks.Stop` | `~/.claude/skills` |
| project | `<repo>/.mcp.json` | `<repo>/.claude/settings.local.json` | `<repo>/.claude/skills` |

The `Authorization` header is written as `Bearer ${FLINTD_TOKEN}`, which Claude Code expands itself: the token's
value never reaches a file a team shares. The project scope writes `.claude/settings.local.json` and never the
`settings.json` a team shares, because the hook command names this machine's own paths.

Nothing else in either file is touched. The first run that changes a file somebody else wrote keeps one `<file>.bak`
beside it.

`PostToolUse`, `SessionStart` and `Stop` run `flintd-hook claude-code`, which posts one Observation per tool call:
the harness, the session, the tool name, the **names** of its arguments and the status. No argument value is sent.
`PreToolUse` is deliberately not installed, so a call is never counted twice.

## Confirm

```
$ flintd init --harness claude-code --check
configured	MCP server flintd	/Users/me/.claude.json
configured	hooks	/Users/me/.claude/settings.json
configured	skills directory and transcripts	/Users/me/.flintd/config.json
transcripts off
MCP http://127.0.0.1:3546/mcp
skills /Users/me/.claude/skills
```

It exits 1 when anything is missing, and writes nothing either way. Inside Claude Code, `/mcp` lists the flintd
server and its tools.

## The first Tool

Ask for one in plain words: *"write a flint tool that counts the words in a text, with an example, then call it"*.
Claude Code has the seven meta tools — `tool_create`, `tool_update`, `tool_read`, `tool_find`, `tool_run`,
`tool_retire`, `tool_history` — and every Active Tool as `fl_<name>`. The Example runs before anything is saved, so
a Body that does not work is never written.

Then, from your own terminal:

```
flintd tools list
flintd tools show word_count
```

Claude Code reads `tools/list_changed`, so a Tool that becomes Active while you work reaches the session as
`fl_<name>` without a restart.

## Transcripts

`flintd init --harness claude-code --transcripts yes` lets the Observer read the transcripts of this harness. The
default is no. Read [the Observer](../observer.md) before you answer yes; the answer takes effect at the next
`flintd serve`.
