from __future__ import annotations

import json

import pytest

from flintd import Flint, ToolError, TransportError

MANIFEST_TOOL = {
    "name": "weather_note",
    "description": "Write one line about the weather of a place from a fixed note.",
    "parameters_json": json.dumps(
        {
            "type": "object",
            "properties": {"place": {"type": "string"}},
            "required": ["place"],
            "additionalProperties": False,
        }
    ),
    "execute_source": "return `${args.place}: fair`",
    "examples": [{"args": {"place": "Berlin"}, "expected": "Berlin: fair"}],
    "manifest_json": json.dumps({"hosts": ["api.example.com"]}),
}


def test_a_token_the_daemon_does_not_hold_is_unauthorized(daemon: tuple[str, str]) -> None:
    url, _ = daemon
    with pytest.raises(ToolError) as refusal:
        Flint(url, "not-the-token").status()
    assert refusal.value.code == "unauthorized"


def test_status_carries_the_library_and_the_configured_model(library: Flint) -> None:
    status = library.status()
    assert status["model"]["configured"] is True
    assert "apiKey" not in json.dumps(status)
    assert status["activeCap"] >= 1
    assert [one["library"] for one in status["libraries"]] == ["user"]


def test_a_tool_written_through_the_client_answers_its_own_call(library: Flint) -> None:
    assert library.call("split_list", {"value": "one, two , three"}) == ["one", "two", "three"]
    assert library.call("tool_run", {"name": "split_list", "args": {"value": "a,b"}}) == ["a", "b"]
    assert "split_list" in [one["name"] for one in library.library()]


def test_a_call_carries_an_id_and_a_report_moves_the_contribution(library: Flint) -> None:
    call = library.call_with_id("shout", {"text": "quiet"})
    assert call["result"] == "QUIET"
    assert isinstance(call["id"], str)
    report = library.report(call["id"], "negative", "it shouted at the wrong moment")
    assert report["tool"] == "shout"
    assert report["outcome"] == "negative"
    assert report["contribution"] < 1
    assert library.report(call["id"], "positive")["contribution"] == 1
    assert library.call_with_id("tool_find", {"query": "shout"})["id"] is None


def test_an_unknown_call_id_is_not_found(library: Flint) -> None:
    with pytest.raises(ToolError) as refusal:
        library.report("no-such-call", "positive")
    assert refusal.value.code == "not_found"


def test_find_answers_the_tool_closest_to_the_query(library: Flint) -> None:
    found = library.find("split a delimited string into parts", 1)
    assert [one["name"] for one in found] == ["split_list"]
    assert found[0]["state"] == "active"
    with pytest.raises(ToolError) as refusal:
        library.find("")
    assert refusal.value.code == "invalid_arguments"


def test_a_manifest_waits_for_an_approval_and_approve_decides_it(library: Flint) -> None:
    library.call("tool_create", MANIFEST_TOOL)
    with pytest.raises(ToolError) as refusal:
        library.call("weather_note", {"place": "Berlin"})
    assert refusal.value.code == "awaiting_approval"

    waiting = [one for one in library.approvals() if one["tool"] == "weather_note"]
    assert [one["status"] for one in waiting] == ["pending"]
    assert waiting[0]["manifest"] == {"hosts": ["api.example.com"]}

    decision = library.approve(waiting[0]["id"], "the host is ours")
    assert decision["status"] == "approved"
    assert decision["note"] == "the host is ours"
    assert library.call("weather_note", {"place": "Berlin"}) == "Berlin: fair"


def test_a_denied_approval_leaves_the_tool_refused(library: Flint) -> None:
    library.call(
        "tool_create",
        {**MANIFEST_TOOL, "name": "tide_note", "description": "Write one line about the tide of a harbour."},
    )
    waiting = next(one for one in library.approvals() if one["tool"] == "tide_note")
    assert library.deny(waiting["id"], "no")["status"] == "denied"
    with pytest.raises(ToolError) as refusal:
        library.call("tide_note", {"place": "Kiel"})
    assert refusal.value.code == "awaiting_approval"


def test_a_connection_header_value_is_written_once_and_never_answered(library: Flint) -> None:
    written = library.add_connection("gitplace", ["api.gitplace.test"], "authorization", "Bearer secret")
    assert written == {"name": "gitplace", "hosts": ["api.gitplace.test"]}
    listed = library.connections()
    assert "secret" not in json.dumps(listed)
    assert {"name": "gitplace", "hosts": ["api.gitplace.test"]} in listed
    assert library.remove_connection("gitplace")["name"] == "gitplace"
    assert "gitplace" not in [one["name"] for one in library.connections()]


def test_a_daemon_that_is_not_there_answers_no_call(daemon: tuple[str, str]) -> None:
    _, token = daemon
    with pytest.raises(TransportError) as refusal:
        Flint("http://127.0.0.1:1", token, timeout=2.0).status()
    assert refusal.value.code == "transport_failed", "a code no daemon sends, so it is never a refusal of a Tool"
    assert refusal.value.details["url"] == "http://127.0.0.1:1"
    assert "flintd serve" in refusal.value.message
    assert isinstance(refusal.value, ToolError), "one except catches every refusal this client raises"


def test_start_proves_the_daemon_answers_and_stop_leaves_it_running(library: Flint) -> None:
    library.start()
    library.stop()
    assert library.status()["tools"] >= 2


def test_a_code_this_client_does_not_know_reads_as_internal_error() -> None:
    assert ToolError("no_such_code", "a daemon of another build").code == "internal_error"
    assert ToolError("timeout", "took too long").code == "timeout"
