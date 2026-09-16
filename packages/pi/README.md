# @flintd/pi

The flintd extension for the pi coding agent. It connects to a running flintd daemon over MCP and registers the
Library as pi tools: the seven meta tools, and every Active Tool as `fl_<name>`. A Tool promoted while you work
appears in the same session, and a Tool that is retired leaves the active set without a reload.

## Install

The extension needs `@modelcontextprotocol/client`, so it installs as a directory with its own `node_modules`.

```
pi install npm:@flintd/pi
```

Or copy it in by hand:

```
mkdir -p ~/.pi/agent/extensions/flintd
cp -R packages/pi/package.json packages/pi/src ~/.pi/agent/extensions/flintd/
cd ~/.pi/agent/extensions/flintd && npm install
```

Start the daemon first: `flintd serve`. Then start pi.

## Configuration

Nothing to write when the daemon runs on this machine with its own home: the extension reads the port from
`<flintd home>/config.json` and the token from `<flintd home>/token`. The home is `$FLINTD_HOME`, or `~/.flintd`.

Write `<flintd home>/pi.json` when the daemon is somewhere else:

| Key | What it is |
| --- | --- |
| `url` | the MCP URL, default `http://127.0.0.1:<port from config.json>/mcp`. `http` is for the loopback address only; any other host must be `https`, because the token rides every request |
| `token` | the bearer token, read from the token file when this is absent |
| `tokenFile` | another file to read the token from, absolute or relative to the flintd home |

```json
{"url": "http://127.0.0.1:3546/mcp", "tokenFile": "token"}
```

A key this extension does not read is refused by name at session start. A file that holds a token, `pi.json` with
a `token` key or the token file itself, must not be readable by other users: run `chmod 600` on it, which is the
mode `flintd serve` writes its own token file with.

## What it registers

- `tool_create`, `tool_update`, `tool_read`, `tool_find`, `tool_run`, `tool_retire`, `tool_history`: the meta
  tools, with the daemon's own argument schemas.
- `fl_<name>` for every Active Tool, with the Tool's own argument schema and description.

Each pi session names itself to the daemon (the `X-Flintd-Session` header), so the calls of one session count
toward a Tool earning its place in the list.

## The approval flow

A Tool whose Manifest asks for the filesystem, a host, a Connection or a shell waits for a person to decide. The
first call answers with the daemon's own refusal, which names the line that grants it:

```
awaiting_approval: … flintd approvals approve <tool>
```

Run that line in another terminal, then ask the model to call the Tool again. This extension asks no question of
its own.

## Limits

- pi has no way to unregister a tool. A Tool that leaves the list is taken out of the active set instead, so the
  model stops seeing it; a call that reaches it anyway is refused by the daemon.
- The extension forwards no call record for pi's own built-in tools. The daemon has no route for one yet.
