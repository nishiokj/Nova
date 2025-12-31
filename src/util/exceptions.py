"""
Centralized exception hierarchy for rex.

Usage:
    from util.exceptions import AgentError, ToolExecutionError

    raise ToolExecutionError("tool_name", "Failed to execute", cause=original_error)
"""

from typing import Optional


class RexError(Exception):
    """Base exception for all rex errors."""

    def __init__(self, message: str, cause: Optional[Exception] = None):
        super().__init__(message)
        self.message = message
        self.cause = cause

    def __str__(self) -> str:
        if self.cause:
            return f"{self.message} (caused by: {self.cause})"
        return self.message


# === Configuration Errors ===


class ConfigurationError(RexError):
    """Error in configuration loading or validation."""

    pass


class MissingConfigError(ConfigurationError):
    """Required configuration key is missing."""

    def __init__(self, key: str, config_file: Optional[str] = None):
        msg = f"Missing required config key: {key}"
        if config_file:
            msg += f" in {config_file}"
        super().__init__(msg)
        self.key = key
        self.config_file = config_file


# === Agent Errors ===


class AgentError(RexError):
    """Base error for agent operations."""

    pass


class PlanningError(AgentError):
    """Error during plan creation."""

    pass


class ExecutionError(AgentError):
    """Error during plan execution."""

    pass


class ReflectionError(AgentError):
    """Error during reflection phase."""

    pass


# === Tool Errors ===


class ToolError(RexError):
    """Base error for tool operations."""

    pass


class ToolNotFoundError(ToolError):
    """Requested tool does not exist in registry."""

    def __init__(self, tool_name: str):
        super().__init__(f"Tool not found: {tool_name}")
        self.tool_name = tool_name


class ToolExecutionError(ToolError):
    """Error during tool execution."""

    def __init__(self, tool_name: str, message: str, cause: Optional[Exception] = None):
        super().__init__(f"Tool '{tool_name}' failed: {message}", cause)
        self.tool_name = tool_name


class ToolTimeoutError(ToolError):
    """Tool execution timed out."""

    def __init__(self, tool_name: str, timeout_seconds: float):
        super().__init__(f"Tool '{tool_name}' timed out after {timeout_seconds}s")
        self.tool_name = tool_name
        self.timeout_seconds = timeout_seconds


# === LLM Errors ===


class LLMError(RexError):
    """Base error for LLM operations."""

    pass


class LLMProviderError(LLMError):
    """Error from LLM provider (OpenAI, Anthropic, etc.)."""

    def __init__(self, provider: str, message: str, cause: Optional[Exception] = None):
        super().__init__(f"LLM provider '{provider}' error: {message}", cause)
        self.provider = provider


class LLMRateLimitError(LLMError):
    """Rate limit exceeded."""

    def __init__(self, provider: str, retry_after: Optional[float] = None):
        msg = f"Rate limit exceeded for {provider}"
        if retry_after:
            msg += f", retry after {retry_after}s"
        super().__init__(msg)
        self.provider = provider
        self.retry_after = retry_after


# === Communication Errors ===


class CommunicationError(RexError):
    """Base error for IPC/event bus operations."""

    pass


class ProcessNotFoundError(CommunicationError):
    """Target process does not exist."""

    def __init__(self, process_name: str):
        super().__init__(f"Process not found: {process_name}")
        self.process_name = process_name


class MessageDeliveryError(CommunicationError):
    """Failed to deliver message."""

    pass


# === Service Errors ===


class ServiceError(RexError):
    """Base error for service operations."""

    pass


class STTError(ServiceError):
    """Speech-to-text error."""

    pass


class TTSError(ServiceError):
    """Text-to-speech error."""

    pass


class AudioDeviceError(ServiceError):
    """Audio device not available or failed."""

    def __init__(self, device_name: Optional[str] = None, message: str = "Audio device error"):
        full_msg = message
        if device_name:
            full_msg = f"{message}: {device_name}"
        super().__init__(full_msg)
        self.device_name = device_name
