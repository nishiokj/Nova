"""
Comprehensive tests for the Agent component.

Tests:
- Agent initialization
- Tool execution through agent
- Tiered agent behavior
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
    Agent, AgentConfig, AgentResponse,
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
        # Mock the planner and wizard for a simple test
        with patch.object(mock_agent, '_planner') as mock_planner, \
             patch.object(mock_agent, '_wizard') as mock_wizard:
            # Use MagicMock for Plan since it has many required fields
            mock_plan = MagicMock()
            mock_plan.goal = "Test response"
            mock_plan.steps = []
            mock_planner.create_plan.return_value = mock_plan

            # Create a minimal wizard result
            mock_plan_state = MagicMock()
            mock_plan_state.goal = "Test response"
            mock_result = MagicMock()
            mock_result.final_response = "This is a test response."
            mock_result.plan_state = mock_plan_state
            mock_result.duration_ms = 100.0
            mock_result.success = True
            mock_result.goal_achieved = True
            mock_result.final_context_state = None
            mock_result.to_dict.return_value = {"metadata": {}}
            mock_result.to_reflection.return_value = None
            mock_wizard.orchestrate.return_value = mock_result

            response = mock_agent.run("Hello, how are you?")

            assert response.success
            assert "test response" in response.content.lower()

    def test_run_with_context(self, mock_agent):
        """Test run with additional context"""
        with patch.object(mock_agent, '_planner') as mock_planner, \
             patch.object(mock_agent, '_wizard') as mock_wizard:
            mock_plan = MagicMock()
            mock_plan.goal = "Test"
            mock_plan.steps = []
            mock_planner.create_plan.return_value = mock_plan

            mock_plan_state = MagicMock()
            mock_plan_state.goal = "Test"
            mock_result = MagicMock()
            mock_result.final_response = "Response with context"
            mock_result.plan_state = mock_plan_state
            mock_result.duration_ms = 100.0
            mock_result.success = True
            mock_result.goal_achieved = True
            mock_result.final_context_state = None
            mock_result.to_dict.return_value = {"metadata": {}}
            mock_result.to_reflection.return_value = None
            mock_wizard.orchestrate.return_value = mock_result

            response = mock_agent.run(
                "Continue our discussion",
                context="We were talking about Python programming"
            )

            assert response.success
            # Verify context was passed to planner
            call_args = mock_planner.create_plan.call_args
            assert "Python programming" in str(call_args)

    def test_run_tracks_duration(self, mock_agent):
        """Test that response tracks total duration"""
        with patch.object(mock_agent, '_planner') as mock_planner, \
             patch.object(mock_agent, '_wizard') as mock_wizard:
            mock_plan = MagicMock()
            mock_plan.goal = "Test"
            mock_plan.steps = []
            mock_planner.create_plan.return_value = mock_plan

            mock_plan_state = MagicMock()
            mock_plan_state.goal = "Test"
            mock_result = MagicMock()
            mock_result.final_response = "Response"
            mock_result.plan_state = mock_plan_state
            mock_result.duration_ms = 150.0
            mock_result.success = True
            mock_result.goal_achieved = True
            mock_result.final_context_state = None
            mock_result.to_dict.return_value = {"metadata": {}}
            mock_result.to_reflection.return_value = None
            mock_wizard.orchestrate.return_value = mock_result

            response = mock_agent.run("Hello")

            assert response.total_duration_ms == 150.0


class TestAgentCallbacks:
    """Test Agent callback functionality"""

    @pytest.fixture
    def mock_agent(self, tool_registry, mock_llm_config, mock_logger):
        config = AgentConfig(llm_config=mock_llm_config)
        agent = Agent(config, tool_registry, mock_llm_config)

        mock_behavior = MockLLMBehavior(responses=["Test response"])
        agent._llm = MockLLMAdapter(mock_llm_config, mock_behavior)

        return agent

    def test_phase_callback(self, mock_agent):
        """Test phase callback is called"""
        phases_received = []

        def on_phase(message: str, tool_name, step_number: int):
            phases_received.append((message, step_number))

        mock_agent.add_phase_callback(on_phase)

        with patch.object(mock_agent, '_planner') as mock_planner, \
             patch.object(mock_agent, '_wizard') as mock_wizard:
            mock_plan = MagicMock()
            mock_plan.goal = "Test"
            mock_plan.steps = []
            mock_planner.create_plan.return_value = mock_plan

            mock_plan_state = MagicMock()
            mock_plan_state.goal = "Test"
            mock_result = MagicMock()
            mock_result.final_response = "Response"
            mock_result.plan_state = mock_plan_state
            mock_result.duration_ms = 100.0
            mock_result.success = True
            mock_result.goal_achieved = True
            mock_result.final_context_state = None
            mock_result.to_dict.return_value = {"metadata": {}}
            mock_result.to_reflection.return_value = None
            mock_wizard.orchestrate.return_value = mock_result

            mock_agent.run("Hello")

        # Should have received at least the "Request received" phase
        assert len(phases_received) >= 1
        assert any("Request received" in msg for msg, _ in phases_received)

    def test_remove_phase_callback(self, mock_agent):
        """Test removing a phase callback"""
        calls = []

        def callback(message, tool_name, step_number):
            calls.append(message)

        mock_agent.add_phase_callback(callback)
        mock_agent.remove_phase_callback(callback)

        # Callback should not be called after removal
        mock_agent._notify_phase("Test", step_number=0)
        assert len(calls) == 0


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
        assert TIER_MAX_TOKENS["simple"] == 4096

    def test_standard_tier_limits(self):
        """Test standard tier has moderate limits"""
        assert TIER_TOOL_LIMITS["standard"] == 15
        assert TIER_MAX_TOKENS["standard"] == 16000

    def test_advanced_tier_limits(self):
        """Test advanced tier has generous limits"""
        assert TIER_TOOL_LIMITS["advanced"] == 30
        assert TIER_MAX_TOKENS["advanced"] == 32000

    def test_tier_limits_ascending(self):
        """Test that tier limits increase from simple to advanced"""
        assert TIER_TOOL_LIMITS["simple"] < TIER_TOOL_LIMITS["standard"]
        assert TIER_TOOL_LIMITS["standard"] < TIER_TOOL_LIMITS["advanced"]

        assert TIER_MAX_TOKENS["simple"] < TIER_MAX_TOKENS["standard"]
        assert TIER_MAX_TOKENS["standard"] < TIER_MAX_TOKENS["advanced"]


class TestAgentResponse:
    """Test AgentResponse data structure"""

    def test_response_to_dict(self):
        """Test AgentResponse serialization"""
        response = AgentResponse(
            content="Test response",
            total_duration_ms=100.5,
            tools_used=["calculator"],
            success=True
        )

        d = response.to_dict()

        assert d["content"] == "Test response"
        assert d["success"] is True
        assert d["total_duration_ms"] == 100.5
        assert "calculator" in d["tools_used"]

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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
