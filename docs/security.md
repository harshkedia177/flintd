# Security

Every sentence here traces to [the REST contract](rest-contract.md), which is the source of truth. Read that file
when this page is not enough.

## What the token protects

The daemon binds `127.0.0.1` and nothing else. Every route, `/api/v1` and `/mcp` alike, needs
`Authorization: Bearer <token>`, compared in constant time. The token is generated on the first `flintd serve` into
a 0600 file in the flintd home. When a request carries an `Origin` header it must be the daemon's own origin, and
that check runs before the token check, so a browser page on another origin is refused even with a correct token.

One token is one Tenant. `sessionId` and `harness` are strings the caller chooses, not identities: the boundary a
session draws is between the honest sessions of one Tenant, so an unfinished Draft does not reach a colleague's
tool list. It is not a boundary between people.

For remote use, the operator puts the daemon behind their own TLS and shares the token (the spec's "Daemon and
surfaces"). flintd terminates no TLS of its own and listens on no other address.

## The Manifest and the Approval

A Manifest is a Tool's declaration of what it needs to reach. It is empty by default.

| Field | What it asks for |
| --- | --- |
| `fs` | one directory, relative to the Library directory. `..`, an absolute path, `.` and any directory flintd owns are refused |
| `hosts` | exact lower-case hostnames, no scheme, no port, no wildcard, at most 20 |
| `connections` | Connection names, at most 20 |
| `exec` | `true` asks to run a command, which needs the container tier |

**Any non-empty Manifest waits for one Approval before a Body runs with what it asks for.** That covers every place
a Body runs: the save gate, the Held-out run and every call. A call to a Tool that is waiting is
`403 awaiting_approval`, and the message names what the Manifest asks for and the CLI line that decides it. There is
no automatic denial and no timeout: with no channel to answer, the request stays pending and every call keeps being
refused.

One Approval is live per Tool, for the Manifest it declares now. A new Version of the same Manifest keeps the
decision a person made, which is how an Approval is inherited by a Body that passed its Examples. A Manifest change,
including one written into `tool.json` by hand, drops the decision and asks again. Granting runs every Example again
with the full Manifest before the decision is written, so a grant the Examples did not survive is no grant.

Approvals live in the Library index, never in git: a decision is about this machine. An index that is deleted is
rebuilt from the repository, and every non-empty Manifest asks again.

The channels are `flintd approvals list` / `approve` / `deny`, the SDK's `onApproval` watcher, and MCP elicitation.

### What elicitation proves, and what it does not

When a client declares the `elicitation` capability in form mode, a refused call comes back with one
`elicitation/create` request and a `requestState`: an HMAC-sealed record of the Approval id and the hash of the
Manifest the person was shown, minted per form, valid for ten minutes and bound to the method it was issued on. An
answer without it, or one that names another Approval or an older Manifest, decides nothing.

That proves flintd issued this form, for this Approval and this Manifest, and that the answer came back bound to it.
**It does not prove what the person said.** MCP has the client show the form and relay the answer, so a client that
reads "deny" from the person and sends `approve` is believed. No server closes that, and flintd does not pretend to.

## The three tiers

The Manifest and the Body's imports pick the tier. A Tool always runs in the lowest tier that satisfies it.

| The Tool | Tier |
| --- | --- |
| an empty Manifest | `quickjs`, with no host function installed |
| `fs`, `hosts` or `connections` | `quickjs`, with the host functions the Manifest asks for |
| a Body that imports a Node builtin, or `cheerio` | `node` |
| `exec` | `container` |

### QuickJS

QuickJS in WebAssembly, in the daemon's own process, with the host functions the Manifest asks for and no others. A
Tool with an empty Manifest has no I/O surface at all: `globalThis.fetch` does not exist, nor does a socket, a file
or a process. This is the tier every Tool gets unless something forces another.

### Node: a seat belt, not a sandbox

The Node tier is a child process started with `--permission` and no allow flag but the Manifest root and the Bundle
directory:

```
node --permission --allow-fs-read=<bundle>/* --allow-fs-read=<root> --allow-fs-write=<root> \
  <flintd>/tier-child.ts <allowed imports>
```

Its environment carries `PATH`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL` and `LC_CTYPE` and nothing else. It has its own process
group, and stopping it stops whatever it started. Child processes, worker threads, native addons and WASI are denied
because `--permission` denies them and no flag turns them back on. `process.getBuiltinModule`, `process.binding`,
`process._linkedBinding` and `process.dlopen` are deleted before the Body loads, and a `module.registerHooks` resolve
hook refuses every specifier outside the Bundle and the Node builtin list, so a Bundle name resolves to the one built
file and never to anything under `node_modules`.

**A fresh child for every call is the default, and it is the only structurally closed answer.** `warmNodeRunners`
is 0 unless an operator asks for more, and at 0 the child that answered a call is retired as it answers: nothing of
one call reaches the next, because no next call runs in that process. It costs about 54 ms a call against the 0.6 ms
a warm child answers in. What that buys is the reason the default is this way round: a warm child is per Tool and
not per session, so call 1 of a Tool from one session and call 2 of it from another share a process, and a Body that
reads the channel in between reads the second session's arguments and its per-call token.

**Above 0 a sweep stands in for that, and a sweep is best effort.** A child with `warmNodeRunners` above 0 stays
warm for the next call of its Tool. Before the first Body runs, the child records the own property descriptors of
`globalThis`, of every object one level in from it such as `process`, `process.env` and `console`, of the intrinsics
with their prototypes, of the iterator, generator and async prototypes no global name reaches — derived by value
from expressions, because a walk from `globalThis` arrives at none of them — of its own `import.meta` and `execute`,
and of every object one level in from each module its source names — and of every prototype up the chain of each, so
`EventEmitter.prototype`, which `process` is built on, is in it. When the call settles it deletes every key the Body
added and puts back every key it wrote over, so `Array.prototype.stolen`, `process.stolen`, a write into a Bundle
package's `globalRegistry`, a write to the prototype every `for` loop of the sweep itself walks, and a replaced
`emit` on the prototype of `process` are all gone before the next call reads them. It restores what it can name and
reach, it retires the child when it cannot put something back, and an object it reaches by no expression at all is a
residue it does not promise to remove. That is what an explicit opt-in buys, and it is not what the default is.

`emit` is the one to hold in mind. The frame that carries the next call's arguments and its token is delivered
through `process.emit`, which resolves on `EventEmitter.prototype`. A Body that replaced it there read the next
call's arguments and its whole token, and the token is what flintd checks a `result` or a `host` frame against.
`process.removeAllListeners` is the same shape: replacing it with a function that does nothing left the Body's own
listener attached for every later call. The child names none of these at the end of a call. It holds `on`,
`removeListener`, `eventNames` and `rawListeners` as they were before the seal, and every function the sweep itself
runs beside them, and it walks its own arrays by index rather than through an iterator prototype a Body can write
over. `"message"` is not the only event a Body can attach to either — `process.on("unhandledRejection", ...)` is not
the channel and the seal never refused it — so what the end of a call puts back is the whole listener map `process`
carried before any Body could reach it.

A callback outlives a call the way a listener does. `setTimeout`, `setImmediate`, `queueMicrotask` and
`process.nextTick` are all held, each callback belongs to the call that asked for it, and one that arrives after
that call settled is dropped rather than run. Clearing what can be cleared is not enough on its own: a callback that
re-arms itself from inside installs the next one, and dropping it is what ends the chain. A Body's own callback
inside its own call is untouched.

**What cannot be put back retires the child.** A frozen or sealed object, a global the Body defined as
non-configurable, and a package it imported under a name it computed rather than wrote are all detected by the same
sweep, and the child is taken away rather than handed to the next call. A Body that pollutes pays a fresh child, 54
ms on the machine this was measured on; a Body that does not keeps the 0.6 ms warm path.

**Some things still cross a call.** State a package keeps inside a container the sweep cannot read crosses it: a
`Map`, a `Set`, a `WeakMap` or a closure variable, such as the entry `z.globalRegistry.add(schema, meta)` writes
into the `WeakMap` the registry holds. The prototype of a class a Bundle package exports crosses it, because the
package writes there itself: `zod` installs 90 methods on `ZodString.prototype` at the first `z.string()`, a sweep
cannot tell that from a Body's own write, and taking it back leaves the next call with a package that no longer
works. A promise chain the Body left running crosses it as well: the chain resumes after the call settled and after
the sweep walked, and what it writes then is written into the child the next call will use. The Manifest is the
trust boundary and the child is not, so do not hand a Tool a secret you would not let its next caller read.
`"warmNodeRunners": 0`, which is the default, answers all of it: a fresh child for every call, and nothing to carry.
The container tier is the other tier with no carry at all.

**The network lock is the resolve hook plus the deleted globals.** The ten Node builtins a Body may import are pure
computation, and `node:net`, `node:http`, `node:https`, `node:http2`, `node:tls`, `node:dgram` and `node:dns` are
not among them, so the resolve hook refuses each one however the Body names it. `fetch`, `WebSocket`, `EventSource`
and `XMLHttpRequest` are deleted from `globalThis` before the Body loads. `ctx.fetch` is the only way out, and it
goes through the Proxy on the main thread. From Node 25, where `--allow-net` exists, the child is started without it,
so a socket also fails with `ERR_ACCESS_DENIED`: the permission model is the second lock, not the only one. The tier
runs on Node 22.18 and later, the same floor as flintd itself.

### Container

A Manifest with `"exec": true` runs the Tool in one container per call, thrown away afterwards, on an OCI engine
that answers the `docker` command line:

```
docker run --rm -i --name flintd-<uuid> --network none --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 512m --cpus 1 --user <uid>:<gid> \
  --workdir /workspace -v <the Manifest root>:/workspace -v <the Bundle>:/bundle:ro \
  -v <flintd>/tier-child.ts:/runner.ts:ro <image> node /runner.ts <allowed imports>
```

| Flag | Why |
| --- | --- |
| `--network none` | the Proxy on the main thread is the only way out, so the container opens no socket of its own. `ctx.fetch` still works; a command inside reaches nothing |
| `--read-only`, `--tmpfs /tmp` | nothing the image ships can be changed, and scratch space goes with the container |
| `--cap-drop ALL`, `--security-opt no-new-privileges` | no capability and no way to gain one |
| `--pids-limit`, `--memory`, `--cpus` | a fork bomb, a leak and a spin cost the container and not the machine |
| `--user <uid>:<gid>` | never root: the uid flintd runs as, falling back to `1000:1000` when flintd is itself root |
| the three mounts | the Manifest root read-write, the Bundle read-only, the runner read-only. A Tool with no `fs` gets `--tmpfs /workspace:mode=1777` and no host path at all |
| no `-e` of any kind | the environment inside is the image's own. A Connection value never leaves the main thread |

**What it does not promise.** The container is the isolation boundary and the kernel is shared: this is a container,
not a virtual machine. flintd does not build, pull or verify the image, and an image an operator points it at is an
image an operator trusts. `ctx.fs` is not answered inside the container: it is a host call like `ctx.fetch`, resolved
on the main thread, so one containment implementation serves all three tiers. Both tmpfs mounts are `noexec`, which
is Docker's default, so a Tool that declares no `fs` cannot execute a file its own command wrote, though it can run
it through an interpreter. A Tool that declares `fs` runs from the bind mount, which is not `noexec`, so a script it
wrote there does run.

No CI runner covers this tier: `test:container` skips every test without an engine. It is proved on a developer
machine and by the evals lane.

## The Proxy and Connections

`ctx.fetch` is the only network path a Tool has, in every tier. The Body is suspended and the request is made on the
main thread, so the Body holds no socket and no credential.

A **Connection** is a stored credential for a named service: a name, a list of hosts and one header. A Tool's
Manifest names the Connection; the Body receives the name and never the value. Connection values live in the flintd
home, never in a Library, so they are never committed, and no route ever answers with one.

| The request | What happens |
| --- | --- |
| a hostname the Manifest does not declare | refused, naming the host. Exact lower-case match: no wildcard, no suffix, no allowance for a loopback or private address unless it is written down |
| a host a declared Connection carries | allowed, and that Connection's header is attached |
| `authorization`, `cookie` or `proxy-authorization` set by the Body | always dropped, whether a Connection applies or not |
| a header whose name is a declared Connection's header | dropped, and flintd's own is sent |
| `host`, `connection`, `content-length`, `transfer-encoding` set by the Body | always dropped |
| a redirect | followed up to 3 times, and every hop is checked and credentialed again |
| a scheme that is not `http` or `https`, or an IPv6 literal | refused |
| longer than `fetchTimeoutMs`, or an answer over `maxFetchBytes` | refused, naming the bound |
| a Tool whose Approval is no longer `approved` | refused. The Approval is read again at every request |

**DNS rebinding is accepted, not defended against.** A declared hostname whose DNS answer is a private address
reaches that address. Three gates stand in front of it: a person approved that exact hostname, the Manifest allows no
wildcard, and a metadata address could be declared outright and would read the same in the Approval prompt. Pinning
the resolved address means dialling an address and carrying a `Host` header, which breaks SNI and every CDN, for a
threat whose entry cost is owning the DNS of a host an operator typed in by hand.

## Redaction, and where it applies

flintd holds two kinds of secret: the model key and each Connection header value. Every one of them is struck out of

- what a Body receives, including a `ctx.fetch` answer whose upstream quoted the credential back, in the body and in
  every response header,
- a `ctx.log` line,
- an error message and its `details` object,
- a Provenance excerpt, which is what lands in git.

**`ctx.fs.read` does not redact file contents.** A declared filesystem root is what a person approved, and a Body
reads what is in it. Do not approve a root that holds credentials.

## The filesystem

Every path a Tool names is resolved on the main thread against the real path of the Manifest root. An absolute path,
a `..`, a symlink that leads out, a dangling symlink and any directory flintd owns are refused, and a read or a write
over `maxResultBytes` is refused with the bound.

One limit is worth naming. Node's own documentation says of the permission model: "Symbolic links will be followed
even to locations outside of the set of paths that access has been granted to." `ctx.fs` resolves every real path
itself and refuses one that leads out, so the path a Tool is meant to use is safe; a Body that reached raw `fs`
through some future hole would have the weaker guarantee.

## What a Body can never do

- hold a credential: the worker environment carries none, in any tier.
- widen a callee: `ctx.callTool` runs the callee under the callee's own Manifest and Approval.
- forge a lifecycle code: whatever a Body throws reaches the caller as `call_failed`.
- outlive its call: a timeout kills the worker or the container, and the container holds the process namespace, so
  whatever a command started inside it dies with it.
