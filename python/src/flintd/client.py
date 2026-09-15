from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .errors import ToolError, TransportError
from .formats import Format, failure, format_tools, library_name, parsed, read_call, success

API = "/api/v1"

# A daemon binds 127.0.0.1, so an environment proxy is never the way to it.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Flint:
    """A client of one flintd daemon, reached by its URL and its bearer token."""

    def __init__(self, url: str, token: str, *, timeout: float = 35.0) -> None:
        if not url:
            raise ToolError("internal_error", "Flint needs a `url`: the address the daemon logged when it started.")
        if not token:
            raise ToolError("internal_error", "Flint needs a `token`: the one in the token file of the flintd home.")
        self._base = url.rstrip("/")
        self._token = token
        self._timeout = timeout

    def start(self) -> None:
        """Answers when the daemon answers. A client starts no daemon; `flintd serve` does."""
        self._request("/status")

    def stop(self) -> None:
        """Does nothing. A daemon belongs to whoever started it, so a client never stops one."""

    def status(self) -> dict[str, Any]:
        return self._one("/status", "status")

    def library(self) -> list[dict[str, Any]]:
        return self._many("/library", "library")

    def tools(self, format: Format | None = None) -> list[dict[str, Any]]:
        listed = self._many("/tools", "tools")
        return listed if format is None else format_tools(listed, format)

    def find(self, query: str, limit: int | None = None) -> list[dict[str, Any]]:
        asked = {"q": query} if limit is None else {"q": query, "limit": str(limit)}
        return self._many(f"/find?{urllib.parse.urlencode(asked)}", "find")

    def call(self, name: str, args: Any = None, meta: dict[str, Any] | None = None) -> Any:
        return self.call_with_id(name, args, meta)["result"]

    def call_with_id(self, name: str, args: Any = None, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """The call, not the bare result: `id` is the string a report names, and `None` for a meta tool."""
        body = {"name": name, "args": {} if args is None else args, "meta": {} if meta is None else meta}
        return self._one("/call", "call", body)

    def report(self, call_id: str, outcome: str, note: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"outcome": outcome}
        if note is not None:
            body["note"] = note
        return self._one(f"/calls/{urllib.parse.quote(call_id, safe='')}/report", "report", body)

    def approvals(self) -> list[dict[str, Any]]:
        return self._many("/approvals", "approvals")

    def approve(self, id: str, note: str | None = None) -> dict[str, Any]:
        return self._decide(id, "approve", note)

    def deny(self, id: str, note: str | None = None) -> dict[str, Any]:
        return self._decide(id, "deny", note)

    def connections(self) -> list[dict[str, Any]]:
        """Names and hosts. A Connection header value is written once and no route ever answers with it."""
        return self._many("/connections", "connections")

    def add_connection(self, name: str, hosts: list[str], header_name: str, header_value: str) -> dict[str, Any]:
        body = {"name": name, "hosts": hosts, "header": {"name": header_name, "value": header_value}}
        return self._one("/connections", "connection", body)

    def remove_connection(self, name: str) -> dict[str, Any]:
        return self._one(f"/connections/{urllib.parse.quote(name, safe='')}", "connection", verb="DELETE")

    def call_from(self, block: dict[str, Any], format: Format, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """Run one provider's tool-call block and answer in that provider's tool-result shape."""
        call_id, name, written = read_call(block, format)
        try:
            result = self.call(library_name(name), parsed(written), meta)
        except ToolError as cause:
            return failure(call_id, name, cause, format)
        return success(call_id, name, result, format)

    def _decide(self, id: str, decision: str, note: str | None) -> dict[str, Any]:
        body = {} if note is None else {"note": note}
        return self._one(f"/approvals/{urllib.parse.quote(id, safe='')}/{decision}", "approval", body)

    def _one(self, path: str, key: str, body: Any = None, verb: str | None = None) -> dict[str, Any]:
        answer = self._read(path, key, body, verb)
        if not isinstance(answer, dict):
            raise ToolError("internal_error", f"The daemon at {self._base} answered {key!r} that is not an object.")
        return answer

    def _many(self, path: str, key: str) -> list[dict[str, Any]]:
        answer = self._read(path, key)
        if not isinstance(answer, list):
            raise ToolError("internal_error", f"The daemon at {self._base} answered {key!r} that is not a list.")
        return answer

    def _read(self, path: str, key: str, body: Any = None, verb: str | None = None) -> Any:
        payload = self._request(path, body, verb)
        if key not in payload:
            raise ToolError("internal_error", f"The daemon at {self._base} answered without the key {key!r}.")
        return payload[key]

    def _request(self, path: str, body: Any = None, verb: str | None = None) -> dict[str, Any]:
        data = None if body is None else json.dumps(body).encode()
        asked = urllib.request.Request(
            f"{self._base}{API}{path}", data=data, method=verb or ("GET" if data is None else "POST")
        )
        asked.add_header("authorization", f"Bearer {self._token}")
        asked.add_header("accept", "application/json")
        if data is not None:
            asked.add_header("content-type", "application/json")
        try:
            with OPENER.open(asked, timeout=self._timeout) as answer:
                return self._parse(answer.read(), answer.status)
        except urllib.error.HTTPError as cause:
            raise self._refused(cause.read(), cause.code) from None
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as cause:
            raise self._unreachable(cause) from None

    def _parse(self, raw: bytes, status: int) -> dict[str, Any]:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ToolError(
                "internal_error",
                f"The daemon at {self._base} answered with something that is not JSON.",
                {"status": status},
            ) from None
        if not isinstance(payload, dict):
            raise ToolError(
                "internal_error",
                f"The daemon at {self._base} answered with something that is not an object.",
                {"status": status},
            )
        return payload

    def _refused(self, raw: bytes, status: int) -> ToolError:
        try:
            error = self._parse(raw, status).get("error")
        except ToolError:
            error = None
        if isinstance(error, dict):
            code, message, details = error.get("code"), error.get("message"), error.get("details")
            if isinstance(code, str) and isinstance(message, str):
                return ToolError(code, message, details if isinstance(details, dict) else {})
        return ToolError(
            "internal_error",
            f"The daemon at {self._base} refused the call with status {status}.",
            {"status": status},
        )

    def _unreachable(self, cause: Exception) -> TransportError:
        reason = getattr(cause, "reason", cause)
        if isinstance(reason, TimeoutError) or isinstance(cause, TimeoutError):
            return TransportError(
                "transport_failed",
                f"The daemon at {self._base} did not answer within {self._timeout} seconds.",
                {"url": self._base, "timeout": self._timeout},
            )
        return TransportError(
            "transport_failed",
            f"The daemon at {self._base} did not answer: {reason}. Start it with `flintd serve`, or point the client "
            "at the URL it logged.",
            {"url": self._base, "reason": str(reason)},
        )
