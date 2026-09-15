# Changelog

## 0.1.0

The first release. A Library of Tools that agents write for themselves, served by one daemon to every Harness on the
machine and to your own agent loop.

### The Tool and its Versions

- A Tool is a name, a description, a JSON Schema for its arguments, an optional schema for its result, a Body, its
  Examples, its Manifest, its stats and its Provenance. It is the only first-class unit.
- Every write is a Version: one commit in the Library's own git repository, restorable by id. Git is the source of
  truth; the SQLite index is rebuilt from it.
- Two Libraries: the user Library in the flintd home and the project Library in the working directory. The project
  Tool wins a name collision. With a git remote set, the daemon pulls on start and pushes after each commit; a
  concurrent change to one Tool keeps both Versions and flags the Tool for review.

### The save gate and the lifecycle

- `tool_create` runs every Example before anything is saved. One failure saves nothing and names the failure. The
  one exception is an Example that could not run because the Tool's own Manifest is still waiting for its Approval:
  that one is saved as deferred, and the grant runs every Example again with the Manifest in force.
- A near-identical Verified or Active Tool refuses the save and names that Tool; a near-identical Draft is a warning.
- Draft → Verified on Held-out examples flintd's own model wrote. Verified → Active on five clean calls spread
  across two sessions, two calendar days or two harness names, or on one Approval. At most 50 Active Tools per
  Tenant, and nothing is ever retired to make room.
- Contribution is the call record adjusted by Outcome reports, and it ranks the model-facing list.

### Execution

- Three tiers behind one `ctx`: QuickJS in WebAssembly, a Node child process under the permission model, and one
  container per call on an OCI engine. The Manifest picks the lowest tier that fits.
- A schema may carry `pattern`. flintd never compiles it on the main thread: the tier's own prelude checks the
  arguments before the Body runs and the result before it returns, under the call's timeout and interrupt.
- The Bundle: `zod`, `date-fns`, `cheerio`, `papaparse`, `yaml`, `marked`, `lodash-es`, `jsonpath-plus`, fixed for
  this release and present in every tier, plus ten pure Node builtins.
- `ctx.callTool` composes Tools, with cycle detection and one clock for the whole chain.

### Security

- A Manifest declares a filesystem root, hosts, Connections and `exec`, and any non-empty Manifest waits for one
  Approval before a Body runs with what it asks for. An Approval is inherited only when the Manifest is unchanged
  and the new Body passes every Example.
- The Proxy is the only network path in every tier: it enforces the host list, attaches a Connection's credential
  and strips the ones a Body tried to set. A Body receives a Connection's name, never its value.
- Every credential flintd holds is struck out of what a Body, a log line, an error, a Provenance excerpt and a fetch
  answer carry.
- The Node tier's network lock is the resolve hook plus deleted globals: `node:net`, `node:http`, `node:https`,
  `node:http2`, `node:tls`, `node:dgram` and `node:dns` are outside the import allowlist, and `fetch`, `WebSocket`,
  `EventSource` and `XMLHttpRequest` are deleted before the Body loads. From Node 25 the absent `--allow-net` refuses
  a socket as well.
- The daemon binds `127.0.0.1`, checks the Origin, and needs a bearer token on every request.

### Surfaces

- CLI: `serve`, `init`, `status`, `tools`, `find`, `call`, `report`, `observe`, `approvals`, `connect`, `export`.
- MCP over Streamable HTTP: the seven meta tools — `tool_create`, `tool_update`, `tool_read`, `tool_find`,
  `tool_run`, `tool_retire`, `tool_history` — plus the Active Tools as `fl_<name>`, `listChanged`, and Approvals
  through elicitation where a client supports it.
- `flintd init --harness` for Claude Code, Codex, OpenCode, Hermes, OpenClaw and pi: the MCP or extension config,
  the hook scripts and the skills directory, with `--check` to confirm.
- SKILL.md export: one skill per Active Tool and one that teaches the CLI, regenerated on every change.
- TypeScript SDK, embedded and remote, with `anthropic`, `openai`, `openai-chat`, `gemini`, `vercel` and `mcp`
  lists, `callFrom`, and adapters for the Vercel AI SDK, the OpenAI Agents SDK, LangChain and Google ADK.
- Python client, remote only, standard library only, with the Pydantic AI toolset.

### The Observer

- Reads flintd's own call log always, and a harness's Observations and transcripts only where the operator answered
  yes. Proposes a Tool for a pattern seen in three sessions in seven days, through the same gate, on the observer
  Channel. It lists retirement proposals and retires nothing.

### Packages

`flintd` (the daemon, the CLI and the `flintd` binary), `@flintd/core`, `@flintd/sdk`, `@flintd/hooks`,
`@flintd/pi` on npm; `flintd` on PyPI. Node 22.18 or newer, every tier included. Apache-2.0.
