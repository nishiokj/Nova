"""
Tests for error recovery and resilience.
"""

import time
from unittest.mock import Mock, patch

import pytest

from util.resilience import (
    CircuitBreakerOpenError,
    CircuitBreakerState,
    ResilienceConfig,
    _compute_backoff,
)
from util.exceptions import (
    RexError,
    AgentError,
    ToolError,
    ToolExecutionError,
    ToolTimeoutError,
    ToolNotFoundError,
    LLMError,
    LLMProviderError,
    LLMRateLimitError,
    ConfigurationError,
    MissingConfigError,
)


class TestCircuitBreakerState:
    """Test circuit breaker state transitions."""

    def test_initial_state_closed(self):
        """Circuit should start in closed state."""
        state = CircuitBreakerState()
        now = time.monotonic()
        assert not state.is_open(now)
        assert state.consecutive_failures == 0

    def test_circuit_opens_when_opened_until_set(self):
        """Circuit should be open when opened_until is in the future."""
        state = CircuitBreakerState()
        now = time.monotonic()
        state.opened_until = now + 10.0
        assert state.is_open(now)

    def test_circuit_closes_when_opened_until_passed(self):
        """Circuit should close when opened_until is in the past."""
        state = CircuitBreakerState()
        now = time.monotonic()
        state.opened_until = now - 1.0
        assert not state.is_open(now)

    def test_time_remaining(self):
        """Should return correct time remaining."""
        state = CircuitBreakerState()
        now = time.monotonic()
        state.opened_until = now + 5.0
        remaining = state.time_remaining(now)
        assert 4.9 < remaining <= 5.0

    def test_time_remaining_zero_when_closed(self):
        """Time remaining should be 0 when circuit is closed."""
        state = CircuitBreakerState()
        now = time.monotonic()
        assert state.time_remaining(now) == 0.0

    def test_enter_half_open(self):
        """Circuit should transition to half-open correctly."""
        state = CircuitBreakerState()
        state.opened_until = time.monotonic() + 100
        state.consecutive_failures = 5

        state.enter_half_open()

        assert state.half_open is True
        assert state.opened_until is None
        assert state.consecutive_failures == 0
        assert state.half_open_successes == 0

    def test_reset(self):
        """Reset should clear all state."""
        state = CircuitBreakerState()
        state.consecutive_failures = 10
        state.opened_until = time.monotonic() + 100
        state.half_open = True
        state.half_open_successes = 2
        state.last_error = "some error"

        state.reset()

        assert state.consecutive_failures == 0
        assert state.opened_until is None
        assert state.half_open is False
        assert state.half_open_successes == 0
        # Note: reset doesn't clear last_error
        assert state.last_error == "some error"


class TestResilienceConfig:
    """Test resilience configuration."""

    def test_default_config(self):
        """Default config should have sensible values."""
        config = ResilienceConfig()
        assert config.max_retries == 0
        assert config.initial_backoff == 0.5
        assert config.backoff_multiplier == 2.0
        assert config.max_backoff == 30.0
        assert config.failure_threshold == 5

    def test_custom_config(self):
        """Custom config values should be stored."""
        config = ResilienceConfig(
            max_retries=3,
            initial_backoff=1.0,
            backoff_multiplier=3.0,
            max_backoff=60.0,
            failure_threshold=10
        )
        assert config.max_retries == 3
        assert config.initial_backoff == 1.0
        assert config.backoff_multiplier == 3.0
        assert config.max_backoff == 60.0
        assert config.failure_threshold == 10


class TestBackoffComputation:
    """Test backoff delay calculation."""

    def test_first_attempt_backoff(self):
        """First attempt should use initial backoff."""
        config = ResilienceConfig(initial_backoff=1.0, jitter=0)
        delay = _compute_backoff(config, 1)
        assert delay == 1.0

    def test_exponential_backoff(self):
        """Backoff should increase exponentially."""
        config = ResilienceConfig(
            initial_backoff=1.0,
            backoff_multiplier=2.0,
            max_backoff=100.0,
            jitter=0
        )
        assert _compute_backoff(config, 1) == 1.0
        assert _compute_backoff(config, 2) == 2.0
        assert _compute_backoff(config, 3) == 4.0
        assert _compute_backoff(config, 4) == 8.0

    def test_max_backoff_cap(self):
        """Backoff should be capped at max_backoff."""
        config = ResilienceConfig(
            initial_backoff=1.0,
            backoff_multiplier=10.0,
            max_backoff=5.0,
            jitter=0
        )
        delay = _compute_backoff(config, 5)
        assert delay == 5.0

    def test_zero_initial_backoff(self):
        """Zero initial backoff should return 0."""
        config = ResilienceConfig(initial_backoff=0)
        delay = _compute_backoff(config, 1)
        assert delay == 0.0


class TestCircuitBreakerOpenError:
    """Test circuit breaker open error."""

    def test_error_message(self):
        """Error should have descriptive message."""
        error = CircuitBreakerOpenError(
            component="test",
            target="api",
            retry_after=10.0,
            last_error="Connection refused"
        )
        assert "test" in str(error)
        assert "api" in str(error)
        assert "10.0" in str(error)
        assert "Connection refused" in str(error)

    def test_error_attributes(self):
        """Error should preserve attributes."""
        error = CircuitBreakerOpenError(
            component="llm",
            target="openai",
            retry_after=5.0,
            last_error="Rate limit"
        )
        assert error.component == "llm"
        assert error.target == "openai"
        assert error.retry_after == 5.0
        assert error.last_error == "Rate limit"


class TestExceptionHierarchy:
    """Test the custom exception hierarchy."""

    def test_rex_error_base(self):
        """RexError should be base class."""
        error = RexError("Test error")
        assert isinstance(error, Exception)
        assert str(error) == "Test error"

    def test_rex_error_with_cause(self):
        """RexError should include cause in message."""
        cause = ValueError("original")
        error = RexError("Wrapped error", cause=cause)
        assert "Wrapped error" in str(error)
        assert "original" in str(error)
        assert error.cause is cause

    def test_agent_error_inherits_rex_error(self):
        """AgentError should inherit from RexError."""
        error = AgentError("Agent failed")
        assert isinstance(error, RexError)
        assert isinstance(error, Exception)

    def test_tool_execution_error(self):
        """ToolExecutionError should include tool name."""
        error = ToolExecutionError("my_tool", "timeout")
        assert "my_tool" in str(error)
        assert "timeout" in str(error)
        assert error.tool_name == "my_tool"

    def test_tool_timeout_error(self):
        """ToolTimeoutError should include timeout value."""
        error = ToolTimeoutError("slow_tool", 30.0)
        assert "slow_tool" in str(error)
        assert "30" in str(error)
        assert error.tool_name == "slow_tool"
        assert error.timeout_seconds == 30.0

    def test_tool_not_found_error(self):
        """ToolNotFoundError should include tool name."""
        error = ToolNotFoundError("missing_tool")
        assert "missing_tool" in str(error)
        assert error.tool_name == "missing_tool"

    def test_llm_provider_error(self):
        """LLMProviderError should include provider name."""
        error = LLMProviderError("openai", "Connection failed")
        assert "openai" in str(error)
        assert "Connection failed" in str(error)
        assert error.provider == "openai"

    def test_llm_rate_limit_error(self):
        """LLMRateLimitError should include retry info."""
        error = LLMRateLimitError("anthropic", retry_after=60.0)
        assert "anthropic" in str(error)
        assert "60" in str(error)
        assert error.provider == "anthropic"
        assert error.retry_after == 60.0

    def test_missing_config_error(self):
        """MissingConfigError should include key and file."""
        error = MissingConfigError("api_key", "config.json")
        assert "api_key" in str(error)
        assert "config.json" in str(error)
        assert error.key == "api_key"
        assert error.config_file == "config.json"

    def test_exception_hierarchy_is_catchable(self):
        """Exceptions should be catchable by parent types."""
        error = ToolExecutionError("test", "failed")

        # Should be catchable as various parent types
        assert isinstance(error, ToolError)
        assert isinstance(error, RexError)
        assert isinstance(error, Exception)

        # Can catch with parent
        try:
            raise error
        except RexError as e:
            assert "test" in str(e)


@pytest.mark.integration
class TestAgentErrorRecovery:
    """Test agent-level error recovery."""

    def test_agent_handles_tool_failure_gracefully(self):
        """Agent should handle tool execution failures."""
        # This would require actual agent setup
        # Documented as integration test to be expanded
        pass

    def test_agent_handles_llm_timeout(self):
        """Agent should handle LLM timeouts gracefully."""
        # This would require actual agent setup
        pass
