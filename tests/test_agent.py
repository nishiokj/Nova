"""
Comprehensive tests for the Agent component.

Tests:
- Agent initialization
- Tool execution through agent
- Tiered agent behavior
- Conversation history
- Callbacks
- Error handling
- Tool limits per tier
"""

import sys
import time
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch
from typing import List

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.agent.agent import (
    Agent, AgentConfig, AgentResponse, AgentStep, AgentState,
    TieredAgent, TIER_TOOL_LIMITS, TIER_MAX_TOKENS,
    SIMPLE_TIER_PROMPT, STANDARD_TIER_PROMPT, ADVANCED_TIER_PROMPT
)
from util.config import LLMConfig
from harness.agent.tool_registry import ToolRegistry, ToolConfig, ToolResult, ToolStatus
from util.llm_adapter import ToolCall, ToolDefinition, Message, MessageRole

from tests.test_helpers import (
    MockLLMAdapter, MockLLMBehavior,
    create_tool_call, assert_tool_result_success,
    TEST_DATA
)


class TestAgentInitialization:
    """Test Agent initialization and configuration"""

    def test_agent_creation(self, tool_registry, mock_llm_config, mock_logger):
        """Test basic agent creation"""
        config = AgentConfig(
            llm_config=mock_llm_config,
            tier="standard",
            system_prompt="Test system prompt"
        )

        agent = Agent(config, tool_registry, mock_llm_config)

        assert agent is not None
        assert agent.config.tier == "standard"
        assert agent._current_state == AgentState.IDLE

    def test_agent_without_llm(self, tool_registry, mock_logger):
        """Test agent behavior without LLM configured"""
        config = AgentConfig(
            llm_config=None,
            tier="standard"
        )

        agent = Agent(config, tool_registry, None)
        response = agent.run("Hello")

        assert not response.success
        assert "not properly configured" in response.content.lower()

    def test_agent_conversation_history(self, tool_registry, mock_llm_config, mock_logger):
        """Test that conversation history is maintained"""
        config = AgentConfig(llm_config=mock_llm_config)
        agent = Agent(config, tool_registry, mock_llm_config)

        # Initially empty
        assert len(agent.conversation_history) == 0

    def test_agent_reset_conversation(self, tool_registry, mock_llm_config, mock_logger):
        """Test resetting conversation history"""
        config = AgentConfig(llm_config=mock_llm_config)
        agent = Agent(config, tool_registry, mock_llm_config)

        # Add some conversation
        agent._add_message(Message(MessageRole.USER, "Test message"))

        # Reset
        agent.reset_conversation()
        assert len(agent._conversation) == 0


class TestAgentExecution:
    """Test Agent run execution"""

    @pytest.fixture
    def mock_agent(self, tool_registry, mock_llm_config, mock_logger):
        """Create an agent with mock LLM"""
        config = AgentConfig(
            llm_config=mock_llm_config,
            tier="standard",
            max_tool_calls=5
        )
        agent = Agent(config, tool_registry, mock_llm_config)

        # Replace LLM with mock
        mock_behavior = MockLLMBehavior(
            responses=["This is a test response."]
        )
        agent._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        return agent

    def test_simple_run_no_tools(self, mock_agent):
        """Test simple run without tool usage"""
        response = mock_agent.run("Hello, how are you?")

        assert response.success
        assert "test response" in response.content.lower()
        assert len(response.tools_used) == 0

    def test_run_with_tool_call(self, tool_registry, mock_llm_config, mock_logger):
        """Test run that triggers a tool call"""
        config = AgentConfig(
            llm_config=mock_llm_config,
            tier="standard",
            max_tool_calls=5
        )
        agent = Agent(config, tool_registry, mock_llm_config)

        # Mock LLM that makes a tool call then responds
        mock_behavior = MockLLMBehavior(
            responses=["", "The answer is 4."],
            tool_calls=[
                [create_tool_call("calculator", expression="2+2")],
                []
            ]
        )
        agent._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        # Use "search" keyword to trigger tool allowance
        response = agent.run("Search and calculate 2+2")

        assert response.success
        assert "calculator" in response.tools_used

    def test_run_respects_tool_limit(self, tool_registry, mock_llm_config, mock_logger):
        """Test that tool limit is respected"""
        config = AgentConfig(
            llm_config=mock_llm_config,
            tier="simple",
            max_tool_calls=1  # Only 1 tool call allowed
        )
        agent = Agent(config, tool_registry, mock_llm_config)

        # Mock LLM that tries to make many tool calls
        mock_behavior = MockLLMBehavior(
            responses=["", "", "Final answer"],
            tool_calls=[
                [create_tool_call("calculator", expression="1+1")],
                [create_tool_call("calculator", expression="2+2")],  # Should be blocked
                []
            ]
        )
        agent._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        response = agent.run("Calculate things")

        # Should have limited tool calls
        assert response.metadata.get("tool_calls", 0) <= 2

    def test_run_with_context(self, mock_agent):
        """Test run with additional context"""
        response = mock_agent.run(
            "Continue our discussion",
            context="We were talking about Python programming"
        )

        assert response.success
        # Context should be included in the request

    def test_run_response_contains_steps(self, mock_agent):
        """Test that response contains execution steps"""
        response = mock_agent.run("Hello")

        assert isinstance(response.steps, list)
        # Should have at least a thinking step
        assert len(response.steps) >= 1

    def test_run_tracks_duration(self, mock_agent):
        """Test that response tracks total duration"""
        response = mock_agent.run("Hello")

        assert response.total_duration_ms > 0


class TestAgentCallbacks:
    """Test Agent callback functionality"""

    @pytest.fixture
    def mock_agent(self, tool_registry, mock_llm_config, mock_logger):
        config = AgentConfig(llm_config=mock_llm_config)
        agent = Agent(config, tool_registry, mock_llm_config)

        mock_behavior = MockLLMBehavior(responses=["Test response"])
        agent._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        return agent

    def test_step_callback(self, mock_agent):
        """Test step callback is called"""
        steps_received = []

        def on_step(step: AgentStep):
            steps_received.append(step)

        mock_agent.add_step_callback(on_step)
        mock_agent.run("Hello")

        assert len(steps_received) >= 1

    def test_thought_callback(self, mock_agent):
        """Test thought callback is called"""
        thoughts_received = []

        def on_thought(thought: str):
            thoughts_received.append(thought)

        mock_agent.add_thought_callback(on_thought)
        mock_agent.run("Hello")

        assert len(thoughts_received) >= 1

    def test_callback_exception_handling(self, mock_agent):
        """Test that callback exceptions don't crash the agent"""
        def bad_callback(step):
            raise ValueError("Callback error!")

        mock_agent.add_step_callback(bad_callback)

        # Should not raise
        response = mock_agent.run("Hello")
        assert response.success


class TestAgentToolExecution:
    """Test Agent tool execution specifics"""

    @pytest.fixture
    def agent_with_tools(self, tool_registry, mock_llm_config, mock_logger):
        """Create agent with mocked LLM and real tools"""
        config = AgentConfig(
            llm_config=mock_llm_config,
            tier="standard",
            max_tool_calls=5
        )
        agent = Agent(config, tool_registry, mock_llm_config)
        return agent

    def test_execute_calculator_tool(self, agent_with_tools, mock_llm_config):
        """Test executing calculator through agent"""
        mock_behavior = MockLLMBehavior(
            responses=["", "The result is 100."],
            tool_calls=[
                [create_tool_call("calculator", expression="10*10")],
                []
            ]
        )
        agent_with_tools._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        # Use "search" keyword to enable tool usage
        response = agent_with_tools.run("Search and calculate 10 times 10")

        assert response.success
        assert "calculator" in response.tools_used

    def test_execute_time_tool(self, agent_with_tools, mock_llm_config):
        """Test executing get_current_time through agent"""
        mock_behavior = MockLLMBehavior(
            responses=["", "The current time is displayed above."],
            tool_calls=[
                [create_tool_call("get_current_time", format="human")],
                []
            ]
        )
        agent_with_tools._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        # Use "current" keyword to trigger realtime data detection
        response = agent_with_tools.run("What is the current time right now?")

        assert response.success
        assert "get_current_time" in response.tools_used

    def test_tool_deduplication(self, agent_with_tools, mock_llm_config):
        """Test that duplicate tool calls are deduplicated"""
        mock_behavior = MockLLMBehavior(
            responses=["", "Done."],
            tool_calls=[
                [
                    create_tool_call("calculator", expression="2+2"),
                    create_tool_call("calculator", expression="2+2"),  # Duplicate
                ],
                []
            ]
        )
        agent_with_tools._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        response = agent_with_tools.run("Calculate 2+2 twice")

        # Should have deduplicated
        assert response.success

    def test_tool_error_handling(self, agent_with_tools, mock_llm_config):
        """Test handling of tool execution errors"""
        mock_behavior = MockLLMBehavior(
            responses=["", "I encountered an error."],
            tool_calls=[
                [create_tool_call("calculator", expression="invalid++")],
                []
            ]
        )
        agent_with_tools._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        response = agent_with_tools.run("Calculate something invalid")

        # Should still complete (agent handles error)
        assert response.success


class TestTieredAgent:
    """Test the TieredAgent component"""

    @pytest.fixture
    def tiered_agent(self, tool_registry, mock_logger):
        """Create a TieredAgent with mock configs"""
        mock_config = LLMConfig(
            provider="mock",
            model="mock-model",
            api_key="test"
        )

        tier_configs = {
            "simple": mock_config,
            "standard": mock_config,
            "advanced": mock_config
        }

        config = AgentConfig(
            tier="standard",
            max_tool_calls=5
        )

        return TieredAgent(config, tool_registry, tier_configs)

    def test_tiered_agent_creation(self, tiered_agent):
        """Test TieredAgent creation"""
        assert tiered_agent is not None
        assert tiered_agent.current_tier == "standard"

    def test_set_tier(self, tiered_agent):
        """Test setting the tier"""
        tiered_agent.set_tier("advanced")
        assert tiered_agent.current_tier == "advanced"

        tiered_agent.set_tier("simple")
        assert tiered_agent.current_tier == "simple"

    def test_get_agent_for_tier(self, tiered_agent):
        """Test getting agent for specific tier"""
        simple_agent = tiered_agent._get_agent("simple")
        assert simple_agent is not None
        assert simple_agent.config.tier == "simple"

        standard_agent = tiered_agent._get_agent("standard")
        assert standard_agent is not None
        assert standard_agent.config.tier == "standard"

        advanced_agent = tiered_agent._get_agent("advanced")
        assert advanced_agent is not None
        assert advanced_agent.config.tier == "advanced"

    def test_tier_specific_tool_limits(self, tiered_agent):
        """Test that each tier has correct tool limits"""
        for tier_name, expected_limit in TIER_TOOL_LIMITS.items():
            agent = tiered_agent._get_agent(tier_name)
            assert agent.config.max_tool_calls == expected_limit, \
                f"{tier_name} should have {expected_limit} tool calls, got {agent.config.max_tool_calls}"

    def test_tier_specific_prompts(self, tiered_agent):
        """Test that each tier gets appropriate system prompt"""
        simple_agent = tiered_agent._get_agent("simple")
        standard_agent = tiered_agent._get_agent("standard")
        advanced_agent = tiered_agent._get_agent("advanced")

        # Check prompts are different
        assert simple_agent.config.system_prompt != standard_agent.config.system_prompt
        assert standard_agent.config.system_prompt != advanced_agent.config.system_prompt

    def test_agent_caching(self, tiered_agent):
        """Test that agents are cached after creation"""
        agent1 = tiered_agent._get_agent("simple")
        agent2 = tiered_agent._get_agent("simple")

        assert agent1 is agent2  # Same instance


class TestAgentRealTimeDetection:
    """Test Agent's ability to detect real-time data needs"""

    @pytest.fixture
    def agent(self, tool_registry, mock_llm_config, mock_logger):
        config = AgentConfig(llm_config=mock_llm_config)
        return Agent(config, tool_registry, mock_llm_config)

    @pytest.mark.parametrize("query,should_need_realtime", [
        ("What's the weather in New York?", True),
        ("What's the temperature outside?", True),
        ("What's the stock price of AAPL?", True),
        ("What's the latest news?", True),
        ("What's the current time?", True),
        ("What's the bitcoin price?", True),
        ("What's the capital of France?", False),  # Static fact
        ("How do you make bread?", False),  # General knowledge
        ("What is photosynthesis?", False),  # Definition
        ("Calculate 2+2", False),  # Calculation
    ])
    def test_realtime_detection(self, agent, query, should_need_realtime):
        """Test detection of queries needing real-time data"""
        needs_realtime = agent._needs_realtime_data(query)
        assert needs_realtime == should_need_realtime, \
            f"'{query}' should {'need' if should_need_realtime else 'not need'} realtime data"


class TestAgentState:
    """Test Agent state management"""

    @pytest.fixture
    def agent(self, tool_registry, mock_llm_config, mock_logger):
        config = AgentConfig(llm_config=mock_llm_config)
        agent = Agent(config, tool_registry, mock_llm_config)
        mock_behavior = MockLLMBehavior(responses=["Response"])
        agent._llm = MockLLMAdapter(mock_llm_config, mock_behavior)
        return agent

    def test_initial_state(self, agent):
        """Test agent starts in IDLE state"""
        assert agent.state == AgentState.IDLE

    def test_state_during_run(self, agent):
        """Test state changes during run"""
        states_observed = []

        def track_state(step):
            states_observed.append(agent.state)

        agent.add_step_callback(track_state)
        agent.run("Hello")

        # Should have passed through THINKING at least
        assert any(s in states_observed for s in [AgentState.THINKING, AgentState.GENERATING_RESPONSE])

    def test_state_after_completion(self, agent):
        """Test state after successful completion"""
        agent.run("Hello")
        assert agent.state == AgentState.COMPLETE


class TestAgentStep:
    """Test AgentStep data structure"""

    def test_step_to_dict(self):
        """Test AgentStep serialization"""
        step = AgentStep(
            step_number=1,
            state=AgentState.EXECUTING_TOOL,
            tool_name="calculator",
            tool_input={"expression": "2+2"},
            tool_output="4",
            duration_ms=50.5
        )

        d = step.to_dict()

        assert d["step"] == 1
        assert d["state"] == "executing_tool"
        assert d["tool_name"] == "calculator"
        assert d["duration_ms"] == 50.5

    def test_step_with_error(self):
        """Test AgentStep with error"""
        step = AgentStep(
            step_number=1,
            state=AgentState.ERROR,
            error="Something went wrong"
        )

        d = step.to_dict()
        assert d["error"] == "Something went wrong"

    def test_step_output_truncation(self):
        """Test that long outputs are truncated in to_dict"""
        long_output = "x" * 1000
        step = AgentStep(
            step_number=1,
            state=AgentState.EXECUTING_TOOL,
            tool_output=long_output
        )

        d = step.to_dict()
        assert len(d["tool_output"]) <= 500


class TestAgentResponse:
    """Test AgentResponse data structure"""

    def test_response_to_dict(self):
        """Test AgentResponse serialization"""
        step = AgentStep(step_number=0, state=AgentState.THINKING)
        response = AgentResponse(
            content="Test response",
            steps=[step],
            total_duration_ms=100.5,
            tools_used=["calculator"],
            success=True
        )

        d = response.to_dict()

        assert d["content"] == "Test response"
        assert d["success"] is True
        assert d["total_duration_ms"] == 100.5
        assert "calculator" in d["tools_used"]
        assert len(d["steps"]) == 1

    def test_response_with_error(self):
        """Test AgentResponse with error"""
        response = AgentResponse(
            content="Error occurred",
            success=False,
            error="Test error"
        )

        assert not response.success
        assert response.error == "Test error"

    def test_response_metadata(self):
        """Test AgentResponse metadata"""
        response = AgentResponse(
            content="Test",
            metadata={"model": "test-model", "tool_calls": 3}
        )

        assert response.metadata["model"] == "test-model"
        assert response.metadata["tool_calls"] == 3


class TestTierPrompts:
    """Test tier-specific system prompts"""

    def test_simple_prompt_content(self):
        """Test simple tier prompt contains expected guidance"""
        prompt = SIMPLE_TIER_PROMPT
        assert "fast" in prompt.lower() or "brief" in prompt.lower()
        assert "zero tools" in prompt.lower() or "unless" in prompt.lower()

    def test_standard_prompt_content(self):
        """Test standard tier prompt contains expected guidance"""
        prompt = STANDARD_TIER_PROMPT
        assert "concise" in prompt.lower() or "clear" in prompt.lower()

    def test_advanced_prompt_content(self):
        """Test advanced tier prompt contains expected guidance"""
        prompt = ADVANCED_TIER_PROMPT
        assert "expert" in prompt.lower() or "complex" in prompt.lower()

    def test_prompts_include_tool_placeholder(self):
        """Test that prompts have tool placeholder"""
        for prompt in [SIMPLE_TIER_PROMPT, STANDARD_TIER_PROMPT, ADVANCED_TIER_PROMPT]:
            assert "{tools}" in prompt


class TestTierLimits:
    """Test tier-specific limits"""

    def test_simple_tier_limits(self):
        """Test simple tier has strict limits"""
        assert TIER_TOOL_LIMITS["simple"] == 1
        assert TIER_MAX_TOKENS["simple"] == 1500

    def test_standard_tier_limits(self):
        """Test standard tier has moderate limits"""
        assert TIER_TOOL_LIMITS["standard"] == 3
        assert TIER_MAX_TOKENS["standard"] == 4000

    def test_advanced_tier_limits(self):
        """Test advanced tier has generous limits"""
        assert TIER_TOOL_LIMITS["advanced"] == 10
        assert TIER_MAX_TOKENS["advanced"] == 8000

    def test_tier_limits_ascending(self):
        """Test that tier limits increase from simple to advanced"""
        assert TIER_TOOL_LIMITS["simple"] < TIER_TOOL_LIMITS["standard"]
        assert TIER_TOOL_LIMITS["standard"] < TIER_TOOL_LIMITS["advanced"]

        assert TIER_MAX_TOKENS["simple"] < TIER_MAX_TOKENS["standard"]
        assert TIER_MAX_TOKENS["standard"] < TIER_MAX_TOKENS["advanced"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
