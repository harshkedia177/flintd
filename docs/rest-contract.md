# flintd REST contract (frozen at wave A, extended by tickets 06, 07, 08, 09, 10, 11, 12, 13, 14, 16, 17 and 18)

This file is the contract every flintd client implements: the TypeScript remote client
(`packages/sdk/src/remote.ts`), the Python client (`python/src/flintd/client.py`, remote only and standard library
only), and the framework adapters of `packages/sdk/src/adapters/`.
The server is `packages/daemon/src/server.ts`. Change this file and the server in the same diff, never one alone.

## Envelope rule

**Every response body is a JSON object with exactly one key. On success the key names the payload. On failure
the key is `error`.**

That is the whole rule. There is no bare payload and no second top-level key. A client reads one key and stops.

```
200  {"status": {...}}          200  {"tools": [...]}        200  {"call": {"id": "...", "result": ...}}
404  {"error": {"code": "not_found", "message": "...", "details": {}}}
```

`error` always carries `code` (one of `TOOL_ERROR_CODES`), `message` (written for a model to act on) and
`details` (an object, possibly empty). A client that meets an unknown `code` maps it to `internal_error`.

## Transport

| Item | Value |
| --- | --- |
| Bind address | `127.0.0.1` only |
| Base path | `/api/v1` |
| Authorization | `Authorization: Bearer <token>` on every request, compared in constant time |
| Origin | when an `Origin` header is present it must be the daemon's own origin, else `403 forbidden` |
| Request body | `application/json` (or no `Content-Type`), at most 1048576 bytes, else `413 request_too_large` |
| Response | `application/json`, one line, trailing newline |
| Trailing slash | stripped before routing |
| `HEAD` | follows `GET` |
| `/mcp` | the MCP surface, Streamable HTTP, behind the same token and Origin check; see "MCP" below |
| `X-Flintd-Session` | optional, on `/mcp` only: the session an MCP call belongs to, at most 128 printable characters |

**`port: 0` is published in the flintd home.** The config may name port 0, and the daemon then binds a free port
the operator never chose. `flintd serve` writes the port it bound to `<flintd home>/port` and its own process id to
`<flintd home>/pid`, beside the token, and takes both files away again on a clean stop, so the hook, the pi
extension and the CLI read the running daemon's address rather than assuming 3546. A configured port that is not 0
wins over the file; with neither, the default is 3546, and a `--url` the operator passes wins over all of it.

**`flintd init` starts the daemon when nothing answers**, rather than asking a person to start a service before
they can connect an agent. It probes the port first and starts nothing when a daemon already answers there; any
answer counts, including the refusal an unauthenticated request receives. `--check` and `--dry-run` start nothing,
because neither is allowed to change the machine.

**`flintd stop` ends the daemon this home is running.** It signals the pid only when the published port still
answers: an operating system reuses a pid, so an alive pid alone is no proof that process is this daemon. Anything
else is a stale file, which it clears without signalling. Stopping a daemon that is not running is not a failure and
exits 0.

The Origin check runs before the token check, so a browser page on another origin is refused even with a
correct token.

## Routes

| Method | Path | Query | Request body | Success key |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/status` | — | — | `status`: `FlintStatus` |
| GET | `/api/v1/tools` | — | — | `tools`: `ToolDefinition[]` (the model-facing list: the meta tools plus the Active Tools) |
| GET | `/api/v1/library` | — | — | `library`: `LibraryEntry[]` (every Tool of every Library, shadowed names once) |
| GET | `/api/v1/approvals` | — | — | `approvals`: `ApprovalEntry[]` (every live Approval request) |
| POST | `/api/v1/approvals/<id>/approve` | — | `{note?}` | `approval`: `ApprovalDecision` |
| POST | `/api/v1/approvals/<id>/deny` | — | `{note?}` | `approval`: `ApprovalDecision` |
| GET | `/api/v1/connections` | — | — | `connections`: `{name, hosts}[]` (never the header value) |
| POST | `/api/v1/connections` | — | `{name, hosts, header:{name,value}}` | `connection`: `{name, hosts}` |
| DELETE | `/api/v1/connections/<name>` | — | — | `connection`: `{name, hosts}` of the one that went |
| GET | `/api/v1/observations` | `since`, `harness`, `limit` | — | `observations`: `Observation[]`, newest first |
| POST | `/api/v1/observations` | — | `{harness, tool, status, session?, argumentKeys?, transcriptPath?, at?}` | `observation`: the `Observation` as stored |
| GET | `/api/v1/observe` | — | — | `proposals`: `RetirementProposal[]`, worst Contribution first |
| POST | `/api/v1/observe` | — | `{dry_run?}` | `run`: the `ObserverRun` |
| GET | `/api/v1/find` | `q`, `limit` | — | `find`: `FindEntry[]` (the Tools closest to `q`) |
| POST | `/api/v1/call` | — | `{name, args?, meta?}` | `call`: `{id, result}` |
| POST | `/api/v1/calls/<id>/report` | — | `{outcome, note?}` | `report`: `{id, tool, library, outcome, contribution}` |
| GET | `/api/v1/tools/<name>` | `source`, `examples` | — | `tool`: the `tool_read` answer |
| GET | `/api/v1/tools/<name>/history` | `before`, `limit`, `source` | — | `history`: the `tool_history` answer |
| POST | `/api/v1/tools/<name>/restore` | — | `{version, meta?}` | `result`: the `tool_update` answer |
| POST | `/api/v1/tools/<name>/retire` | — | `{meta?}` | `result`: the `tool_retire` answer |

`<name>` is percent-decoded. A segment that is not valid percent encoding is `400 invalid_name`; it never
reaches the Library and never produces a 500.

A boolean query parameter is true when it is present and empty, `1`, or `true`. Anything else is false.

**A Connection header value is write-only.** It goes in on the POST and no route ever answers with it: the Proxy
attaches it to a Tool's request and nothing else reads it. The value lives in the flintd home, never in a Library,
so it is never committed. A Connection that comes from the config file is listed like any other and `DELETE`
refuses it with `400 invalid_arguments`, because the file is where it is written and where it has to be taken out.

`meta` is the `CallMeta` object: `sessionId`, `harness`, `model`, `excerpt`, `library`, `tokens`. **A caller does
not choose the Channel**: a `channel` in `meta` is `400 invalid_arguments`. A write a caller makes is the agent
Channel, and flintd itself writes the observer, the file and the flintd Channels, which is what makes the Channel
of a Version worth reading.
`tokens` is `{input?, output?}`, whole counts the caller reports. flintd stores them as given and never estimates a
count of its own. `sessionId` also decides what a Draft answers: a Draft is reachable by the session that created
it and by a call that names no session, and a call from another session gets `404 not_found` on the call itself and
on `tool_read`, `tool_history`, `tool_update` and `tool_retire`.

**`sessionId` is not a security control, and neither is `harness`.** Both are strings the caller chooses, and this
daemon authenticates the token, not either of them. One caller can read its own Drafts under any session name it
likes, and can reach promotion by sending two session strings, by sending two harness strings, or by waiting for
the clock to turn over: each of the three arms of the rule is as forgeable as the others, deliberately, because the
rule is about spread and not about identity. The boundary `sessionId` draws is between the honest sessions of one
Tenant, so an unfinished Draft does not reach a colleague's tool list; it is not a boundary between people.
Everything behind one token belongs to one Tenant.

`GET /api/v1/status` → `status` carries `active` (the Active Tools of the union) and `activeCap`, beside `tools`,
`retired`, `invalid`, `review`, `model`, `tiers` (`{"container": {"available", "engine", "version"}}`) and
`libraries`.

## The call id, and why `/call` answers `call` and not `result`

`POST /api/v1/call` answers `{"call": {"id": ..., "result": ...}}`. `result` is the Tool's own result, any JSON
value, so the id cannot travel beside it inside the payload, and the envelope rule allows exactly one top-level
key. The payload is therefore the call, not the bare result. The embedded and remote clients keep
`call(name, args, meta)` returning the result alone, and add `callWithId(name, args, meta)` for the pair, so code
that only wants the answer is unchanged.

`id` is a string for a call that reached a Tool, and `null` for a call that reached a meta tool, which records no
call of its own. `tool_run` carries the id of the Tool call it dispatched.

A call that fails still has an id, and a harness has every reason to report on it, so a refusal that comes from a
recorded call carries `details.callId`: `{"error": {"code": "call_failed", "message": "…", "details": {"callId":
"…"}}}`. A refusal raised before the Body ran, such as `invalid_arguments` or `not_found`, carries no id, because no
call was recorded.

`POST /api/v1/calls/<id>/report` records an Outcome report against one recorded call. `outcome` is `"positive"` or
`"negative"`; anything else is `400 invalid_arguments`. `note` is an optional string, cut to 1024 bytes. An id this
daemon has no record of is `404 not_found`. A second report on one call replaces the first, so a report is never
counted twice. A negative report counts that call as a failure and a positive one counts it as a success:

```
contribution = (successes - failures) / calls
```

`LibraryEntry` carries `calls`, `errors`, `lastCallAt`, `contribution`, `tier`, `manifest`, `approval` (the
Approval status, or `null` for a Tool with an empty Manifest) and `downgraded` (see "A Version another Library
wrote" below), read live from the Library index. The
`stats.json` of a Tool directory is written from the index with the Tool's next Version, so git shows the counts as
of that Version rather than after every call.

## The result schema

A Tool may declare a JSON Schema for its result. `tool_create` and `tool_update` take it as `result_json`, beside
`parameters_json`. Both fields read the schema object itself and that same object written as a JSON string, and a
string that holds JSON text which is itself a JSON string is read once more, because a model that quoted the schema
twice still sent the schema. Anything else is `400 invalid_schema` with the form to send instead. `result_json` is
optional, its root may be any type (`{}` promises nothing), and flintd
checks it with the same keywords it checks arguments with: `type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`,
`pattern`. `additionalProperties` takes `true` or `false` only; a schema there is refused, and the shape of a value
belongs under `properties`. A schema flintd cannot check is `400 invalid_schema`.

**`pattern` is the one keyword flintd never runs on the main thread.** A `pattern` is a string of at most 256
characters, and a longer one is `400 invalid_schema` at the save. The regular expression is the model's own, so it is
compiled inside the Tool's own tier: the prelude of the QuickJS, Node and container tier walks the argument schema
for a `pattern` on a string and refuses `400 invalid_arguments` naming the property **before the Body runs**, and
walks the result schema the same way **before the result returns**, refusing `400 invalid_result`. A `pattern` is
refused at the save on any `type` but `"string"`, because nothing would check it.

**What bounds a walk that never finishes is the tier, and the two tiers bound it differently.** In the QuickJS tier
the runtime's own interrupt handler stops the regex, so the call ends at `callTimeoutMs` as `408 timeout`. In the
Node and container tiers the regex is V8's and cannot be interrupted: the child's own timer cannot fire while the
event loop is held, so the bound is the pool's `terminateAfterMs` (`callTimeoutMs` + 500 by default), at which the
runner is killed and restarted and the call ends as `408 timeout`. Either way one call pays and the next one runs.
Nothing else changes: every other keyword is still checked on the main thread, before a tier is asked for anything.

It lives in `tool.json` and is versioned with the Body, and a change to it is a change like any other: every
Example runs again and the Tool goes back to Draft.

| Where | What it does |
| --- | --- |
| the save gate | an Example whose result the schema refuses is `400 invalid_result` and nothing is saved |
| every call | a result the schema refuses is `400 invalid_result`; the message names the mismatch and the call is recorded as a failure |
| a Held-out example | a result the schema refuses is a failure with that reason, and the model is never asked to judge it |
| `tool_read` | `result` carries the schema, or `null` |
| `GET /api/v1/tools` | a Tool that declares one carries it as `result` beside `parameters` |
| MCP `tools/list` | a `fl_` Tool whose result schema declares `"type": "object"` carries it as `outputSchema`; any other root carries none, because `structuredContent` is an object |

Declare one only when the shape is fixed. A Tool that declares none is held to nothing, which is what every Tool
written before this was.

## The Manifest, the tier and the Approval

A Tool's Manifest says what it needs to reach. It is empty by default, it lives in `tool.json`, and it is versioned
like the Body:

```
{"fs": "workspace", "hosts": ["api.example.com"], "connections": ["github"], "exec": true}
```

| Field | Meaning |
| --- | --- |
| `fs` | one directory path, relative to the Library directory. `..`, an absolute path, `.` and any directory flintd owns (`tools`, `index.sqlite*`, the lock, `.git`, `.gitignore`) are `400 invalid_manifest` |
| `hosts` | exact lower-case hostnames, no scheme, no port, no path, no wildcard, at most 20 |
| `connections` | Connection names, lower-case letters, digits, underscores and hyphens, at most 20 |
| `exec` | `true` asks to run a command, which needs the container tier |

`tool_create` and `tool_update` take the Manifest as `manifest_json`, a JSON string, beside `parameters_json`. A
Manifest flintd cannot read is `400 invalid_manifest` and nothing is saved. **A Manifest change is a Version like a
Body change**: every Example runs again, the Tool goes back to Draft, and the Held-out run that follows is what earns
Verified again.

The Manifest and the Body's imports pick the tier, which `tool_read`, `GET /api/v1/library` and `flintd tools list`
all carry:

| The Tool | Tier |
| --- | --- |
| an empty Manifest | `quickjs`, with no host function installed |
| `fs`, `hosts` or `connections` | `quickjs`, with the host functions the Manifest asks for |
| a Body that imports a Node builtin, or `cheerio` | `node`, a child process under Node's permission model (see Security below) |
| `exec` | `container`, one container per call, on the machine's OCI engine (see Container below) |

A Body imports only what flintd ships: the Bundle below, and these Node builtins, each of them pure computation:
`node:assert`, `node:buffer`, `node:crypto`, `node:path`, `node:punycode`, `node:querystring`, `node:string_decoder`,
`node:url`, `node:util`, `node:zlib`. Any other specifier, and any import whose name is worked out while the Body
runs, is `400 invalid_source` (ADR 0003) with the specifier named.

### The Bundle

The Bundle is fixed for a release and versioned with flintd (ADR 0003). `pnpm build` writes one ESM file per package
into `packages/core/dist/bundle/`, and both tiers load that file: no Body and no Bundle file ever reaches
`node_modules`. A Body imports one with `await import("<name>")`, which is the only import form a Body can write,
because a Body is the inside of a function.

| Package | Version | Tier | Why |
| --- | --- | --- | --- |
| `zod` | 4.6.4 | `quickjs` | |
| `date-fns` | 4.4.0 | `quickjs` | |
| `jsonpath-plus` | 10.4.0 | `quickjs` | |
| `lodash-es` | 4.18.1 | `quickjs` | |
| `marked` | 18.0.13 | `quickjs` | |
| `papaparse` | 5.7.0 | `quickjs` | `import Papa from "papaparse"`: it has one default export and no named ones |
| `yaml` | 2.9.1 | `quickjs` | |
| `cheerio` | 1.2.0 | `node` | it decodes its entity tables with `Buffer`, which the QuickJS tier does not have |

A Body that imports `cheerio` selects the Node tier, the way a Body that imports a Node builtin does. Every other
Bundle package runs in either tier and changes nothing about the one the Manifest picked.

**`jsonpath-plus` evaluates a filter expression as code.** `JSONPath({ path: "$[?(@.n > 1)]" })` compiles the part
inside `?(...)`. That is no new capability — a Body already holds `Function` — but a Body that passes a path it took
from its own arguments runs whatever the caller wrote, inside the Tool's own Manifest. Build the path in the Body,
or take the field name as an argument and put it into a path the Body owns.

### `ctx`

| Field | What it does |
| --- | --- |
| `toolName` | the name of the Tool running |
| `log(message)` | one line to the daemon log, redacted, never part of the result |
| `callTool(name, args)` | run another Tool in the Library and get its result |
| `fetch(url, init?)` | the Proxy, when the Manifest declares `hosts` |
| `fs.read(path)`, `fs.write(path, text)`, `fs.list(dir)` | files under the Manifest root, when the Manifest declares `fs` |
| `exec(command, options?)` | one command line inside the container, when the Manifest declares `exec` |

Every filesystem path is resolved on the main thread against the real path of the Manifest root: an absolute path, a
`..`, a symlink that leads out, a dangling symlink and any directory flintd owns are all refused, and a read or a
write over `maxResultBytes` is refused with the bound.

`setTimeout(run, ms, ...rest)` and `clearTimeout(id)` are **plain names a Body can use, not fields of `ctx`**:
write `setTimeout(...)`, never `ctx.setTimeout(...)`, and note that `globalThis.setTimeout` is `undefined` in the
QuickJS tier. `setInterval` throws: a call ends, and a repeating timer has nothing to repeat into. A `setTimeout`
set for longer than the call has left never fires, and the call ends at its timeout; a timer still waiting when the
call settles is dropped, and a timer the Body never awaits holds up neither its own call nor the next one. A timer
callback that throws is dropped with it: it fails no call, in either tier, so a Body that needs to know catches its
own.

### `ctx.callTool`

`ctx.callTool(name, args)` runs another Tool through the same door a caller uses: the arguments are checked against
the callee's own schema, the callee's Approval must be in force, the callee runs in its own tier and its own worker
turn, and the call is recorded as a call of the callee with the caller's call as its parent.

- **The callee's Manifest governs the callee, and the caller cannot widen it.** A caller that declares no host still
  cannot reach one; a callee that declares one reaches it only once a person has granted it.
- **A chain that reaches a Tool twice is `400 recursive_call`, with the chain named.** So is a chain longer than
  `maxCallDepth`, which is 8 by default: eight Tools in one chain, counting the one the caller ran.
- **The caller's clock bounds the callee.** What is left of the caller's call timeout is the whole of the callee's.
- **A callee's refusal reaches the caller's Body as a thrown error with `code` and `message`**, so a Body can catch
  it. A Body that throws it onward fails its own call with `call_failed`: no Body can put a lifecycle code on a call,
  whatever it throws.

**Any non-empty Manifest waits for one Approval before a Body runs with what it asks for.** That is every place a
Body runs, not only a call: the save gate, the Held-out run and every call all run the Body with the capabilities
the Approval granted, and until one person grants them that is nothing. A call to a Tool that is waiting is
`403 awaiting_approval`, and the message names what the Manifest asks for and the CLI line that decides it. There is
no automatic denial: with no channel to answer, the request stays `pending` and every call keeps being refused.

So a Tool with a Manifest is written in one step, and its Examples decide what the save records:

| The Examples | What happens |
| --- | --- |
| do not need what the Manifest asks for | the gate proves them with the capabilities off, the Tool is saved as a Draft, and the request is pending |
| need what the Manifest asks for | each such Example is saved as `deferred`, the Tool is saved as a Draft, the answer names the Approval and the CLI line, and the request is written so there is something to decide |
| fail for any other reason | the save is refused `400 example_failed` and nothing is written, the same as a Tool with no Manifest |

The Held-out run does not start while the Approval is pending, so a Tool with an undecided Manifest never leaves
Draft. Granting is one turn of the Library's write queue: flintd runs every Example again with the full Manifest while the
request still reads `pending`, and writes `approved` only when they pass. A call that arrives during that run is
refused like any other, and no Version can land between the read and the run. If the Examples fail, the request
stays `pending` with the reason, so the Tool never becomes callable unproved. When they pass, the Held-out run
starts and the Tool can earn Verified on evidence gathered with the capabilities it was granted. A second `approve`
on a Manifest that is already granted reruns nothing and is a promotion.

```
{"id": "...", "tool": "word_count", "version": "...", "manifestHash": "...", "bodyDigest": "...", "manifest": {...},
 "summary": "read and write files under \"workspace\" in the Library directory",
 "status": "pending" | "approved" | "denied", "requester": null, "requestedAt": "...",
 "decidedBy": null, "decidedAt": null, "note": null, "library": "user" | "project"}
```

One Approval is live per Tool: the one for the pair it declares now. **The key names the Body as well as the
Manifest** — `(tenant, tool, manifest hash, body digest)` — so replacing an approved Body asks a person again, the
same as a Manifest change does. A restore to a Version whose Manifest and Body were approved before finds that same
pair's row and is approved again, with no new decision. A Manifest change, including one a person writes into
`tool.json` by hand, drops the old request and asks again, and the hand-edited directory takes the Tool back to
Draft in the same pass. A Tool with an empty Manifest has no Approval row at all and `approval` is `null`.

flintd keeps the newest 20 rows per `(tenant, tool)`. A Tool that is edited many times over its life does not grow
this table without a bound: past that count, the oldest row by when it was last written or re-asked is dropped once
a new one is written, never the row that is live now.

`POST /api/v1/approvals/<id>/approve` answers the `ApprovalDecision`: the Approval, plus `promotion`
(`promoted`, `blocked` or `unchanged`) and `message`. **An Approval is the human path to Active**: approving a
Verified Tool promotes it, and a full Active cap answers `blocked` with the message that names the
lowest-contribution Active Tool. An id this daemon has no record of is `404 not_found`.

**A decision is about the pair the Approval names, and flintd proves that pair or nothing.** The grant runs every
Example with the Manifest in force, so before it runs anything it compares the Manifest and the Body the Tool
declares now with the `manifestHash` and `bodyDigest` of the row being decided. A Tool whose Body or Manifest changed
between the request and the decision answers `404 not_found` saying the Tool changed since the Approval was raised,
nothing runs, and the row keeps the status it had. Decide the Approval the Tool asks for now, which
`GET /api/v1/approvals` holds.

The embedded SDK also takes an `onApproval(request)` callback on `createFlint`, answering `"approve"`, `"deny"` or
`"defer"`; it is asked once per request, it is never waited on, and `"defer"` leaves the request pending.

**`onApproval(watcher)` on the client is the shared shape**, and both modes answer it: it registers a watcher and
returns the call that takes it off again. The embedded client runs the watcher as soon as a request starts waiting.
A remote client runs it when a call of its own comes back `403 awaiting_approval`, with the request as
`GET /api/v1/approvals` holds it — a daemon calls back into no client it does not hold, and this client polls
nothing. Either way the watcher decides with `approve(id, note?)` or `deny(id, note?)`, which are these routes. A
remote user who wants every request, including the ones another client raised, reads `approvals()`. The CLI is
`flintd approvals list`, `flintd approvals approve <tool> [--version <id>] [--note <text>]` and
`flintd approvals deny <tool> [--version <id>] [--note <text>]`.

Approvals live in the Library index, not in git: a decision is about this machine, and it is never committed. Every
`approve` or `deny` is also appended to `approvals.jsonl` in the flintd home, mode `0600`, one line per decision.
That file sits beside every Library, never inside one, so it is never committed either.

An index that will not open is never deleted. flintd moves it aside to `index.sqlite.broken-<timestamp>`, opens a
fresh index, and replays this Library's lines from `approvals.jsonl` back into it, so a Manifest a person already
decided on keeps that decision. A request that was only ever `pending` in the broken index is gone, and it asks
again the first time it is needed. `status()` names the moved file on the Library it belongs to.

## A Version another Library wrote

A Version is a file, and git is the source of truth for what a Tool *is* (ADR 0001). It is not the source of truth
for what a Tool has *earned*: a colleague who commits `"state": "active"` is making a claim, not showing evidence.
On every start, and after every pull, flintd reads the evidence that travels beside the claim and keeps the state
only as far as that evidence reaches:

| The Version declares | It is kept when | Otherwise |
| --- | --- | --- |
| `verified` | its `held-out.json` says `"status": "passed"` | it is a Draft |
| `active` | its `stats.json` counts 5 calls or more, or this machine holds an Approval for its Manifest | it is Verified |

A Tool that is put below what it declares carries `downgraded` in `library()` and in `tool_read`: one sentence that
says what was claimed and what was missing. The downgrade is about the prompt slot only. The Tool still runs, its
Examples were proved here like any other, and its Manifest still waits for a local Approval before a Body reaches
anything. The Tool climbs back the ordinary way: a Held-out run here, or five clean calls here.

The downgrade lives in this Library's index and is never committed, so it never travels back to the colleague.

## The container tier

A Manifest with `"exec": true` runs the Tool in a container, and `ctx.exec` is the only place a command line runs.
It never runs on the host, in any tier: a Body that calls `ctx.exec` anywhere else is refused with the sentence that
says how to reach this tier.

```
const answer = await ctx.exec("git rev-parse HEAD", { cwd: "repo", timeoutMs: 5000, env: { LC_ALL: "C" } })
// answer: { ok, code, signal, stdout, stderr, durationMs }
```

`ok` is `code === 0`. `timeoutMs` is bounded by what is left of the call: a command never outlives the call that
started it, and a command that is killed comes back with `signal` set rather than as a thrown error. `cwd` is a path
inside the container: a relative one is relative to `/workspace`, the working directory a command starts in, and an
absolute one is taken as it is, because the container is the boundary and every path inside it is already contained.

`stdout` and `stderr` are **text**. Each is capped at `maxExecBytes` on its own and carries `[cut at <n> bytes]`
when it was cut, the cap counts bytes, and the bytes are then decoded as UTF-8: a command that writes binary comes
back as replacement characters, and a cut can land in the middle of a multibyte sequence and cost that one
character. A Body that wants bytes asks the command for text — `base64`, `hexdump`, `jq` — rather than piping the
bytes out.

**What it needs.** An OCI engine that answers the `docker` command line: Docker, or podman or nerdctl under the same
CLI. flintd asks `docker version` once per process at start, and asks again whenever a container fails to start, so
an engine that stops while flintd runs is reported rather than handed to a Body as its own error. A start that
fails therefore costs that Body at most the runner bound of 10 s plus the detection bound of 5 s before it reads the
refusal, and the call after it reads the refusal at once.

With no engine, `status().tiers.container` reads
`{ "available": false, "engine": "docker", "version": null }`, and a Tool already in the Library is refused
`501 not_implemented` at its call, naming what is missing. A Tool whose Manifest asks for `exec` still **saves** as a
Draft, because its capability-off proof runs in the Node tier and needs no engine; the refusal comes where the
capability does, at the grant, which leaves the request `pending` with that reason.
`"containerEngine": "none"` in the config says so outright and asks nothing of the machine.

| Option | Default | What it is |
| --- | --- | --- |
| `containerImage` | `node:<the Node major flintd runs>-alpine` | the image a Body runs in. flintd does not pull it; `docker pull` does |
| `containerEngine` | `docker` | `docker` or `none` |
| `containerTimeoutMs` | 300000 | the tier's own call timeout, five minutes |

**The container.** One call, one container, and it is thrown away afterwards: a Body never inherits what another
Body left behind, and no state crosses a call. The cost is the start, about 150 ms on a warm daemon, on every call.
A pool of warm containers keyed by the Manifest root is the upgrade path if that ever matters; it would trade that
start for state shared between calls of the same Tool.

```
docker run --rm -i --name flintd-<uuid> --network none --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 512m --cpus 1 --user <uid>:<gid> \
  --workdir /workspace -v <the Manifest root>:/workspace -v <the Bundle>:/bundle:ro \
  -v <flintd>/tier-child.ts:/runner.ts:ro <image> node /runner.ts <allowed imports>
```

Three mounts and no more: the Manifest root, the Bundle, and the runner. The last two are read-only, and the runner
is flintd's own child, the same file the Node tier runs, so one Body harness serves both.

| Flag | Why |
| --- | --- |
| `--network none` | ADR 0002: the Proxy on the main thread is the only way out, so the container opens no socket of its own. `ctx.fetch` still works, and a command inside the container reaches nothing at all |
| `--read-only`, `--tmpfs /tmp` | nothing the image ships can be changed, and scratch space is memory that goes with the container |
| `--cap-drop ALL`, `--security-opt no-new-privileges` | no capability and no way to gain one, so a setuid binary in the image buys nothing |
| `--pids-limit`, `--memory`, `--cpus` | a fork bomb, a leak and a spin cost the container and not the machine |
| `--user <uid>:<gid>` | never root: the uid flintd itself runs as, so what a command writes into the Manifest root belongs to the person who started flintd. A flintd that is itself root falls back to `1000:1000`, the unprivileged user the Node images ship |
| `-v <root>:/workspace` | the Manifest root, read-write, and the only host path a command can reach. A Tool that declares no `fs` gets `--tmpfs /workspace:mode=1777` instead, so a command always has a working directory it can write to and no host path at all |
| `-v <bundle>:/bundle:ro` | the same built Bundle files both other tiers load, so a Tool cannot be proved against one Bundle and run against another |
| `-v <flintd>/tier-child.ts:/runner.ts:ro` | the runner, read-only. The image carries no flintd code, so nothing has to be rebuilt when flintd changes |
| no `-e` of any kind | the environment inside is the image's own. Nothing of the parent's reaches it, and a Connection value never leaves the main thread |

**What it does not promise.** The container is the isolation boundary, and the kernel is shared: this is a
container, not a virtual machine. flintd does not build, pull or verify the image, and an image an operator points
it at is an image an operator trusts. `ctx.fs` is not answered inside the container: it is a host call like
`ctx.fetch`, resolved on the main thread against the real path of the Manifest root, so there is one containment
implementation for all three tiers rather than a second one inside the container that would have to agree with it.
What a command writes under `/workspace` and what `ctx.fs.write` writes are the same directory, seen from two sides.

Both tmpfs mounts are `noexec`, which is Docker's default: a Tool that declares **no** `fs` cannot execute a file its
own command wrote into `/workspace`, though it can still run it through an interpreter (`sh script.sh`). A Tool that
declares `fs` runs from the bind mount, which is not `noexec`, so a script it wrote runs there.

A Body is also the only thing that proves this tier. An Example runs before the Approval and therefore with the
capabilities off, and a capability-off run of a container-tier Body runs in the **Node tier** with an empty Manifest,
so an Example can never call `ctx.exec` and every such Example is deferred. The gate tests of `packages/core` are the
whole of the exec coverage until the evals lane runs Tools that are already approved.

**No CI runner covers this tier.** `test:container` skips every test when the machine has no OCI engine and no
image, and the gate runners have neither, so the container tier is proved on a developer machine and by the evals
lane and never by the gate.

**Stopping.** A call that times out, and `stop()`, both `docker kill` the container and then `docker rm -f` it. The
container holds the process namespace, so whatever a command started inside it, background jobs included, dies with
it. Nothing of the call survives.

## The Proxy, and what `ctx.fetch` answers

`ctx.fetch(url, init?)` is the only network path a Tool has, in every tier. The Body is suspended and the request is
made on the main thread, so the Body holds no socket and no credential (ADR 0002).

```
const answer = await ctx.fetch("https://api.example.com/v1/things", {
  method: "POST", headers: { accept: "application/json" }, body: JSON.stringify(payload),
})
// answer: { status, headers, body }
```

`init` takes `method` (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`), `headers` (a flat object of strings, at most
20) and `body` (a string). The answer carries `status`, the response headers flintd passes on (`content-type`,
`content-length`, `etag`, `last-modified`, `location`, `retry-after`), and `body`: parsed JSON when the response says
JSON, and text otherwise. The request headers never come back.

The Proxy refuses, and the Body sees the refusal as a thrown `Error` whose message names the host and the fix:

| The request | What happens |
| --- | --- |
| a scheme that is not `http` or `https` | refused, naming the scheme |
| a hostname the Manifest does not declare | refused, naming the host and how to declare it. The match is the exact lower-case hostname: no wildcard, no suffix, and no allowance for a loopback or private address unless it is written down. A port is not part of the match |
| a host a declared Connection carries | allowed, and that Connection's header is attached |
| a header the Body set whose name is a declared Connection's header | dropped, and flintd's own is sent |
| `authorization`, `cookie` or `proxy-authorization` set by the Body | always dropped, whether a Connection applies or not. flintd's own credential is the Connection's; one a Body carries came from its arguments, and a Tool is not the way out for a caller's secret |
| `host`, `connection`, `content-length`, `transfer-encoding` set by the Body | always dropped |
| a header name that is not an HTTP header name, or a value holding a control character | refused, naming the header |
| a Connection the Manifest names that this flintd does not hold | named in the refusal, with `flintd connect`, because only the operator can put it right |
| an IPv6 literal | refused, and the message does not ask for one to be declared: a Manifest declares hostnames and would refuse `[::1]` in turn |
| a redirect | followed up to 3 times, and every hop is checked and credentialed again, so a redirect to a host the Manifest does not declare is refused like a direct call to it |
| longer than `fetchTimeoutMs` (default 30000, and never longer than what is left of the call) | refused, naming the bound |
| an answer over `maxFetchBytes` (default 5242880) | refused, naming the bound |
| a Tool whose Approval is no longer `approved` | refused; the Approval is read again at every request, so a decision taken back while a Body runs stops the next one |

Every value flintd holds — the model key and each Connection header value — is struck out of what a Body, a log line,
an error message, a `details` object, a Provenance excerpt and a `ctx.fetch` answer carry. An upstream that quotes the
credential back reaches the Body as `[redacted]`, in the response body and in every response header alike.

`maxFetchBytes` is counted on what the reader yields, which is what the HTTP client has already decompressed, so a
compressed answer is capped by its real size and the stream is cancelled at the bound rather than read to the end.

## Security of the Node tier

The Node tier is a **seat belt, not a sandbox**. It is a child process started with `--permission` and no allow
flag but the Manifest root and the Bundle directory:

```
node --max-old-space-size=<memoryLimitBytes in MiB> --permission --allow-fs-read=<bundle>/* \
  --allow-fs-read=<root> --allow-fs-write=<root> <flintd>/tier-child.ts <allowed imports>
```

The two root flags are there only when a Manifest granted a root. A Body proving with the capabilities off runs in
this tier with an empty Manifest, and then the Bundle directory is the whole of what it may read.

Its environment carries `PATH`, `TMPDIR`, `TEMP`, `TMP`, `LANG` and `LC_*` and nothing else; it has its own process
group, and stopping it stops whatever it started. Child processes, worker threads, native addons and WASI are all
denied because `--permission` denies them and no allow flag turns them back on. The child imports no flintd file, so
it can read none. The Bundle directory holds one built ESM file per Bundle package, plus the `versions.json` the build writes, and every one of
them imports nothing at all, which is what the build asserts before it writes them.

Inside the process, `process.getBuiltinModule`, `process.binding`, `process._linkedBinding` and `process.dlopen`
are deleted before the Body loads, and a `module.registerHooks` resolve hook refuses every specifier outside the Bundle and the Node builtin
list. A Bundle name resolves to that one built file, never to anything under `node_modules`. Without that hook the
save-time import check would be advisory: a Body is a real module and can name a builtin the source never shows.

**One child per Tool.** A Node tier runner is keyed by the Tool it serves and the Manifest root it was started with,
so two Tools that name one root are two children, and what a Body leaves behind in its child is left for its own
Tool and for no other. `warmNodeRunners` is 0 by default and the child is retired at the end of every request, so
every call pays a fresh one, about 54 ms against the 0.5 ms a warm child answers in. Above 0 the pool keeps that
many children warm — the Tools called most recently — and takes the rest away as soon as it has nothing left to run.
A warm child holds tens of mebibytes, and it answers every session that calls its Tool out of one process, which is
what the default trades the latency for.

**What a warm child carries from one call to the next.** A warm child answers every call of its Tool in one
process, for every session, so `globalThis` and every module it has loaded are the same objects each time. At its
first request, before any Body runs, the child records the own property descriptors of `globalThis`, of every
object one level in from it such as `process`, `process.env` and `console`, of the intrinsics with their
prototypes, of the iterator, generator and async prototypes no global name reaches, of its own `import.meta` and
`execute`, and of every object one level in from each module its source names. When the call settles it deletes
every key the Body added and puts back every key it wrote over. It also drops every callback the call scheduled and
did not see run, and puts back the listener map `process` carried before the Body could reach it.

**What cannot be put back retires the child.** A frozen or sealed object, a global the Body defined as
non-configurable, and a package it imported under a name it computed rather than wrote are all detected by the same
sweep, and the child is taken away rather than handed to the next call. A Body that pollutes pays a fresh child; a
Body that does not keeps the warm path.

Some things still cross a call regardless: state a package keeps for itself where the sweep cannot read it, an
object the baseline never named, such as a class prototype reached through a package's own exports, and a promise
chain the Body left running, which resumes after the sweep walked. The sweep is best effort and says so:
`docs/security.md` names each one exactly and says what the default `"warmNodeRunners": 0` and the container tier
answer. The Manifest is the trust
boundary and the child is not: two sessions that call one Tool share its process, so do not hand a Tool a secret you
would not let its next caller read.

**One child holds one request.** The harness hands a Node tier child a single execute frame at a time, and the child
refuses a second while one is in flight. A frame that asks it to run while it is running is a frame a Body wrote,
never the harness's, and it is dropped.

Inside the child, `process.on`, `process.once`, `process.addListener`, `process.prependListener` and
`process.prependOnceListener` refuse the `"message"` event, and `process.send` and `process.disconnect` refuse every
call; the harness takes the references it needs before a Body can reach any of them. `process.channel` stays, because
Node's own reader of the channel reads it, and the object it holds answers `ref`, `unref` and `fd` and no frame at
all. `EventEmitter.prototype` is still a way to add a listener, and `"message"` is not the only event there is, which is
why a call ends with the whole listener map of `process` put back as it was: what a Body attached reads its own call
and never the call after it.

**Every frame carries the token of the request it answers.** flintd gives each dispatched execute request a random
token, keeps it beside the pending call, and hands it to the tier inside the execute frame. A `host`, `result` or
`failure` frame is read only when it names a call that is in flight, on the runner it arrived from, with that call's
token; the comparison is constant-time. Every other frame is dropped, and flintd writes one line about it, under the
runner and the Tool the frame came from rather than under the call it named, once for each request that runner is
handed: a Body that forges in a loop cannot fill the log, and one drop never silences the next.
That is what makes a frame a Body wrote itself, through a command in a container or through any later hole in a tier,
a frame that speaks for nothing and for nobody.

**The network lock of the Node tier is the resolve hook plus the deleted globals, and ADR 0002 rests on both.**
`node:net`, `node:http`, `node:https`, `node:http2`, `node:tls`, `node:dgram` and `node:dns` are outside the ten
builtins a Body may import, so the resolve hook refuses every one of them, whatever name the Body works out while it
runs; and `fetch`, `WebSocket`, `EventSource` and `XMLHttpRequest` are deleted from `globalThis` before the Body
loads. `ctx.fetch` is the only way out of the tier. From Node 25, where `--allow-net` exists, the child is started
without it, so a socket fails with `ERR_ACCESS_DENIED` as well: the permission model is the second lock, never the
only one. The tier runs on Node 22.18 and later, the same floor as flintd itself.

**DNS rebinding is accepted, not defended against.** A declared hostname whose DNS answer is a private address
reaches that address. Three gates stand in front of it: a person approved that exact hostname, the Manifest allows no
wildcard, and a metadata address could be declared outright and would read the same in the Approval prompt. Pinning
the resolved address means dialling an address and carrying a `Host` header, which breaks SNI and every CDN, for a
threat whose entry cost is owning the DNS of a host an operator typed in by hand.

Two limits are worth naming. Node's own documentation says of the permission model: "Symbolic links will be
followed even to locations outside of the set of paths that access has been granted to." `ctx.fs` resolves every
real path itself and refuses one that leads out, so the path a Tool is meant to use is safe; a Body that reaches
raw `fs` through some future hole would have the weaker guarantee. And on macOS the kernel re-injects
`__CF_USER_TEXT_ENCODING` into a scrubbed environment: it carries the user's id, not a credential.

## The limits of one call

Every one is a `createFlint` option and a key in the daemon's `config.json`. `createFlint` also takes `clock`,
which the call ledger reads for "now"; it is a test seam and is no config key.

| Limit | Default | What it bounds |
| --- | --- | --- |
| `callTimeoutMs` | 30000 | one call, including every Tool it calls |
| `maxArgsBytes` | 1000000 | the arguments of one call |
| `maxResultBytes` | 1000000 | the result of one call, and one `ctx.fs` read or write |
| `maxBodyBytes` | 262144 | the Body a `tool_create` or `tool_update` may save |
| `maxFetchBytes` | 5242880 | the answer to one `ctx.fetch` |
| `fetchTimeoutMs` | 30000 | one `ctx.fetch`, and never longer than what is left of the call |
| `maxCallDepth` | 8 | how many Tools one chain may hold, counting the one the caller ran |
| `maxLogLines` | 200 | the `ctx.log` lines of one call; the next line says the limit was reached and the rest are dropped |
| `maxLogBytes` | 1024 | one `ctx.log` line, cut after the redaction |
| `maxExecBytes` | 1048576 | the stdout and the stderr of one `ctx.exec`, each on its own |
| `containerTimeoutMs` | 300000 | one call in the container tier, in place of `callTimeoutMs` |
| `terminateAfterMs` | `callTimeoutMs` + 500 | how long the main thread waits for a tier to stop a Body of its own |
| `warmNodeRunners` | 0 | Node tier children the pool holds warm when it has nothing left to run; 0, the default, is a fresh child for every call |
| `memoryLimitBytes` | 67108864 | the heap one Body may use: the QuickJS runtime limit, and `--max-old-space-size` in whole MiB (floor, and never under 32) for the Node tier child. The container tier takes its own bound from the engine |
| `modelTimeoutMs` | 60000 | one model call |
| `heldOutTimeoutMs` | 300000 | one Held-out run, model calls and Bodies together |
| `stopGraceMs` | 2000 | how long `stop()` waits for a Held-out run and for an embedding pass |
| `syncTimeoutMs` | 10000 | one pull or one push |
| `activeCap` | 50 | Active Tools per Tenant |
| `activeListLimit` | 30 | Active Tools in the model-facing list |
| `heldOutConcurrency` | 2 | Held-out runs at one time |
| `findLimit` | 5 | Tools one `tool_find` returns |
| `duplicateThreshold` | 0.9 | token Jaccard at or above which a save is refused |
| `duplicateBand` | 0.5 | token Jaccard at or above which the model is asked |
| `duplicateCosine` | 0.9 | embedding cosine at or above which a save is refused |
| `duplicateCosineBand` | 0.8 | embedding cosine at or above which the model is asked |
| `duplicateMaxJudgments` | 3 | times one create may ask the model whether two Tools are one capability |
| `siblingThreshold` | 0.6 | token Jaccard at or above which two Tools are siblings |
| `siblingCosine` | 0.92 | embedding cosine at or above which two Tools are siblings |
| `searchCosine` | 0.5 | embedding cosine a vector search counts as a result |

Every refusal names the size, the bound and what to send or return instead.

`ctx.log` reaches the SDK's `onLog` as `{ tool, callId, message }`, redacted, and is never part of the result.
`flintd serve --verbose` writes those lines to stdout as they happen.

## Retrieval

`GET /api/v1/find?q=<query>&limit=<n>` searches the Library by intent and answers `FindEntry[]`:

```
[{"name": "word_count",
  "description": "Count the words in a piece of text.",
  "state": "draft" | "verified" | "active",
  "contribution": 1,
  "library": "user" | "project",
  "score": 1,
  "siblings": [{"name": "count_words", "state": "draft", "library": "user"}]}]
```

`q` is required; an empty or missing `q`, and a `limit` that is not a whole number of at least 1, are
`400 invalid_arguments`. `q` is cut to 2000 bytes and the `tool_find` answer echoes it as flintd read it. `limit`
defaults to `findLimit` (5) and never raises it; the `tool_find` answer carries the `limit` it applied, so a
caller that asked for more can see the cap. `description` is the first sentence of the Tool's description, at most
120 characters.

`score` is the share of the query a Tool matched, from just above 0 to 1, whenever the search was lexical alone —
a number that means the same thing in two different searches. When an embedding search ran beside it the two
retrievers have no common scale, so `score` is normalized against the best entry and the first entry is `1`.

A query whose every word is in nearly every Tool ("the a of") separates nothing and answers `[]` rather than
ranking the Library by accident.

The search is lexical (BM25 over the name, the description, the argument names and the argument descriptions) and
needs no model. With a model whose provider serves embeddings (`model.embedModel`), flintd also embeds each Tool in
the background and runs a vector search beside the lexical one, merging the two by reciprocal rank fusion. An
embedding that fails is logged and the answer is the lexical search alone, never an error.

Near-identical Tools are grouped: one entry comes back for the group, and the rest are named under `siblings`, so a
search never offers two Tools for one capability without saying so. The entry is the member this query ranked
highest; Contribution breaks a tie, and the state (Active, then Verified, then Draft) breaks a tie on that. A Tool
that earned more is still the wrong answer when the query asked for the other one.

Retired Tools and Tools whose directory does not match a Version never appear. A Draft appears only for the session
that wrote it and for a caller that names no session; `GET /api/v1/find` carries no `meta`, so it searches as a
caller that names no session. The meta tools are not in the Library and are never a result.

`POST /api/v1/call` with `tool_find` answers `{"query": "<the query, as flintd read it>", "limit": <the limit it
applied>, "tools": [<the same entries>]}`, and it carries `meta`, so an agent's own session scoping applies to its
Drafts.

## The duplicate refusal

`tool_create`, and a `tool_update` that changes the argument schema, compare the proposed name, description and
argument names against every other Tool of the union.

| The closest Tool | The answer |
| --- | --- |
| Verified or Active, and judged the same capability | `409 duplicate`: the message names that Tool, its state and its argument schema, and nothing is saved |
| a Draft, at any similarity that reaches the band | `200`, the Tool is saved, and the answer carries `warning` naming the Draft |
| in the band with no judgment to be had | `200`, the Tool is saved, and the answer carries `warning` naming the Tool and the similarity |
| below the band | `200`, nothing is said |

The comparison has three bands. At or above `duplicateThreshold` (0.9 token Jaccard) or `duplicateCosine` (0.9)
the two are the same capability and flintd refuses without asking anything. Between `duplicateBand` (0.5) or
`duplicateCosineBand` (0.8) and that line, flintd asks the configured model: both Tools' name, description,
argument schema and Examples go out with one question, "same capability or different?", and only "same" refuses.
Below the band the save goes through with nothing said.

**Every Tool in the band is judged, best first, not only the best one.** Two Tools that differ by one word score
almost the same against a third: `sha512_hex` at 0.80 outranks `sha256_hex` at 0.63 against a paraphrase of
`sha256_hex`, and a "different" on the first used to end the comparison and let the copy through. flintd now walks
the band in order of similarity and stops at the first "same". One create asks the model at most
`duplicateMaxJudgments` times (3), so a Library of any size costs a bounded number of model calls; the Tools the
budget never reached are a band with no judgment behind it, and the best of them is the `warning` the save carries.

**A band with no judgment behind it is a warning, never a refusal.** With no model configured, and when a judgment
fails or the model cannot be reached, the Tool is saved and the answer carries `warning` naming the Tool it reads
like and how alike the two are. No lexical line can separate a copy from a near neighbour — `sha512_hex` and a
word-for-word copy of `sha256_hex` sit at the same 0.875 against it — so flintd says what it sees and lets the
agent decide, rather than refusing work it cannot prove is a copy. A model outage never blocks an agent and never
passes one in silence.

`duplicate` details carry `{name, state, library, parameters, similarity, judged}`. `judged` is the model's
sentence when the model decided, and `null` when the thresholds did. A Tool of exactly the same name is
`409 exists` as before; the duplicate check is about two names for one capability.

A `tool_update` runs the same check when it changes the argument schema or the description, and a restore runs it
on the Version it is bringing back. A change to the Body alone never runs it: that is the same Tool getting better.

## The tool list and one Tool

`GET /api/v1/tools` carries the meta tools and then the Active Tools of the union, best contribution first, at most
`activeListLimit` of them (default 30). Each entry is `{name, description, parameters}`, plus `result` when the
Tool declares a result schema. Names carry no `fl_` prefix here; the export surfaces add it.

`GET /api/v1/tools/<name>` (`tool_read`) carries `manifest`, `tier`, `result` (the result schema, or `null`),
`downgraded` (why the Tool sits below the state its Version declares, or `null`), `approval` (`{id, status,
summary, decided_by, decided_at, note}`, or `null`), `stats`
(`{calls, errors, lastCallAt, p50Ms, tokens, contribution}`), carries `deferred` (the indices of the Examples that
are waiting for the Approval) when any Example is deferred, and carries `promotion`
(`{blocked: true, reason, lowest}`) when a Verified Tool has earned Active and the cap (`activeCap`, default 50 per
Tenant) is full. `reason` names the lowest-contribution Active Tool. Nothing is ever retired to make room.

The four `/tools/<name>` routes are conveniences over `/call`; they exist so a client that thinks in resources
does not have to build meta-tool argument objects. `/call` reaches every meta tool and every Tool, including
ones no route names.

## MCP

`POST /mcp` is the Streamable HTTP MCP surface, on the same port, behind the same bearer token and the same Origin
check as `/api/v1`: both run before the transport sees the request, so an MCP client is refused with the same
`401` and `403` envelopes a REST client is. One daemon serves one Tenant, and every MCP client of that daemon sees
that Tenant's Library.

The surface speaks the 2026-07-28 revision through `@modelcontextprotocol/server`, and that package's own stateless
fallback answers a 2025-era client on the same path.

### The seven meta tools

`tool_create`, `tool_update`, `tool_read`, `tool_find`, `tool_run`, `tool_retire` and `tool_history` are always in
`tools/list`, first and in that order, with the argument schemas of `GET /api/v1/tools`. Every one but `tool_run`
declares `outputSchema: {"type": "object"}`, which is the whole of what flintd promises about a meta tool's answer:
the answer is a JSON object, and its keys are the ones this contract names per tool. `tool_run` declares none,
because its answer is the answer of whatever Tool it ran.

### The `fl_` tools

Every Active Tool of the union is also registered first-class as `fl_<name>`, best contribution first, at most
`activeListLimit` of them (default 30, `activeListLimit` in `config.json`). A first-class Tool carries its argument
schema as `inputSchema` and annotations read from its Manifest:

| Annotation | When it is true |
| --- | --- |
| `readOnlyHint` | the Manifest declares no `fs`, no `hosts`, no `connections` and no `exec` |
| `destructiveHint` | the Manifest declares `fs` or `exec` |
| `idempotentHint` | never: a Body is arbitrary JavaScript and flintd promises nothing about a second call |
| `openWorldHint` | the Manifest declares `hosts` or `connections` |

A Tool carries an `outputSchema` when it declares a result schema whose root is `"type": "object"`, and none
otherwise (see "The result schema"). Annotations are hints, and a client is right to treat them as untrusted.

### `tools/call`

A call to `fl_<name>` runs that Tool; a call to `tool_run` runs the Tool it names. Both answer the same way: one
text content block holding the result as JSON, and `structuredContent` beside it when that result is a JSON object.
The call carries `harness: "mcp <client name>"` into the Provenance of anything it writes.

**The result carries the id of the call in `_meta`, under the key `flintd/call`**, which is the id
`POST /api/v1/calls/<id>/report` takes. It is how an MCP client says a call helped or hurt, the way `callWithId`
serves a REST client; `tool_run` carries the id of the call it dispatched, not one of its own. A call that wrote no
row in the ledger carries no `_meta`. The report is optional and a client that files none still promotes a Tool on
its clean calls.

Every `ToolError` comes back as a tool error result — `isError: true` and one text block reading
`"<code>: <message>"` — so the model reads the refusal and acts on it. A protocol-level JSON-RPC error means the
transport or the request itself was wrong, never that a Tool refused. **A name no Library holds is a tool error
result too**, not the protocol error the spec allows: `not_found` tells the model to run `tool_find`, and a
protocol error would only tell the client.

`callFrom(…, "mcp")` writes a refusal as `{"error": {"code", "message"}}` in its text block, while this daemon's own
`tools/call` writes `"<code>: <message>"`; both carry `isError: true`, and the daemon's spelling is the one this
contract froze.

The `fl_` prefix is the export spelling and nothing else. A Tool may not be named with it (`tool_create` refuses
the prefix), so `fl_<name>` always means the Tool `<name>`; a meta tool answers its own name only, and
`fl_tool_create` is a name no Library holds. This surface and `tools(format)` below apply that spelling with one
implementation, `exportName` and `libraryName` of `packages/core/src/formats.ts`, so a Tool is named the same way
whether a client reads `tools/list` or a developer reads `tools("anthropic")`.

**`X-Flintd-Session` names the session of an MCP call.** The revision has no session of its own to take one from,
so a harness that can set a header writes its session id there and flintd passes it as `meta.sessionId`. The value
is at most 128 printable characters; anything else is read as no session at all, never as an error. A harness that
cannot set a header sends nothing and the call names no session, which is what every MCP call did before.

**`X-Flintd-Harness` names the harness of an MCP call, and is not built yet.** Without it the harness of a call is
`mcp <clientInfo.name>`, which names the client and not the product it runs inside. The plan, when it lands: a
harness that can set a header writes its own name there and flintd passes it as `meta.harness` in place of the
derived one. The value is at most 128 printable characters; anything else is read as no harness at all, never as an
error, and the derived name is used. The guard is the one `X-Flintd-Session` already has, and the two headers are
read in the same place. Until then every call of one client carries the name that client gave itself.

A Tool earns Active on **five clean calls, and evidence that more than one turn used it**: two distinct sessions,
or calls on two distinct UTC calendar days, or two distinct harness names. Any one of the three is enough, so a
surface that carries no session still reaches Active on its own traffic — a burst inside one day from one harness
does not, and that is the point. An Approval decision still promotes a Verified Tool on its own.

A Draft is reachable through `tool_find` and `tool_run`, because an MCP call names no session and a Draft answers a
call that names none. A Draft is never first-class.

### `listChanged`

The surface declares `tools.listChanged`, and a client that opens a `subscriptions/listen` stream with
`toolsListChanged` is sent `notifications/tools/list_changed` whenever the model-facing list changes: a promotion, a
retirement, a demotion, or a change to the description or the argument schema of a Tool that is in the list. Writing
a Draft changes nothing in the list and sends nothing. `tools/list` carries `ttlMs: 60000` and
`cacheScope: "private"`, so a client may hold the list for a minute and still learn of a promotion from the stream.

### Which clients need `tool_run`

A client that reads the tool list once per session, or snapshots it per turn, never sees a Tool that became Active
during the session. Codex, Claude Desktop, the Vercel AI SDK and VS Code are in that group today. For them the
seven meta tools are the whole surface: `tool_find` to find the Tool, `tool_run` to run it.

### The client quirk table

`mcpClientQuirks` in `config.json` is keyed by the client's own `clientInfo.name`, lower case, and is written over
the table flintd ships with:

```
{"mcpClientQuirks": {"opencode": {"omitOutputSchema": true}, "some-client": {"omitOutputSchema": false}}}
```

`omitOutputSchema` takes `outputSchema` off every tool in `tools/list` for that client. flintd ships it on for
`opencode`, which refuses a tool that carries one. A quirk key this build does not read is refused by name, so a new
quirk needs a line in `mcp.ts` and a reader in `config.ts`.

### Approvals through elicitation

When a call is refused with `awaiting_approval` and the request declares the `elicitation` capability in form mode,
the handler answers with an `input_required` result carrying one `elicitation/create` request and a `requestState`.
**The `requestState` is what makes the answer a decision**: it is an HMAC-sealed record of the Approval id and the
hash of the Manifest the person was shown, minted per form, valid for ten minutes, and bound to the method it was
issued on. An answer that arrives without it, with one that does not verify, or with one that names another
Approval or an older Manifest decides nothing and the call is refused again — so a client cannot write an Approval
by attaching `inputResponses` to a call, and a Manifest changed while the form was open is never approved unseen.
A decision is recorded only for `accept` with `decision` of `approve` or `deny`; a dismissal, a decline, or an
accept that names no decision leaves the Approval waiting.

**What elicitation proves, and what it does not.** It proves that flintd issued this form, for this Approval and
this Manifest, and that the answer came back bound to it. It does not prove what the person said: MCP's model has
the client show the form and relay the answer, so a client that reads "deny" from the person and sends `approve`
is believed. No server closes that, and flintd does not pretend to.

The form names the Tool, writes out the Manifest line by line — the root, the hosts and that every port of a
declared host is included, the Connections, and that `exec` is a shell inside the container — and asks for
`decision`, `approve` or `deny`, with an optional `note`. The answer is recorded through the same path
`flintd approvals approve` uses, and when it grants the Manifest the call runs on the retry. A grant the Examples
did not survive is no grant and the call is refused with the reason; a grant the Active cap blocked is a grant, so
the call runs and the cap line comes back beside the result. A client that declares no elicitation gets the
`awaiting_approval` error result with the `flintd approvals approve <tool>` line in it. flintd never asks a client
for sampling.

### The pi extension is an ordinary MCP client

`@flintd/pi` is the reference for what a harness extension does with this surface, and it needs nothing from the
daemon that this section does not already name. It connects to `/mcp` with the bearer token, sets
`X-Flintd-Session` to the harness's own session id, reads `tools/list` once, and registers every entry with the
harness: the seven meta tools under their own names and every `fl_<name>` with its `inputSchema` and its
description. It opens the `subscriptions/listen` stream with `toolsListChanged` and re-registers on every
`notifications/tools/list_changed`.

Two consequences are worth naming for any harness that follows it. **`harness` is the client's own name**: a
client that calls itself `pi` writes `harness: "mcp pi"` into every Provenance, and there is no header that
changes it, so the harness spread arm of the promotion rule separates surfaces and not products. **A harness that
cannot unregister a tool disables it instead**: a Tool that leaves the model-facing list stays registered with
the harness, and a call that still reaches it is answered `not_found` by this daemon, which is the refusal that
tells the model to run `tool_find`. No route is needed for either.

## SKILL.md export

A harness that reads files rather than MCP gets the same Library as a directory of skills. flintd writes one
skill per Active Tool and one that teaches the CLI, in the Agent Skills format the six launch harnesses read
(https://agentskills.io/specification): a directory per skill, holding `SKILL.md` with YAML frontmatter and a
Markdown body. The two fields every one of them needs are `name` and `description`; flintd writes those and
nothing else, because a harness that validates the frontmatter refuses a key it does not know.

| Field | What flintd writes |
| --- | --- |
| `name` | `fl-<tool>` for a Tool, `flintd` for the teaching skill, matching the directory name |
| `description` | the Tool's own one-line description, on one line, at most 1024 characters, double quoted |

**The name is spelled with a hyphen and the call with an underscore.** The spec holds a skill name to 1-64
lower-case letters, digits and single inner hyphens, and refuses an underscore, so the Tool `word_count` is the
skill `fl-word-count` in the directory name and in `name`. The `fl_` spelling is unchanged everywhere a name is
called: the body of that skill says `flintd call fl_word_count '<json>'`, and `flintd call` reads `fl_<name>` as
the Tool `<name>` by the same rule `/mcp` uses (`libraryName` of `packages/core/src/formats.ts`). A Tool name a
skill name cannot hold at all — a doubled or trailing underscore — keeps a digest of its own name on the end so
two Tools never land on one directory.

The body of a Tool's skill holds, in this order: when to use it, taken from the description; the argument schema
in plain words, one line per property with its type, whether it is required, its own description, its `enum` and
its bounds; the result schema the same way when the Tool declares one; the exact CLI line, with arguments built
from the Tool's first Example; and how to read the result and the refusal. `renderSkill(tool, examples)` in
`packages/core/src/skill.ts` is the whole of it, and it is a pure function of a Version: the same Tool renders to
the same bytes, so regeneration writes nothing when nothing changed.

The teaching skill, `flintd/SKILL.md`, says what flintd is, then `flintd find <query>` to discover a Tool,
`flintd call tool_create '<json>'` with a worked example that parses and runs unchanged, what
`awaiting_approval` means and who can decide it, and where the list comes from.

### The sentinel

Every directory flintd writes holds a `.flintd` file beside `SKILL.md`. That file is the whole of what flintd
claims: a regeneration removes a `fl-*` directory that holds it and no longer answers to an Active Tool, and
writes over no `SKILL.md` that sits without it. A skill a person wrote by hand survives every run, `fl-` prefix
or not, and a run that met one reports it as `refused` rather than taking the name.

### `flintd export --to <dir>`

Writes the set into `<dir>`, creating `<dir>/<skill>/SKILL.md`, removing the stale directories it marked, and
writing one line per change: `written`, `removed` or `refused`, then the path. **A missing directory is created,
every parent of it included**, so a path with a typo in it is a new tree and not an error. `--dry-run` lists the
same changes and writes nothing. Exit 0 when it ran, 2 when
`--to` is missing, 1 with `<code>: <message>` on stderr when the daemon refused or the directory cannot be
written.

### Configured directories and regeneration

`skillExports` in `config.json` is a list of directories. A leading `~` is the operator's home directory, and
any other relative path is read from where `flintd serve` was started:

```
{"skillExports": ["~/.agents/skills", "/Users/me/.claude/skills"]}
```

The daemon writes every one of them once at start and again on the `onChange` event — a promotion, a
retirement, a demotion, or a change to the description or the argument schema of a Tool in the list — debounced
by half a second, so a burst of writes costs one pass. The debounce is trailing only: a Library that changed
every 400 ms without pause would put the pass off until it stopped. A directory that cannot be written is never fatal: the
daemon writes one line to stderr and carries the reason in `GET /api/v1/status` under `exports`, which
`flintd status` prints as `skills  <dir>  <reason>`. One Tool that cannot be read is the same kind of news: the
pass leaves that Tool's file as it was, writes every other one, and names it in the same `error` line. A Tool
that is simply gone — retired between the list and the read — loses its file with no line at all.

```
{"status": {"…": "…", "exports": [{"dir": "/Users/me/.agents/skills", "skills": 7, "at": "2026-01-01T09:00:00.000Z", "error": null}]}}
```

### Which harness reads which directory

`~/.agents/skills` is the one directory five of the six read, so it is the first thing `flintd init` should
offer. The per-harness paths, from each harness's own documentation:

| Harness | Where it reads a skill |
| --- | --- |
| Claude Code | `~/.claude/skills/<name>/SKILL.md`, and `.claude/skills/` in the project |
| Codex | `$HOME/.agents/skills`, `$REPO_ROOT/.agents/skills`, `$CWD/.agents/skills` and its parents |
| OpenCode | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`; `.opencode/skills`, `.claude/skills`, `.agents/skills` in the project |
| pi | `~/.pi/agent/skills`, `~/.agents/skills`; `.pi/skills` and `.agents/skills` in the project |
| Hermes | `~/.hermes/skills`; `<project>/.hermes/skills` and `<project>/.agents/skills` in a trusted git repository |
| OpenClaw | `<workspace>/skills`, `<workspace>/.agents/skills`, `~/.agents/skills` |

Two things the research pins down and this build depends on. OpenCode recognizes `name`, `description`,
`license`, `compatibility` and `metadata` and nothing else, which is why flintd writes no key of its own.
Hermes's own page lists `version` as required; flintd does not write it, because the spec has no such field and
a harness that validates the key set would refuse it.

## Observations

An Observation is one line of what a **harness** ran, written by the `flintd-hook` binary of `@flintd/hooks` and
read by nothing else in this build. It is not a call record: flintd did not run the tool, and nothing about an
Observation moves a Contribution, a state or a Version.

```
{"observation": {"id": "…", "harness": "claude-code", "session": "abc123", "tool": "Bash",
                 "argumentKeys": ["command", "description"], "status": "ok",
                 "transcriptPath": null, "at": "2026-01-01T09:00:00.000Z"}}
```

| Field | What it holds |
| --- | --- |
| `id` | flintd's own id for the row. A client never sends one |
| `harness` | the harness name `flintd init` wrote into the hook, at most 64 characters |
| `session` | the harness's own session id, or null |
| `tool` | the harness's tool, or the hook event name for a session event, at most 200 characters |
| `argumentKeys` | the **names** of the arguments, at most 64 of them, each at most 128 characters |
| `status` | `ok` or `error` |
| `transcriptPath` | where the harness keeps that session's transcript, or null |
| `at` | when, ISO 8601. The daemon's clock unless the body names one |

**No argument value ever reaches this row.** The hook reads the names of the keys and throws the values away before
the POST, because a tool argument carries the file, the command and, now and then, the secret. A body that names a
field this build does not read is `400 invalid_arguments`, `id` included: flintd mints the id itself and a caller
cannot choose one. A `status` that is not `ok` or `error` is refused the same way.

`GET` answers newest first. `since` is an ISO 8601 timestamp and is inclusive; `harness` is an exact match;
`limit` is 200 by default and 1000 at most. Both routes are behind the same bearer token as every other route.

The rows live in the user Library's index, which is never committed: an Observation belongs to the Tenant and to
no Library.

## Harness init

`flintd init --harness <claude-code|codex|opencode|hermes|openclaw|pi> [--scope user|project]
[--transcripts yes|no] [--check] [--dry-run]` connects one harness to this daemon.

It reads the file each harness documents, merges its own keys in, and writes the result to a temporary file that
it renames over the original. **Nothing else in the file is touched**: another MCP server, another hook, another
setting and every comment stay as they were. The first run that changes a file somebody else wrote keeps one
`<file>.bak` beside it, and a later run never writes over that backup. A file that is not valid JSON, or not
valid YAML, is refused with `invalid_arguments` and left alone.

`--check` writes `configured` or `missing` for each item and exits 1 when anything is missing. `--dry-run` writes
the same lines as a run would, changes nothing, and ends with `nothing written`. A second `init` with the same
arguments reports no change.

### What is written, per harness

| Harness | MCP or extension | Hooks | Skills directory (added to `skillExports`) |
| --- | --- | --- | --- |
| Claude Code | `~/.claude.json`, or `<project>/.mcp.json`: `mcpServers.flintd` = `{type:"http", url, headers:{Authorization}}` | `~/.claude/settings.json`, or `<project>/.claude/settings.local.json`: `hooks.PostToolUse`, `hooks.SessionStart`, `hooks.Stop` | `~/.claude/skills`, or `<project>/.claude/skills` |
| Codex | `~/.codex/config.toml`, or `<project>/.codex/config.toml`: `[mcp_servers.flintd]` with `url` and `bearer_token_env_var` | `~/.codex/hooks.json`, or `<project>/.codex/hooks.json`: the same three events | `~/.agents/skills`, or `<project>/.agents/skills` |
| OpenCode | `~/.config/opencode/opencode.json`, or `<project>/opencode.json`: `mcp.flintd` = `{type:"remote", url, enabled, headers}` | a plugin at `~/.config/opencode/plugins/flintd.js`, or `<project>/.opencode/plugins/flintd.js` | `~/.config/opencode/skills`, or `<project>/.opencode/skills` |
| Hermes | `~/.hermes/config.yaml`: `mcp_servers.flintd` with `url` and `headers` | a Python plugin at `~/.hermes/plugins/flintd/` (`plugin.yaml` and `__init__.py`) | `~/.hermes/skills`, or `<project>/.hermes/skills` |
| OpenClaw | `~/.openclaw/openclaw.json`: `mcp.servers.flintd` with `url`, `transport: "streamable-http"` and `headers`, plus `hooks.internal.entries.flintd.enabled` | a hook at `~/.openclaw/hooks/flintd/` (`HOOK.md` and `handler.ts`) | `~/.agents/skills`, or `<project>/.agents/skills` |
| pi | the extension copied into `~/.pi/agent/extensions/flintd/`, or `<project>/.pi/extensions/flintd/`; pi speaks no MCP | none: pi has no hook surface | `~/.pi/agent/skills`, or `<project>/.pi/skills` |

Hermes keeps one MCP config, so `--scope project` writes the same `~/.hermes/config.yaml` and only the skills
directory follows the project. OpenClaw keeps one config in the same way.

The hook command names this machine's own Node and this machine's own checkout, so the project scope writes
`.claude/settings.local.json` and never the `settings.json` a team checks in.

**Every harness gets a skills directory, MCP or not.** All six read `SKILL.md`, and `tool_run` through a skill is
the fallback for every client that never learns of a promotion.

### The token is never written into a harness config

flintd writes the reference and not the value, in every one of the five harnesses that speak MCP:

| Harness | What the config holds | Why |
| --- | --- | --- |
| Claude Code | `Authorization: Bearer ${FLINTD_TOKEN}` | Claude Code expands `${VAR}` in `.mcp.json` and in `~/.claude.json`, and a project `.mcp.json` is committed |
| Codex | `bearer_token_env_var = "FLINTD_TOKEN"` | the mechanism Codex documents for a Streamable HTTP server; it reads the variable at connect time |
| OpenCode | `Authorization: Bearer {env:FLINTD_TOKEN}` | `{env:VAR}` is OpenCode's own substitution |
| Hermes | `Authorization: Bearer ${FLINTD_TOKEN}` | Hermes resolves `${VAR}` in a header at connect time, from the environment and from `~/.hermes/.env` |
| OpenClaw | `Authorization: Bearer ${FLINTD_TOKEN}` | OpenClaw resolves `${VAR}` in a header value |

`init` prints the one line that sets the variable and never prints the token itself. pi needs no variable: the
extension reads `<flintd home>/token` and `<flintd home>/config.json` for itself.

### `tool_run` is the path for Codex and OpenClaw

Codex reads the MCP tool list once per session and ignores `tools/list_changed`, so a Tool that became Active
while you worked is never a first-class `fl_<name>` for it. OpenClaw does not document an answer to
`tools/list_changed` at all, so flintd assumes the same. For both, `init` prints the line that says so: find the
Tool with `tool_find`, run it with `tool_run`. The skills directory is the second path to the same place.

### Transcript mining is one question, answered once per harness

`--transcripts yes|no` answers it. With no flag and a terminal, `init` asks; with no flag and no terminal, the
answer that is already in the config stands, and the default is no. The answer lands in `config.json`:

```
{"harnesses": {"claude-code": {"transcripts": true}, "codex": {"transcripts": false}}}
```

The hook reads that key at every call, so turning it off takes effect at once and needs no second `init`. With it
off, `transcriptPath` on every Observation of that harness is null.

### What the hook sends

`flintd-hook <harness>` reads the harness's own hook payload on stdin and POSTs one Observation. It gives the
daemon 500 ms, writes nothing to stdout — a harness reads what a hook prints as a decision — and exits 0 whatever
happened, so a daemon that is not running costs a turn nothing. **An Observation it could not send is one line on
stderr saying why**, never silence: no token, a `FLINTD_URL` it refuses, a harness name it does not know, or a
daemon that did not answer.

`FLINTD_TOKEN` and `FLINTD_URL` name the daemon, and an empty variable is no variable at all: `export
FLINTD_TOKEN=` before `flintd serve` ever wrote the token leaves the hook reading `<flintd home>/token`, which is
the same rule `FLINTD_HOME` has. **The hook talks to a daemon on this machine and to nothing else**: `FLINTD_URL`
must name a loopback host — `127.0.0.0/8`, `::1` or `localhost` — under `http` or `https`, and anything else is
refused by name. The bearer token is why: it opens every route, any process in the session can set this variable,
and a hostname that merely begins with `127.` belongs to somebody else. The whole of `127.0.0.0/8` passes, not
`127.0.0.1` alone, so a process that can bind a loopback address on this machine can receive the token — the same
process could read the token file. The pi extension reads its url from its own settings file rather
than from the environment, and that file may name an `https` host.

Claude Code and Codex hand the binary their documented record (`session_id`, `transcript_path`, `tool_name`,
`tool_input`, `tool_response`). The other three load code rather than run a program, so `init` writes the small
file that normalizes their own shape and pipes it to the same binary. Two gaps are worth naming: OpenCode's
documented plugin hooks carry no failure of their own, so a tool call it forwards is recorded `ok`; OpenClaw
documents no tool-call hook event at all, so its hook records `command:new` and `command:reset` and no tool call.

`PreToolUse` is deliberately not installed. An Observation carries the result status, and a call recorded before
and after would count twice.

## The Observer

The Observer reads what already happened, finds a sequence that keeps coming back, and asks the model for one Tool
that does the whole sequence in one call. Every proposal enters as a Draft through the gate every create goes
through. It retires nothing, ever.

### What it reads, and what consent gates

| Input | Read when | What it gives |
| --- | --- | --- |
| the `calls` table of every Library | always. flintd ran those calls itself | the Tool, the session and the time of every call that did not fail |
| the `observations` table | only for a harness with `harnesses.<name>.transcripts` true | the tool name, the **argument names** and the status of what that harness ran |
| the transcript at `transcriptPath` | only for the same consented harness | the `tool_use` and `tool_result` entries, and nothing else in the file |

**Consent is one answer and it gates both.** `flintd init --harness <name> --transcripts yes` is the answer; with
it off, both the Observations of that harness and its transcripts are invisible to the Observer, and the harness's
rows stay in the table for `GET /api/v1/observations` alone. The daemon re-reads the answer before every scheduled
run, so `flintd init --harness <name> --transcripts no` is obeyed at the next run and needs no restart.

**A transcript is read and never kept.** flintd opens the file, reads at most the first 1 MiB, takes the name of
each `tool_use` and the names of the keys of its `input`, drops any whose `tool_result` says `is_error`, and
throws the rest of the file away. No line of a transcript, and no argument value, is stored or returned by any
route. A transcript that cannot be read is skipped, counted in `transcripts.skipped`, and logged; the run goes on.
Where a session has a readable transcript, the transcript is that session's record and its hook rows are not
counted beside it, so one call is never two steps.

What comes out of a transcript is held to the size the hook boundary holds: a tool name of at most 200
characters, at most 64 argument names, each at most 128 characters. **One transcript file is one
conversation**: however many sessions name it, flintd reads it once and counts it as one session of evidence.
Each step takes the time of the transcript entry it came from.

### What a pattern is

A **step** is one tool name with its argument names, sorted, written `Bash(command)`. A **pattern** is 2 to 5
steps that ran in that order inside one session, written `Bash(command) -> Read(file_path)`. The count of a
pattern is **the number of distinct sessions it ran in**, never the number of times it ran, so a loop inside one
session proves nothing. A pattern that ran in `observerRepeats` sessions (default 3) inside `observerWindowDays`
days (default 7) is a **candidate**.

One step is a candidate on its own when the tool is not one flintd already holds: not a meta tool, not a Tool
of either Library under its own name or its `fl_` export spelling. A pattern inside a longer one that ran in
as many sessions is dropped, so the candidate is the longest sequence the evidence carries. A row with no session
is skipped, because a step with no session belongs to no sequence. A session event (`SessionStart`, `Stop`,
`on_session_start`, `command:new` and the rest) is not a step, and neither is a step that failed. At most
`observerMaxCandidates` candidates go to the model in one run (default 5), worst-repeated first.

**Detection needs no model.** `POST /api/v1/observe {"dry_run": true}` answers the candidates and asks nothing of
any provider, and so does a run on a daemon with no model configured.

### What is stored

The pattern signature and its counts, and nothing else: the tool names, the argument names, the number of
sessions, and the first and last time. The Provenance of a proposal carries that signature as its excerpt,
through the same redaction every excerpt goes through, and says in so many words that flintd records no argument
value and that every value in the Examples is one the model invented.

### The proposal

One model call per candidate, with a JSON schema, answering a name, a description, an argument schema, a Body and
Examples. flintd then calls `tool_create` with **Channel `observer`** and that excerpt. From there it is an
ordinary create: the Examples run before anything is saved, the duplicate refusal applies, the Tool lands as a
Draft of the run's own session (`observer:<the run's time>`), so it is reachable by a call that names no session
and by nothing else until its Held-out examples pass, and a Held-out run follows it. A refused proposal is
recorded in `refusals` with the
`ToolError` code and the message — a `duplicate` says which Tool the Library already holds — and nothing is
written. `git log` says `create(<name>): observer`.

A proposal lands in the Library a create with no `meta.library` lands in, which is the project Library when one is
open. The Body of a proposal asks for no Manifest, so it runs in QuickJS and needs no Approval.

### Retirement proposals

`GET /api/v1/observe` lists them, and every run carries the same list.

| Reason | When |
| --- | --- |
| `contribution` | an Active or Verified Tool whose Contribution is at or below `retireContribution` (default −0.10) after at least `retireMinCalls` calls (default 100) |
| `idle` | an Active or Verified Tool whose last call is `retireIdleDays` days old or older (default 30) |

Each proposal carries `name`, `library`, `state`, `reason`, `calls`, `errors`, `contribution`, `lastCallAt` and
`idleDays`, so the operator reads the numbers and not a verdict. A Draft is never proposed, and a Tool that was
never called is never proposed for idleness: no call is no evidence of how long it has been idle. **Nothing here
retires anything.** `flintd observe --retire <name>` calls `tool_retire`, the same path an agent and the CLI use,
and that is an operator's act.

### The schedule

`flintd serve` observes once a day, and only while the daemon is idle: no call in the last `observerIdleMinutes`
minutes (default 10). The first run comes one whole day after the daemon started, one run at a time, and a run in
flight and a `flintd observe` that meet are one run with one answer. `stop()` cancels a run inside the stop grace
and writes nothing more. One whole run is bounded by `observerTimeoutMs` (default 10 minutes), and each model call
by `modelTimeoutMs` like every other.

A dry run never joins a run in flight and never holds the slot: it asks no model and writes nothing, so
`--dry-run` always answers a dry run. `flintd observe` gives the daemon `observerTimeoutMs` plus a tenth
before it gives up, because the answer comes only when the run ends.

`GET /api/v1/status` → `status.observer` carries `{running, lastRunAt, candidates, drafts, refusals, retirements}`
of the last run.

### The CLI

```
flintd observe                 run the Observer now; with a model, propose
flintd observe --dry-run       list the candidates and ask no model
flintd observe --proposals     the retirement proposals, with their numbers
flintd observe --retire <name> retire that Tool, through tool_retire
```

Every one of them takes `--json`, which writes the `ObserverRun` or the `RetirementProposal[]` as it comes off the
route.

### The config keys

`observerRepeats`, `observerWindowDays`, `observerIdleMinutes`, `observerTimeoutMs`, `observerMaxCandidates`,
`retireContribution`, `retireMinCalls` and `retireIdleDays` in `config.json`. `observerMaxCandidates` is how many
candidates one run may send to the model, default 5. `retireContribution` is a Contribution between −1 and 1;
the rest are whole numbers of at least 1.

## Held-out examples and the model

`GET /api/v1/tools/<name>` (`tool_read`) always carries `held_out`:

```
{"status": "pending" | "passed" | "failed" | "unavailable",
 "grades": {"exact": 0, "assertion": 0},
 "failures": [...],
 "reason": "..."}
```

| `status` | Meaning |
| --- | --- |
| `pending` | a model is configured and the Held-out run for the current Version has not finished |
| `passed` | every Held-out example was seen, at least one of them was decided, none failed, and the Tool is Verified |
| `failed` | at least one Held-out example failed, or the run saw them all and decided none, or flintd could not produce any; the Tool stays Draft |
| `unavailable` | no model is configured, so flintd writes no Held-out example |

A Held-out run that **fails** leaves the Tool a Draft and leaves it in the session that wrote it. Only a run that
passes takes a Tool out of its session, because that is what makes it findable from any session.

Each entry of `failures` is `{index, args, grade, expected, actual, reason}`. `grade` is `exact` (the result is
compared to `expected` after JSON canonicalization) or `assertion` (`expected` is `null`; the call must not throw
and the model must judge the result plausible). `grades` counts the Held-out examples of each grade, so a reader
can see how much of the evidence rests on the model's judgment rather than on an exact result.

**The Tool's own description is the whole standard of that judgment.** The result schema is not part of it:
`check` enforces that deterministically before the judge runs, so a judge deciding on it would add nothing and
would only widen what a clause may be quoted from. The judging model is given the description, is told to add no
requirement of its own, and must copy out the clause that settles the case. A judgment that calls a result
implausible and quotes no clause of the description neither passes nor fails the Tool: the example is undecided, it
counts as no evidence, and its stored judgment says it was not decided and why. Undecided examples are counted in
the run's `reason`, and a run every example of which went undecided has decided nothing and does not pass. A
judgment that does quote a clause carries it in the `reason` of the failure and in the stored judgment of the
Held-out example.

**A Tool is charged for a throw only where its description accepts those arguments.** A Held-out example whose call
throws goes to a second judgment, given the description, the arguments and what was thrown, and nothing else. A
clause of the description it can copy out that says the Tool takes arguments like those makes the throw a failure.
Anything else, a clause it cannot quote included, leaves the example undecided: the generator wrote those
arguments, and a Tool that refuses arguments it never promised to take is doing what it declared. So a Tool that
throws at every example decides nothing and does not pass.

`actual` is cut to the first 4096 bytes of its JSON when the Body returned more, and the `reason` says so. A case
the model wrote in a shape flintd cannot read, or one whose arguments the Tool's own argument schema refuses, is
left out rather than ending the run; `reason` is present on the object when a case was left out, and when no case
survived at all, and it says why.

**A Tool whose Examples need what its Manifest asks for is created once, and its Examples are deferred.** While the
Approval of a non-empty Manifest is pending, every Example runs with the Manifest stripped. The tier does not go with
the capabilities: a Body whose own tier is `node` or `container` runs that capability-off proof in the Node tier, where
`Buffer` and the ten Node builtins are what they will be once the Manifest is granted, and a QuickJS-tier Body proves in
QuickJS as before. The empty Manifest is what makes the run reach no file, no host, no Connection and no command. An Example that failed
**only** because a capability was off — the `fs`, `hosts`, `connections` or `exec` refusal the capability-off gate
raises — is recorded as `deferred` rather than refusing the save: the Tool saves as a Draft, `tool_read` carries
`deferred: [<index>, …]` and `examples[i].status: "deferred"`, and `held_out` is
`{"status": "unavailable", "reason": "unavailable until approved: …"}`. An Example that failed for any other reason
still refuses the save with `400 example_failed`, and nothing is written. The `tool_create` answer carries the same
`deferred` list and a `warning` naming what to approve.

The grant is what runs a deferred Example. `POST /api/v1/approvals/<id>` with `"approved"` runs **every** Example
again with the full Manifest in force, in the same turn of the write queue, **before** `approved` is written; only
then does the Held-out run start. An Example that fails that rerun puts the row back to `pending` with the reason,
the grant is not in force, and the deferred state comes back. So no Example is ever counted as evidence without
having run with what it was granted, and no Body ever runs with a capability nobody approved.

A Held-out run starts after a successful `tool_create`, after a `tool_update` that changed the Body, the argument
schema or the Examples, and after a restore. It runs outside the request, so the response of that call never waits
for it. A Version that lands while a run is in flight supersedes it.

`GET /api/v1/status` → `status.model` is `{"configured": false}` or
`{"configured": true, "provider": "anthropic" | "openai", "model": "<name>"}`. The key is never part of it, and it
is in no error, no log line and no Version.

## Method and path refusals

- A known path with a method it does not serve: `405 method_not_allowed`.
- A request line over Node's own header limit — a `q` of about 16 KB or more on `GET /api/v1/find` — is answered
  by Node itself with `431` and an empty body, before any flintd code runs. It is the one answer that does not
  carry the envelope. Send a shorter query, or `POST /api/v1/call` with `tool_find`, which takes the query in a
  body and caps it at 2000 bytes.
- An unknown path under `/api/v1`: `404 not_found`, and the message lists the surface.
- Anything outside `/api/v1` and `/mcp`: `404 not_found`.

## Status codes

| Code | HTTP |
| --- | --- |
| `invalid_name`, `invalid_description`, `invalid_schema`, `invalid_source`, `invalid_arguments`, `invalid_examples`, `invalid_result`, `invalid_manifest`, `example_failed`, `recursive_call`, `call_failed`, `unserializable_result`, `result_too_large` | 400 |
| `unauthorized` | 401 |
| `forbidden`, `awaiting_approval` | 403 |
| `not_found` | 404 |
| `method_not_allowed` | 405 |
| `exists`, `duplicate`, `dir_in_use` | 409 |
| `request_too_large` | 413 |
| `not_implemented` | 501 |
| `store_error`, `internal_error` | 500 |
| `worker_unavailable` | 503 |
| `timeout` | 504 |
| `transport_failed` | none: no daemon sends it |

`STATUS` in `server.ts` is typed `Record<ToolErrorCode, number>`, so a new error code cannot ship without a
status here. `transport_failed` is the exception that proves it: it is in `TOOL_ERROR_CODES` because a client
raises it and every client shares that list, and it carries 500 in the map only to keep the map exhaustive. It
never appears in a response body, because a response body is what a daemon sends and this code means none
arrived.

## One interface

`Flint` is one TypeScript interface and both clients answer to it: the embedded Library and the remote client the
SDK builds from a URL and a token. Every method answers a promise, because a remote answer crosses a socket to
reach the same Library an embedded one reads in process, and one interface that told two stories would be the
drift this contract exists to stop.

`onChange(watcher)` and `onApproval(watcher)` register and answer with the call that takes the watcher off again;
neither crosses the wire to register. A daemon pushes nothing over REST, so the remote client runs an `onChange`
watcher when the model-facing list it reads after its own write is not the list it read before. A client that must
see another client's changes reads `tools()` again, or uses `/mcp`, which does push.

`observations(query?)` answers the Observations of this Tenant, newest first, and `observe(observation)` writes
one. Both are on the interface, so an observer reads the same rows whether it runs inside the daemon's process or
across the socket; the remote client sends them to `/api/v1/observations`.

`observer.run({dryRun?})` and `observer.proposals()` are the Observer, on the same interface for the same reason:
`flintd observe` drives a daemon across the socket and a developer who embedded flintd calls the same two methods
in process. The remote client sends both to `/api/v1/observe`.

Three limits are worth naming outright:

- **`stop()` on a remote client does nothing.** A daemon belongs to whoever started it, so a client never stops
  one. The call answers and the daemon keeps running; stop it with the process that started `flintd serve`.
- **`onApproval` on a remote client fires for the requests that client's own calls raised**, because
  `403 awaiting_approval` is the only signal a daemon sends it. A request another client raised, or one raised
  before the watcher was registered, reaches it only through `approvals()`.
- **`onApproval` on the embedded client fires once for each Approval that starts waiting.** A watcher registered
  after a request went pending never sees that request, because it has already been asked. Read `approvals()` once
  after registering when the backlog matters.

## The tool list in a provider's shape

`GET /api/v1/tools` answers the provider-neutral list, and that is the whole of what the wire carries. **A format is
a client-side shape, never a query parameter**: every client holds the same emitter, so a daemon that meets a new
provider needs no route and an older daemon serves a newer client. A client asked for a format it does not hold
refuses with `invalid_arguments` naming the ones it has.

`tools(format)` takes `"anthropic"`, `"openai"`, `"openai-chat"`, `"gemini"`, `"vercel"`, `"mcp"`, or nothing for the
list as it is. **The `fl_` prefix is applied at this boundary and nowhere else**, by the rule the MCP surface uses: a
meta tool keeps its own name, an Active Tool is exported as `fl_<name>`. A stored name is at most 60 characters, so
the export is at most 63 and fits the 64 every provider allows.

| Format | Tool shape | Where the result schema goes |
| --- | --- | --- |
| `anthropic` | `{name, description, input_schema}` | nowhere: a Messages API tool has no output schema |
| `openai` | `{type: "function", name, description, parameters, strict}` | nowhere |
| `openai-chat` | `{type: "function", function: {name, description, parameters, strict}}` | nowhere |
| `gemini` | `{name, description, parameters, response?}` | `response`, in the same subset |
| `vercel` | `{<name>: {description, inputSchema, outputSchema?}}` | `outputSchema` |
| `mcp` | `{name, description, inputSchema, outputSchema?, annotations?}` | `outputSchema` when its root is an object |

The `mcp` format and `tools/list` are one shaping: both call `formatTools(tools, "mcp", manifests)`, annotations and
the meta tools' `outputSchema` included. The daemon adds only the per-client quirk table on top, so a quirk is the
only way the two can differ.

Two provider subsets are enforced by the emitter:

- **OpenAI strict.** `strict` is `true` only when the root is an object, every object node closes with
  `additionalProperties: false` and requires every property it declares, nothing nests deeper than ten levels, no
  node says `"type": "null"`, and no node carries `minLength`, `maxLength`, `title`, `default` or `examples`. flintd
  allows 32 levels and stores all five keywords, so a schema that uses them is a valid tool with `strict: false`.
- **Gemini.** `parameters` and `response` are emitted as the OpenAPI 3.03 subset a genai `Schema` holds:
  `additionalProperties` and `examples` are removed from every node, recursively. `minItems`, `maxItems`,
  `minLength` and `maxLength` are written as strings, the way proto JSON writes an int64, and an `enum` that is not
  a list of strings on a string moves into the description as "One of: …", because a genai `Schema.enum` is
  `string[]`. Types keep the JSON Schema spelling the REST examples use; the genai SDK's own `Type` is a TypeScript
  enum, which no client can produce structurally, so passing this list to `@google/genai` asks for one cast.

A name that fails the provider's own rule is `internal_error` naming the tool and the format. It cannot happen
through this daemon, because `tool_create` already holds a name to `[a-z][a-z0-9_]*` and 60 characters.

The Python client mirrors the same emitter over the same list, with `anthropic`, `openai`, `openai-chat` and
`gemini`; `vercel` and `mcp` are the TypeScript client's, and the daemon's own `/mcp` is the other way to the last
one. The two emitters read one fixture file, `python/tests/parity.json`, which holds the tool list and the answer
both must give; `packages/core/test/format-parity.test.ts` and `python/tests/test_parity.py` each assert their own
side of it, so neither emitter can gain a conversion the other does not have.

### `callFrom(format, block, meta?)`

`call(name, args, meta)` takes a name and arguments; `callFrom` takes the tool-call block the provider produced, runs
it through the same `POST /api/v1/call`, and answers the result shape that provider wants back. It is a function over
a client and not a method on it, so one implementation serves the embedded client and the remote one.

| Format | It reads | It answers | The error slot |
| --- | --- | --- | --- |
| `anthropic` | a `tool_use` block: `id`, `name`, `input` | `{type: "tool_result", tool_use_id, content}` | `content` is the error JSON and `is_error` is `true` |
| `openai` | a `function_call` item: `call_id`, `name`, `arguments` | `{type: "function_call_output", call_id, output}` | `output` is the error JSON |
| `openai-chat` | one `tool_calls` entry: `id`, `function.name`, `function.arguments` | `{role: "tool", tool_call_id, content}` | `content` is the error JSON |
| `gemini` | a `functionCall` part, or the call itself: `name`, `args`, `id?` | `{functionResponse: {id?, name, response: {output}}}` | `response` is `{"error": {…}}` |
| `vercel` | a tool call: `toolCallId`, `toolName`, `input` | `{type: "tool-result", toolCallId, toolName, output: {type: "json", value}}` | the same part, `output: {type: "error-json", value}` — the AI SDK has no tool-error content part |
| `mcp` | `{name, arguments}` | `{content: [{type: "text", text}], structuredContent?}` | one text block `{"error": {"code", "message"}}` and `isError: true` |

The error JSON is always `{"error": {"code", "message"}}` with a code from `TOOL_ERROR_CODES`, so a model reads the
same refusal whatever provider it is speaking through. `arguments` given as a JSON string is parsed, and a string
that is not JSON is `invalid_arguments` **in the provider's error slot**, because the model wrote it and the model
can fix it. `arguments: ""` is an empty object, which is what Chat Completions sends for a call with no arguments. A
block that is not a tool call at all throws instead: that is the caller's own bug and no model can act on it.

`meta` is the ordinary `CallMeta`, so a harness names its session and its model here exactly as it does on `/call`.

### The framework adapters

An adapter is a client-side function that puts this list into one framework's own per-step tool hook, and reads the
Library again at every one of those steps, so a Tool that becomes Active during a run is offered in the next step.
None of them imports its framework: each takes the framework's own factory as an argument.

| Framework | The hook | Where |
| --- | --- | --- |
| Vercel AI SDK | a tools map filled in place and a `prepareStep` that answers `activeTools` | `packages/sdk/src/adapters/vercel.ts` |
| OpenAI Agents SDK | function tools whose `isEnabled` asks the Library again on every run | `packages/sdk/src/adapters/openai-agents.ts` |
| LangChain | a `wrapModelCall` body that puts the Library into each model call | `packages/sdk/src/adapters/langchain.ts` |
| Google ADK | one toolset whose `getTools` is resolved per invocation | `packages/sdk/src/adapters/google-adk.ts` |
| Pydantic AI | one toolset whose `get_tools` is resolved per step | `python/src/flintd/toolset.py` |

## Client rules

1. Read one key. Never accept a bare payload; a response without the expected key is a protocol error.
2. Revive `error` into the client's own error type, keeping `code`, `message` and `details` unchanged.
3. Send the token on every request, including `GET`.
4. Send no `Origin` header from a non-browser client.
5. Treat `details` as open: new fields may appear, none are removed.
6. Raise the client's own `transport_failed` when the daemon was never reached, never a code a daemon sends.
   `worker_unavailable` means the daemon answered and its executor is gone; `timeout` means the daemon answered
   504. Neither says "there is no daemon at that URL". `details` says which failure it was: `{url, reason}` for a
   daemon that is not there, `{url, timeout}` for one that did not answer in time.
7. Reach the daemon directly, never through an HTTP proxy the environment names. A daemon binds 127.0.0.1, so a
   proxy on the way to it can only be a mistake or a redirection.
