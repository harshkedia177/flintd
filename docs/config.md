# Configuration reference

The daemon reads `~/.flintd/config.json` once, at `flintd serve`. `FLINTD_HOME` moves that directory, and the token,
the Connections and the default Library directory move with it. **No key in this file is re-read while the daemon
runs, except `harnesses.<name>.transcripts`**: change any other key and restart `flintd serve`. The Observer reads
the transcripts answer again at every run, so `flintd init --harness <name> --transcripts no` takes that consent
away at once and needs no restart. The skills directory `flintd init` writes is an ordinary key, so the first
`init` for a harness does need a restart before that directory is exported.

A key this build does not read is refused by name, and so is a value of the wrong type. When the file holds a model
key or a Connection, it must be mode 0600, the same check the token file gets.

Every key below is also an option of `createFlint`, except the four marked **daemon only**, which have no meaning
in an embedded Library. The table was written by reading `packages/daemon/src/config.ts` (the reader and the
messages), `packages/core/src/index.ts` and `packages/core/src/search.ts` (the defaults) and
`packages/daemon/src/cli.ts` (the mapping). There is no generator: `packages/daemon` has no `scripts/` directory,
and one script for one table is more moving parts than the table.

## Where things live

| Key | Type | Default | `createFlint` |
| --- | --- | --- | --- |
| `port` | whole number, 0 to 65535; 0 binds a free port and writes it to `<flintd home>/port` | `3546` | **daemon only** |
| `libraryDir` | path, relative to the flintd home | `<flintd home>/library` | `userDir` |
| `projectLibraryDir` | path, relative to the working directory | `<cwd>/.flintd/library` when that `.flintd` exists, else none | `projectDir` |
| `libraryRemote` | git remote URL | none | `userRemote` |
| `projectLibraryRemote` | git remote URL | none | `projectRemote` |
| `skillExports` | list of directories; a leading `~` is the home directory | `[]` | **daemon only** |
| `harnesses` | `{"<harness>": {"transcripts": <true or false>}}` | `{}` | `transcriptHarnesses`, the names whose `transcripts` is true |
| `mcpClientQuirks` | `{"<client name>": {"omitOutputSchema": <true or false>}}`, written over flintd's own table | `{"opencode": {"omitOutputSchema": true}}` | **daemon only** |
| `connections` | list of `{name, hosts, header: {name, value}}` | `[]` | `connections` |
| `model` | `{provider, apiKey, model?, baseUrl?, embedModel?}` | none | `model` |

`provider` is `"anthropic"` or `"openai"`. The Anthropic model defaults to `claude-sonnet-5`; an OpenAI-compatible
endpoint has no default and `model.model` is required. `embedModel` turns on embedding search beside the lexical one, and only the
OpenAI-compatible provider serves embeddings: `model.embedModel` reaches `<baseUrl>/v1/embeddings`, so the Anthropic
provider ignores it and the search stays lexical. A Connection written here is listed like any other and `DELETE` refuses it: the file is where it was written
and where it has to be taken out.

## The Library and the lifecycle

| Key | Type | Default | `createFlint` |
| --- | --- | --- | --- |
| `activeCap` | whole number | `50` | `activeCap` |
| `activeListLimit` | whole number | `30` | `activeListLimit` |
| `syncTimeoutMs` | milliseconds | `10000` | `syncTimeoutMs` |
| `stopGraceMs` | milliseconds | `2000` | `stopGraceMs` |

## The model and the Held-out run

| Key | Type | Default | `createFlint` |
| --- | --- | --- | --- |
| `modelTimeoutMs` | milliseconds | `60000` | `modelTimeoutMs` |
| `heldOutTimeoutMs` | milliseconds | `300000` | `heldOutTimeoutMs` |
| `heldOutConcurrency` | whole number | `2` | `heldOutConcurrency` |

## Retrieval and the duplicate refusal

A fraction is a number from 0 to 1.

| Key | Type | Default | `createFlint` |
| --- | --- | --- | --- |
| `findLimit` | whole number | `5` | `findLimit` |
| `duplicateThreshold` | fraction | `0.9` | `duplicateThreshold` |
| `duplicateBand` | fraction | `0.5` | `duplicateBand` |
| `duplicateCosine` | fraction | `0.9` | `duplicateCosine` |
| `duplicateCosineBand` | fraction | `0.8` | `duplicateCosineBand` |
| `duplicateMaxJudgments` | whole number | `3` | `duplicateMaxJudgments` |
| `siblingThreshold` | fraction | `0.6` | `siblingThreshold` |
| `siblingCosine` | fraction | `0.92` | `siblingCosine` |
| `searchCosine` | fraction | `0.5` | `searchCosine` |

`duplicateThreshold` and `duplicateCosine` are the lines above which a save is refused outright.
`duplicateBand` and `duplicateCosineBand` are the lines above which flintd asks the configured model whether the two
are one capability. Between the band and the threshold with no model to ask, the save goes through with a warning.
Every Tool in the band is judged, best first, until one of them is the same capability; `duplicateMaxJudgments`
bounds how many of them one create may ask about, and the best Tool the budget never reached is the warning.

## The Observer

| Key | Type | Default | `createFlint` |
| --- | --- | --- | --- |
| `observerRepeats` | whole number | `3` | `observerRepeats` |
| `observerWindowDays` | whole number | `7` | `observerWindowDays` |
| `observerIdleMinutes` | whole number | `10` | **daemon only** |
| `observerTimeoutMs` | milliseconds | `600000` | `observerTimeoutMs` |
| `observerMaxCandidates` | whole number | `5` | `observerMaxCandidates` |
| `retireContribution` | Contribution, −1 to 1 | `-0.1` | `retireContribution` |
| `retireMinCalls` | whole number | `100` | `retireMinCalls` |
| `retireIdleDays` | whole number | `30` | `retireIdleDays` |

## The limits of one call

| Key | Type | Default | `createFlint` |
| --- | --- | --- | --- |
| `callTimeoutMs` | milliseconds | `30000` | `callTimeoutMs` |
| `terminateAfterMs` | milliseconds | `callTimeoutMs` + 500 | `terminateAfterMs` |
| `maxArgsBytes` | bytes | `1000000` | `maxArgsBytes` |
| `maxResultBytes` | bytes | `1000000` | `maxResultBytes` |
| `maxBodyBytes` | bytes | `262144` | `maxBodyBytes` |
| `maxCallDepth` | whole number of Tools in one chain | `8` | `maxCallDepth` |
| `maxLogLines` | whole number | `200` | `maxLogLines` |
| `maxLogBytes` | bytes | `1024` | `maxLogBytes` |
| `memoryLimitBytes` | bytes | `67108864` | `memoryLimitBytes` |
| `maxFetchBytes` | bytes | `5242880` | `maxFetchBytes` |
| `fetchTimeoutMs` | milliseconds | `30000` | `fetchTimeoutMs` |
| `maxExecBytes` | bytes | `1048576` | `maxExecBytes` |

`maxResultBytes` bounds one `ctx.fs` read or write as well as the result of a call. `fetchTimeoutMs` is never longer
than what is left of the call. `maxExecBytes` bounds the stdout and the stderr of one `ctx.exec`, each on its own.

## The tiers

| Key | Type | Default | `createFlint` |
| --- | --- | --- | --- |
| `containerImage` | image reference | `node:<the Node major flintd runs>-alpine` | `containerImage` |
| `containerEngine` | `"docker"` or `"none"` | `"docker"` | `containerEngine` |
| `containerTimeoutMs` | milliseconds | `300000` | `containerTimeoutMs` |
| `warmNodeRunners` | whole number, 0 or more | `0` | `warmNodeRunners` |

`warmNodeRunners` is the isolation-against-latency trade of the Node tier, and the default is isolation. At `0` no
child stays warm: the child is retired at the end of every request, every call pays a fresh one, and nothing of one
call can reach the next. Measured on the machine this was written on, that is 54 ms a call against 0.6 ms warm.

Above `0` the pool holds that many children — the Tools called most recently — and each holds tens of mebibytes. A
warm child is per Tool and not per session, so every session that calls that Tool is answered out of one process,
and what stands between one call and the next is a sweep that puts back what it can name and reach and retires the
child when it cannot. `docs/security.md` says what is put back, what retires the child, and what still crosses a
call. Set it above 0 when 0.6 ms against 54 ms is worth that to you, and for a Tool whose callers are one session.

`"containerEngine": "none"` says outright that this machine has no OCI
engine and asks nothing of it. flintd does not pull `containerImage`; `docker pull` does.

## Options `createFlint` takes and `config.json` does not

| Option | What it is |
| --- | --- |
| `dir` | one directory for one Library, the short form of `userDir` with no project Library |
| `connectionsFile` | where the Connections are kept. The daemon always passes `<flintd home>/connections.json` |
| `clock` | what the call ledger reads for "now". A test seam; the default is `Date.now` |
| `onLog` | every `ctx.log` line, redacted. `flintd serve --verbose` is this option |
| `onApproval` | the callback that answers an Approval request with `approve`, `deny` or `defer` |

## An example

```json
{
  "port": 3546,
  "activeCap": 80,
  "model": { "provider": "openai", "apiKey": "...", "model": "gpt-5-mini", "embedModel": "text-embedding-3-small" },
  "skillExports": ["~/.agents/skills"],
  "harnesses": { "claude-code": { "transcripts": true } },
  "connections": [
    { "name": "github", "hosts": ["api.github.com"], "header": { "name": "Authorization", "value": "Bearer ..." } }
  ]
}
```

Write the file with mode 0600 when it holds a key, or the daemon refuses to start and says so.
