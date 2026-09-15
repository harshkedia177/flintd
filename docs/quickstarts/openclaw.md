# OpenClaw

## Connect

```
flintd serve                                  # in its own terminal
export FLINTD_TOKEN="$(cat ~/.flintd/token)"  # in the terminal that starts OpenClaw
flintd init --harness openclaw                # --scope project moves the skills directory only
```

Restart `flintd serve` after the first `init`: the daemon reads `config.json` at start, and that is where the skills
directory lands.

## What it writes

| What | Where |
| --- | --- |
| MCP server | `~/.openclaw/openclaw.json`: `mcp.servers.flintd` with `url`, `transport: "streamable-http"` and `headers.Authorization`, plus `hooks.internal.entries.flintd.enabled` |
| Hook | `~/.openclaw/hooks/flintd/HOOK.md` and `~/.openclaw/hooks/flintd/handler.ts` |
| Skills directory | `~/.agents/skills`, or `<repo>/.agents/skills` with `--scope project` |

OpenClaw keeps one config, so `--scope project` writes the same `~/.openclaw/openclaw.json` and only the skills
directory follows the project. The header is written as `Bearer ${FLINTD_TOKEN}`, which OpenClaw resolves itself.

**OpenClaw documents no tool-call hook event**, so this hook records the start and the reset of a conversation
(`command:new`, `command:reset`) and no tool call. The Observer therefore sees nothing of what OpenClaw ran, and
works from flintd's own call log for this harness.

## Confirm

```
flintd init --harness openclaw --check   # exits 1 when anything is missing
openclaw mcp list                        # the flintd server as OpenClaw sees it
```

## The first Tool

**OpenClaw documents no answer to `tools/list_changed`**, so flintd assumes it reads the tool list once. A Tool that
becomes Active while you work never appears as `fl_<name>` for it. The seven meta tools are the whole surface here:

1. `tool_find` with what you want: *"count the words in a text"*.
2. `tool_run` with the name it answered and the arguments.

`tool_create` writes the Tool in the first place, and `tool_run` calls it in the same session. The skills directory
is the second path to the same place: `~/.agents/skills` holds one `SKILL.md` per Active Tool and one that teaches
the CLI.

## Transcripts

`flintd init --harness openclaw --transcripts yes` lets the Observer read the transcripts of this harness. The
default is no, and with no tool-call hook there is little for it to read. Read [the Observer](../observer.md) before
you answer yes; the answer takes effect at the next `flintd serve`.
