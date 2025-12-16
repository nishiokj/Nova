"""
Test helper utilities for the Agent Harness test suite.

Contains:
- Mock LLM adapters
- Assertion helpers
- Test data generators
- Utility functions

These are imported by test modules and conftest.py
"""

import os
import sys
import time
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Generator

# Add harness to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.agent.tool_registry import ToolResult, ToolStatus
from util.llm_adapter import (
    LLMAdapter, LLMResponse, Message, MessageRole,
    ToolCall, ToolDefinition
)
from util.config import LLMConfig


# =============================================================================
# MOCK LLM ADAPTER - Critical for testing without API calls
# =============================================================================

@dataclass
class MockLLMBehavior:
    """Defines how the mock LLM should respond"""
    responses: List[str] = field(default_factory=list)
    tool_calls: List[List[ToolCall]] = field(default_factory=list)
    response_index: int = 0
    delay_ms: float = 0  # Simulate latency
    should_fail: bool = False
    fail_message: str = "Mock LLM failure"

    def get_next_response(self) -> tuple:
        """Get next response and tool calls"""
        if self.should_fail:
            raise Exception(self.fail_message)

        if self.delay_ms > 0:
            time.sleep(self.delay_ms / 1000)

        response = ""
        tools = []

        if self.responses and self.response_index < len(self.responses):
            response = self.responses[self.response_index]

        if self.tool_calls and self.response_index < len(self.tool_calls):
            tools = self.tool_calls[self.response_index]

        self.response_index += 1
        return response, tools


class MockLLMAdapter(LLMAdapter):
    """
    Mock LLM adapter for testing.

    Allows precise control over:
    - Response content
    - Tool call sequences
    - Latency simulation
    - Error injection
    """

    def __init__(self, config: LLMConfig = None, behavior: MockLLMBehavior = None):
        self._config = config or LLMConfig(provider="mock", model="mock-model", api_key="mock-key")
        self.behavior = behavior or MockLLMBehavior()
        self.call_history: List[Dict[str, Any]] = []
        self._prewarmed = False
        self.logger = None  # Mock logger

    @property
    def config(self):
        return self._config

    @property
    def provider(self) -> str:
        return "mock"

    def prewarm(self) -> bool:
        self._prewarmed = True
        return True

    def complete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """Return mocked response"""
        self.call_history.append({
            "method": "complete",
            "messages": [m.to_dict() for m in messages],
            "tools": [t.name for t in tools] if tools else [],
            "kwargs": kwargs
        })

        response_text, tool_calls = self.behavior.get_next_response()

        return LLMResponse(
            content=response_text,
            role=MessageRole.ASSISTANT,
            tool_calls=tool_calls,
            finish_reason="stop" if not tool_calls else "tool_calls",
            usage={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
            model="mock-model"
        )

    def stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """Stream mocked response"""
        response = self.complete(messages, tools, **kwargs)
        # Yield content in chunks
        for word in response.content.split():
            yield word + " "
        return response

    async def acomplete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        return self.complete(messages, tools, **kwargs)

    async def astream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ):
        response = self.complete(messages, tools, **kwargs)
        for word in response.content.split():
            yield word + " "


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def create_tool_call(name: str, **kwargs) -> ToolCall:
    """Helper to create a ToolCall"""
    import uuid
    return ToolCall(
        id=f"call_{uuid.uuid4().hex[:8]}",
        name=name,
        arguments=kwargs
    )


def assert_tool_result_success(result: ToolResult, expected_output_contains: str = None):
    """Assert tool result was successful"""
    assert result.status == ToolStatus.SUCCESS, f"Expected SUCCESS but got {result.status}: {result.error}"
    assert result.is_success
    if expected_output_contains:
        assert expected_output_contains in str(result.output), \
            f"Expected '{expected_output_contains}' in output: {result.output}"


def assert_tool_result_error(result: ToolResult, expected_error_contains: str = None):
    """Assert tool result was an error"""
    assert result.status in (ToolStatus.ERROR, ToolStatus.TIMEOUT, ToolStatus.PERMISSION_DENIED), \
        f"Expected error but got {result.status}"
    assert not result.is_success
    if expected_error_contains:
        assert expected_error_contains in str(result.error), \
            f"Expected '{expected_error_contains}' in error: {result.error}"


def wait_for_condition(condition_fn, timeout: float = 5.0, interval: float = 0.1) -> bool:
    """Wait for a condition to become true"""
    start = time.time()
    while time.time() - start < timeout:
        if condition_fn():
            return True
        time.sleep(interval)
    return False


# =============================================================================
# TEST DATA GENERATORS
# =============================================================================

class TestDataGenerator:
    """Generate various test inputs"""

    SIMPLE_QUERIES = [
        "What is 2+2?",
        "What time is it?",
        "Hello!",
        "Thanks for your help",
        "What is the capital of France?",
        "How do you spell 'necessary'?",
        "What is the meaning of life?",
        "Yes",
        "No",
        "Define photosynthesis"
    ]

    STANDARD_QUERIES = [
        "Search for the latest news about AI",
        "Read the file config.json",
        "Run the command ls -la",
        "Find all Python files in the current directory",
        "Download the webpage at example.com",
        "Check my network connection",
        "What's the weather in New York?",
        "Look up the stock price of AAPL"
    ]

    ADVANCED_QUERIES = [
        "Write a Python function to calculate fibonacci numbers",
        "Analyze this code and suggest improvements",
        "Debug the error in my application",
        "Create a REST API for user management",
        "Compare React and Vue for building web apps",
        "Research the latest developments in quantum computing",
        "Build a comprehensive testing framework",
        "Optimize the database queries in my application"
    ]

    EDGE_CASE_QUERIES = [
        "",  # Empty
        "   ",  # Whitespace only
        "a" * 10000,  # Very long
        "!@#$%^&*()",  # Special characters
        "SELECT * FROM users; DROP TABLE users;--",  # SQL injection attempt
        "<script>alert('xss')</script>",  # XSS attempt
        "rm -rf /",  # Dangerous command
        "\n\n\n",  # Newlines only
        "🔥💻🚀",  # Emojis
        "中文测试",  # Chinese characters
        "مرحبا",  # Arabic
    ]

    TOOL_TRIGGERING_QUERIES = {
        "calculator": [
            "Calculate 25 * 4",
            "What is sqrt(144)?",
            "Compute 3.14 * 2^2"
        ],
        "get_current_time": [
            "What time is it?",
            "What's today's date?",
            "Tell me the current time"
        ],
        "file_read": [
            "Read the file test.txt",
            "Show me the contents of config.json",
            "Open and display readme.md"
        ],
        "bash_execute": [
            "Run ls -la",
            "Execute the command pwd",
            "Run echo hello"
        ],
        "python_execute": [
            "Run this Python code: print('hello')",
            "Execute Python: 2+2",
        ]
    }


# Export for tests
TEST_DATA = TestDataGenerator()
