from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from flintd.formats import FORMATS, Format, format_tools

# The TypeScript emitter of packages/core/src/formats.ts answers the same `expected` over the same `tools`, and
# packages/core/test/format-parity.test.ts asserts it, so a conversion in one language alone fails on the other side.
FIXTURES = json.loads((Path(__file__).parent / "parity.json").read_text())


@pytest.mark.parametrize("format", FORMATS)
def test_the_emitter_answers_what_the_typescript_emitter_answers(format: Format) -> None:
    tools: list[dict[str, Any]] = FIXTURES["tools"]
    assert format_tools(tools, format) == FIXTURES["expected"][format]
