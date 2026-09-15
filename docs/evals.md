# The two lanes

flintd has a free lane that runs on every change and a paid lane that runs before a ship. Nothing under `evals/` is
imported by a package test, so no test lane changes with that directory. `pnpm typecheck` does read it, so a core
type change that breaks `evals/` fails the gate.

## The gate: free, offline, on every change

```
pnpm build       # the Bundle every tier loads, and the dist/ each package publishes
pnpm typecheck
pnpm test        # every package lane
pnpm example     # the two offline examples, end to end
```

Deterministic, no key, no network beyond `127.0.0.1`, and the test runner is `node --test` with nothing on top of
it. `.github/workflows/gate.yml` runs all four on Node 22 and 24, on Linux and macOS, plus the Python lane
(`uv run pytest`, `ruff`, `mypy --strict`).

Per-lane budgets, which are advisory and measured at low load:

| Lane | Command | Budget |
| --- | --- | --- |
| core, fast | `pnpm --filter @flintd/core test:fast` | 3.5 s |
| core, tiers | `pnpm --filter @flintd/core test:tiers` | 4.5 s |
| core, store | `pnpm --filter @flintd/core test:store` | 3.0 s |
| core, library | `pnpm --filter @flintd/core test:library` | 3.0 s |
| core, container | `pnpm --filter @flintd/core test:container` | 3.0 s (skips every test with no OCI engine) |
| daemon, CLI | `pnpm --filter flintd test:cli` | 4.0 s (it starts and stops a real daemon twice) |
| daemon, HTTP | `pnpm --filter flintd test:http` | 3.0 s |
| sdk | `pnpm --filter @flintd/sdk test` | 2.0 s |
| pi | `pnpm --filter @flintd/pi test` | 2.0 s |
| hooks | `pnpm --filter @flintd/hooks test` | 2.0 s |

A lane is as fast as the cores it is given. `node --test` runs the files of a lane beside each other, so a lane costs
its slowest file on a machine with cores to spare and the sum of them on a machine with none. The store lane was
seven files contending for cores, not one slow file: its slowest, `library.test.ts` at 2.22 s, plus six more all
paying the same contention tax. It is now split by measured per-file time into `test:store` (`approvals.test.ts`,
`concurrency.test.ts`, `observer.test.ts`, `pulled.test.ts`) and `test:library` (`held-out.test.ts`,
`library.test.ts`, `sync.test.ts`), each four files or fewer. Measured twice at a load average of 6.4: core fast
3.90 s and 3.83/3.97 s, core tiers 3.89 s (3.78/4.00 s), core container 2.93 s (3.01/2.85 s), core store 3.23 s
(3.24/3.23 s), core library 3.66 s (3.62/3.70 s). The tiers lane is near its own slowest file, `executor.test.ts` at
2.58 s, which carries the catastrophic `pattern` test. The tiers budget is 4.5 s and not 3.5 s because the Node
tier default is a fresh child for every call: `node-tier.test.ts` pays about 54 ms a call where a warm child paid
0.6 ms, and the tests that measure the warm path ask for it by name. The same lane measured 3.97 s before that
change and 4.4 to 5.1 s after it, on a machine that was running a second workload throughout. The daemon CLI lane
is one smoke test that starts every command that changes nothing at once, rather than paying for twenty-six binary
spawns in a row. The budgets above
are set for low load; the run that produced these numbers ran at roughly twice that, so every lane reads over its
own budget here without being a regression.

The budgets are advisory: they exist so a lane that doubles is noticed, not so a loaded machine fails a gate. The
same lanes cost two to three times as much on a machine already running something else.

`.github/workflows/gate.yml` also packs the five tarballs, installs them with `npm` into a temporary directory and
runs what an operator runs first: the CLI, `import("@flintd/sdk")`, the hook binary and
`flintd init --harness claude-code --dry-run`. The dev tree resolves paths a published install does not, and that
job is what proves the difference.

The container tier is covered by no CI runner: the runners have no OCI engine and no image, so `test:container`
skips every test there. That tier is proved on a developer machine and by the paid lane.

## The evals lane: a real model, real money, before a ship

```
pnpm eval [--suite held-out|harness|observer|all] [--dry-run] [--model <id>]
pnpm eval:check     # the shape checks: free, offline, under a second
```

The operator key lives in `~/.flintd/eval.env`, mode 0600 (`OPENAI_API_KEY`, and the org and project ids). The same
names in the environment win over the file. The runner never prints, logs or writes any of them: the key reaches the
daemon through the `config.json` of a temporary flintd home that is deleted at the end of the run, and the results
file carries the token usage and no credential. `EVAL_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` runs the same
lane against the Claude API.

### What a run costs

`--model <id>`, else `EVAL_MODEL`, else `gpt-5-mini` (`claude-sonnet-5` for anthropic). The runner reads the
provider's own model list at the start of every run and refuses a model the provider does not serve; it never
guesses an id.

Before it starts, the run prints its estimate: the prompts it will run times the per-prompt token estimate times the
price. **A run stops when the estimate is over `EVAL_MAX_USD`, which is $2 by default.** Every model call of the run,
the runner's own authoring calls and the daemon's Held-out generations and judgments alike, goes through a local
metering proxy, so the cost in the results file is measured and not estimated. A model with no price row is run and
reported `unpriced`.

### The thresholds

| Suite | What it does | Threshold |
| --- | --- | --- |
| `held-out` | twenty fixed prompts (`evals/prompts.json`), plus one container prompt where an OCI engine exists: author `tool_create` with the eval model, create over REST, decide the Approval a Manifest raised, send the prompt once more where flintd refused the write or the grant, wait for the Held-out run, call the Tool once | **90 percent of the prompts that ran reach Verified.** The command exits non-zero below it |
| `harness` | one script per harness against a temporary `HOME`: `flintd init`, `flintd init --check`, the harness's own `mcp list`, and then one real tool call driven through the harness with this run's meter as its model endpoint | **every installed harness passes.** A harness that is not on `PATH` is skipped with the reason |
| `observer` | three sessions of one repeated two-step pattern through `POST /api/v1/observations`, then one `POST /api/v1/observe` | **1 of 1**: a Draft came back and its newest Version carries the Channel `observer`, read through `tool_history` |

The held-out prompts cover the tiers and the Bundle on purpose: 6 pure, 7 one Bundle package each, 3 filesystem,
2 network against a server the runner starts on `127.0.0.1`, 2 composition through `ctx.callTool`, and 1 `exec` in
the container tier. No eval Tool ever reaches a host off this machine.

### A Tool whose Examples need its Manifest is created once

Where the Examples need what the Manifest asks for, the save keeps those Examples as `deferred` and the Tool saves
as a Draft. The runner decides the Approval the way a person would (`evals/held-out.ts`), and the grant runs every
Example again with the Manifest in force before `approved` is written. One create, one decision: no Example is
counted as evidence without having run with what it was granted, and no Body runs with a capability nobody
approved.

### One repair, and only for a refusal

A refusal is flintd saving nothing and saying what to fix, and an agent that reads one sends the write again. Each
prompt gets exactly one such round, and only where flintd refused: a `tool_create` or `tool_update` error, or a
grant that reported its Examples did not pass. The second prompt is the first prompt and the refusal flintd
returned, with nothing added, because that message is what is being measured. Where the refused write left a Tool
in the Library, the repair changes it with `tool_update` rather than writing it again.

**A Held-out failure is never re-prompted.** The Held-out examples are the verification gate and the authoring
model has never seen them; handing them back as advice would leave the rate measuring nothing.

The results file carries two rates: `firstPassRate`, the prompts that passed with no repair, and `rate`, the
prompts that passed at all, which stays the one the 90 percent threshold is checked against. **Read `repaired`, the
count of prompts flintd refused, before either rate: it is the measure of whether a refusal message says enough to
act on.**

No harness suite runs a model prompt: every harness keeps its credentials under the operator's own `HOME`, and this
lane never uses that `HOME`.

The observer suite proves the proposal half, which is the half that costs money. Detection is deterministic and
belongs in the gate, where `packages/core` already holds it.

### The results file

`evals/results/<UTC timestamp>.json`, checked against the schema in `evals/results.ts` before it is written. The
directory is ignored by git: a run measures one machine on one day, and it is a record for whoever ran it rather
than a published artefact. It carries the per-prompt and per-harness outcomes, the measured token usage and cost split between the
runner and the daemon, the durations, the model id, and the git tree hash of the working tree the run measured.

The file is saved as the run goes: after every held-out prompt, after the Observer and after every harness, always
to the one path the run settled at its start. `stopped` says how far it got. It reads `the run had not finished
when this file was written` while the run is still going, `stopped by SIGINT` or `stopped by SIGTERM` when a signal
ended it, the error when one did, and `null` only for a run that reached its own end. `ran` and both rates are over
the prompts that really ran, so a file a killed run left is read exactly like any other, and `ok` is false whenever
`stopped` is not null. The summary is printed only at the end, so a part of a run is never read off the console as
a rate.

**The newest file whose `stopped` is null is the evidence for a ship.** A file a killed run left behind is a
record, never a result, so read `stopped` before you read any rate.

**Read `repaired` before `rate`.** A prompt that fails and then passes on flintd's own error message proves the
message was actionable, which is what decides whether a real agent's loop closes. A prompt that fails twice on the
same message proves it was not, and that is a defect in flintd rather than in the model. The repair round found one
on its first run: a refusal that said only that a result differed, twice, with nothing for the model to act on. That
is why `example_failed` now names the expected value and the returned one.

**The rate measures the authoring model and the generator, not flintd's runtime.** Runs on one tree have scored
between 7 and 17 of 21, moving with the model that wrote the Bodies rather than with any change to flintd. Read the
per-prompt reasons before the rate, and treat a single number from a single run as worth very little.

Neither judge failed a Tool in the latest run. The plausibility judge holds to the Tool's description alone, and a
refusal it cannot quote from that description is undecided and counts as no evidence. The acceptance judge answers
one question on a throw, whether the description says the Tool takes arguments like those, and charges the Tool
only where it can quote a clause that says so. Before it existed, a generator that handed a file path to a
directory lister failed the Tool four runs running.

The price table in `evals/model.ts` carries the URL it was read from and the date. Re-read both pages before a ship,
or the cost line of a results file is wrong.

`evals/README.md` holds the rest: how to add a prompt, what each harness script proves, and where the prices come
from.
