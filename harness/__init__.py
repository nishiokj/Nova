"""
Agentic Harness - Modular agent system for speech-driven AI interactions
"""

from .config import HarnessConfig, RuntimeConfig
from .logger import StructuredLogger, LogEntry
from .llm_adapter import LLMAdapter, LLMResponse, create_adapter
from .tool_registry import ToolRegistry, Tool, ToolResult
from .router import Router, TaskClassification
from .service_rep import ServiceRep
from .agent import Agent, AgentResponse
from .harness import AgentHarness

__all__ = [
    # Config
    "HarnessConfig",
    "RuntimeConfig",
    # Logging
    "StructuredLogger",
    "LogEntry",
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
    "AgentHarness",
]

__version__ = "1.0.0"
