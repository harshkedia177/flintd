from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from flintd import Flint

ROOT = Path(__file__).resolve().parents[2]
DAEMON = ROOT / "packages" / "daemon" / "bin" / "flintd.ts"
# A held-out run spawns a daemon, a model fake and a tier per Tool. A CI runner is several times slower than a
# laptop at all of it, and this bound exists to fail a hang, not to measure speed.
DEADLINE_S = float(os.environ.get("FLINTD_TEST_DEADLINE_S", "90"))

SPLIT_LIST = {
    "name": "split_list",
    "description": "Split a delimited string into a list of trimmed parts.",
    "parameters_json": json.dumps(
        {
            "type": "object",
            "properties": {"value": {"type": "string", "description": "The text to split."}},
            "required": ["value"],
            "additionalProperties": False,
        }
    ),
    "execute_source": 'return args.value.split(",").map((part) => part.trim())',
    "examples": [{"args": {"value": "a,b"}, "expected": ["a", "b"]}],
}

SHOUT = {
    "name": "shout",
    "description": "Return one piece of text in upper case.",
    "parameters_json": json.dumps(
        {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "The text to raise."}},
            "required": ["text"],
            "additionalProperties": False,
        }
    ),
    "execute_source": "return args.text.toUpperCase()",
    "examples": [{"args": {"text": "hi"}, "expected": "HI"}],
}

# The model adapter fake: the Held-out cases each Tool of this suite earns Verified with.
HELD_OUT: dict[str, list[dict[str, Any]]] = {
    "split_list": [{"args": {"value": "x, y"}, "expected": ["x", "y"]}],
    "shout": [{"args": {"text": "ok"}, "expected": "OK"}],
    "count_words": [{"args": {"text": "one two three"}, "expected": 3}],
}


class FakeModel(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        raw = self.rfile.read(int(self.headers.get("content-length", "0")))
        asked = json.loads(raw or b"{}")
        self.answer(json.dumps({"choices": [{"message": {"content": written(asked)}}]}).encode())

    def answer(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def written(asked: dict[str, Any]) -> str:
    text = "\n".join(str(one.get("content", "")) for one in asked.get("messages", []))
    if "judge" in text:
        return json.dumps({"plausible": True, "reason": "the result is what the Tool promises."})
    for name, cases in HELD_OUT.items():
        if f"Tool: {name}\n" in text:
            return json.dumps(
                {
                    "cases": [
                        {"args": json.dumps(one["args"]), "confident": True, "expected": json.dumps(one["expected"])}
                        for one in cases
                    ]
                }
            )
    return json.dumps({"cases": []})


@pytest.fixture(scope="session")
def model() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="session")
def daemon(model: str, tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[str, str]]:
    home = tmp_path_factory.mktemp("flintd-home")
    config = home / "config.json"
    config.write_text(
        json.dumps({"port": 0, "model": {"provider": "openai", "apiKey": "gate", "model": "fake", "baseUrl": model}})
    )
    config.chmod(0o600)
    # A directory of its own for the working directory too, so no project Library of this repository is opened.
    work = tmp_path_factory.mktemp("flintd-cwd")
    started = subprocess.Popen(
        ["node", str(DAEMON), "serve"],
        cwd=work,
        env={**os.environ, "FLINTD_HOME": str(home)},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert started.stdout is not None
    url = ""
    while (line := started.stdout.readline()) != "":
        if line.startswith("flintd listening on "):
            url = line.split(" ")[-1].strip()
            break
    if url == "":
        started.kill()
        raise AssertionError(f"the daemon did not start: {started.communicate()[0]}")
    threading.Thread(target=started.stdout.read, daemon=True).start()
    yield url, (home / "token").read_text().strip()
    started.terminate()
    try:
        started.wait(timeout=10)
    except subprocess.TimeoutExpired:
        started.kill()


@pytest.fixture(scope="session")
def flint(daemon: tuple[str, str]) -> Flint:
    url, token = daemon
    return Flint(url, token, timeout=10.0)


@pytest.fixture(scope="session")
def library(flint: Flint) -> Flint:
    """One Library, holding `split_list` as an Active Tool and `shout` as a Verified one."""
    flint.call("tool_create", SPLIT_LIST)
    flint.call("tool_create", SHOUT)
    verified(flint, "split_list")
    verified(flint, "shout")
    activate(flint, "split_list", {"value": "a, b"})
    return flint


def verified(flint: Flint, name: str) -> None:
    until(lambda: flint.call("tool_read", {"name": name})["held_out"]["status"] == "passed", f"{name} is Verified")


def activate(flint: Flint, name: str, args: dict[str, Any]) -> None:
    for session in ("one", "two"):
        for _ in range(3):
            flint.call(name, args, {"sessionId": session})
    until(lambda: name in [one["name"] for one in flint.tools()], f"{name} is Active")


def until(ready: Callable[[], bool], what: str) -> None:
    limit = time.monotonic() + DEADLINE_S
    while time.monotonic() < limit:
        if ready():
            return
        time.sleep(0.02)
    raise AssertionError(f"waited {DEADLINE_S} s and {what} never happened")
