# flintd

A Library of Tools that agents write for themselves. A Tool enters the Library only after it passes its own
Examples, becomes findable only after it passes Held-out examples its author never saw, and reaches the default tool
list only after real use or one Approval. One daemon serves that Library to every Harness on the machine and to your
own agent loop.

This package is the daemon, the CLI and the `flintd` binary.

```
npm i -g flintd
flintd serve
export FLINTD_TOKEN="$(cat ~/.flintd/token)"
flintd init --harness claude-code        # claude-code, codex, opencode, hermes, openclaw, pi
flintd init --harness claude-code --check
```

`flintd` alone prints every command. Node 22.18 or newer, every execution tier included.

**Writing your own agent loop, or your own harness?** This package is the daemon; the one you import is
[`@flintd/sdk`](https://www.npmjs.com/package/@flintd/sdk), which opens the same Library in your own process or
against this daemon, whichever you point it at. Start at
[the SDK quickstart](https://github.com/harshkedia177/flintd/blob/main/docs/quickstarts/sdk.md).

| Package | What it is |
| --- | --- |
| `flintd` | the daemon, the CLI and the `flintd` binary |
| [`@flintd/core`](https://www.npmjs.com/package/@flintd/core) | the Library: store, save gate, execution tiers, Proxy, Observer |
| [`@flintd/sdk`](https://www.npmjs.com/package/@flintd/sdk) | the library an agent loop builds on: one client, embedded or remote |
| [`@flintd/hooks`](https://www.npmjs.com/package/@flintd/hooks) | the `flintd-hook` binary the harnesses run |
| [`@flintd/pi`](https://www.npmjs.com/package/@flintd/pi) | the extension for the pi harness |
| [`flintd` on PyPI](https://pypi.org/project/flintd/) | the Python client, remote only |

The documentation lives at [github.com/harshkedia177/flintd](https://github.com/harshkedia177/flintd): the
[quickstarts](https://github.com/harshkedia177/flintd/tree/main/docs/quickstarts), the
[security page](https://github.com/harshkedia177/flintd/blob/main/docs/security.md), the
[configuration reference](https://github.com/harshkedia177/flintd/blob/main/docs/config.md) and the
[REST contract](https://github.com/harshkedia177/flintd/blob/main/docs/rest-contract.md).

Apache-2.0.
