"""An agent loop against any OpenAI-compatible endpoint, with the flintd meta tools and Active Tools.

    export OPENAI_API_KEY=...            # OpenRouter: your OpenRouter key
    export OPENAI_BASE_URL=https://openrouter.ai/api/v1
    export OPENAI_MODEL=anthropic/claude-sonnet-5
    uv run python examples/openai_compatible.py "count the words in this sentence"

The daemon is `flintd serve`. FLINTD_URL and FLINTD_TOKEN name it; without them this reads the local token file.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any

from flintd import Flint

STEPS = 12
SYSTEM = (
    "You reach a Library of Tools through flintd. Call tool_find to look for a Tool before you write one, "
    "tool_create to write one that is missing, and a fl_ Tool to run it. Answer the user when you have the answer."
)


def ask(messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    body = json.dumps({"model": os.environ.get("OPENAI_MODEL", "gpt-5"), "messages": messages, "tools": tools}).encode()
    asked = urllib.request.Request(f"{base}/chat/completions", data=body, method="POST")
    asked.add_header("authorization", f"Bearer {os.environ['OPENAI_API_KEY']}")
    asked.add_header("content-type", "application/json")
    with urllib.request.urlopen(asked, timeout=120) as answer:
        said: dict[str, Any] = json.loads(answer.read())["choices"][0]["message"]
    return said


def main(question: str) -> int:
    token = os.environ.get("FLINTD_TOKEN") or (Path.home() / ".flintd" / "token").read_text().strip()
    flint = Flint(os.environ.get("FLINTD_URL", "http://127.0.0.1:3546"), token)
    status = flint.status()
    print(f"flintd holds {status['tools']} Tools, {status['active']} of them Active")

    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}]
    for _ in range(STEPS):
        # The list is read again every step, so a Tool the model writes in this turn is callable in the next one.
        said = ask(messages, flint.tools("openai-chat"))
        messages.append(said)
        calls = said.get("tool_calls") or []
        if not calls:
            print(f"\n{said.get('content', '')}")
            return 0
        for call in calls:
            print(f"  -> {call['function']['name']} {call['function']['arguments'][:120]}")
            answered = flint.call_from(call, "openai-chat")
            print(f"  <- {answered['content'][:200]}")
            messages.append(answered)
    print("the model did not finish within the step limit", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(" ".join(sys.argv[1:]) or "count the words in this sentence"))
