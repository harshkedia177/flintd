from __future__ import annotations

from typing import Any

TOOL_ERROR_CODES = frozenset(
    {
        "invalid_name",
        "invalid_description",
        "invalid_schema",
        "invalid_source",
        "invalid_arguments",
        "invalid_examples",
        "invalid_result",
        "example_failed",
        "exists",
        "duplicate",
        "not_found",
        "not_implemented",
        "invalid_manifest",
        "awaiting_approval",
        "recursive_call",
        "call_failed",
        "unserializable_result",
        "result_too_large",
        "timeout",
        "worker_unavailable",
        "store_error",
        "dir_in_use",
        "internal_error",
        "unauthorized",
        "forbidden",
        "method_not_allowed",
        "request_too_large",
        # The one code a daemon never sends: this client raises it when no daemon answered at all.
        "transport_failed",
    }
)


class ToolError(Exception):
    """Every refusal a flintd surface makes, with the stable code the daemon sent."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code if code in TOOL_ERROR_CODES else "internal_error"
        self.message = message
        self.details: dict[str, Any] = {} if details is None else details


class TransportError(ToolError):
    """The daemon was never reached, so no Tool refused anything and no call was recorded."""
