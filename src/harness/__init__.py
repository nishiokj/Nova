"""
Agentic Harness - Modular agent system for speech-driven AI interactions

Clean Refactored Architecture:
- ProcessWorker interface for all workers
- Mailbox pattern for event delivery
- EventBus for pub/sub communication

IMPORT GUIDELINES (to avoid circular imports):
- Use direct imports: from harness.harness import AgentHarness
- Use direct imports: from util.runtime import create_runtime
- Workers: from workers.service_rep_worker import ServiceRepWorker
"""

# Only import things that don't trigger circular dependencies
from util.config import HarnessConfig, RuntimeConfig, load_or_create_config
from util.logger import StructuredLogger

# Tools can be imported safely
from .agent.tool_registry import ToolRegistry, Tool, ToolResult

# Agent components (these don't import harness.harness)
from .agent.agent import Agent, AgentResponse

# Communication (safe)
from communication.process_worker import ProcessWorker


def get_harness_class():
    """Lazy import of AgentHarness to avoid circular imports."""
    from .harness import AgentHarness
    return AgentHarness


def get_service_rep_class():
    """Lazy import of ServiceRep to avoid circular imports."""
    from .service_rep import ServiceRep
    return ServiceRep


def get_runtime_factory():
    """Lazy import of create_runtime to avoid circular imports."""
    from util.runtime import create_runtime
    return create_runtime


__all__ = [
    # Config
    "HarnessConfig",
    "RuntimeConfig",
    "load_or_create_config",
    # Logging
    "StructuredLogger",
    # Tools
    "ToolRegistry",
    "Tool",
    "ToolResult",
    # Agent
    "Agent",
    "AgentResponse",
    # Communication
    "ProcessWorker",
    # Lazy getters (for backwards compatibility)
    "get_harness_class",
    "get_service_rep_class",
    "get_runtime_factory",
]

__version__ = "2.0.0"
