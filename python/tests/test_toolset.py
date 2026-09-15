from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, RetryPromptPart, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from conftest import activate, verified
from flintd import Flint, TransportError
from flintd.toolset import FlintToolset

COUNT_WORDS = {
    "name": "count_words",
    "description": "Count the words in a piece of text.",
    "parameters_json": json.dumps(
        {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        }
    ),
    "execute_source": "return args.text.trim().split(/\\s+/).length",
    "examples": [{"args": {"text": "a b"}, "expected": 2}],
}


def test_a_tool_written_in_one_step_is_callable_in_a_later_step(library: Flint) -> None:
    seen: list[list[str]] = []

    def steps(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append([one.name for one in info.function_tools])
        step = len(seen)
        if step == 1:
            return ModelResponse(parts=[ToolCallPart("tool_create", COUNT_WORDS)])
        if step == 2:
            verified(library, "count_words")
            activate(library, "count_words", {"text": "one two"})
            return ModelResponse(parts=[ToolCallPart("tool_find", {"query": "count the words"})])
        if step == 3:
            return ModelResponse(parts=[ToolCallPart("fl_count_words", {"text": "one two three"})])
        returned = [one for one in messages[-1].parts if isinstance(one, ToolReturnPart)]
        return ModelResponse(parts=[TextPart(str(returned[-1].content))])

    agent = Agent(FunctionModel(steps), toolsets=[FlintToolset(library)])
    answer = agent.run_sync("count the words")

    assert answer.output == "3"
    assert "fl_count_words" not in seen[0], "the Tool did not exist when the run started"
    assert "fl_count_words" in seen[2], "the toolset is read again at every step, so the new Tool is callable"
    assert set(seen[0][:7]) == set(seen[2][:7]), "the meta tools are there at every step"


def test_a_refusal_goes_back_to_the_model_rather_than_ending_the_run(library: Flint) -> None:
    refusals: list[str] = []

    def steps(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        for one in messages[-1].parts:
            if isinstance(one, RetryPromptPart):
                refusals.append(str(one.content))
        if refusals:
            return ModelResponse(parts=[TextPart("the model read the refusal")])
        return ModelResponse(parts=[ToolCallPart("tool_read", {"name": "no_such_tool"})])

    agent = Agent(FunctionModel(steps), toolsets=[FlintToolset(library)])
    answer = agent.run_sync("read a Tool that is not there")

    assert answer.output == "the model read the refusal"
    assert refusals[0].startswith("not_found: ")


def test_the_toolset_carries_the_argument_schema_of_every_tool(library: Flint) -> None:
    held: dict[str, Any] = {}

    def steps(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        held.update({one.name: one for one in info.function_tools})
        return ModelResponse(parts=[TextPart("done")])

    Agent(FunctionModel(steps), toolsets=[FlintToolset(library)]).run_sync("say what you hold")

    assert held["fl_split_list"].parameters_json_schema["required"] == ["value"]
    assert held["fl_split_list"].description.startswith("Split a delimited string")
    assert "tool_create" in held and "fl_tool_create" not in held


class DiesOnCall(Flint):
    """A daemon that answers the tool list and is gone by the time the model calls one of them."""

    def call(self, name: str, args: Any = None, meta: dict[str, Any] | None = None) -> Any:
        raise TransportError("transport_failed", "The daemon did not answer.", {"url": "http://127.0.0.1:1"})


def test_a_daemon_that_dies_ends_the_run_rather_than_asking_the_model_again(daemon: tuple[str, str]) -> None:
    url, token = daemon
    asked: list[int] = []

    def steps(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        asked.append(len(messages))
        return ModelResponse(parts=[ToolCallPart("tool_find", {"query": "anything"})])

    agent = Agent(FunctionModel(steps), toolsets=[FlintToolset(DiesOnCall(url, token))])
    with pytest.raises(TransportError) as refusal:
        agent.run_sync("find a Tool")

    assert refusal.value.code == "transport_failed"
    assert len(asked) == 1, "no model can start a daemon, so the run ends rather than asking again"
