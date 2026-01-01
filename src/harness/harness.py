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
from .agent.agent import Agent, AgentResponse, TieredAgent
from util.runtime import HarnessRuntime, create_runtime
from util.agent_execution_logger import AgentExecutionLogger
from hooks.models import InvocationContext, TaskCompletionData
from skills.models import SkillDefinition


class HarnessState(Enum):
    """Harness execution states"""
    IDLE = "idle"
    PROCESSING = "processing"
    AGENT_WORKING = "agent_working"
    PAUSED = "paused"
    STOPPING = "stopping"
    ERROR = "error"

@dataclass
class HarnessResponse:
    """Complete response from the harness"""
    full_response: str
    agent_response: AgentResponse
    spoken_response: str = ""  # Suggested spoken version (ServiceRep may override)
    state: HarnessState = HarnessState.IDLE
    duration_ms: float = 0
    metadata: Dict[str, Any] = field(default_factory=dict)
    # Pause state for ask_user tool
    paused: bool = False
    user_prompt: Optional[Dict[str, Any]] = None  # {question, options, context}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "full_response": self.full_response,
            "agent_response": self.agent_response.to_dict() if self.agent_response else None,
            "spoken_response": self.spoken_response,
            "state": self.state.value,
            "duration_ms": self.duration_ms,
            "metadata": self.metadata,
            "paused": self.paused,
            "user_prompt": self.user_prompt,
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
        execution_logger: Optional[AgentExecutionLogger] = None,
        log_dir: Optional[str] = None
    ):
        if runtime and (config or config_path):
            raise ValueError("Provide either an existing runtime or configuration inputs, not both.")

        self.runtime = runtime or create_runtime(
            config=config,
            config_path=config_path,
            profiler=profiler,
            logger=logger,
            execution_logger=execution_logger,
            log_dir=log_dir
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
        self.graphd = getattr(self.runtime, "graphd", None)
        self.skill_registry = getattr(self.runtime, "skill_registry", None)
        self.skill_router = getattr(self.runtime, "skill_router", None)
        self.hook_manager = getattr(self.runtime, "hook_manager", None)

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
        budget: Optional[Dict[str, int]] = None,
        request_id: Optional[str] = None,
        session_key: Optional[str] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None
    ) -> HarnessResponse:
        """
        Process request through the agent.

        Args:
            speech_text: User's request
            tier: Agent tier (determined by ServiceRep/Router)
            context: Optional additional context
            budget: Optional budget constraints from router
            request_id: Request identifier
            session_key: Session key for conversation persistence
            on_stream_chunk: Optional callback for streaming final response synthesis.
                            Called with (chunk: str, chunk_index: int, is_final: bool)

        Returns:
            HarnessResponse with results
        """
        request_id = request_id or self.logger.new_request()
        start_time = time.time()

        self.logger.request_received(speech_text)
        call_dir = os.getcwd()
        self._set_state(HarnessState.PROCESSING)

        # Session management: touch session (creates if needed) and load context
        session_context_data = None  # Full context snapshot for hydration
        if session_key and self.graphd:
            try:
                self.graphd.session_touch(session_key, working_dir=call_dir)

                # Load full context snapshot for SessionContext hydration
                session_context_data = self.load_session_context(session_key)
            except Exception as e:
                self.logger.warning(f"Failed to load session context: {e}", component="harness")

        agent_response = None
        full_response = ""

        # Clear control flags
        self._stop_requested.clear()
        self._pause_requested.clear()
        while not self._injected_context.empty():
            self._injected_context.get_nowait()

        try:
            invocation_context = InvocationContext(
                request_id=request_id,
                session_key=session_key,
                user_input=speech_text,
                tier=tier,
                metadata={"context": context} if context else {},
            )

            hook_blocked = False
            ran_invocation_after = False

            if self.hook_manager:
                hook_result = self.hook_manager.run("invocation.before", invocation_context)
                if hook_result.blocked:
                    blocked_msg = hook_result.message or "Request blocked by hook"
                    agent_response = AgentResponse(
                        content=blocked_msg,
                        success=False,
                        error=blocked_msg,
                        metadata={"hook_blocked": True},
                    )
                    full_response = blocked_msg
                    hook_blocked = True

            if not hook_blocked:
                speech_text = invocation_context.user_input
                tier = invocation_context.tier

                skill_match = None
                if self.skill_router:
                    skill_match = self.skill_router.route(speech_text, tier, session_key)

                if skill_match:
                    skill = skill_match.skill
                    self._set_state(HarnessState.AGENT_WORKING)

                    # Instruction-based skill: inject instructions into agent context
                    skill_context = self._build_skill_context(skill, speech_text, context)

                    # Reset progress tracking and wire up callbacks
                    self._last_progress_tool = None
                    phase_callback = self._create_phase_callback(request_id)

                    if hasattr(self.agent, "get_agent_for_tier"):
                        tier_agent = self.agent.get_agent_for_tier(tier)
                    else:
                        tier_agent = self.agent
                    if hasattr(tier_agent, "add_phase_callback"):
                        tier_agent.add_phase_callback(phase_callback)

                    try:
                        if self.graphd:
                            self.graphd.set_active(True)
                        with self.tool_registry.with_working_dir(call_dir):
                            with self.tool_registry.with_invocation_context(invocation_context):
                                with self.tool_registry.with_allowed_tools(skill.allowed_tools):
                                    with self._profile("harness.skill_agent_run_ms"):
                                        agent_response = self.agent.run(
                                            user_input=speech_text,
                                            tier=tier,
                                            context=skill_context,
                                            budget=budget,
                                            on_stream_chunk=on_stream_chunk,
                                            session_context=session_context_data,
                                        )
                        # Add skill metadata to response
                        if agent_response.metadata is None:
                            agent_response.metadata = {}
                        agent_response.metadata["skill_id"] = skill.id
                        agent_response.metadata["skill_trigger"] = skill_match.trigger_type
                        agent_response.metadata["skill_type"] = "instructions"
                    finally:
                        if self.graphd:
                            self.graphd.set_active(False)
                        if hasattr(tier_agent, "remove_phase_callback"):
                            tier_agent.remove_phase_callback(phase_callback)

                    if self.hook_manager:
                        self.hook_manager.run("invocation.after", invocation_context)
                    ran_invocation_after = True
                else:
                    # Step 1: Agent execution with progress updates
                    self._set_state(HarnessState.AGENT_WORKING)

                    # Reset progress tracking and wire up callbacks
                    self._last_progress_tool = None
                    phase_callback = self._create_phase_callback(request_id)

                    # Get the agent for this tier and add callbacks
                    if hasattr(self.agent, "get_agent_for_tier"):
                        tier_agent = self.agent.get_agent_for_tier(tier)
                    else:
                        tier_agent = self.agent
                    if hasattr(tier_agent, "add_phase_callback"):
                        tier_agent.add_phase_callback(phase_callback)

                    try:
                        if self.graphd:
                            self.graphd.set_active(True)
                        with self.tool_registry.with_working_dir(call_dir):
                            with self.tool_registry.with_invocation_context(invocation_context):
                                with self._profile("harness.agent_run_ms"):
                                    agent_response = self.agent.run(
                                        user_input=speech_text,
                                        tier=tier,
                                        context=context,
                                        budget=budget,
                                        on_stream_chunk=on_stream_chunk,
                                        session_context=session_context_data,
                                    )
                    finally:
                        if self.graphd:
                            self.graphd.set_active(False)
                        if hasattr(tier_agent, "remove_phase_callback"):
                            tier_agent.remove_phase_callback(phase_callback)

                if self.hook_manager and not ran_invocation_after:
                    self.hook_manager.run("invocation.after", invocation_context)

                # Run task.completed hooks for code review
                if self.hook_manager and agent_response and not agent_response.paused:
                    task_completion = self._build_task_completion_data(
                        agent_response=agent_response,
                        user_input=speech_text,
                        tier=tier,
                        duration_ms=(time.time() - start_time) * 1000,
                        base_dir=call_dir,
                    )
                    invocation_context.task_completion = task_completion
                    self.hook_manager.run("task.completed", invocation_context)

                    # Log code review result if available
                    review_notes = invocation_context.annotations.get("code_review_notes")
                    if review_notes:
                        self.logger.info(
                            f"Code review completed: risk={invocation_context.annotations.get('code_review_risk', 'unknown')}",
                            component="harness",
                        )

            # Step 2: Build response
            if agent_response and not full_response:
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

            # Check if agent is paused waiting for user input
            is_paused = agent_response.paused if agent_response else False
            user_prompt = agent_response.user_prompt if agent_response else None
            final_state = HarnessState.PAUSED if is_paused else HarnessState.IDLE

            response = HarnessResponse(
                full_response=full_response,
                agent_response=agent_response,
                spoken_response=agent_response.content if agent_response else "",  # ServiceRep will summarize
                state=final_state,
                duration_ms=duration_ms,
                metadata={
                    "request_id": request_id,
                    "tier": tier,
                    "tools_used": agent_response.tools_used if agent_response else [],
                    "session_key": session_key,
                },
                paused=is_paused,
                user_prompt=user_prompt,
            )

            # Session management: persist conversation messages and context state
            if session_key and self.graphd:
                self._persist_session_data(
                    session_key=session_key,
                    request_id=request_id,
                    user_input=speech_text,
                    assistant_response=full_response,
                    tools_used=agent_response.tools_used if agent_response else [],
                    duration_ms=duration_ms,
                )

                # Persist final context state for next request hydration
                final_context = agent_response.metadata.get("final_context_state") if agent_response else None
                if final_context:
                    self.save_session_context(session_key, final_context)
                    self.logger.debug(
                        f"Persisted context state for session {session_key}",
                        component="harness",
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

    def _create_phase_callback(self, request_id: str) -> Callable[[str, Optional[str], int], None]:
        """Create callback to forward agent phase progress to progress_callbacks.

        This handles phase transitions during agent execution.
        """
        def on_phase(message: str, tool_name: Optional[str], step_number: int):
            # Forward to all progress callbacks
            for callback in self._progress_callbacks:
                try:
                    callback(message, tool_name, step_number)
                except Exception as e:
                    self.logger.error(f"Phase progress callback error: {e}", component="harness")

        return on_phase

    def _build_task_completion_data(
        self,
        agent_response: AgentResponse,
        user_input: str,
        tier: str,
        duration_ms: float,
        base_dir: Optional[str] = None,
    ) -> TaskCompletionData:
        """Build TaskCompletionData from agent response for code review hooks."""
        metadata = agent_response.metadata or {}

        base_dir = base_dir or os.getcwd()

        # Extract file operations
        file_ops = metadata.get("file_operations", [])
        normalized_ops = []
        for op in file_ops:
            if not isinstance(op, dict):
                continue
            path = op.get("path")
            if not path:
                continue
            path_str = str(path)
            if os.path.isabs(path_str):
                normalized_path = os.path.abspath(path_str)
            else:
                normalized_path = os.path.abspath(os.path.join(base_dir, path_str))
            normalized_ops.append({"path": normalized_path, "action": op.get("action")})

        files_written = [
            op.get("path") for op in normalized_ops
            if op.get("action") in ("write", "edit", "create", "append")
        ]
        files_read = [
            op.get("path") for op in normalized_ops
            if op.get("action") == "read"
        ]

        # Dedupe while preserving order
        files_written = list(dict.fromkeys([p for p in files_written if p]))
        files_read = list(dict.fromkeys([p for p in files_read if p]))

        # Extract reflection data if available
        reflection = agent_response.reflection
        steps_completed = 0
        steps_failed = 0
        steps_skipped = 0
        goal = ""

        if reflection:
            if hasattr(reflection, "plan_goal"):
                goal = reflection.plan_goal or ""
            # Try to get step counts from metadata
            steps_completed = metadata.get("steps_completed", 0)
            steps_failed = metadata.get("steps_failed", 0)
            steps_skipped = metadata.get("steps_skipped", 0)

        # Also check final_context_state for more data
        final_context = metadata.get("final_context_state", {})
        if final_context:
            # Get read_files from context if available
            ctx_read_files = final_context.get("read_files", [])
            if ctx_read_files:
                normalized_ctx_reads = []
                for path in ctx_read_files:
                    if not path:
                        continue
                    path_str = str(path)
                    if os.path.isabs(path_str):
                        normalized_ctx_reads.append(os.path.abspath(path_str))
                    else:
                        normalized_ctx_reads.append(os.path.abspath(os.path.join(base_dir, path_str)))
                files_read = list(dict.fromkeys(files_read + normalized_ctx_reads))

        plan_steps = metadata.get("plan_steps", [])
        if not isinstance(plan_steps, list):
            plan_steps = []

        symbols_modified = metadata.get("symbols_modified", [])
        if not isinstance(symbols_modified, list):
            symbols_modified = []
        if not symbols_modified and files_written and self.graphd:
            try:
                from harness.graphd.utils import normalize_path
                collected = []
                for file_path in files_written:
                    rel_path = normalize_path(file_path, self.graphd.root)
                    if rel_path.startswith(".."):
                        continue
                    for symbol in self.graphd.store.get_symbols_for_file(rel_path):
                        symbol_id = symbol.get("id") or symbol.get("name")
                        if symbol_id:
                            collected.append(symbol_id)
                symbols_modified = list(dict.fromkeys(collected))
            except Exception as exc:
                self.logger.debug(
                    f"Failed to derive symbols_modified: {exc}",
                    component="harness",
                )

        return TaskCompletionData(
            success=agent_response.success,
            goal_achieved=agent_response.goal_achieved,
            goal=goal or user_input[:100],
            files_written=files_written,
            files_read=files_read,
            tools_used=agent_response.tools_used or [],
            tool_call_count=len(agent_response.tools_used or []),
            steps_completed=steps_completed,
            steps_failed=steps_failed,
            steps_skipped=steps_skipped,
            duration_ms=duration_ms,
            symbols_modified=symbols_modified,
            plan_steps=plan_steps,
            final_response=agent_response.content or "",
        )

    def _build_skill_context(
        self,
        skill: SkillDefinition,
        user_input: str,
        existing_context: Optional[str],
    ) -> str:
        """Build context string with skill instructions injected for agent."""
        parts = []

        # Add skill instructions as primary context
        parts.append(f"## Active Skill: {skill.name}")
        parts.append("")
        parts.append("You are operating under the following skill instructions. Follow them carefully:")
        parts.append("")
        parts.append(skill.instructions or "")
        parts.append("")
        parts.append("---")
        parts.append("")

        # Append any existing context
        if existing_context:
            parts.append("## Additional Context")
            parts.append("")
            parts.append(existing_context)
            parts.append("")

        return "\n".join(parts)

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

    def resume_with_answer(self, answer: str) -> HarnessResponse:
        """
        Resume execution after user provides an answer to ask_user prompt.

        Args:
            answer: The user's response to the question

        Returns:
            HarnessResponse with continued execution results
        """
        start_time = time.time()
        self._set_state(HarnessState.AGENT_WORKING)

        try:
            agent_response = self.agent.resume_with_answer(answer)
            duration_ms = (time.time() - start_time) * 1000

            is_paused = agent_response.paused
            user_prompt = agent_response.user_prompt
            final_state = HarnessState.PAUSED if is_paused else HarnessState.IDLE

            self._set_state(final_state)

            return HarnessResponse(
                full_response=agent_response.content,
                agent_response=agent_response,
                spoken_response=agent_response.content,
                state=final_state,
                duration_ms=duration_ms,
                paused=is_paused,
                user_prompt=user_prompt,
            )
        except Exception as e:
            self._set_state(HarnessState.ERROR)
            self.logger.error(f"Resume with answer failed: {e}", component="harness")
            return HarnessResponse(
                full_response=f"Error resuming: {str(e)}",
                agent_response=None,
                spoken_response="I'm sorry, something went wrong.",
                state=HarnessState.ERROR,
                duration_ms=(time.time() - start_time) * 1000,
            )

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
    # SESSION MANAGEMENT
    # =============================================================================

    def _persist_session_data(
        self,
        session_key: str,
        request_id: str,
        user_input: str,
        assistant_response: str,
        tools_used: List[str],
        duration_ms: float,
    ):
        """
        Persist conversation data to GraphDB for the session.

        This is called after each successful request to store:
        - User message
        - Assistant response with metadata

        Args:
            session_key: Session key for persistence
            request_id: Request ID for tracing
            user_input: User's message
            assistant_response: Agent's response
            tools_used: List of tools used
            duration_ms: Request duration in milliseconds
        """
        if not self.graphd:
            return

        try:
            # Store user message
            self.graphd.message_add(
                session_key=session_key,
                role="user",
                content=user_input,
                request_id=request_id,
            )

            # Store assistant response with metadata
            self.graphd.message_add(
                session_key=session_key,
                role="assistant",
                content=assistant_response,
                request_id=request_id,
                metadata={
                    "tools_used": tools_used,
                    "duration_ms": duration_ms,
                },
            )

            self.logger.debug(
                f"Session data persisted for {session_key}",
                component="harness",
            )

        except Exception as e:
            # Log but don't fail the request - session persistence is best-effort
            self.logger.warning(
                f"Failed to persist session data: {e}",
                component="harness",
            )

    def save_session_context(self, session_key: str, context_data: Dict[str, Any]) -> bool:
        """
        Save context snapshot for a session.

        This can be called explicitly to persist the current context state.

        Args:
            session_key: Session key
            context_data: Context data to save (e.g., from ContextState.to_dict())

        Returns:
            True if saved successfully, False otherwise
        """
        if not self.graphd:
            return False

        try:
            result = self.graphd.context_save(session_key, context_data)
            if result.get("success"):
                self.logger.debug(
                    f"Context snapshot saved for {session_key} (v{result.get('snapshot_version')})",
                    component="harness",
                )
                return True
            else:
                self.logger.warning(
                    f"Failed to save context snapshot: {result.get('error')}",
                    component="harness",
                )
                return False
        except Exception as e:
            self.logger.warning(f"Failed to save context snapshot: {e}", component="harness")
            return False

    def load_session_context(self, session_key: str) -> Optional[Dict[str, Any]]:
        """
        Load the latest context snapshot for a session.

        Args:
            session_key: Session key

        Returns:
            Context data dict or None if not found
        """
        if not self.graphd:
            return None

        try:
            result = self.graphd.context_get(session_key)
            snapshot = result.get("snapshot")
            if snapshot and snapshot.get("context"):
                return snapshot["context"]
            return None
        except Exception as e:
            self.logger.warning(f"Failed to load context snapshot: {e}", component="harness")
            return None

    def get_session_messages(self, session_key: str, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Get conversation history for a session.

        Args:
            session_key: Session key
            limit: Maximum messages to return

        Returns:
            List of message dicts
        """
        if not self.graphd:
            return []

        try:
            result = self.graphd.messages_get(session_key, limit=limit)
            return result.get("messages", [])
        except Exception as e:
            self.logger.warning(f"Failed to get session messages: {e}", component="harness")
            return []

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
    execution_logger: Optional[AgentExecutionLogger] = None,
    log_dir: Optional[str] = None
) -> AgentHarness:
    """
    Create and configure an AgentHarness instance.

    Args:
        config_path: Path to configuration file
        default_tier: Default agent tier
        profiler: Optional profiler for runtime metrics
        logger: Logger instance
        execution_logger: Execution logger
        log_dir: Optional log directory override

    Returns:
        Configured AgentHarness instance
    """
    config = load_or_create_config(config_path) if config_path else HarnessConfig()
    config.agent.tier = default_tier

    runtime = create_runtime(
        config=config,
        profiler=profiler,
        logger=logger,
        execution_logger=execution_logger,
        log_dir=log_dir
    )

    return AgentHarness(runtime=runtime)
