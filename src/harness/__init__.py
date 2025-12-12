"""
Agentic Harness - Modular agent system for speech-driven AI interactions

Clean Refactored Architecture:
- ProcessWorker interface for all workers
- Mailbox pattern for event delivery
- EventBus for pub/sub communication
"""

from .config import HarnessConfig, RuntimeConfig, load_or_create_config
from .logger import StructuredLogger
from .llm_adapter import LLMAdapter, LLMResponse, create_adapter
from .tool_registry import ToolRegistry, Tool, ToolResult
from .router import Router, TaskClassification
from .service_rep import ServiceRep
from .agent import Agent, AgentResponse
from .harness import AgentHarness, HarnessResponse, HarnessState, create_harness
from .runtime import HarnessRuntime, create_runtime

# Refactored multiprocess components
from .process_manager import ProcessManager
from .process_worker import ProcessWorker
from .tts_worker import TTSWorker
from .harness_worker import HarnessWorker  # Legacy, kept for compatibility
from .service_rep_worker import ServiceRepWorker


__all__ = [
    # Config
    "HarnessConfig",
    "RuntimeConfig",
    "load_or_create_config",
    # Logging
    "StructuredLogger",
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
    "HarnessRuntime",
    "create_runtime",
    # Multiprocess (refactored)
    "ProcessManager",
    "ProcessWorker",
    "TTSWorker",
    "HarnessWorker",  # Legacy
    "ServiceRepWorker",
]

__version__ = "2.0.0"
