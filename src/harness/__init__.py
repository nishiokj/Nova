"""
Agentic Harness - Modular agent system for speech-driven AI interactions

Clean Refactored Architecture:
- ProcessWorker interface for all workers
- Mailbox pattern for event delivery
- EventBus for pub/sub communication
"""

from util.config import HarnessConfig, RuntimeConfig, load_or_create_config
from util.logger import StructuredLogger
from util.llm_adapter import LLMAdapter, LLMResponse, create_adapter
from .agent.tool_registry import ToolRegistry, Tool, ToolResult
from services.router import Router, TaskClassification
from .service_rep import ServiceRep
from .agent.agent import Agent, AgentResponse
from .harness import AgentHarness, HarnessResponse, HarnessState, create_harness
from util.runtime import HarnessRuntime, create_runtime

# Refactored multiprocess components
from communication.process_worker import ProcessWorker
try:
    from workers.tts_worker import TTSWorker
except ImportError:
    TTSWorker = None  # Optional: needs pyaudio
from workers.harness_worker import HarnessWorker  # Legacy, kept for compatibility
from workers.service_rep_worker import ServiceRepWorker


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
    "ProcessWorker",
    "TTSWorker",
    "HarnessWorker",  # Legacy
    "ServiceRepWorker",
]

__version__ = "2.0.0"
