# The flintd evals lane

This is the **periodic** lane, not the gate. It calls a real model, it costs money, and it runs before a ship.
Nothing here runs in CI's gate job and nothing under `evals/` is imported by any package test, so `pnpm test` and
`pnpm typecheck` are the same with this directory as without it.

```
pnpm eval [--suite held-out|harness|observer|all] [--dry-run] [--model <id>]
pnpm eval:check     # the shape checks, free, offline, under a second — this one may run in CI
```

## The key

The operator key lives in `~/.flintd/eval.env`, mode 0600:

```
OPENAI_API_KEY=...
OPENAI_ORG_ID=...
OPENAI_PROJECT_ID=...
```

The same names in the environment win over the file. The runner reads them and **never prints, logs or writes any
of them**: the key reaches the daemon only through the `config.json` of a temporary flintd home, and the results
file carries the token usage and no credential. That home is removed on **every** path — a clean run, a failed
start, an exception, and a Ctrl-C, which the runner traps to stop the daemon and remove the home before it exits.
`--dry-run` never reads the key at all. Every harness smoke step drops
a line that names an authorization header before it goes into the results file, because a harness prints what it
sends.

`EVAL_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` runs the same lane against the Claude API.

## The model, and what a run costs

`--model <id>`, else `EVAL_MODEL`, else `gpt-5-mini` (`claude-sonnet-5` for anthropic). The runner reads the
provider's own model list at the start of every run and refuses a model the provider does not serve, naming what it
does serve. It never guesses an id.

Prices are the table in `evals/model.ts`, read from
[developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing) and
[platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing) on
2026-09-14. A model with no row is run and reported `unpriced` rather than refused.

Before it starts, the run prints the estimate: the prompts it will run × the per-prompt token estimate in
`run.ts` × the price. **`EVAL_MAX_USD`, $2 by default, is checked twice**: once against that estimate before
anything starts, and then against the **measured** spend before every prompt, before the Observer and before every
harness, so a run that costs more than it predicted stops instead of finishing. What is left is recorded `skipped`
with the spend that stopped it. A model with no row in the price table cannot be capped and is refused, unless
`EVAL_ALLOW_UNPRICED=1` says to run it uncapped.

Every model call of the run — the runner's own authoring calls, the daemon's Held-out generations, judgments and
duplicate checks, and a harness driven through its own base URL — goes through a local metering proxy, so the cost
in the results file is measured and not estimated. The proxy is the daemon's `model.baseUrl` for the run. Its path
carries a secret this run made, so nothing else on the machine can spend the operator's key through a loopback
port, and it counts the answers whose usage it could not read so an under-count is never silent.

| Suite | Model calls | Roughly |
| --- | --- | --- |
| `held-out` | 21 authoring calls, plus what the daemon spends per Tool | see the latest file in `evals/results/` |
| `harness` | none | free, but it runs four harness binaries |
| `observer` | one per candidate, at most five | a few cents |

## What each suite proves

### `held-out` — threshold 90 percent

Twenty fixed prompts (`evals/prompts.json`) plus one container prompt when an OCI engine is on the machine. For
each prompt the runner:

1. asks the eval model to author the `tool_create` arguments, giving it flintd's own `tool_create` definition read
   live from the daemon's tool list and nothing else;
2. calls `tool_create` over REST;
3. approves any Approval the Manifest raised, the way the operator would, and sends the Tool again — a Manifest's
   Examples cannot pass before a person decides, which is the documented flow;
4. waits for the Held-out run of that Version to settle;
5. calls the Tool once with a fixed probe.

**A prompt passes when the Tool is Verified**, which is `held_out.status === "passed"`. The probe call is held to
the prompt's own `expect` where the prompt fixes the answer, so a call proves the Tool works and not merely that
nothing threw. The pass rate is over the
prompts that ran; a prompt that was skipped (no Docker, or its dependency was never written) is not counted either
way. The run exits non-zero below 90 percent.

The kinds, and what each one is there for:

| Kind | Count | What it exercises |
| --- | --- | --- |
| `pure` | 6 | the QuickJS tier with no host function, and `node:buffer` for the Node tier |
| `bundle` | 7 | one Bundle package each: zod, yaml, date-fns, papaparse, marked, cheerio (Node tier), jsonpath-plus |
| `fs` | 3 | a Manifest `fs` root, the Approval, and `ctx.fs.read` / `.write` / `.list` |
| `network` | 2 | a Manifest `hosts`, the Approval, and `ctx.fetch` through the Proxy to a server on 127.0.0.1 the runner starts |
| `composition` | 2 | `ctx.callTool` against a Tool an earlier prompt wrote |
| `exec` | 1 | `"exec": true`, the container tier, and `ctx.exec`. Skipped with no OCI engine |

No eval Tool ever leaves this machine: the two network prompts reach a `http.createServer` on 127.0.0.1 that the
runner starts and stops.

### `harness` — no installed harness may fail

One script per harness under `evals/harness/`. Each one checks whether the binary is on `PATH` and reports
`skipped` with the reason when it is not. When it is there, the script runs `flintd init --harness <name>
--scope user` against a **temporary HOME and a temporary flintd home this run made and deletes**, runs
`flintd init --check` and asserts exit 0, then drives the harness's own command.

The temporary flintd home matters: it carries the daemon's port and token and nothing else, so `flintd init`
writing `skillExports` and the transcript answer cannot reach the daemon under test. The runner compares the
daemon's own `config.json` before and after the suite and fails the run if it moved.

| Harness | Handshake | A tool call |
| --- | --- | --- |
| Claude Code | `claude mcp list` → a live MCP handshake, `${FLINTD_TOKEN}` expanded | `claude -p`, with `ANTHROPIC_BASE_URL` pointed at this run's meter. Needs the **whole run** on `EVAL_PROVIDER=anthropic`: the meter holds one key and one upstream, and the results file prices one model, so an Anthropic lane inside an OpenAI run would report a cost it cannot price |
| Codex | `codex mcp list` → the `[mcp_servers.flintd]` table with `bearer_token_env_var` | `codex exec`, through a `[model_providers.flintd-eval]` table whose `base_url` is the meter. Needs `EVAL_PROVIDER=openai` |
| OpenCode | `opencode mcp list` → a live connection, `{env:FLINTD_TOKEN}` resolved | `opencode run`, with `provider.<name>.options.baseURL` in the run's own `opencode.json` pointed at the meter and the key left as `{env:…}` |
| Hermes | `hermes mcp test flintd` → a live connection **and the seven meta tools by name** | `hermes chat -q`, against the `openai-api` provider, whose endpoint `OPENAI_BASE_URL` points at the meter. Needs `EVAL_PROVIDER=openai` |
| OpenClaw | `openclaw mcp list` → the `mcp.servers.flintd` entry | no: its CLI reference lists no non-interactive prompt mode — no `run`, no `-p`, no `--print`, no `exec` |
| pi | `flintd init` copied the pi extension in and `npm install --omit=dev --prefix <the extension>` gave it the MCP client it holds; pi speaks no MCP itself | `pi -p`, against a provider the run writes into its own `~/.pi/agent/models.json` with the meter as `baseUrl` |

A harness that is not on `PATH` is skipped, except `pi` and `openclaw`: those two are installed for the run with
`npm install --prefix <the run's own directory>` (`@earendil-works/pi-coding-agent` and `openclaw`). The install is
never global and never touches the operator's own tree, and a harness whose install does not produce the binary is
`skipped` with that reason.

Every drive names the Tool and the arguments the held-out suite already proved, and none of them is given an open
stdin: `codex exec` appends piped stdin to its prompt, so a pipe nothing closes costs the drive its whole timeout.

**A status of `pass` is earned only by a tool call the daemon recorded**, which the runner reads from the seeded
Tool's own `stats.calls` before and after — not from anything the harness printed. A harness that reached the
daemon and no further is `handshake`, which is not a failure and is reported as its own count. `fail` means a step
that should have worked did not. The threshold is that no installed harness is `fail`.

The user scope is deliberate: Claude Code holds a project `.mcp.json` server at "pending approval" until a person
opens a session, so a project-scope smoke could never reach "Connected".

### `observer` — threshold 1 of 1

Three sessions of one repeated two-step pattern (`Read(file_path) -> Edit(file_path, new_string, old_string)`) go
in through `POST /api/v1/observations`, which is the smallest corpus that reaches the default `observerRepeats` of
three, because a pattern is counted by the number of **distinct sessions** it ran in. Then one
`POST /api/v1/observe`, and the suite asserts a Draft came back and that its newest Version carries the Channel
`observer`, read through `tool_history`.

This is the proposal half of the Observer, which is the half that costs money. Detection is deterministic and
belongs in the gate, where `packages/core` already holds it.

## The results file

`evals/results/<UTC timestamp>.json`, which git ignores: a run measures one machine on one day. `evals/results.ts` is its schema, and the runner checks
what it built against that schema before it writes, so a reader never has to guess at the shape. It carries the
per-prompt and per-harness outcomes, the measured token usage and cost split between the runner and the daemon, the
durations, the model id, and the git tree hash of the working tree the run measured.

The file is saved as the run goes: after every held-out prompt, after the Observer and after every harness, always
to the one path the run settled at its start. `stopped` says how far it got. It reads `the run had not finished
when this file was written` while the run is still going, `stopped by SIGINT` or `stopped by SIGTERM` when a signal
ended it, the error when one did, and `null` only for a run that reached its own end. `ran` and both rates are over
the prompts that really ran, so a file a killed run left is read exactly like any other, and `ok` is false whenever
`stopped` is not null. The summary is printed only at the end, so a part of a run is never read off the console as
a rate.

A prompt that failed carries the Held-out run's own `failures` beside the reason — the arguments, the grade, what
was expected and what the Body returned — which is what tells a Tool that did not generalize from a flintd defect.

**A prompt the interface refused carries `sent`: the arguments the authoring model wrote, as JSON text, cut to
4096 bytes.** Read it rather than deriving the shape from the refusal. It is what a refusal such as
`invalid_schema: the result schema must be a JSON Schema object` is about, and the runs before 2026-09-15 have no
such field, which is why the report on those runs had to work the shape out from the code path instead. It carries
no credential: the runner sends the model the prompt and the `tool_create` definition, and nothing of the
environment the run holds the key in.

The tree hash is taken with `git add -A` and `git write-tree` under a temporary `GIT_INDEX_FILE`, so the
repository's own index is untouched. It does write the blobs of the working tree into the object store, which the
next commit would write anyway.

## Adding a prompt

Add an object to `evals/prompts.json`:

```json
{
  "id": "unique_snake_case",
  "kind": "pure | bundle | fs | network | composition | exec",
  "prompt": "What the Tool does. Name every argument and its type, so the probe below matches.",
  "probe": { "the_argument": "the value the runner calls the finished Tool with" },
  "expect": "what the finished Tool must answer for that probe",
  "requires": "the id of a prompt whose Tool this one calls, for composition only",
  "requiresDocker": true
}
```

Two rules the runner depends on. **Name the arguments in the prompt text**: `probe` is fixed and the model chooses
the schema, so a prompt that leaves the argument names open fails for a reason that is not flintd's. **Write the
expected behaviour precisely enough for an exact result**: a Held-out example the model is confident about is
graded exactly, and a vague prompt turns the whole suite into the model judging itself.

`{{fixture}}` becomes the base URL of the local server, and `{{requires}}` becomes the name of the Tool the
required prompt wrote. `pnpm eval:check` refuses any other placeholder, a duplicate id, a `requires` that names no
prompt, a count of fixed prompts that is not twenty, and a prompt that omits `expect` without being one of the two
whose answer really moves between runs.

`pnpm eval:typecheck` type-checks this directory. Run it with `eval:check`; neither costs anything.
