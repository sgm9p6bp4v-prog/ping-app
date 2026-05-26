from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "ping_outputs"


@pytest.fixture(scope="session")
def ping_fixture():
    """Load a named ping-output fixture as raw text."""

    def _load(name: str) -> str:
        return (FIXTURES / name).read_text()

    return _load
