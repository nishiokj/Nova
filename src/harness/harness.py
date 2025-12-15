"""
AgentHarness - Main orchestrator for the agentic system (Refactored).

Responsibilities:
1. Execute agent with tools
2. Return structured responses
3. Provide control interface (stop, pause, inject_context)
4. Emit progress via callbacks

Decoupled from:
- Communication layer (no EventBus, no publishing)
- ServiceRep (just returns responses, no direct calls)
- TTS/Voice (no speech-specific logic)
- Router (tier comes from request)
"""

import os
import time
import threading
import queue
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Callable
from enum import Enum
from contextlib import nullcontext

# No communication layer imports - AgentHarness is decoupled from EventBus
from util.config import HarnessConfig, RuntimeConfig, load_or_create_config
from util.logger import StructuredLogger
from .agent.tool_registry import ToolRegistry
from .agent.agent import Agent, AgentResponse, AgentStep, TieredAgent
from util.runtime import HarnessRuntime, create_runtime
from util.agent_execution_logger import AgentExecutionLogger


class HarnessState(Enum):
    """Harness execution states"""
    IDLE = "idle"
    PROCESSING = "processing"
    AGENT_WORKING = "agent_working"
    PAUSED = "paused"
    STOPPING = "stopping"
    ERROR = "error"
[]

@dataclass
class HarnessResponse:
    """Complete response from the harness"""
    full_response: str
    agent_response: AgentResponse
    spoken_response: str = ""  # Suggested spoken version (ServiceRep may override)
    state: HarnessState = HarnessState.IDLE
    duration_ms: float = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "full_response": self.full_response,
            "agent_response": self.agent_response.to_dict() if self.agent_response else None,
            "spoken_response": self.spoken_response,
            "state": self.state.value,
            "duration_ms": self.duration_ms,
            "metadata": self.metadata
        }


class AgentHarness:
    """
    Main orchestrator for the agentic system.

    Flow:
    1. Receive request via process() method
    2. Execute agent with tools
    3. Emit progress via callbacks
    4. Return HarnessResponse

    Control interface:
    - stop(): Cancel current execution
    - pause(): Pause at checkpoint
    - inject_context(): Add clarification mid-execution
    - Callbacks for progress and state changes
    """

    def __init__(
        self,
        config: Optional[HarnessConfig] = None,
        config_path: str = None,
        profiler: Optional[Any] = None,
        runtime: Optional[HarnessRuntime] = None,
        logger: Optional[StructuredLogger] = None,
        execution_logger: Optional[AgentExecutionLogger] = None
    ):
        if runtime and (config or config_path):
            raise ValueError("Provide either an existing runtime or configuration inputs, not both.")

        self.runtime = runtime or create_runtime(
            config=config,
            config_path=config_path,
            profiler=profiler,
            logger=logger,
            execution_logger=execution_logger
        )

        # Instrumentation
        self.profiler = profiler if profiler is not None else self.runtime.profiler
        self._runtime_config = self.runtime.runtime_config
        self.logger: StructuredLogger = self.runtime.logger

        # State management
        self._state = HarnessState.IDLE
        self._lock = threading.Lock()

        # Core components sourced from runtime
        self.tool_registry = self.runtime.tool_registry
        self.agent = self.runtime.agent

        # Control interface state
        self._stop_requested = threading.Event()
        self._pause_requested = threading.Event()
        self._injected_context: queue.Queue = queue.Queue()

        # Callbacks
        self._response_callbacks: List[Callable[[HarnessResponse], None]] = []
        self._state_callbacks: List[Callable[[HarnessState], None]] = []
        self._progress_callbacks: List[Callable[[str, Optional[str], int], None]] = []  # (message, tool_name, step_number)

        # Track progress for deduplication
        self._last_progress_tool = None

        self.logger.system_init("harness", "ready")

    def _profile(self, metric_name: str):
        """Helper to get profiler context if available"""
        if not self.profiler:
            return nullcontext()
        return self.profiler.measure(metric_name)

    def _set_state(self, state: HarnessState):
        """Set harness state and notify callbacks"""
        self._state = state
        for callback in self._state_callbacks:
            try:
                callback(state)
            except Exception as e:
                self.logger.error(f"State callback error: {e}", component="harness")

    def process(
        self,
        speech_text: str,
        tier: str = "standard",
        context: Optional[str] = None,
        request_id: Optional[str] = None
    ) -> HarnessResponse:
        """
        Process request through the agent.

        Args:
            speech_text: User's request
            tier: Agent tier (determined by ServiceRep/Router)
            context: Optional additional context
            request_id: Request identifier

        Returns:
            HarnessResponse with results
        """
        request_id = request_id or self.logger.new_request()
        start_time = time.time()

        self.logger.request_received(speech_text)
        call_dir = os.getcwd()
        self._set_state(HarnessState.PROCESSING)

        agent_response = None
        full_response = ""

        # Clear control flags
        self._stop_requested.clear()
        self._pause_requested.clear()
        while not self._injected_context.empty():
            self._injected_context.get_nowait()

        try:
            # Step 1: Agent execution with progress updates
            self._set_state(HarnessState.AGENT_WORKING)

            # Reset progress tracking and wire up callback
            self._last_progress_tool = None
            progress_callback = self._create_progress_callback(request_id)

            # Get the agent for this tier and add progress callback
            if hasattr(self.agent, "get_agent_for_tier"):
                tier_agent = self.agent.get_agent_for_tier(tier)
            else:
                tier_agent = self.agent
            tier_agent.add_step_callback(progress_callback)

            try:
                with self.tool_registry.with_working_dir(call_dir):
                    with self._profile("harness.agent_run_ms"):
                        agent_response = self.agent.run(
                            user_input=speech_text,
                            tier=tier,
                            context=context
                        )
            finally:
                if hasattr(tier_agent, "remove_step_callback"):
                    tier_agent.remove_step_callback(progress_callback)

            # Step 2: Build response
            full_response = agent_response.content
            file_ops = agent_response.metadata.get("file_operations", []) if agent_response.metadata else []

            for op in file_ops:
                self.logger.file_operation(
                    "harness_file",
                    op.get("path"),
                    status="noted",
                    detail=f"tool={op.get('tool')} action={op.get('action')}",
                    component="harness"
                )

            # Complete
            self._set_state(HarnessState.IDLE)
            duration_ms = (time.time() - start_time) * 1000

            response = HarnessResponse(
                full_response=full_response,
                agent_response=agent_response,
                spoken_response=agent_response.content if agent_response else "",  # ServiceRep will summarize
                state=HarnessState.IDLE,
                duration_ms=duration_ms,
                metadata={
                    "request_id": request_id,
                    "tier": tier,
                    "tools_used": agent_response.tools_used if agent_response else []
                }
            )

            # Notify callbacks
            for callback in self._response_callbacks:
                try:
                    callback(response)
                except Exception as e:
                    self.logger.error(f"Response callback error: {e}", component="harness")

            return response

        except Exception as e:
            self._set_state(HarnessState.ERROR)
            self.logger.error(f"Harness processing failed: {e}", component="harness", error=e)

            return HarnessResponse(
                full_response=f"Error: {str(e)}",
                agent_response=agent_response,
                spoken_response="I'm sorry, something went wrong.",
                state=HarnessState.ERROR,
                duration_ms=(time.time() - start_time) * 1000,
                metadata={"error": str(e), "request_id": request_id}
            )

    def _create_progress_callback(self, request_id: str) -> Callable[[AgentStep], None]:
        """Create callback to notify progress during agent execution"""
        def on_step(step: AgentStep):
            # Only report progress for tool executions
            if step.tool_name:
                progress_msg = self._get_tool_progress_message(step.tool_name, step.step_number)
                if progress_msg:
                    # Notify all progress callbacks
                    for callback in self._progress_callbacks:
                        try:
                            callback(progress_msg, step.tool_name, step.step_number)
                        except Exception as e:
                            self.logger.error(f"Progress callback error: {e}", component="harness")

        return on_step

    def _get_tool_progress_message(self, tool_name: str, step_number: int) -> Optional[str]:
        """
        Get progress message for tool execution.
        Returns None if we shouldn't report (to avoid over-chatting).
        """
        # Don't repeat progress for same tool
        if self._last_progress_tool == tool_name:
            return None

        self._last_progress_tool = tool_name
        tool_lower = tool_name.lower()

        # Map tools to progress messages
        if "search" in tool_lower or "web" in tool_lower or "fast_answer" in tool_lower:
            return "Searching now."
        elif "fetch" in tool_lower or "get" in tool_lower:
            return "Getting that information."
        elif "read" in tool_lower or "file" in tool_lower:
            return "Reading the file."
        elif "write" in tool_lower or "save" in tool_lower:
            return "Writing the file."
        elif "bash" in tool_lower or "command" in tool_lower or "exec" in tool_lower:
            return "Running the command."
        elif "calc" in tool_lower or "math" in tool_lower:
            return "Calculating."
        else:
            # Only speak for first tool call
            if step_number == 0:
                return "Working on it."
            return None


    # =============================================================================
    # CONTROL INTERFACE (Phase 5)
    # =============================================================================

    def stop(self):
        """
        Stop current execution.

        Sets stop flag - agent should check periodically and abort.
        """
        self._stop_requested.set()
        self.logger.info("Stop requested", component="harness")

    def pause(self):
        """
        Pause execution at next checkpoint.

        Sets pause flag - agent should pause at safe point.
        """
        self._pause_requested.set()
        self.logger.info("Pause requested", component="harness")

    def resume(self):
        """Resume paused execution"""
        self._pause_requested.clear()
        self._set_state(HarnessState.AGENT_WORKING)
        self.logger.info("Resumed", component="harness")

    def inject_context(self, context: str):
        """
        Inject clarification/context into running execution.

        Args:
            context: Additional context to inject
        """
        self._injected_context.put(context)
        self.logger.info(f"Context injected: {context}", component="harness")

    @property
    def is_stop_requested(self) -> bool:
        """Check if stop was requested"""
        return self._stop_requested.is_set()

    @property
    def is_pause_requested(self) -> bool:
        """Check if pause was requested"""
        return self._pause_requested.is_set()

    def get_injected_context(self) -> Optional[str]:
        """Get next injected context (if any)"""
        try:
            return self._injected_context.get_nowait()
        except queue.Empty:
            return None

    # =============================================================================
    # CONFIGURATION & STATE
    # =============================================================================

    @property
    def state(self) -> HarnessState:
        """Get current harness state"""
        return self._state

    @property
    def config(self) -> RuntimeConfig:
        """Get runtime configuration"""
        return self._runtime_config

    def update_config(self, updates: Dict[str, Any]) -> List[str]:
        """Update configuration at runtime"""
        successful = self._runtime_config.update(updates)
        for path in successful:
            self.logger.config_change(path, "previous", updates.get(path))
        return successful

    def set_default_tier(self, tier: str):
        """Set default agent tier"""
        self.agent.set_tier(tier)
        self.logger.info(f"Default tier set to: {tier}", component="harness")

    # =============================================================================
    # TOOL MANAGEMENT
    # =============================================================================

    def register_tool(self, tool):
        """Register a new tool"""
        self.tool_registry.register(tool)

    def enable_tool(self, name: str):
        """Enable a tool"""
        self.tool_registry.enable(name)

    def disable_tool(self, name: str):
        """Disable a tool"""
        self.tool_registry.disable(name)

    def list_tools(self) -> List[str]:
        """List available tools"""
        return [t.name for t in self.tool_registry.list_tools()]

    # =============================================================================
    # CALLBACKS
    # =============================================================================

    def add_response_callback(self, callback: Callable[[HarnessResponse], None]):
        """Add callback for completed responses"""
        self._response_callbacks.append(callback)

    def add_state_callback(self, callback: Callable[[HarnessState], None]):
        """Add callback for state changes"""
        self._state_callbacks.append(callback)

    def add_progress_callback(self, callback: Callable[[str, Optional[str], int], None]):
        """
        Add callback for progress updates.

        Callback signature: (message: str, tool_name: Optional[str], step_number: int)
        """
        self._progress_callbacks.append(callback)

    # =============================================================================
    # CLEANUP
    # =============================================================================

    def cleanup(self):
        """Clean up all resources"""
        self.logger.info("AgentHarness cleaned up", component="harness")


def create_harness(
    config_path: str = None,
    default_tier: str = "standard",
    profiler: Optional[Any] = None,
    logger: Optional[StructuredLogger] = None,
    execution_logger: Optional[AgentExecutionLogger] = None
) -> AgentHarness:
    """
    Create and configure an AgentHarness instance.

    Args:
        config_path: Path to configuration file
        default_tier: Default agent tier
        profiler: Optional profiler for runtime metrics
        logger: Logger instance
        execution_logger: Execution logger

    Returns:
        Configured AgentHarness instance
    """
    config = load_or_create_config(config_path) if config_path else HarnessConfig()
    config.agent.tier = default_tier

    runtime = create_runtime(
        config=config,
        profiler=profiler,
        logger=logger,
        execution_logger=execution_logger
    )

    return AgentHarness(runtime=runtime)
