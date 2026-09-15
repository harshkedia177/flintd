from __future__ import annotations

import json
import re
from typing import Any, Literal

from .errors import ToolError

Format = Literal["anthropic", "openai", "openai-chat", "gemini"]

FORMATS: tuple[Format, ...] = ("anthropic", "openai", "openai-chat", "gemini")

META_TOOL_NAMES = frozenset(
    {"tool_create", "tool_update", "tool_read", "tool_find", "tool_run", "tool_retire", "tool_history"}
)

TOOL_PREFIX = "fl_"

# A stored name is at most 60 characters of `[a-z][a-z0-9_]*`, so `fl_` still fits the 64 every provider allows.
NAME_RULES: dict[str, re.Pattern[str]] = {
    "anthropic": re.compile(r"^[a-zA-Z0-9_-]{1,128}$"),
    "openai": re.compile(r"^[a-zA-Z0-9_-]{1,64}$"),
    "openai-chat": re.compile(r"^[a-zA-Z0-9_-]{1,64}$"),
    "gemini": re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$"),
}

# Gemini's Schema is a subset of OpenAPI 3.03: it has no `additionalProperties`, and its examples field is singular.
GEMINI_UNSUPPORTED = frozenset({"additionalProperties", "examples"})

# A genai Schema spells these four as strings, the way proto JSON spells an int64. `maximum` and `minimum` stay numbers.
GEMINI_COUNTS = frozenset({"minItems", "maxItems", "minLength", "maxLength"})

# Structured outputs names the keywords it takes, and these five of flintd's are not among them.
STRICT_UNSUPPORTED = frozenset({"minLength", "maxLength", "title", "default", "examples"})

# "Objects have limitations on nesting depth and size": up to 10 levels. flintd's own bound is 32.
STRICT_MAX_DEPTH = 10


def export_name(name: str) -> str:
    return name if name in META_TOOL_NAMES else f"{TOOL_PREFIX}{name}"


def library_name(exported: str) -> str:
    """`fl_` is reserved at create, so a Tool never carries it and the prefix is only the spelling a format exports."""
    if exported in META_TOOL_NAMES or not exported.startswith(TOOL_PREFIX):
        return exported
    bare = exported[len(TOOL_PREFIX) :]
    return exported if bare in META_TOOL_NAMES else bare


def format_tools(tools: list[dict[str, Any]], format: Format) -> list[dict[str, Any]]:
    """The `tools` of one provider's request, built from the model-facing list the daemon answers."""
    if format == "anthropic":
        return [
            {"name": named(one, format), "description": one["description"], "input_schema": one["parameters"]}
            for one in tools
        ]
    if format == "openai":
        return [
            {
                "type": "function",
                "name": named(one, format),
                "description": one["description"],
                "parameters": one["parameters"],
                "strict": strictly(one["parameters"]),
            }
            for one in tools
        ]
    if format == "openai-chat":
        return [
            {
                "type": "function",
                "function": {
                    "name": named(one, format),
                    "description": one["description"],
                    "parameters": one["parameters"],
                    "strict": strictly(one["parameters"]),
                },
            }
            for one in tools
        ]
    if format == "gemini":
        return [
            {
                "name": named(one, format),
                "description": one["description"],
                "parameters": subset(one["parameters"]),
                **({} if one.get("result") is None else {"response": subset(one["result"])}),
            }
            for one in tools
        ]
    raise unknown(format)


def read_call(block: Any, format: Format) -> tuple[str, str, Any]:
    """The id the provider wants echoed, the Tool name and the arguments, read from one tool-call block."""
    one = obj(block, "the tool call")
    if format == "anthropic":
        return string(one.get("id"), "id"), string(one.get("name"), "name"), one.get("input")
    if format == "openai":
        return string(one.get("call_id"), "call_id"), string(one.get("name"), "name"), one.get("arguments")
    if format == "openai-chat":
        call = obj(one.get("function"), "function")
        return string(one.get("id"), "id"), string(call.get("name"), "name"), call.get("arguments")
    if format == "gemini":
        part = obj(one["functionCall"], "functionCall") if "functionCall" in one else one
        held = part.get("id")
        return "" if held is None else string(held, "id"), string(part.get("name"), "name"), part.get("args")
    raise unknown(format)


def success(call_id: str, name: str, result: Any, format: Format) -> dict[str, Any]:
    """The block a caller puts back into the provider's next request, holding the result as JSON."""
    if format == "anthropic":
        return {"type": "tool_result", "tool_use_id": call_id, "content": json.dumps(result)}
    if format == "openai":
        return {"type": "function_call_output", "call_id": call_id, "output": json.dumps(result)}
    if format == "openai-chat":
        return {"role": "tool", "tool_call_id": call_id, "content": json.dumps(result)}
    if format == "gemini":
        return {"functionResponse": {**identified(call_id), "name": name, "response": {"output": result}}}
    raise unknown(format)


def failure(call_id: str, name: str, cause: ToolError, format: Format) -> dict[str, Any]:
    """The same block carrying a refusal, in the slot each provider keeps for one, so the model reads it and acts."""
    payload = {"error": {"code": cause.code, "message": cause.message}}
    if format == "anthropic":
        return {"type": "tool_result", "tool_use_id": call_id, "content": json.dumps(payload), "is_error": True}
    if format == "openai":
        return {"type": "function_call_output", "call_id": call_id, "output": json.dumps(payload)}
    if format == "openai-chat":
        return {"role": "tool", "tool_call_id": call_id, "content": json.dumps(payload)}
    if format == "gemini":
        return {"functionResponse": {**identified(call_id), "name": name, "response": payload}}
    raise unknown(format)


def parsed(args: Any) -> Any:
    if not isinstance(args, str):
        return {} if args is None else args
    try:
        return json.loads(args)
    except json.JSONDecodeError as cause:
        raise ToolError(
            "invalid_arguments", f"The arguments are not JSON: {cause}. Send the arguments again as one JSON object."
        ) from None


def identified(call_id: str) -> dict[str, str]:
    return {} if call_id == "" else {"id": call_id}


def named(tool: dict[str, Any], format: Format) -> str:
    name = export_name(tool["name"])
    if NAME_RULES[format].match(name) is None:
        raise ToolError(
            "internal_error", f"{name} is not a name the {format} format accepts.", {"name": name, "format": format}
        )
    return name


def strictly(schema: Any) -> bool:
    """OpenAI structured outputs holds a strict schema to a closed object whose every property is required."""
    return isinstance(schema, dict) and schema.get("type") == "object" and qualifies(schema, 1)


def qualifies(schema: Any, depth: int) -> bool:
    if not isinstance(schema, dict) or depth > STRICT_MAX_DEPTH:
        return False
    # The supported types are string, number, boolean, integer, object, array, enum and anyOf. A null is none of them.
    if schema.get("type") == "null":
        return False
    if any(key in STRICT_UNSUPPORTED for key in schema):
        return False
    properties: dict[str, Any] = schema.get("properties") or {}
    if schema.get("type") == "object":
        if schema.get("additionalProperties") is not False:
            return False
        if any(key not in (schema.get("required") or []) for key in properties):
            return False
    if any(not qualifies(child, depth + 1) for child in properties.values()):
        return False
    return schema.get("items") is None or qualifies(schema["items"], depth + 1)


def subset(schema: Any) -> Any:
    if not isinstance(schema, dict):
        return schema
    kept: dict[str, Any] = {}
    for key, value in schema.items():
        if key in GEMINI_UNSUPPORTED:
            continue
        if key == "properties" and isinstance(value, dict):
            kept[key] = {child: subset(one) for child, one in value.items()}
            continue
        if key in GEMINI_COUNTS:
            kept[key] = str(value)
            continue
        kept[key] = subset(value) if key == "items" else value
    held = schema.get("enum")
    # A genai Schema.enum is string[], so an enum of anything else moves into the description, where a model reads it.
    if held is not None and not (schema.get("type") == "string" and all(isinstance(one, str) for one in held)):
        kept.pop("enum", None)
        values = ", ".join(json.dumps(one) for one in held)
        said = schema.get("description")
        kept["description"] = f"{'' if said is None else f'{said} '}One of: {values}."
    return kept


def unknown(format: str) -> ToolError:
    return ToolError("invalid_arguments", f"The tool format {format!r} is not one of {', '.join(FORMATS)}.")


def obj(value: Any, what: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ToolError("invalid_arguments", f"{what} is not an object, so there is no tool call to run.")
    return value


def string(value: Any, field: str) -> str:
    if not isinstance(value, str) or value == "":
        raise ToolError("invalid_arguments", f"The tool call carries no `{field}`, so there is nothing to run.")
    return value
