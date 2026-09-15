# flintd for Python

The Python client of a flintd daemon: the Tools an agent writes for itself, in the shape each provider asks for.
It is remote-only — a URL and a token — and the client itself needs nothing but the standard library.

```
uv add flintd                    # the client
uv add "flintd[pydantic-ai]"     # and the Pydantic AI toolset
```

## Connect

Start the daemon with `flintd serve`. It logs the address and the path of its token file.

```python
from pathlib import Path
from flintd import Flint

flint = Flint("http://127.0.0.1:3546", (Path.home() / ".flintd" / "token").read_text().strip())

flint.status()  # what this Tenant holds
flint.tools()  # the meta tools and the Active Tools
flint.call("tool_find", {"query": "count words"})
flint.call("word_count", {"text": "one two"})
```

Every method answers the daemon's own payload, and every refusal is a `ToolError` carrying the daemon's stable
`code`, its `message` and its `details`. A code this build does not know reads as `internal_error`. A daemon that
cannot be reached, or that did not answer in time, raises `TransportError`, a `ToolError` whose code is
`transport_failed` — the one code no daemon ever sends, so a refusal of a Tool is never confused with a daemon that
is not there. Nothing was run and no call was recorded.

| Method | What it does |
| --- | --- |
| `start()` | answers when the daemon answers; a client starts no daemon |
| `stop()` | does nothing: a daemon belongs to whoever started it |
| `status()`, `library()`, `tools(format=None)` | what the Tenant holds |
| `call(name, args, meta)` | the result alone |
| `call_with_id(name, args, meta)` | `{"id", "result"}`; `id` is `None` for a meta tool |
| `report(call_id, outcome, note)` | `"positive"` or `"negative"` against one recorded call |
| `find(query, limit)` | the Tools closest to a query |
| `approvals()`, `approve(id, note)`, `deny(id, note)` | the Manifest decisions |
| `connections()`, `add_connection(...)`, `remove_connection(name)` | the credentials the Proxy attaches |
| `call_from(block, format, meta)` | run a provider's tool-call block and answer in its tool-result shape |

This client registers no watcher: it has no `onChange` and no `onApproval`, which the TypeScript client answers
without either crossing the wire. Read `tools()` again to see the list after a write, and `approvals()` to see every
request waiting, including the ones another client raised.

## The formats

`tools(format)` answers the `tools` of one provider's request. A meta tool keeps its own name and every Tool of the
Library carries `fl_`; a stored name is at most 60 characters, so `fl_` still fits the 64 every provider allows.

| `format` | What it answers |
| --- | --- |
| `None` | the daemon's own list: `{name, description, parameters}` |
| `"anthropic"` | `{name, description, input_schema}` |
| `"openai"` | the Responses API: `{type, name, description, parameters, strict}` |
| `"openai-chat"` | Chat Completions: `{type, function: {name, description, parameters, strict}}` |
| `"gemini"` | the `functionDeclarations` of one `tools` entry: `{name, description, parameters}`, and `response` when the Tool declares a result schema, all in Gemini's schema subset |

`strict` is `true` only for a closed object schema whose every property is required, nested no deeper than ten
levels, with no node typed `null` and no node carrying `minLength`, `maxLength`, `title`, `default` or `examples` —
which is what OpenAI's structured outputs holds a strict tool to. The Gemini schema carries no
`additionalProperties` and no `examples`; it writes `minItems`, `maxItems`, `minLength` and `maxLength` as strings,
the way proto JSON writes an int64, and it moves an `enum` that is not a list of strings on a string into the
description, because a genai `Schema.enum` is `string[]`.

This emitter and the TypeScript one answer the same shapes: `tests/parity.json` holds one tool list and the answer
both must give, and `tests/test_parity.py` and `packages/core/test/format-parity.test.ts` each assert their own
side of it.

The TypeScript SDK emits two more, `vercel` and `mcp`; this client does not, and asking for one is
`invalid_arguments`. Reach them through `@flintd/sdk`, or through the daemon's own `/mcp` surface, which every MCP
client speaks already.

`call_from` takes the block the model emitted and answers the block the provider wants back:

```python
answered = flint.call_from(block, "anthropic")  # {"type": "tool_result", "tool_use_id": ..., "content": ...}
messages.append({"role": "user", "content": [answered]})
```

A refusal goes into the provider's own error slot — `is_error` for Anthropic, the output string for OpenAI, the
`response.error` object for Gemini — so the model reads the refusal and acts on it rather than the run ending.

## Pydantic AI

```python
from pydantic_ai import Agent
from flintd.toolset import FlintToolset

agent = Agent("anthropic:claude-sonnet-5", toolsets=[FlintToolset(flint)])
```

The toolset reads the Library again at every run step, so a Tool the model writes with `tool_create` in one step is
callable as `fl_<name>` in a later one, once it has earned Active. A refusal reaches the model as a retry carrying
`"<code>: <message>"`. Each call carries `harness: "pydantic-ai"` and the run id as its session.

## Approvals

A Tool whose Manifest asks for a file root, a host, a Connection or `exec` runs nothing until a person grants it.
A call to one that is waiting is refused with `awaiting_approval`, and the decision is two calls:

```python
waiting = [one for one in flint.approvals() if one["status"] == "pending"]
flint.approve(waiting[0]["id"], "the host is ours")
```

`flintd approvals list` and `flintd approvals approve <tool>` are the same decision on the command line.

## Develop

```
uv run pytest        # against a daemon this suite starts, with no key and no network beyond 127.0.0.1
uv run ruff check
uv run ruff format --check
uv run mypy --strict src tests examples
```
