"""
Stateless Worker that executes bounded work items.
Workers NEVER mutate global state - all results go through WorkerOutcome.
"""

import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Protocol, Set, Tuple

# Environment variable to enable full context debug logging
# Set AGENT_DEBUG_CONTEXT=1 to see the complete context sent to LLM
_DEBUG_CONTEXT = os.getenv("AGENT_DEBUG_CONTEXT", "0") == "1"

from .knowledge_store import KnowledgeFact, FactSource
from .plan_patch import PlanPatch


class ToolResult(Protocol):
    """Protocol for tool execution results."""
    is_success: bool  # Match actual ToolResult from tool_registry.py
    output: str
    error: Optional[str]
    metadata: Optional[Dict[str, Any]]


class ToolRegistry(Protocol):
    """Protocol for tool registry - allows any compatible implementation."""
    def get_tool(self, name: str) -> Any: ...
    def get_definitions(self, enabled_only: bool = True) -> List[Any]: ...
    def execute(self, name: str, **kwargs) -> ToolResult: ...


class Logger(Protocol):
    """Protocol for logger - allows any compatible implementation."""
    def info(self, msg: str, **kwargs) -> None: ...
    def debug(self, msg: str, **kwargs) -> None: ...
    def warning(self, msg: str, **kwargs) -> None: ...
    def error(self, msg: str, **kwargs) -> None: ...


class WorkerAction(Enum):
    """
    Explicit action requested by LLM.

    CRITICAL: We require explicit action markers to prevent premature termination.
    Without this, "LLM returned text without tool calls" ambiguously means:
    - "I'm done" (final answer)
    - "I need to think more" (should continue)
    - "I need more context" (should request tools)
    """

    TOOL = "tool"  # Execute tool calls
    FINAL = "final"  # Final answer, done
    NEED_CONTEXT = "need_context"  # Need more info, will request tools next
    CONTINUE = "continue"  # Keep going (internal reasoning)

@dataclass
class ToolExchange:
    """A tool invocation and its result (internal to Worker)."""

    call_id: str
    tool_name: str
    arguments: Dict[str, Any]
    result_content: str = ""
    success: bool = True
    error: Optional[str] = None

from .context_window import ContextWindow, ContextDelta, build_files_message, format_context_for_debug
from .work_item import WorkItem


@dataclass
class WorkerMetrics:
    """Compact metrics bundle for audit trail."""
    tool_calls_made: int = 0
    tool_calls_succeeded: int = 0
    tool_calls_failed: int = 0
    llm_calls_made: int = 0
    duration_ms: float = 0


@dataclass
class PatchSuggestion:
    """Worker-suggested plan change for Wizard review."""
    patch_type: str
    objective: Optional[str] = None
    tool_hint: Optional[str] = None
    target_step: Optional[int] = None
    insert_after: Optional[int] = None
    phase: Optional[str] = None
    depends_on: List[int] = field(default_factory=list)
    required: bool = False
    rationale: str = ""


# Patterns that indicate the LLM is REFUSING to work rather than completing
REFUSAL_PATTERNS = [
    r"cannot be completed",
    r"can't be completed",
    r"cannot complete",
    r"can't complete",
    r"unable to complete",
    r"unable to accomplish",
    r"exceeds? (?:the )?(?:budget|limit|constraint)",
    r"beyond (?:the )?(?:scope|budget|limit)",
    r"too (?:complex|large|big) (?:for|to)",
    r"not (?:possible|achievable|feasible)",
    r"would require (?:more|additional|exceeding)",
    r"insufficient (?:budget|resources|time)",
    r"task (?:is )?too (?:large|complex|broad)",
]

def _is_refusal_response(content: str) -> bool:
    """
    Detect if the LLM's response is a REFUSAL to work rather than an actual answer.

    This is critical because refusals should NOT be treated as successful Q&A responses.
    """
    if not content:
        return False

    import re
    content_lower = content.lower()

    for pattern in REFUSAL_PATTERNS:
        if re.search(pattern, content_lower):
            return True

    return False


PATCH_SUGGESTION_BLOCK = re.compile(
    r"\[PATCH_SUGGESTION\](.*?)\[/PATCH_SUGGESTION\]",
    re.IGNORECASE | re.DOTALL,
)


@dataclass
class WorkerOutcome:
    """
    Canonical output from Worker.

    CRITICAL: Workers NEVER mutate global state.
    All state changes go through WorkerOutcome for Wizard to ingest.
    Context updates are returned as message deltas.

    Version envelope for optimistic concurrency:
    - base_version: Plan version worker operated against
    - Patches with stale base_version are rejected by Wizard
    """

    # Identity
    work_id: str
    step_num: int

    # Version envelope (for optimistic concurrency)
    base_version: int

    # Core result
    success: bool
    final_response: Optional[str] = None
    error: Optional[str] = None
    tool_errors: List[str] = field(default_factory=list)

    # Flag: True if LLM refused to attempt work (detected via REFUSAL_PATTERNS)
    is_refusal: bool = False

    # Knowledge to auto-append (replaces suggested_facts + suggested_evidence)
    facts: List[KnowledgeFact] = field(default_factory=list)

    # Plan mutations (replaces patch_hints)
    patches: List[PlanPatch] = field(default_factory=list)
    # Worker-suggested plan changes (Wizard decides to apply)
    patch_suggestions: List[PatchSuggestion] = field(default_factory=list)

    # Metrics (for WorkLedger audit)
    metrics: WorkerMetrics = field(default_factory=WorkerMetrics)

    # Entity refs discovered (for audit trail)
    entity_refs: List[str] = field(default_factory=list)

    # Context updates (Wizard merges these into session context)
    context_messages: List[Dict[str, Any]] = field(default_factory=list)
    read_files: Set[str] = field(default_factory=set)

    # User input request (tool-driven pause)
    needs_user_input: bool = False
    user_prompt: Optional[Dict[str, Any]] = None  # {question, options, context}

    # Internal tracking (not for Wizard, but useful for debugging)
    termination_reason: str = ""

    @property
    def made_progress(self) -> bool:
        """Derived: True if tools succeeded or facts discovered."""
        return (
            self.metrics.tool_calls_succeeded > 0 or
            len(self.facts) > 0 or
            len(self.entity_refs) > 0
        )



@dataclass
class WorkerConfig:
    """Worker configuration."""

    max_iterations: int = 10
    enable_adaptive_reasoning: bool = True

    # If False (default), only explicit [FINAL] markers count as completion claims
    # If True, substantive responses without tools also count as implicit finals
    allow_implicit_finals: bool = False
    # Tools the Worker must never call (Wizard owns user interaction)
    disallowed_tools: Set[str] = field(default_factory=lambda: {"ask_user"})


@dataclass
class WorkerCacheParams:
    """
    Caching parameters for Worker LLM calls.

    These parameters enable OpenAI Responses API prompt caching:
    - prompt_cache_key: Stable key for caching the system prompt + tool definitions
    - prompt_cache_retention: How long to retain the cache (e.g., "24h")
    """
    prompt_cache_key: Optional[str] = None
    prompt_cache_retention: Optional[str] = None


class Worker:
    """
    Stateless inner-loop executor.

    CRITICAL INVARIANTS:
    - Worker NEVER mutates PlanState, Ledger, or Stores
    - All observations are returned in WorkerOutcome
    - Worker receives a read-only ContextWindow + WorkItem, returns WorkerOutcome

    API:
    - execute(base_context, work_item, plan_version) - Execute using base context + local delta
    """

    def __init__(
        self,
        tool_registry: ToolRegistry,
        llm: Any,  # LLMAdapter
        config: Optional[WorkerConfig] = None,
        logger: Optional[Logger] = None,
    ):
        self.tool_registry = tool_registry
        self.llm = llm
        self.config = config or WorkerConfig()
        self.logger = logger
        self._disallowed_tools = set(self.config.disallowed_tools)

    def _log(self, level: str, msg: str, **kwargs) -> None:
        """Log with optional logger. Silently no-ops if logger is None."""
        if self.logger is None:
            return
        log_fn = getattr(self.logger, level, None)
        if log_fn:
            log_fn(msg, component="worker", **kwargs)

    def _log_context(self, event_type: str, full_context: str, step_num: int) -> None:
        """
        Log full LLM context to health.jsonl without truncation.

        The full context is stored in data.full_context field.
        This is only called when AGENT_DEBUG_CONTEXT=1.

        Args:
            event_type: Event identifier (e.g., "LLM_CONTEXT", "LLM_CONTEXT_SYNTHESIS")
            full_context: The formatted context string (no truncation)
            step_num: Current step number for correlation
        """
        if self.logger is None:
            return

        # Use _log_health directly if available (StructuredLogger)
        # This stores full content in data field without truncation
        log_health_fn = getattr(self.logger, "_log_health", None)
        if callable(log_health_fn):
            log_health_fn(
                evt=f"{event_type}:step_{step_num}",
                svc="worker",
                data={"full_context": full_context, "step_num": step_num}
            )
        else:
            # Fallback: use debug() which may truncate, but stores full in data
            debug_fn = getattr(self.logger, "debug", None)
            if callable(debug_fn):
                debug_fn(
                    f"{event_type}:step_{step_num}",
                    component="worker",
                    data={"full_context": full_context, "step_num": step_num}
                )

    def execute(
        self,
        base_context: ContextWindow,
        work_item: WorkItem,
        plan_version: int = 0,
        cache_params: Optional[WorkerCacheParams] = None,
        read_files: Optional[Set[str]] = None,
    ) -> WorkerOutcome:
        """
        Execute work item using a read-only ContextWindow and a local ContextDelta.

        Args:
            base_context: Read-only ContextWindow with full context for this step
            work_item: Work item with objective and bounds
            plan_version: Plan version for optimistic concurrency
            cache_params: Optional caching/stateful params for LLM calls
            read_files: Files already read in this session (dedup metadata)

        Returns:
            WorkerOutcome with results, facts, and metrics
        """
        start_time = time.time()
        self._log("debug", f"Worker executing: step={work_item.step_num}, objective='{work_item.objective[:60]}'")

        # Reset response tracking for this execution
        self._cache_params = cache_params or WorkerCacheParams()

        outcome = WorkerOutcome(
            work_id=work_item.work_id,
            step_num=work_item.step_num,
            base_version=plan_version,
            success=False,
        )

        try:
            context_delta = ContextDelta()
            read_files = read_files or set()
            self._execute_loop(base_context, context_delta, read_files, work_item, outcome, start_time)
        except Exception as exc:
            self._log("error", f"Worker exception: {type(exc).__name__}: {str(exc)[:100]}")
            outcome.success = False
            outcome.error = str(exc)
            outcome.termination_reason = f"exception: {type(exc).__name__}"

        outcome.metrics.duration_ms = (time.time() - start_time) * 1000

        # Merge context delta into outcome for Wizard ingestion
        outcome.context_messages = context_delta.messages
        outcome.read_files = context_delta.read_files
        return outcome

    def _execute_loop(
        self,
        base_context: ContextWindow,
        context_delta: ContextDelta,
        read_files: Set[str],
        work_item: WorkItem,
        outcome: WorkerOutcome,
        start_time: float,
    ) -> None:
        """
        Main execution loop using read-only base context + local delta.

        Uses ContextDelta for:
        - Message accumulation (assistant/user/tool messages)
        - File read tracking (dedup metadata for Wizard)
        """
        # ========== AUTO-READ TARGET FILES (PRE-LOOP) ==========
        if work_item.target_paths:
            self._log("debug", f"Auto-reading {len(work_item.target_paths)} target files")

            files_read: List[Tuple[str, str]] = []
            cwd = self.tool_registry._get_current_working_dir()
            for path in work_item.target_paths:
                if path in read_files or path in context_delta.read_files:
                    self._log("debug", f"  ⊘ Skipping {path} (already read)")
                    continue

                try:
                    result = self.tool_registry.execute("Read", cwd=cwd, path=path)
                    outcome.metrics.tool_calls_made += 1

                    if result.is_success and result.output is not None:
                        content = str(result.output)
                        files_read.append((path, content))
                        context_delta.read_files.add(path)
                        if path not in outcome.entity_refs:
                            outcome.entity_refs.append(path)
                        outcome.metrics.tool_calls_succeeded += 1
                        self._log("debug", f"  ✓ Read {path} ({len(content)} chars)")
                    else:
                        outcome.metrics.tool_calls_failed += 1
                        self._log("warning", f"  ✗ Failed to read {path}: {result.error}")
                except Exception as e:
                    outcome.metrics.tool_calls_failed += 1
                    self._log("error", f"  ✗ Exception reading {path}: {e}")

            files_message = build_files_message(files_read)
            if files_message:
                context_delta.add_message(files_message)

        iteration = 0
        final_content: Optional[str] = None
        consecutive_no_action = 0

        while True:
            # Check all bounds before proceeding
            termination = self._check_bounds(outcome, work_item, start_time, iteration)
            if termination:
                outcome.termination_reason = termination
                break

            iteration += 1

            # Get messages from base context + local delta
            messages = context_delta.merged_messages(base_context)

            tools_allowed = work_item.bounds.max_tool_calls > 0
            response = (
                self._call_llm(messages, work_item, outcome)
                if tools_allowed
                else self._call_llm_no_tools(messages, outcome)
            )
            outcome.metrics.llm_calls_made += 1

            if not response:
                outcome.termination_reason = "llm_error"
                if not outcome.error:
                    outcome.error = "LLM returned no response"
                break

            # Check if LLM wants to call tools
            if self._has_tool_calls(response):
                consecutive_no_action = 0

                # Process tool calls
                tool_exchanges = self._process_tool_calls(
                    response,
                    outcome,
                    work_item,
                    context_delta,
                )

                # Check if a tool requested user input (e.g., ask_user)
                if outcome.needs_user_input:
                    self._log("info", "Worker pausing for user input")
                    break
                if outcome.termination_reason == "tool_requested_user":
                    break

                # Add assistant message with tool calls to local context
                assistant_content = self._extract_content(response) or ""
                tool_calls_for_msg = [
                    {
                        "id": ex.call_id,
                        "type": "function",
                        # Responses API requires arguments as JSON string, not dict
                        "function": {
                            "name": ex.tool_name,
                            "arguments": json.dumps(ex.arguments) if isinstance(ex.arguments, dict) else ex.arguments,
                        },
                    }
                    for ex in tool_exchanges
                ]
                assistant_msg: Dict[str, Any] = {"role": "assistant"}
                if assistant_content:
                    assistant_msg["content"] = assistant_content
                assistant_msg["tool_calls"] = tool_calls_for_msg
                context_delta.add_message(assistant_msg)

                # Add tool results to local context
                for ex in tool_exchanges:
                    content = ex.result_content
                    if not ex.success and ex.error:
                        content = f"ERROR: {ex.error}\n{content}"
                    context_delta.add_message({
                        "role": "tool",
                        "tool_call_id": ex.call_id,
                        "content": content,
                    })

                synthesis_suffix = (
                    "SYNTHESIS REQUIRED: Read the tool outputs above and do ONE of:\n"
                    "1) Explain findings + next action.\n"
                    "2) If objective is satisfied, output [FINAL] with a concise explanation.\n"
                    "Do NOT call tools in this synthesis step."
                )
                synth_messages = context_delta.merged_messages(
                    base_context,
                    system_suffix=synthesis_suffix,
                )
                synth = self._call_llm_no_tools(synth_messages, outcome)
                outcome.metrics.llm_calls_made += 1

                content = self._extract_content(synth) if synth else None
                self._log("debug", content or "")

                if content:
                    context_delta.add_message({"role": "assistant", "content": content})

                # Check for action markers
                action = self._extract_action(content)
                if action == WorkerAction.FINAL:
                    final_content = self._strip_action_marker(content)
                    outcome.termination_reason = "completed"
                    break

                elif action == WorkerAction.NEED_CONTEXT:
                    prompt = self._extract_user_prompt(content)
                    if prompt:
                        outcome.needs_user_input = True
                        outcome.user_prompt = prompt
                        outcome.termination_reason = "awaiting_user"
                        final_content = None
                        break
                    outcome.termination_reason = "need_context_no_prompt"
                    outcome.error = "NEED_CONTEXT missing structured prompt"
                    break

                elif action == WorkerAction.CONTINUE:
                    consecutive_no_action += 1
                    if consecutive_no_action >= 3:
                        outcome.termination_reason = "max_continues"
                        outcome.error = "LLM continued reasoning without taking action"
                        break
                    continue

                else:
                    # No explicit action marker - use heuristics
                    if content and len(content) > 50:
                        final_content = content
                        outcome.termination_reason = "implicit_final"
                        break
                    else:
                        consecutive_no_action += 1
                        if consecutive_no_action >= 2:
                            outcome.termination_reason = "no_action"
                            outcome.error = "LLM returned content without action or tools"
                            break
                        continue

            else:
                # TEXT-ONLY RESPONSE (no tool calls)
                content = self._extract_content(response)
                self._log("debug", f"Text-only response (no tools): {len(content or '')} chars")

                if content:
                    context_delta.add_message({"role": "assistant", "content": content})

                action = self._extract_action(content)
                if action == WorkerAction.FINAL:
                    final_content = self._strip_action_marker(content)
                    outcome.termination_reason = "completed"
                    break
                elif action == WorkerAction.NEED_CONTEXT:
                    prompt = self._extract_user_prompt(content)
                    if prompt:
                        outcome.needs_user_input = True
                        outcome.user_prompt = prompt
                        outcome.termination_reason = "awaiting_user"
                        final_content = None
                        break
                    outcome.termination_reason = "need_context_no_prompt"
                    outcome.error = "NEED_CONTEXT missing structured prompt"
                    break
                elif action == WorkerAction.CONTINUE:
                    consecutive_no_action += 1
                    if consecutive_no_action >= 3:
                        outcome.termination_reason = "max_continues"
                        outcome.error = "LLM continued reasoning without taking action"
                        break
                    continue
                elif content and len(content) > 50:
                    final_content = content
                    outcome.termination_reason = "implicit_final"
                    self._log("debug", f"Implicit final detected: {len(content)} chars")
                    break
                else:
                    consecutive_no_action += 1
                    if consecutive_no_action >= 2:
                        outcome.termination_reason = "no_action"
                        outcome.error = "LLM returned short response without action or tools"
                        break
                    continue

        if final_content:
            suggestions, cleaned = self._extract_patch_suggestions(final_content)
            outcome.patch_suggestions = suggestions
            final_content = cleaned

        if not outcome.needs_user_input:
            # Determine success
            self._determine_success(outcome, final_content, work_item)

    def _call_llm(
        self,
        messages: List[Dict[str, Any]],
        work_item: WorkItem,
        outcome: WorkerOutcome,
    ) -> Optional[Any]:
        """Call LLM with tools using a merged message list."""
        # Debug logging: show full context when AGENT_DEBUG_CONTEXT=1
        # Full context is stored in data.full_context, written to logs/health.jsonl
        if _DEBUG_CONTEXT:
            formatted_context = format_context_for_debug(messages)
            self._log_context("LLM_CONTEXT", formatted_context, work_item.step_num)

        try:
            tools = self.tool_registry.get_definitions(enabled_only=True)
            if self._disallowed_tools:
                tools = [t for t in tools if t.name not in self._disallowed_tools]

            if hasattr(self.llm, "respond_with_messages"):
                response = self.llm.respond_with_messages(
                    messages=messages,
                    tools=tools,
                    prompt_cache_key=self._cache_params.prompt_cache_key,
                    prompt_cache_retention=self._cache_params.prompt_cache_retention,
                )
                return response

            # Fallback for LLMs without respond_with_messages
            if hasattr(self.llm, "respond"):
                packed = "\n".join(
                    f"{m.get('role', '?').upper()}: {m.get('content', '')}"
                    for m in messages
                    if m.get("content")
                )
                system_msg = next((m["content"] for m in messages if m["role"] == "system"), "")
                response = self.llm.respond(
                    input=packed,
                    instructions=system_msg,
                    tools=tools,
                    prompt_cache_key=self._cache_params.prompt_cache_key,
                    prompt_cache_retention=self._cache_params.prompt_cache_retention,
                )
                return response

            outcome.error = "LLM adapter missing respond methods"
            return None

        except Exception as exc:
            error_msg = f"LLM call failed: {type(exc).__name__}: {str(exc)[:200]}"
            outcome.error = error_msg
            self._log("error", error_msg)
            return None

    def _call_llm_no_tools(
        self,
        messages: List[Dict[str, Any]],
        outcome: WorkerOutcome,
    ) -> Optional[Any]:
        """Call LLM without tools (synthesis step)."""
        # Debug logging: show full context when AGENT_DEBUG_CONTEXT=1
        # Full context is stored in data.full_context, written to logs/health.jsonl
        if _DEBUG_CONTEXT:
            formatted_context = format_context_for_debug(messages)
            self._log_context("LLM_CONTEXT_SYNTHESIS", formatted_context, outcome.step_num)

        try:
            if hasattr(self.llm, "respond_with_messages"):
                response = self.llm.respond_with_messages(
                    messages=messages,
                    tools=[],
                    prompt_cache_key=self._cache_params.prompt_cache_key,
                    prompt_cache_retention=self._cache_params.prompt_cache_retention,
                )
                return response

            if hasattr(self.llm, "respond"):
                packed = "\n".join(
                    f"{m.get('role', '?').upper()}: {m.get('content', '')}"
                    for m in messages
                    if m.get("content")
                )
                system_msg = next((m["content"] for m in messages if m["role"] == "system"), "")
                response = self.llm.respond(
                    input=packed,
                    instructions=system_msg,
                    tools=[],
                    prompt_cache_key=self._cache_params.prompt_cache_key,
                    prompt_cache_retention=self._cache_params.prompt_cache_retention,
                )
                return response

            return None
        except Exception as exc:
            error_msg = f"LLM(no-tools) failed: {type(exc).__name__}: {str(exc)[:200]}"
            outcome.error = error_msg
            self._log("error", error_msg)
            return None

    def _process_tool_calls(
        self,
        response: Any,
        outcome: WorkerOutcome,
        work_item: WorkItem,
        context_delta: ContextDelta,
    ) -> List[ToolExchange]:
        """Execute tool calls and return ToolExchange records."""
        exchanges: List[ToolExchange] = []
        tool_calls = getattr(response, "tool_calls", []) or []

        self._log("debug", f"=== PROCESSING {len(tool_calls)} TOOL CALLS ===")

        for tool_call in tool_calls:
            if outcome.metrics.tool_calls_made >= work_item.bounds.max_tool_calls:
                self._log("warning", f"Hit tool call limit ({work_item.bounds.max_tool_calls}), skipping remaining")
                break

            raw_args = getattr(tool_call, "arguments", {})
            parsed_args = self._parse_tool_arguments(raw_args)

            call_id = getattr(tool_call, "id", str(uuid.uuid4())[:8])
            tool_name = getattr(tool_call, "name", "unknown")

            self._log("debug", f"--- Executing Tool: {tool_name} ---")
            self._log("debug", f"  call_id: {call_id}")
            self._log("debug", f"  arguments: {json.dumps(parsed_args, default=str)[:500]}")

            exchange = ToolExchange(
                call_id=call_id,
                tool_name=tool_name,
                arguments=parsed_args,
            )

            try:
                if tool_name in self._disallowed_tools:
                    outcome.metrics.tool_calls_made += 1
                    outcome.metrics.tool_calls_failed += 1
                    exchange.success = False
                    exchange.error = f"Tool '{tool_name}' is not allowed in Worker"
                    exchange.result_content = "ERROR: Tool not allowed"
                    outcome.error = exchange.error
                    outcome.termination_reason = "tool_requested_user"
                    self._log("warning", f"Blocked tool call to {tool_name}")
                    outcome.tool_errors.append(f"{tool_name}: {exchange.error}")
                    exchanges.append(exchange)
                    continue

                result = self.tool_registry.execute(tool_name, **parsed_args)
                outcome.metrics.tool_calls_made += 1

                if result.is_awaiting_user:
                    outcome.metrics.tool_calls_failed += 1
                    exchange.success = False
                    exchange.error = "Tool requested user input; Worker must not call ask_user"
                    exchange.result_content = "ERROR: User prompt must be handled by Wizard"
                    outcome.error = exchange.error
                    outcome.termination_reason = "tool_requested_user"
                    self._log("warning", f"Tool {tool_name} requested user input; blocked")
                    outcome.tool_errors.append(f"{tool_name}: {exchange.error}")
                    exchanges.append(exchange)
                    return exchanges

                if result.is_success:
                    outcome.metrics.tool_calls_succeeded += 1
                    exchange.success = True
                    exchange.result_content = str(result.output) if result.output is not None else ""
                    self._log("debug", f"  result: SUCCESS")

                    # Record as KnowledgeFact
                    outcome.facts.append(KnowledgeFact(
                        key=f"tool:{tool_name}:result",
                        value=str(result.output) if result.output is not None else "",
                        confidence=0.9,
                        source=FactSource.TOOL,
                        tool_name=tool_name,
                    ))

                    # Track entity refs
                    if result.metadata:
                        path = result.metadata.get("path")
                        if path:
                            outcome.entity_refs.append(path)
                            context_delta.read_files.add(path)
                else:
                    outcome.metrics.tool_calls_failed += 1
                    exchange.success = False
                    exchange.error = result.error
                    exchange.result_content = str(result.output) if result.output is not None else ""
                    self._log("warning", f"  result: FAILED - {result.error}")
                    if exchange.error:
                        outcome.tool_errors.append(f"{tool_name}: {exchange.error}")

            except Exception as exc:
                outcome.metrics.tool_calls_made += 1
                outcome.metrics.tool_calls_failed += 1
                exchange.success = False
                exchange.error = str(exc)
                outcome.tool_errors.append(f"{tool_name}: {exchange.error}")

            exchanges.append(exchange)

        return exchanges

    def _extract_action(self, content: Optional[str]) -> Optional[WorkerAction]:
        if not content:
            return None
        import re
        c = content.strip()

        # robust: allows "[NEED_CONTEXT]" "NEED_CONTEXT]" "[NEED_CONTEXT" "ACTION: NEED_CONTEXT"
        if re.search(r'(\bACTION:\s*)?\[?\s*FINAL\s*\]?\b', c, re.IGNORECASE):
            return WorkerAction.FINAL
        if re.search(r'(\bACTION:\s*)?\[?\s*NEED_CONTEXT\s*\]?\b', c, re.IGNORECASE):
            return WorkerAction.NEED_CONTEXT
        if re.search(r'(\bACTION:\s*)?\[?\s*CONTINUE\s*\]?\b', c, re.IGNORECASE):
            return WorkerAction.CONTINUE

        return None

    def _extract_user_prompt(self, content: Optional[str]) -> Optional[Dict[str, Any]]:
        """Extract a structured user prompt from a [NEED_CONTEXT] response."""
        if not content:
            return None

        marker = re.search(r"\[?\s*NEED_CONTEXT\s*\]?", content, re.IGNORECASE)
        if not marker:
            return None

        json_start = content.find("{", marker.end())
        if json_start < 0:
            return None

        decoder = json.JSONDecoder()
        try:
            parsed, _ = decoder.raw_decode(content[json_start:])
        except json.JSONDecodeError:
            return None

        if not isinstance(parsed, dict):
            return None

        question = parsed.get("question")
        if not isinstance(question, str) or not question.strip():
            return None

        options = parsed.get("options", [])
        if not isinstance(options, list):
            options = []
        options = [str(opt) for opt in options if str(opt).strip()]

        context = parsed.get("context", "")
        if context is None:
            context = ""
        return {
            "question": question.strip(),
            "options": options,
            "context": str(context).strip(),
        }

    def _extract_patch_suggestions(
        self,
        content: str,
    ) -> Tuple[List[PatchSuggestion], str]:
        """Parse PATCH_SUGGESTION blocks and return suggestions + cleaned content."""
        suggestions: List[PatchSuggestion] = []
        if not content:
            return suggestions, content

        for match in PATCH_SUGGESTION_BLOCK.finditer(content):
            raw = match.group(1).strip()
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue

            parsed_items = parsed if isinstance(parsed, list) else [parsed]
            for item in parsed_items:
                if not isinstance(item, dict):
                    continue
                patch_type = str(item.get("type", "")).strip().lower()
                if patch_type not in ("insert", "replace", "remove"):
                    continue
                suggestion = PatchSuggestion(
                    patch_type=patch_type,
                    objective=item.get("objective"),
                    tool_hint=item.get("tool_hint"),
                    target_step=item.get("target_step"),
                    insert_after=item.get("after_step"),
                    phase=item.get("phase"),
                    depends_on=item.get("depends_on") or [],
                    required=bool(item.get("required", False)),
                    rationale=str(item.get("rationale") or item.get("reason") or ""),
                )
                suggestions.append(suggestion)

        cleaned = PATCH_SUGGESTION_BLOCK.sub("", content).strip()
        return suggestions, cleaned

    def _strip_action_marker(self, content: str) -> str:
        """Remove action markers from content."""
        import re
        # Remove [MARKER] style
        content = re.sub(r'\[(?:FINAL|NEED_CONTEXT|CONTINUE)\]', '', content, flags=re.IGNORECASE)
        # Remove ACTION: MARKER style
        content = re.sub(r'ACTION:\s*(?:FINAL|NEED_CONTEXT|CONTINUE)', '', content, flags=re.IGNORECASE)
        return content.strip()

    def _check_bounds(
        self,
        outcome: WorkerOutcome,
        work_item: WorkItem,
        start_time: float,
        iteration: int,
    ) -> Optional[str]:
        """
        Check all resource bounds. Returns termination reason if exceeded.
        """
        # Check tool call limit
        if work_item.bounds.max_tool_calls > 0 and outcome.metrics.tool_calls_made >= work_item.bounds.max_tool_calls:
            return "max_tool_calls"

        # Check LLM call limit
        if outcome.metrics.llm_calls_made >= work_item.bounds.max_llm_calls:
            return "max_llm_calls"

        # Check duration limit
        elapsed_ms = (time.time() - start_time) * 1000
        if elapsed_ms >= work_item.bounds.max_duration_ms:
            return "timeout"

        # Check iteration limit (defense against infinite loops)
        if iteration >= self.config.max_iterations:
            return "max_iterations"

        return None

    def _has_tool_calls(self, response: Any) -> bool:
        """Check if LLM response contains tool calls."""
        if hasattr(response, "has_tool_calls"):
            return response.has_tool_calls
        if hasattr(response, "tool_calls"):
            return bool(response.tool_calls)
        return False

    def _extract_content(self, response: Any) -> Optional[str]:
        """Extract text content from LLM response."""
        if hasattr(response, "content"):
            return response.content
        if isinstance(response, dict):
            return response.get("content")
        return str(response) if response else None

    def _parse_tool_arguments(self, raw_args: Any) -> Dict[str, Any]:
        """
        Robustly parse tool arguments.

        Some LLM APIs return arguments as:
        - Dict[str, Any] (already parsed)
        - str (JSON string that needs parsing)
        - None (no arguments)

        This handles all cases safely.
        """
        if raw_args is None:
            return {}

        if isinstance(raw_args, dict):
            return raw_args

        if isinstance(raw_args, str):
            if not raw_args.strip():
                return {}
            try:
                parsed = json.loads(raw_args)
                if isinstance(parsed, dict):
                    return parsed
                # If parsed to non-dict, wrap it
                return {"value": parsed}
            except json.JSONDecodeError:
                # If it's not valid JSON, treat as a single string argument
                return {"raw": raw_args}

        # Unknown type - try to convert
        return {"value": raw_args}

    def _determine_success(
        self, outcome: WorkerOutcome, final_content: Optional[str], work_item: WorkItem
    ) -> None:
        """
        Determine success based on hard errors and evidence.

        Simplified logic:
        - REFUSAL: If LLM says "I can't do this" → FAILED, is_refusal=True
        - FAILED: explicit error, hard termination, or no output/evidence
        - SUCCESS: otherwise

        The Wizard uses outcome.made_progress (property) for nuanced retry decisions.
        """
        outcome.final_response = final_content

        # CRITICAL: Check for refusal FIRST - refusals are NEVER success
        if final_content and _is_refusal_response(final_content):
            outcome.is_refusal = True
            outcome.success = False
            outcome.termination_reason = "refusal"
            outcome.error = "LLM refused to attempt work - task may need decomposition"
            self._log("warning", f"Detected refusal response: {final_content[:100]}...")
            return

        # Collect evidence
        has_evidence = len(outcome.entity_refs) > 0 or len(outcome.facts) > 0
        has_output = bool(final_content and final_content.strip())

        failure_reasons = {
            "max_tool_calls",
            "max_llm_calls",
            "timeout",
            "max_iterations",
            "llm_error",
            "need_context_no_prompt",
            "no_action",
            "max_continues",
        }

        if outcome.termination_reason in failure_reasons and not outcome.error:
            outcome.error = f"Termination reason: {outcome.termination_reason}"

        if not outcome.error:
            if outcome.metrics.tool_calls_failed > 0 and outcome.metrics.tool_calls_succeeded == 0:
                if outcome.tool_errors:
                    detail = outcome.tool_errors[0][:200]
                    outcome.error = (
                        f"All {outcome.metrics.tool_calls_failed} tool calls failed. "
                        f"First error: {detail}"
                    )
                else:
                    outcome.error = f"All {outcome.metrics.tool_calls_failed} tool calls failed"
            elif outcome.metrics.tool_calls_made == 0 and not has_output and not has_evidence:
                outcome.error = "No tools called and no substantive response"

        if outcome.error:
            outcome.success = False
            return

        if not has_output and not has_evidence:
            outcome.success = False
            outcome.error = "No output or evidence produced"
            return

        outcome.success = True
