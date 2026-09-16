# @flintd/core

The engine of [flintd](https://github.com/harshkedia177/flintd): a Library of Tools that agents write for
themselves. This package holds the store (a git repository per Library with a SQLite index), the save gate, the
three execution tiers, the Proxy, retrieval, the Observer and the model adapters.

Most people do not install this one. `@flintd/sdk` is the package an agent loop builds on: it re-exports this
`createFlint` and adds the remote client and the framework adapters. `flintd` is the daemon and the CLI.

```
npm i @flintd/core
```

```ts
import { createFlint } from "@flintd/core"

const flint = createFlint({ dir: "./library" })
await flint.start()
await flint.tools("anthropic")
await flint.call("word_count", { text: "one two" })
await flint.stop()
```

`createFlint` answers one interface: `start`, `stop`, `status`, `library`, `tools(format?)`, `find`, `call`,
`callWithId`, `report`, `approvals`, `approve`, `deny`, `onChange`, `onApproval`, `observations`, `observe`,
`observer` and `connections`. The daemon and both SDK clients are thin over it. Every option is in
[the configuration reference](https://github.com/harshkedia177/flintd/blob/main/docs/config.md), and the wire shape
of every answer is in
[the REST contract](https://github.com/harshkedia177/flintd/blob/main/docs/rest-contract.md).

The Bundle, the packages a Tool's Body may import, ships built inside this package, at `dist/bundle/`. A Body
imports nothing else, and never reaches `node_modules`.

Node 22.18 or newer, every execution tier included; see
[the security page](https://github.com/harshkedia177/flintd/blob/main/docs/security.md).

Apache-2.0.
