# Contributing to flintd

Issues and pull requests are welcome. This page is the whole process: there is no committee, no template to fill in
and no design document to write first. For anything larger than a fix, open an issue before you write the code, so a
direction that will not be merged costs you an hour rather than a weekend.

Read [CONTEXT.md](CONTEXT.md) before you touch anything. It is the glossary, and the repository uses those words and
no synonyms, in identifiers, in error messages and in documentation. [docs/rest-contract.md](docs/rest-contract.md)
is the source of truth for every behaviour; a change to behaviour is a change to that file in the same pull request.

## Set up

Node 22.18 or newer, and pnpm. The TypeScript sources run directly under Node's type stripping, so there is no build
step between an edit and a test.

```
pnpm install
```

The container tier needs an OCI engine that answers the `docker` command line. Without one, its tests skip
themselves and everything else still runs.

## The gate

Run all four before you open a pull request. `.github/workflows/gate.yml` runs the same four on Node 22 and 24, on
Linux and macOS.

```
pnpm build       # the Bundle every tier loads, and the dist/ each package publishes
pnpm typecheck
pnpm test        # every package lane
pnpm example     # the two offline examples, end to end
```

The gate is deterministic: no API key, no network beyond `127.0.0.1`. The test runner is `node --test` and nothing
on top of it. Test output must be clean. A stray log line or a warning is a failure to fix, not noise to ignore.

Touching `python/`? That lane is `uv run pytest`, `uv run ruff check`, `uv run ruff format --check` and
`uv run mypy --strict src tests examples`, from the `python` directory. It drives a real daemon, so `pnpm build` at
the root has to have run first.

### The two lanes

There is a free lane and a paid one. [docs/evals.md](docs/evals.md) is the full account of both.

**The free lane is the gate above**, and it is the one a contribution has to pass. Its per-lane budgets are advisory
They exist so a lane that doubles gets noticed, not so a loaded machine fails a build. Measured at low load:

| Lane | Command | Budget |
| --- | --- | --- |
| core, fast | `pnpm --filter @flintd/core test:fast` | 3.5 s |
| core, tiers | `pnpm --filter @flintd/core test:tiers` | 4.5 s |
| core, store | `pnpm --filter @flintd/core test:store` | 3.0 s |
| core, library | `pnpm --filter @flintd/core test:library` | 3.0 s |
| core, container | `pnpm --filter @flintd/core test:container` | 3.0 s (skips every test with no OCI engine) |
| daemon, CLI | `pnpm --filter flintd test:cli` | 2.5 s |
| daemon, HTTP | `pnpm --filter flintd test:http` | 3.0 s |
| sdk | `pnpm --filter @flintd/sdk test` | 2.0 s |
| pi | `pnpm --filter @flintd/pi test` | 2.0 s |
| hooks | `pnpm --filter @flintd/hooks test` | 2.0 s |

The same lanes cost two to three times as much on a machine that is already busy, which is not a regression.

**The paid lane (`pnpm eval`) runs a real model and costs real money**, and it runs before a release, not on a pull
request. It needs an operator's own key and stops itself when the estimate goes over `EVAL_MAX_USD`, which is $2 by
default. You do not need to run it to contribute. `pnpm eval:check` is its offline shape check and is free.

## Tests

Every behaviour you add or change gets a test in the same pull request, and a bug you fix gets a test that fails
without the fix.

Drive the seam: the `Flint` interface, or the daemon's HTTP boundary. A test that imports the
store, the index, the executor or the git layer directly is testing a shape rather than a behaviour, and it will be
asked to move. Test names say what the behaviour is. No snapshot tests.

## Code

The bar is what a maintainer of a respected project would merge without a comment.

- **Ask whether it needs to exist.** Then: is it already in this repository, does the standard library do it, does a
  dependency already here do it, can it be one line. Only then write the minimum that works.
- **No abstraction with one implementation** unless the contract names the interface: the store, the model adapter
  and the container engine are the three that do. No configuration for a value that never changes. No scaffolding
  for a use that has not arrived.
- **Errors are part of the API.** Everything the model sees is a `ToolError` with a code from the fixed list and a
  message saying what to do next. No stack trace ever reaches the model. The evals lane measures exactly this: a
  refusal an agent cannot act on is a defect in flintd.
- **Security is never simplified away.** Validate at every trust boundary: arguments, bodies, Manifests, HTTP
  requests. Resolve the real path of every filesystem access. A credential never reaches a worker environment, a
  result, a log or git.
- **Timeouts on every external wait, bounds on every buffer**, a shutdown that stops what it started, and no
  floating promises.
- **Dependencies:** add one only when the standard library cannot do the job in a few lines. Pin the exact version.
  Prefer a package with no transitive dependencies. Say in the pull request why it earns its place.

### Comments

Default to zero. A comment earns its line for exactly one of four reasons: the reason behind a decision, a
constraint, a trap, or a unit. One line, or at most three inside a function for a subtle trap or a formula.

Never restate what the code says. No section banners, no step markers, no file headers, no `TODO`s, no notes to
yourself. No docstring unless the function is public API and its signature does not explain it, and then one line.
Before you open the pull request, read every comment in your diff and delete the ones that fail this test. Most of
them do.

## Documentation

- A behaviour change updates [docs/rest-contract.md](docs/rest-contract.md) in the same pull request.
- A new term goes in [CONTEXT.md](CONTEXT.md), with the words it replaces listed under `_Avoid_`.
- A decision that closes off an alternative is written into the pull request: the decision, the cost, and
  what was rejected. Three sentences is a full one.
- A user-visible change gets a line in [CHANGELOG.md](CHANGELOG.md).

## Commits and pull requests

Write a commit subject that says what changed and why, in the present tense. Keep a pull request to one subject; two
unrelated fixes are two pull requests, and both get reviewed faster.

In the pull request, say how you checked it. Paste the command and its output. A claim without its evidence gets
asked for the evidence.

## Security

Do not open an issue or a pull request for a vulnerability. [SECURITY.md](SECURITY.md) has the private route.

## Code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to every space this project uses.

## License

flintd is Apache-2.0. By opening a pull request you agree that your contribution is licensed under
[Apache-2.0](LICENSE), the same as the rest of the project, per section 5 of the licence. There is no separate CLA
to sign.
