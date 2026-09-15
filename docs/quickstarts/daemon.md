# The daemon in ten minutes

You need this page if a coding agent you did not write is going to call flintd. If you are embedding
[`@flintd/sdk`](sdk.md) in your own loop, you need no daemon at all.

## 1. Start it

```
$ flintd serve
flintd listening on http://127.0.0.1:3546
MCP http://127.0.0.1:3546/mcp
Library user  /Users/me/.flintd/library
token /Users/me/.flintd/token
```

It binds `127.0.0.1` and no other address, and writes a bearer token to a 0600 file on the first start.
`flintd stop` ends it. `flintd init` starts it for you if you skip this step.

## 2. Carry the token

Every surface is behind it, and no harness config ever holds its value.

```
export FLINTD_TOKEN="$(cat ~/.flintd/token)"
```

pi is the exception: its extension holds its own client and reads the token from the flintd home.

## 3. Connect one harness

```
flintd init --harness claude-code
flintd init --harness claude-code --check     # exits 1 when anything is missing
```

`init` writes that harness's own MCP config and its hook scripts where the harness reads them, and writes the
skills directory and the transcripts answer into `~/.flintd/config.json`. The daemon reads `config.json` at start,
so restart it after the first `init`. The six harnesses and what each one gets are in
[the README](../../README.md#connect-your-coding-agent).

## 4. Write a Tool

Ask the harness in plain words, *write me a tool that counts the words in a text*, and it calls `tool_create` for
you. The same call from the terminal:

```
flintd call tool_create '{
  "name": "word_count",
  "description": "Count the words in a piece of text. Call it when a question asks how many words a text holds.",
  "parameters_json": {
    "type": "object",
    "properties": { "text": { "type": "string" } },
    "required": ["text"],
    "additionalProperties": false
  },
  "execute_source": "return { count: args.text.trim().split(/\\s+/).filter(Boolean).length }",
  "examples": [{ "args": { "text": "one two three" }, "expected": { "count": 3 } }]
}'
{
  "name": "word_count",
  "state": "draft",
  "version": "8ac72229d042cffd1801960904e83a215a1adb0c",
  "tier": "quickjs",
  "examples": 1,
  "library": "user",
  "approval": null
}
```

The Example ran before anything was written. A Body that fails its own Example is not saved, and the refusal names
what the Example expected and what the Body returned.

`parameters_json` reads the schema object as written above, and reads that same object sent as a JSON string, which
is the form a model usually produces. `result_json` and `manifest_json` sit beside it; every field is in
[the REST contract](../rest-contract.md).

## 5. Watch it reach Verified

Held-out examples need a model. Put one in `~/.flintd/config.json`, mode 0600, and restart the daemon:

```json
{"model": {"provider": "anthropic", "apiKey": "..."}}
```

`flintd tools show word_count` then prints a `held-out` line that reads `pending`, then `passed`, and the state
moves from `draft` to `verified`. With no model configured the line reads `held-out unavailable` and the Tool stays
a Draft. Everything else works without a key, retrieval included. See [the configuration
reference](../config.md).

## 6. Find it and call it

```
$ flintd find "count the words in a text"
word_count	user	draft	1.00	0.00	Count the words in a piece of text.

$ flintd call word_count '{"text":"the quick brown fox"}'
call a0d123e3-830b-4b3e-8dd9-80bccfcee39e
{
  "count": 4
}
```

The agent makes the same two calls through `tool_find` and `tool_run`, which is how a Tool written after a harness
cached its tool list is still reachable.
