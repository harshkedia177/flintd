# flintd

A library of tools that agents write for themselves. Each tool is tested before it can be called, versioned, limited to declared capabilities, and reachable from any agent harness or agent loop.

## Language

**Tool**:
A named, callable unit an agent can invoke: a schema for its arguments, a body, its examples, and its manifest. The only first-class unit in flint.
_Avoid_: Skill, function, plugin, capability

**Body**:
The JavaScript source that runs when a tool is called.
_Avoid_: Implementation, code, script

**Example**:
One recorded pair of arguments and expected result for a tool. Examples are the evidence that a tool works.
_Avoid_: Test, test case, fixture

**Manifest**:
A tool's declaration of what it needs to reach: a filesystem root and a list of network hosts. Empty by default.
_Avoid_: Permissions, policy, scopes

**Version**:
One immutable snapshot of a tool. Every change to a tool produces a new version; old versions stay restorable.
_Avoid_: Revision, commit, history entry

**Library**:
The full set of tools and their versions that flint holds for one tenant.
_Avoid_: Registry, store, catalog, toolbox

**Tenant**:
The owner boundary of a library. One tenant per library. A single-user install has one tenant named `default`.
_Avoid_: Org, workspace, account, user

**Harness**:
A program that runs an agent loop and reaches flint from the outside: a coding agent such as Claude Code, or a developer's own loop that calls a model API.
_Avoid_: Client, host, agent framework, IDE

**Held-out example**:
An example a tool's author never saw, produced by flint's own model after the tool was created. Passing held-out examples is the proof a tool generalizes.
_Avoid_: Hidden test, validation case

**Connection**:
A stored credential for a named service, referenced by id. A tool receives the id, never the value.
_Avoid_: Secret, token, API key, credential

**Proxy**:
The single path every tool network call goes through. It enforces the manifest's host list and attaches the connection's credential.
_Avoid_: Gateway, egress filter

**Approval**:
A one-time human decision that grants a tool version what its manifest asks for.
_Avoid_: Permission, consent, grant

**Channel**:
Who a version came from. Four exist: the **agent channel** (the model creates a tool mid-task), the **observer channel** (flint proposes a tool from past activity), the **file channel** (a person edits the tool's directory), and the **flintd channel** (flint itself writes a version, such as the one that records a held-out run).
_Avoid_: Source, origin, author type

**Observer**:
The part of flint that reads past tool calls and transcripts, finds repetition, and proposes tools through the observer channel.
_Avoid_: Miner, learner, synthesizer, curriculum

**Contribution**:
A tool's running score. Starts from the success rate of its calls; outcome reports from a harness adjust it. Decides retirement.
_Avoid_: Quality, rating, health, reputation

**Outcome report**:
An optional signal from a harness that a call helped or hurt the task it was part of.
_Avoid_: Feedback, rating, thumbs up

**Provenance**:
The record of where a tool version came from: channel, session, harness, model, and a redacted excerpt of the conversation that produced it.
_Avoid_: Origin, metadata, audit trail

**Sibling**:
A tool a search found to be near-identical to another. A search answers with one tool of the group and names the rest as its siblings, so it never offers two tools for one capability without saying so.
_Avoid_: Clone, variant, alias

**Duplicate**:
A tool an agent is about to write that does the capability of a tool the library already holds. The save gate refuses a duplicate of a verified or active tool and warns about one of a draft.
_Avoid_: Copy, redundant tool, near-match

**Bundle**:
The curated set of packages a body may import, fixed per flintd release and present in every tier.
_Avoid_: Dependencies, allowlist, stdlib

## Lifecycle

**Draft**:
A tool that passed its own examples. Callable only by the session that created it.

**Verified**:
A draft that also passed its held-out examples. Findable by search from any session.

**Active**:
A verified tool that earned a place in the default tool list. At most 50 per tenant.
_Avoid_: Trusted, promoted, published

**Retired**:
A tool removed from use but kept with its versions. Restorable.
_Avoid_: Deleted, archived, disabled

**Tier**:
The isolation level a tool's body runs in, chosen from its manifest. A stricter tier is used when the manifest asks for less.
_Avoid_: Sandbox, runtime, executor
