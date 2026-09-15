# Your own loop: Python

The Python client is **remote only** — a URL and a token — and needs nothing but the standard library.

```
pip install flintd                 # or: uv add flintd
uv add "flintd[pydantic-ai]"       # and the Pydantic AI toolset
```

Start the daemon with `flintd serve`. It logs the address and the path of its token file.

```python
from pathlib import Path
from flintd import Flint

flint = Flint("http://127.0.0.1:3546", (Path.home() / ".flintd" / "token").read_text().strip())

flint.status()                                   # what this Tenant holds
flint.tools("openai-chat")                       # the meta tools and the Active Tools, in one provider's shape
flint.call("tool_find", {"query": "count words"})
flint.call("word_count", {"text": "one two"})
```

`FLINTD_URL` and `FLINTD_TOKEN` are the whole of the environment a script needs.

## A whole loop

[`python/examples/openai_compatible.py`](../../python/examples/openai_compatible.py) runs against any
OpenAI-compatible endpoint. The centre of it:

```python
messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}]
for _ in range(STEPS):
    # The list is read again every step, so a Tool the model writes in this turn is callable in the next one.
    said = ask(messages, flint.tools("openai-chat"))
    messages.append(said)
    calls = said.get("tool_calls") or []
    if not calls:
        print(said.get("content", ""))
        break
    for call in calls:
        messages.append(flint.call_from(call, "openai-chat"))
```

`call_from` takes the block the model emitted and answers the block the provider wants back. A refusal goes into
that provider's own error slot, so the model reads it and acts on it rather than the run ending.

## Pydantic AI

```python
from pydantic_ai import Agent
from flintd.toolset import FlintToolset

agent = Agent("anthropic:claude-sonnet-5", toolsets=[FlintToolset(flint)])
```

The toolset reads the Library again at every run step. Each call carries `harness: "pydantic-ai"` and the run id as
its session.

## What this client does not hold

| Gap | What to do |
| --- | --- |
| no `onChange` and no `onApproval` | read `tools()` again after a write, and `approvals()` for every request waiting, including the ones another client raised |
| `formats` are `None`, `anthropic`, `openai`, `openai-chat` and `gemini` | `vercel` and `mcp` are the TypeScript client's; the daemon's `/mcp` is the other way to the last one |
| embedded mode | there is none: this client is remote only, and `stop()` does nothing because a daemon belongs to whoever started it |
| `start()` | answers when the daemon answers; a client starts no daemon |

Every refusal is a `ToolError` carrying the daemon's stable `code`, its `message` and its `details`. A daemon that
cannot be reached, or that did not answer in time, raises `TransportError`, whose code is `transport_failed` — the
one code no daemon ever sends, so a refusal of a Tool is never confused with a daemon that is not there.

[`python/README.md`](../../python/README.md) holds the full method table and the Approval flow.
