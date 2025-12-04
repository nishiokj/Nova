"""
Agentic Harness - Modular agent system for speech-driven AI interactions
"""

from .config import HarnessConfig, RuntimeConfig, load_or_create_config
from .logger import StructuredLogger, LogEntry, get_logger, set_logger
from .llm_adapter import LLMAdapter, LLMResponse, create_adapter
from .tool_registry import ToolRegistry, Tool, ToolResult
from .router import Router, TaskClassification
from .service_rep import ServiceRep
from .agent import Agent, AgentResponse
from .harness import AgentHarness, HarnessResponse, HarnessState, create_harness

__all__ = [
    # Config
    "HarnessConfig",
    "RuntimeConfig",
    "load_or_create_config",
    # Logging
    "StructuredLogger",
    "LogEntry",
    "get_logger",
    "set_logger",
    # LLM
    "LLMAdapter",
    "LLMResponse",
    "create_adapter",
    # Tools
    "ToolRegistry",
    "Tool",
    "ToolResult",
    # Components
    "Router",
    "TaskClassification",
    "ServiceRep",
    "Agent",
    "AgentResponse",
    # Harness
    "AgentHarness",
    "HarnessResponse",
    "HarnessState",
    "create_harness",
]

__version__ = "1.0.0"
