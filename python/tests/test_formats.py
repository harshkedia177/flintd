from __future__ import annotations

import json
import re
from typing import Any

import pytest

from flintd import Flint, ToolError
from flintd.formats import META_TOOL_NAMES, NAME_RULES, format_tools


def names(emitted: list[dict[str, Any]], format: str) -> list[str]:
    if format == "openai-chat":
        return [one["function"]["name"] for one in emitted]
    return [one["name"] for one in emitted]


@pytest.mark.parametrize("format", ["anthropic", "openai", "openai-chat", "gemini"])
def test_a_meta_tool_keeps_its_name_and_a_library_tool_carries_the_prefix(library: Flint, format: Any) -> None:
    emitted = names(library.tools(format), format)
    assert set(emitted[:7]) == META_TOOL_NAMES
    assert "fl_split_list" in emitted
    assert all(NAME_RULES[format].match(one) is not None for one in emitted)


def test_the_anthropic_shape_carries_the_argument_schema_as_input_schema(library: Flint) -> None:
    emitted = library.tools("anthropic")
    split = next(one for one in emitted if one["name"] == "fl_split_list")
    assert split["input_schema"]["properties"]["value"]["type"] == "string"
    assert split["description"].startswith("Split a delimited string")
    assert all(set(one) == {"name", "description", "input_schema"} for one in emitted)


def test_openai_declares_strict_only_for_a_closed_schema(library: Flint) -> None:
    emitted = library.tools("openai")
    split = next(one for one in emitted if one["name"] == "fl_split_list")
    assert split["type"] == "function"
    assert split["strict"] is True
    assert split["parameters"]["additionalProperties"] is False
    create = next(one for one in emitted if one["name"] == "tool_create")
    assert create["strict"] is False, "tool_create takes optional arguments, so no strict schema describes it"


def test_the_chat_shape_nests_the_function(library: Flint) -> None:
    emitted = library.tools("openai-chat")
    split = next(one for one in emitted if one["function"]["name"] == "fl_split_list")
    assert set(split) == {"type", "function"}
    assert set(split["function"]) == {"name", "description", "parameters", "strict"}
    assert split["function"]["strict"] is True


def keys(schema: dict[str, Any]) -> set[str]:
    held = set(schema)
    for child in (schema.get("properties") or {}).values():
        held |= keys(child)
    if isinstance(schema.get("items"), dict):
        held |= keys(schema["items"])
    return held


def test_gemini_takes_the_schema_subset_alone(library: Flint) -> None:
    emitted = library.tools("gemini")
    assert all("additionalProperties" not in keys(one["parameters"]) for one in emitted)
    split = next(one for one in emitted if one["name"] == "fl_split_list")
    assert split["parameters"]["required"] == ["value"]
    assert split["parameters"]["properties"]["value"]["description"] == "The text to split."


def test_a_name_no_provider_accepts_is_refused_rather_than_sent(library: Flint) -> None:
    with pytest.raises(ToolError) as refusal:
        format_tools([{"name": "a" * 62, "description": "too long for openai", "parameters": {}}], "openai")
    assert refusal.value.code == "internal_error"
    assert re.search(r"^fl_a+ is not a name the openai format accepts", refusal.value.message)


def test_call_from_runs_an_anthropic_tool_use_block(library: Flint) -> None:
    answered = library.call_from(
        {"type": "tool_use", "id": "toolu_1", "name": "fl_split_list", "input": {"value": "a, b"}}, "anthropic"
    )
    assert answered == {"type": "tool_result", "tool_use_id": "toolu_1", "content": '["a", "b"]'}


def test_call_from_runs_an_openai_function_call_item(library: Flint) -> None:
    answered = library.call_from(
        {"type": "function_call", "call_id": "call_1", "name": "fl_shout", "arguments": '{"text": "hey"}'}, "openai"
    )
    assert answered == {"type": "function_call_output", "call_id": "call_1", "output": '"HEY"'}


def test_call_from_runs_a_chat_completions_tool_call(library: Flint) -> None:
    answered = library.call_from(
        {"id": "call_2", "type": "function", "function": {"name": "fl_shout", "arguments": '{"text": "hey"}'}},
        "openai-chat",
    )
    assert answered == {"role": "tool", "tool_call_id": "call_2", "content": '"HEY"'}


def test_call_from_runs_a_gemini_function_call(library: Flint) -> None:
    answered = library.call_from({"functionCall": {"name": "fl_shout", "args": {"text": "hey"}}}, "gemini")
    assert answered == {"functionResponse": {"name": "fl_shout", "response": {"output": "HEY"}}}


def test_call_from_reaches_a_meta_tool_by_its_own_name(library: Flint) -> None:
    answered = library.call_from(
        {"type": "tool_use", "id": "toolu_2", "name": "tool_find", "input": {"query": "split a string"}}, "anthropic"
    )
    assert "split_list" in answered["content"]


@pytest.mark.parametrize("format", ["anthropic", "openai", "openai-chat", "gemini"])
def test_a_refusal_reaches_the_provider_error_slot(library: Flint, format: Any) -> None:
    blocks: dict[str, dict[str, Any]] = {
        "anthropic": {"type": "tool_use", "id": "toolu_3", "name": "fl_no_such_tool", "input": {}},
        "openai": {"type": "function_call", "call_id": "call_3", "name": "fl_no_such_tool", "arguments": "{}"},
        "openai-chat": {"id": "call_3", "type": "function", "function": {"name": "fl_no_such_tool", "arguments": "{}"}},
        "gemini": {"functionCall": {"name": "fl_no_such_tool", "args": {}}},
    }
    answered = library.call_from(blocks[format], format)
    if format == "gemini":
        assert answered["functionResponse"]["response"]["error"]["code"] == "not_found"
        return
    if format == "anthropic":
        assert answered["is_error"] is True
    written = answered.get("content") or answered["output"]
    assert json.loads(written)["error"]["code"] == "not_found"


def test_arguments_that_are_not_json_are_a_refusal_and_never_a_call(library: Flint) -> None:
    answered = library.call_from(
        {"type": "function_call", "call_id": "call_4", "name": "fl_shout", "arguments": "{not json"}, "openai"
    )
    assert json.loads(answered["output"])["error"]["code"] == "invalid_arguments"


def test_a_block_with_no_name_is_refused_before_any_call(library: Flint) -> None:
    with pytest.raises(ToolError) as refusal:
        library.call_from({"type": "tool_use", "id": "toolu_4", "input": {}}, "anthropic")
    assert refusal.value.code == "invalid_arguments"


def test_a_format_this_client_does_not_emit_is_refused(library: Flint) -> None:
    with pytest.raises(ToolError) as refusal:
        library.tools("vercel")  # type: ignore[arg-type]
    assert refusal.value.code == "invalid_arguments"
    assert "anthropic, openai, openai-chat, gemini" in refusal.value.message
