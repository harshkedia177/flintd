# The Observer

The Observer reads what already happened, finds a sequence of steps that keeps coming back, and asks the model for
one Tool that does the whole sequence in one call. Every proposal enters as a Draft through the gate every create
goes through. **It retires nothing, ever.**

## What it reads, and what consent gates

| Input | Read when | What it gives |
| --- | --- | --- |
| the `calls` table of every Library | always. flintd ran those calls itself | the Tool, the session and the time of every call that did not fail |
| the `observations` table | only for a harness with `harnesses.<name>.transcripts` true | the tool name, the **argument names** and the status of what that harness ran |
| the transcript at `transcriptPath` | only for the same consented harness | the `tool_use` and `tool_result` entries, and nothing else in the file |

**Consent is one answer and it gates both.** `flintd init --harness <name> --transcripts yes` is the answer.
Answer no and the Observer has flintd's own call log alone: that harness's Observations and its transcripts are both
invisible to it, and its rows stay in the table for `GET /api/v1/observations` alone. The Observer reads the answer
again at every run, so a change takes effect at the next run and never waits for a restart.

`transcriptPath` is the harness's own path, written by whoever posts the Observation. flintd validates nothing
about it beyond the caps every Observation field gets: the reader opens it as a file, under the consent of that
harness, and skips it when it cannot be read. It grants a caller nothing it did not already have.

Where a session has a readable transcript, the transcript is that session's record and its hook rows are not counted
beside it, so one call is never two steps.

## The pattern rule

A **step** is one tool name with its argument names, sorted: `Bash(command)`. A **pattern** is 2 to 5 steps that ran
in that order inside one session: `Bash(command) -> Read(file_path)`.

The count of a pattern is **the number of distinct sessions it ran in**, never the number of times it ran, so a loop
inside one session proves nothing. A pattern that ran in `observerRepeats` sessions (default 3) inside
`observerWindowDays` days (default 7) is a **candidate**.

- One step is a candidate on its own when the tool is not one flintd already holds: not a meta tool and not an `fl_`
  export. That is how one repeated command shape becomes a Tool.
- A pattern inside a longer one that ran in as many sessions is dropped, so the candidate is the longest sequence
  the evidence carries.
- A row with no session is skipped: a step with no session belongs to no sequence.
- A session event (`SessionStart`, `Stop`, `on_session_start`, `command:new` and the rest) is not a step, and
  neither is a step that failed.
- At most `observerMaxCandidates` candidates (default 5) go to the model in one run, worst-repeated first. One
  candidate is one model call, so this key is the cap on what a single run can spend.

**Detection needs no model.** `flintd observe --dry-run` answers the candidates and asks nothing of any provider,
and so does a run on a daemon with no model configured, which says so on its last line.

## What is stored

The pattern signature and its counts, and nothing else: the tool names, the argument names, the number of sessions,
and the first and last time.

**No transcript text and no argument value is ever stored or returned.** The reader opens the transcript, takes at
most the first 1 MiB, keeps the name of each `tool_use` and the names of the keys of its input, drops the ones whose
`tool_result` says `is_error`, and throws the rest away. A transcript that cannot be read is skipped, counted in
`transcripts.skipped` and logged, and the run goes on.

The Provenance of a proposal carries the pattern signature as its excerpt, through the same redaction and the same
4 KB cap every excerpt goes through, and says in so many words that flintd records no argument value and that every
value in the Examples is one the model invented.

## The proposal

One model call per candidate, with a JSON schema, answering a name, a description, an argument schema, a Body and
Examples. flintd then calls `tool_create` with **Channel `observer`** and that excerpt. From there it is an ordinary
create: the Examples run before anything is saved, the duplicate refusal applies, the Tool lands as a Draft of no
session, and a Held-out run follows it. A refused proposal is recorded with its `ToolError` code and message, and
nothing is written. `git log` says `create(<name>): observer`.

A proposal asks for no Manifest, so it runs in QuickJS and needs no Approval. A proposal lands in the Library a
create with no `meta.library` lands in, which is the project Library when one is open.

## Retirement proposals

| Reason | When |
| --- | --- |
| `contribution` | an Active or Verified Tool whose Contribution is at or below `retireContribution` (default −0.10) after at least `retireMinCalls` calls (default 100) |
| `idle` | an Active or Verified Tool whose last call is `retireIdleDays` days old or older (default 30) |

Each proposal carries `name`, `library`, `state`, `reason`, `calls`, `errors`, `contribution`, `lastCallAt` and
`idleDays`, so the operator reads the numbers and not a verdict. A Draft is never proposed, and a Tool that was never
called is never proposed for idleness: no call is no evidence of how long it has been idle.

**Nothing here retires anything.** `flintd observe --retire <name>` calls `tool_retire`, the same path an agent and
the CLI use, and that is an operator's act. `flintd tools restore <name> <version>` brings the Tool back.

## The schedule and the commands

`flintd serve` observes once a day, and only while the daemon is idle: no call in the last `observerIdleMinutes`
minutes (default 10). The first run comes one whole day after the daemon started, one run at a time. A run in flight
and a `flintd observe` that meet are one run with one answer. One whole run is bounded by `observerTimeoutMs`
(default 10 minutes), and each model call by `modelTimeoutMs`.

```
flintd observe                 run the Observer now; with a model, propose
flintd observe --dry-run       list the candidates and ask no model
flintd observe --proposals     the retirement proposals, with their numbers
flintd observe --retire <name> retire that Tool, through tool_retire
```

Every one takes `--json`. Every one needs a running daemon, as every command but `serve` and `init` does.
`flintd status` carries one `observer` line for the last run, and `GET /api/v1/status` carries
`{running, lastRunAt, candidates, drafts, refusals, retirements}`.

## The keys

`observerRepeats`, `observerWindowDays`, `observerIdleMinutes`, `observerTimeoutMs`, `observerMaxCandidates`,
`retireContribution`, `retireMinCalls` and `retireIdleDays` in `config.json`. See
[the configuration reference](config.md).
