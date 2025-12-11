"""
Agentic Harness - Modular agent system for speech-driven AI interactions

Architecture (v2 - Multiprocess):
- Main Process: Audio capture, STT, routing to EventBus
- Agent Process: LLM reasoning, tool execution
- TTS Process: Speech synthesis

Communication via EventBus with multiprocessing.Queue
"""

from .config import HarnessConfig, RuntimeConfig, load_or_create_config
from .logger import StructuredLogger, get_logger, set_logger
from .llm_adapter import LLMAdapter, LLMResponse, create_adapter
from .tool_registry import ToolRegistry, Tool, ToolResult
from .router import Router, TaskClassification
from .service_rep import ServiceRep
from .agent import Agent, AgentResponse
from .harness import AgentHarness, HarnessResponse, HarnessState, create_harness
from .runtime import HarnessRuntime, create_runtime

# Multiprocess components (v2)
from .event_bus import (
    EventBus,
    AgentRequest,
    AgentResult,
    TTSRequest,
    MessageType,
    BusMessage
)
from .process_manager import ProcessManager
from .tts_worker import TTSWorker, create_tts_worker
from .agent_worker import AgentWorker, create_agent_worker


__all__ = [
    # Config
    "HarnessConfig",
    "RuntimeConfig",
    "load_or_create_config",
    # Logging
    "StructuredLogger",
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
    # Harness (v1 - single process)
    "AgentHarness",
    "HarnessResponse",
    "HarnessState",
    "create_harness",
    "HarnessRuntime",
    "create_runtime",
    # EventBus (v2 - multiprocess)
    "EventBus",
    "ProcessManager",
    "AgentRequest",
    "AgentResult",
    "TTSRequest",
    "MessageType",
    "BusMessage",
    # Workers (v2 - multiprocess)
    "TTSWorker",
    "create_tts_worker",
    "AgentWorker",
    "create_agent_worker",
]

__version__ = "2.0.0"
