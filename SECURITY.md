# Security policy

flintd runs code a model wrote. Reports about how that code escapes what it was granted are the reports this project
most wants.

## Reporting a vulnerability

**Report privately, through GitHub.** Open a private security advisory at
<https://github.com/harshkedia177/flintd/security/advisories/new>, or use the **Report a vulnerability** button under
the repository's **Security** tab. The report is visible only to the maintainer until an advisory is published.

Please do not open a public issue, a pull request or a discussion for a vulnerability. There is no email address for
this; the GitHub route is the only one.

A useful report carries the flintd version, the operating system and Node version, which tier is involved
(`quickjs`, `node` or `container`), and the smallest Tool, its `execute_source` and its Manifest, that shows the
problem. A reproduction that runs is worth more than a description of one.

## What is in scope

- A Body that reaches a file, a host, a process or a credential its Manifest does not declare, in any tier.
- A Body that escapes the QuickJS tier, or that reads another call's arguments or per-call token in the Node or
  container tier at the default `warmNodeRunners` of 0.
- A model key or a Connection value that appears in a result, a log line, an error, a `details` object, a
  Provenance excerpt or a git commit.
- Reaching any route of the daemon without the bearer token, or from an origin the daemon did not serve.
- A Tool that runs with a capability no person approved, or an Approval that survives a Manifest change.
- A path that escapes the Manifest root through a symlink, a `..`, a real-path race or any other route.
- A Tool that forges a lifecycle code, or a callee that runs with the caller's Manifest instead of its own.

## What is out of scope

[docs/security.md](docs/security.md) states the boundaries flintd does not claim, and the README repeats them under
[What it does not promise](README.md#what-it-does-not-promise). Reports of these are already documented, not
vulnerabilities:

- The Node tier not holding hostile code. It is a seat belt under Node's permission model, not a sandbox.
- Container escape through the shared kernel, or anything in an image an operator chose. flintd does not build,
  pull or verify that image.
- DNS rebinding against a hostname a person approved by hand.
- An MCP client that relays the opposite of what the person answered in an elicitation form.
- `sessionId` or `harness` treated as an identity. Everything behind one token is one Tenant.
- File contents read through `ctx.fs.read` from a root a person approved.
- Anything that needs an attacker to already hold the bearer token or write access to the flintd home.

If you think one of these boundaries is drawn in the wrong place, that is worth an issue rather than an advisory.

## What to expect

flintd is maintained by one person, in the open, at version 0.1.0. That sets a realistic expectation and this
document will not pretend otherwise:

- Every report is read. You will get a reply acknowledging it, and a judgement on whether it is in scope, as soon as
  the maintainer reaches it. There is no on-call rotation and no guaranteed response time.
- A confirmed issue is fixed in the open, in a release, with an advisory naming the versions affected.
- You will be credited in the advisory unless you ask not to be.
- There is no bug bounty and no payment.

## Supported versions

0.1.0 is the only release. Fixes land on the newest version; nothing older is maintained.

## Running flintd safely

- Keep the daemon on `127.0.0.1`. It listens nowhere else by design. Remote use means an operator's own TLS in
  front of it, and the token shared as a secret.
- Keep `~/.flintd/token` and `~/.flintd/config.json` at mode 0600. The model key lives in the second one.
- Read a Manifest before you approve it. An Approval is a person's decision about one directory and one list of
  hostnames, and it is the boundary the tiers enforce.
- Do not approve a filesystem root that holds credentials. `ctx.fs.read` does not redact file contents.
- The container tier runs whatever image you point it at. Choose it the way you choose any base image.
