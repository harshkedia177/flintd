from __future__ import annotations

import asyncio
from typing import Any

from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.tools import RunContext, ToolDefinition
from pydantic_ai.toolsets import AbstractToolset, ToolsetTool
from pydantic_core import SchemaValidator, core_schema

from .client import Flint
from .errors import ToolError, TransportError
from .formats import export_name, library_name

# The daemon checks every call against the Tool's own schema, so a validator here would be a second source of truth.
PASS_THROUGH = SchemaValidator(schema=core_schema.any_schema())


class FlintToolset(AbstractToolset[Any]):
    """The Tools of one daemon, read again at every run step, so one written in a step is callable in the next."""

    def __init__(self, flint: Flint, *, id: str | None = None) -> None:
        self._flint = flint
        self._id = id

    @property
    def id(self) -> str | None:
        return self._id

    async def get_tools(self, ctx: RunContext[Any]) -> dict[str, ToolsetTool[Any]]:
        listed = await asyncio.to_thread(self._flint.tools)
        return {
            export_name(one["name"]): ToolsetTool(
                toolset=self,
                tool_def=ToolDefinition(
                    name=export_name(one["name"]),
                    description=one["description"],
                    parameters_json_schema=one["parameters"],
                ),
                max_retries=1,
                args_validator=PASS_THROUGH,
            )
            for one in listed
        }

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[Any], tool: ToolsetTool[Any]
    ) -> Any:
        meta = {"harness": "pydantic-ai", "sessionId": ctx.run_id} if ctx.run_id else {"harness": "pydantic-ai"}
        try:
            return await asyncio.to_thread(self._flint.call, library_name(name), tool_args, meta)
        except TransportError:
            # No model can start a daemon, so a daemon that is not there ends the run rather than asking for a retry.
            raise
        except ToolError as cause:
            # A refusal is written for a model to act on, so it goes back to the model rather than ending the run.
            raise ModelRetry(f"{cause.code}: {cause.message}") from None
