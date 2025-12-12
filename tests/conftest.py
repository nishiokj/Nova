"""
Pytest configuration and shared fixtures for the Agent Harness test suite.

Fixtures are automatically available to all test modules.
"""

import os
import sys
import tempfile
import shutil
from pathlib import Path
import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
SRC_DIR = PROJECT_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from harness.config import (
    HarnessConfig, LLMConfig, AgentConfig, ToolConfig,
    RouterConfig, ServiceRepConfig, LoggingConfig
)
from harness.tool_registry import ToolRegistry
from harness.router import Router
from communication.event_bus import EventBus
from harness.logger import StructuredLogger

# Import helpers from test_helpers module
from tests.test_helpers import (
    MockLLMAdapter, MockLLMBehavior,
    create_tool_call, TEST_DATA
)


# =============================================================================
# FIXTURES - Reusable test components
# =============================================================================

@pytest.fixture
def temp_dir():
    """Create a temporary directory for file operation tests"""
    tmp = tempfile.mkdtemp(prefix="harness_test_")
    yield tmp
    # Cleanup
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def temp_working_dir(temp_dir):
    """Create a structured temporary working directory"""
    # Create subdirectories
    subdir = Path(temp_dir) / "subdir"
    subdir.mkdir()

    nested = subdir / "nested"
    nested.mkdir()

    # Create some test files
    (Path(temp_dir) / "test_file.txt").write_text("Hello, World!")
    (Path(temp_dir) / "test_data.json").write_text('{"key": "value", "number": 42}')
    (subdir / "sub_file.txt").write_text("Subdirectory file content")
    (nested / "deep_file.txt").write_text("Deeply nested content")

    # Create a Python script for execution tests
    (Path(temp_dir) / "test_script.py").write_text(
        'print("Script executed successfully")\n'
        'result = 2 + 2\n'
        'print(f"Result: {result}")\n'
    )

    # Create a bash script
    bash_script = Path(temp_dir) / "test_script.sh"
    bash_script.write_text('#!/bin/bash\necho "Bash script executed"')
    bash_script.chmod(0o755)

    return temp_dir


@pytest.fixture
def mock_llm_config():
    """Create a mock LLM config"""
    return LLMConfig(
        provider="mock",
        model="mock-model",
        api_key="test-key",
        max_tokens=1000,
        temperature=0.7
    )


@pytest.fixture
def mock_logger():
    """Create a mock logger that captures all log entries"""
    return StructuredLogger(
        name="test_harness",
        log_to_file=False,
        log_to_console=False,
        log_level="DEBUG"
    )


@pytest.fixture
def tool_registry(mock_logger):
    """Create a fresh ToolRegistry for testing"""
    config = ToolConfig(
        enabled_tools=[
            "fast_answer", "web_search", "web_fetch",
            "bash_execute", "python_execute",
            "file_read", "file_write", "search_filesystem",
            "calculator", "get_current_time"
        ],
        sandbox_bash=True,
        sandbox_python=True,
        max_output_length=10000,
        bash_timeout=30,
        python_timeout=60
    )
    return ToolRegistry(config, logger=mock_logger)


@pytest.fixture
def tool_registry_with_workdir(temp_working_dir, mock_logger):
    """Create ToolRegistry with a specific working directory"""
    config = ToolConfig(
        enabled_tools=[
            "file_read", "file_write", "search_filesystem", "bash_execute", "python_execute"
        ]
    )
    registry = ToolRegistry(config, default_working_dir=temp_working_dir, logger=mock_logger)
    return registry


@pytest.fixture
def simple_mock_behavior():
    """Simple mock behavior - just returns text"""
    return MockLLMBehavior(
        responses=["This is a simple response."]
    )


@pytest.fixture
def tool_calling_mock_behavior():
    """Mock behavior that makes a tool call then responds"""
    return MockLLMBehavior(
        responses=["", "Based on the calculation, the answer is 4."],
        tool_calls=[
            [create_tool_call("calculator", expression="2+2")],
            []  # No more tool calls
        ]
    )


@pytest.fixture
def multi_tool_mock_behavior():
    """Mock behavior that makes multiple tool calls"""
    return MockLLMBehavior(
        responses=[
            "",  # First call - just tools
            "",  # Second call - more tools
            "Based on my search and calculations, here's the answer."
        ],
        tool_calls=[
            [create_tool_call("calculator", expression="10*5")],
            [create_tool_call("get_current_time", format="human")],
            []  # Final response
        ]
    )


@pytest.fixture
def mock_agent_config(mock_llm_config):
    """Create an agent config with mock LLM"""
    return AgentConfig(
        llm_config=mock_llm_config,
        tier="standard",
        system_prompt="You are a helpful test assistant.",
        max_tool_calls=5,
        tool_timeout=30,
        allow_code_execution=True,
        allow_internet=True,
        allow_bash=True
    )


@pytest.fixture
def router():
    """Create a Router with pattern classification only"""
    config = RouterConfig(
        enabled=True,
        default_tier="standard",
        llm_config=None  # Pattern-only routing
    )
    return Router(config)


@pytest.fixture
def event_bus():
    """Create an EventBus for testing"""
    return EventBus(max_agent_pending=1)


@pytest.fixture
def service_rep_config():
    """Create ServiceRep config (disabled for testing)"""
    return ServiceRepConfig(
        enabled=False,  # Disable TTS in tests
        voice_engine="none"
    )


@pytest.fixture
def harness_config(mock_llm_config, service_rep_config):
    """Create a complete HarnessConfig for integration testing"""
    return HarnessConfig(
        router=RouterConfig(enabled=True, default_tier="standard"),
        service_rep=service_rep_config,
        agent=AgentConfig(tier="standard", max_tool_calls=3),
        tools=ToolConfig(enabled_tools=[
            "calculator", "get_current_time", "file_read", "file_write"
        ]),
        logging=LoggingConfig(log_to_file=False, log_to_console=False),
        llm_configs={
            "router": mock_llm_config,
            "simple": mock_llm_config,
            "standard": mock_llm_config,
            "advanced": mock_llm_config,
            "service_rep": mock_llm_config
        }
    )


@pytest.fixture
def mock_harness_config(harness_config):
    """Alias for harness_config - used by integration tests"""
    return harness_config
