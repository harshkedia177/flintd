# @flintd/hooks

The hook scripts of [flintd](https://github.com/harshkedia177/flintd). This package ships the `flintd-hook` binary
and the small wrapper files that let a harness which loads code, rather than running a program, reach the same
binary.

It is installed beside `flintd`, and `flintd init --harness <name>` writes the hook that calls it. Nobody runs it by
hand.

```
flintd-hook <harness>     # reads that harness's hook payload on stdin
```

One run posts one Observation to the daemon: the harness, the session, the tool name, the **names** of the tool's
arguments and whether it worked. **No argument value is ever sent.** The transcript path travels only where the
operator answered `--transcripts yes` for that harness.

The binary gives the daemon 500 ms, writes nothing to stdout — a harness reads what a hook prints as a decision —
and exits 0 whatever happened, so a daemon that is not running costs a turn nothing.

What it sends, and what the Observer does with it, is in
[the Observer page](https://github.com/harshkedia177/flintd/blob/main/docs/observer.md) and the "Observations"
section of [the REST contract](https://github.com/harshkedia177/flintd/blob/main/docs/rest-contract.md).

Apache-2.0.
