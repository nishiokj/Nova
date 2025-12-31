"""
Benchmark configuration and fixtures.
"""

import sys
from pathlib import Path

import pytest

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


def pytest_configure(config):
    config.addinivalue_line("markers", "benchmark: mark test as a benchmark")


@pytest.fixture
def benchmark_llm_config():
    """LLM config for benchmarks (uses mock)."""
    from util.config import LLMConfig

    return LLMConfig(provider="mock", model="benchmark-model", max_tokens=1000)


@pytest.fixture
def tool_registry():
    """Tool registry for benchmarks."""
    from harness.agent.tool_registry import ToolRegistry

    return ToolRegistry()
