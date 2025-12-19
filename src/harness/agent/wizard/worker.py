"""
Stateless Worker that executes bounded work items.
Workers NEVER mutate global state - all results go through WorkerOutcome.
"""

import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Protocol

from .types import StepStatus


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


class SuccessLevel(Enum):
    """
    Three-level success classification.

    COMPLETED/FAILED is too binary. This allows Wizard to make nuanced decisions:
    - SUCCESS: Objective verifiably achieved with evidence
    - PARTIAL: Some progress made (tools succeeded, facts discovered) but objective not confirmed
    - FAILED: No progress, all tools failed, or explicit failure
    """

    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"


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

from .context_pack import ContextPack
from .work_item import WorkItem


@dataclass
class ToolCallRecord:
    """Record of a single tool call and its result."""

    call_id: str
    tool_name: str
    arguments: Dict[str, Any]
    result: Optional[ToolResult] = None
    success: bool = False
    error: Optional[str] = None


@dataclass
class VerificationResult:
    """
    Result of verifying work completion against success criteria.

    Captures what was checked, what passed, and what failed.
    This is crucial for debugging why the Wizard marks steps as failed.
    """

    passed: bool
    criteria_checked: List[str] = field(default_factory=list)
    criteria_passed: List[str] = field(default_factory=list)
    criteria_failed: List[str] = field(default_factory=list)
    evidence_found: List[str] = field(default_factory=list)
    verification_method: str = ""  # "explicit_criteria", "evidence_heuristic", "none"
    notes: str = ""


@dataclass
class WorkerOutcome:
    """
    Result returned by Worker.
    CRITICAL: Workers NEVER mutate global state.
    All observations go into WorkerOutcome for Wizard to ingest.
    """

    work_id: str
    worker_id: str
    step_num: int

    # Completion status (binary for backward compat, but use success_level for nuance)
    success: bool
    status: StepStatus

    # Three-level success classification for nuanced Wizard decisions
    success_level: SuccessLevel = SuccessLevel.FAILED

    # Completion claim and evidence (the core verification contract)
    completion_claim: bool = False  # Worker claims objective is complete
    completion_evidence: List[str] = field(default_factory=list)  # Evidence IDs/refs supporting claim
    verification_notes: str = ""  # Human-readable explanation of verification

    # Content
    final_response: Optional[str] = None
    error: Optional[str] = None

    # Observations for ingestion
    observations: List[str] = field(default_factory=list)
    reasoning_trace_summary: str = ""

    # Entity references discovered
    entity_refs: List[str] = field(default_factory=list)

    # Suggested knowledge (not applied directly!)
    suggested_facts: List[Dict[str, Any]] = field(default_factory=list)
    suggested_evidence: List[Dict[str, Any]] = field(default_factory=list)

    # Plan modification hints (NOT patches - just hints for Wizard)
    patch_hints: List[Dict[str, Any]] = field(default_factory=list)

    # Progress indicator (separate from success)
    # True if tools succeeded or facts discovered, even if objective not satisfied
    made_progress: bool = False
    tool_results: Dict[str, Any] = field(default_factory=dict)
    # Metrics
    tool_calls_made: int = 0
    tool_calls_succeeded: int = 0
    tool_calls_failed: int = 0
    llm_calls_made: int = 0
    duration_ms: float = 0

    # Termination reason
    termination_reason: str = ""

    # Verification result (detailed breakdown for debugging)
    verification_result: Optional[VerificationResult] = None


@dataclass
class WorkerConfig:
    """Worker configuration."""

    max_iterations: int = 10
    enable_adaptive_reasoning: bool = True

    # If False (default), only explicit [FINAL] markers count as completion claims
    # If True, substantive responses without tools also count as implicit finals
    allow_implicit_finals: bool = False


class Worker:
    """
    Stateless inner-loop executor.

    CRITICAL INVARIANTS:
    - Worker NEVER mutates PlanState, Ledger, or Stores
    - All observations are returned in WorkerOutcome
    - Worker receives ContextPack + WorkItem, returns WorkerOutcome
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
        try:
            from context_scout import ContextScout
            self.scout = ContextScout(self.tool_registry)
        except Exception:
            self.scout = None  # Scout is optional

    def _log(self, level: str, msg: str, **kwargs) -> None:
        """Log with optional logger. Silently no-ops if logger is None."""
        if self.logger is None:
            return
        log_fn = getattr(self.logger, level, None)
        if log_fn:
            log_fn(msg, component="worker", **kwargs)

    def execute(self, context_pack: ContextPack, work_item: WorkItem) -> WorkerOutcome:
        """
        Execute work item within bounds.

        CRITICAL: Worker NEVER mutates context_pack or global state.
        All observations go into WorkerOutcome.

        Bounds enforced:
        - max_tool_calls: Maximum number of tool invocations
        - max_llm_calls: Maximum number of LLM requests
        - max_duration_ms: Maximum wall-clock time
        - max_iterations: Maximum loop iterations (from config)
        """
        start_time = time.time()
        self._log("debug", f"Worker executing: step={work_item.step_num}, objective='{work_item.objective[:60]}'")

        outcome = WorkerOutcome(
            work_id=work_item.work_id,
            worker_id=context_pack.worker_id,
            step_num=work_item.step_num,
            success=False,
            status=StepStatus.IN_PROGRESS,
        )

        try:
            self._execute_loop(context_pack, work_item, outcome, start_time)
        except Exception as exc:
            self._log("error", f"Worker exception: {type(exc).__name__}: {str(exc)[:100]}")
            outcome.success = False
            outcome.status = StepStatus.FAILED
            outcome.error = str(exc)
            outcome.termination_reason = f"exception: {type(exc).__name__}"

        outcome.duration_ms = (time.time() - start_time) * 1000
        return outcome

    def _execute_loop(
        self,
        context_pack: ContextPack,
        work_item: WorkItem,
        outcome: WorkerOutcome,
        start_time: float,
    ) -> None:
        """
        Main execution loop with explicit action markers.

        CRITICAL: We don't auto-terminate on "no tool calls".
        The LLM must explicitly indicate its intent via action markers.

        Action types:
        - TOOL: Execute tool calls
        - FINAL: Done, this is the final answer
        - NEED_CONTEXT: Need more info (will request tools next iteration)
        - CONTINUE: Internal reasoning, continue loop
        """
        llm_context = context_pack.to_llm_context()

        # Build initial message history
        messages: List[Dict[str, Any]] = self._build_initial_messages(
            llm_context, work_item
        )

        # ========== AUTO-READ TARGET FILES ==========
        # If target_paths specified, read them automatically so model has context
        if work_item.target_paths:
            self._log("debug", f"Auto-reading {len(work_item.target_paths)} target files")
            file_contents = []

            for path in work_item.target_paths:
                try:
                    result = self.tool_registry.execute("file_read", path=path)
                    outcome.tool_calls_made += 1

                    if result.is_success and result.output:
                        content = str(result.output)
                        # Truncate very large files but keep enough for context
                        if len(content) > 10000:
                            content = content[:10000] + f"\n... [truncated, {len(result.output)} total chars]"
                        file_contents.append(f"### {path}\n```\n{content}\n```")
                        outcome.tool_calls_succeeded += 1
                        outcome.entity_refs.append(path)
                        self._log("debug", f"  ✓ Read {path} ({len(result.output)} chars)")
                    else:
                        file_contents.append(f"### {path}\n[ERROR: Could not read - {result.error}]")
                        outcome.tool_calls_failed += 1
                        self._log("warning", f"  ✗ Failed to read {path}: {result.error}")
                except Exception as e:
                    file_contents.append(f"### {path}\n[ERROR: {str(e)[:100]}]")
                    outcome.tool_calls_failed += 1
                    self._log("error", f"  ✗ Exception reading {path}: {e}")

            # Inject file contents as authoritative context
            if file_contents:
                messages.append({
                    "role": "user",
                    "content": (
                        "═══════════════════════════════════════════════════════════════\n"
                        "TARGET FILES (pre-loaded, authoritative - do NOT re-read or search):\n"
                        "═══════════════════════════════════════════════════════════════\n\n" +
                        "\n\n".join(file_contents) +
                        "\n\n═══════════════════════════════════════════════════════════════\n"
                        "You have the file content above. Use it directly. DO NOT call file_read on these paths.\n"
                        "═══════════════════════════════════════════════════════════════"
                    )
                })


        iteration = 0
        final_content: Optional[str] = None
        consecutive_no_action = 0  # Prevent infinite loops without explicit action

        # ========== DELTA REASONING ENFORCEMENT ==========
        # Track tool call signatures (name + args hash) to detect non-improving repeats
        # Key: signature, Value: (result_hash, iteration)
        tool_call_history: Dict[str, tuple] = {}

        # Track delta violations - hard terminate after 2
        delta_violations = 0
        MAX_DELTA_VIOLATIONS = 2

        # Track search→read sequence enforcement
        pending_file_read = False  # True if search_filesystem was called but file_read hasn't been
        search_tools = {"search_filesystem", "search", "find_files", "grep", "glob"}
        read_tools = {"file_read", "read_file", "read", "cat"}

        # Track recent tool names for simple loop detection
        recent_tool_calls: List[str] = []
        MAX_REPEATED_TOOL_CALLS = 2

        while True:
            # Check all bounds before proceeding
            termination = self._check_bounds(
                outcome, work_item, start_time, iteration
            )
            if termination:
                outcome.termination_reason = termination
                break

            iteration += 1

            # Call LLM with accumulated message history
            response = self._call_llm(messages, work_item, outcome)
            outcome.llm_calls_made += 1

            if not response:
                outcome.termination_reason = "llm_error"
                if not outcome.error:
                    outcome.error = "LLM returned no response"
                break

            # Check if LLM wants to call tools (highest priority action)
            if self._has_tool_calls(response):
                consecutive_no_action = 0

                # Process tool calls and accumulate results
                tool_records = self._process_tool_calls(response, outcome, work_item)

                # Feed tool results back to LLM via message history
                self._append_tool_messages(messages, response, tool_records)

                # Record observations
                for record in tool_records:
                    status_str = "success" if record.success else "failed"
                    outcome.observations.append(
                        f"Tool {record.tool_name}: {status_str}"
                    )
                    outcome.tool_results[record.tool_name]=status_str
                # Force the model to digest tool outputs and decide next step (no tools allowed).
                messages.append({
                    "role": "user",
                    "content": (
                        "SYNTHESIS REQUIRED: Read the tool outputs above and do ONE of:\n"
                        "1) Explain findings + next action.\n"
                        "2) If objective is satisfied, output [FINAL] with a concise explanation.\n"
                        "Do NOT call tools in this synthesis step."
                    )
                })

                synth = self._call_llm_no_tools(messages, work_item, outcome)
                outcome.llm_calls_made += 1

                content = self._extract_content(synth) if synth else None
                self._log("debug", content or "")
                if content:
                    messages.append({"role": "assistant", "content": content})

                # If it finalized, stop.
                action = self._extract_action(content)
                if action == WorkerAction.FINAL:
                    final_content = self._strip_action_marker(content)
                    outcome.termination_reason = "completed"
                    break
        
                elif action == WorkerAction.NEED_CONTEXT:
                    # LLM says it needs more context but didn't call tools
                    # Give it one more chance, then fail
                    consecutive_no_action += 1
                    if consecutive_no_action >= 3:
                        outcome.termination_reason = "need_context_no_tools"
                        outcome.error = "LLM requested context but didn't call tools"
                        break
                    # Add the response to history and continue
                    messages.append({"role": "assistant", "content": content})
                    continue

                elif action == WorkerAction.CONTINUE:
                    # LLM wants to continue reasoning
                    consecutive_no_action += 1
                    if consecutive_no_action >= 3:
                        # Too many continues without action - force termination
                        outcome.termination_reason = "max_continues"
                        outcome.error = "LLM continued reasoning without taking action"
                        break
                    messages.append({"role": "assistant", "content": content})
                    continue

                else:
                    # No explicit action marker - use heuristics
                    # IMPORTANT: This is the fallback for LLMs that don't use markers
                    if content and len(content) > 50:
                        # Substantive response without tools - treat as final
                        final_content = content
                        outcome.termination_reason = "implicit_final"
                        break
                    else:
                        # Short/empty response without tools - probably incomplete
                        consecutive_no_action += 1
                        if consecutive_no_action >= 2:
                            outcome.termination_reason = "no_action"
                            outcome.error = "LLM returned content without action or tools"
                            break
                        messages.append({"role": "assistant", "content": content or ""})
                        continue

                # # ========== DELTA REASONING ENFORCEMENT ==========
                # # Check each tool call for non-improving repeats and search→read sequence
                # for record in tool_records:
                #     tool_lower = record.tool_name.lower()

                #     # ===== SEARCH→READ SEQUENCE ENFORCEMENT =====
                #     if tool_lower in search_tools or any(s in tool_lower for s in search_tools):
                #         if pending_file_read:
                #             # VIOLATION: Called search again without reading results
                #             self._log("error", f"SEQUENCE VIOLATION: Called '{record.tool_name}' but file_read is pending")
                #             delta_violations += 1
                #             outcome.observations.append(f"SEQUENCE_VIOLATION: search called without file_read")

                #             violation_msg = (
                #                 f"\n\n🚫 SEQUENCE VIOLATION: You called '{record.tool_name}' but you haven't read any "
                #                 f"files yet from your previous search. You MUST call file_read on a specific path "
                #                 f"from your search results BEFORE searching again.\n\n"
                #                 f"Your next action MUST be: file_read(path=<a specific path from search results>)"
                #             )
                #             messages.append({"role": "user", "content": violation_msg})
                #         else:
                #             # Mark that file_read is now required
                #             pending_file_read = True
                #             self._log("debug", f"Search tool called, file_read now pending")

                #     elif tool_lower in read_tools or any(r in tool_lower for r in read_tools):
                #         # File read called - clear the pending flag
                #         pending_file_read = False
                #         self._log("debug", f"File read called, clearing pending flag")

                #     # ===== SIGNATURE-BASED DELTA ENFORCEMENT =====
                #     signature = self._compute_tool_signature(record.tool_name, record.arguments)
                #     result_hash = self._compute_result_hash(record.result)

                #     if signature in tool_call_history:
                #         prev_result_hash, prev_iteration = tool_call_history[signature]

                #         # Same tool+args called again - check if result changed
                #         if result_hash == prev_result_hash:
                #             # VIOLATION: Repeated call with no new evidence
                #             delta_violations += 1
                #             self._log("error", f"DELTA VIOLATION #{delta_violations}: Tool '{record.tool_name}' same args, same result")
                #             self._log("error", f"  Previous call: iteration {prev_iteration}")

                #             outcome.observations.append(f"DELTA_VIOLATION: {record.tool_name} repeated without new info")

                #             if delta_violations >= MAX_DELTA_VIOLATIONS:
                #                 # HARD TERMINATION after too many violations
                #                 outcome.termination_reason = f"max_delta_violations:{record.tool_name}"
                #                 outcome.error = (
                #                     f"TERMINATED: {delta_violations} delta violations. Model is stuck repeating "
                #                     f"'{record.tool_name}' without making progress. Unable to pivot."
                #                 )
                #                 self._log("error", f"HARD TERMINATION: {delta_violations} delta violations")
                #                 break
                #             else:
                #                 # Inject pivot instruction
                #                 pivot_msg = (
                #                     f"\n\n⚠️ DELTA VIOLATION #{delta_violations}/{MAX_DELTA_VIOLATIONS}: "
                #                     f"You called '{record.tool_name}' with the same arguments and got the same result.\n\n"
                #                     f"MANDATORY PIVOT - You MUST now do ONE of:\n"
                #                     f"1. file_read(path=<specific path>) - read actual file content\n"
                #                     f"2. A COMPLETELY different tool with different purpose\n"
                #                     f"3. [NEED_CONTEXT] with specific missing info\n\n"
                #                     f"⚠️ ONE MORE VIOLATION = TERMINATION"
                #                 )
                #                 messages.append({"role": "user", "content": pivot_msg})
                #         else:
                #             # Same args but different result - that's fine, update history
                #             tool_call_history[signature] = (result_hash, iteration)
                #             self._log("debug", f"Tool '{record.tool_name}' same args but NEW result (delta detected)")
                #     else:
                #         # New tool call signature - record it
                #         tool_call_history[signature] = (result_hash, iteration)

                #     recent_tool_calls.append(record.tool_name)

                # # Check if we should break due to delta violations
                # if delta_violations >= MAX_DELTA_VIOLATIONS:
                #     break

                # # Keep only last N calls for simple loop detection
                # if len(recent_tool_calls) > MAX_REPEATED_TOOL_CALLS * 2:
                #     recent_tool_calls = recent_tool_calls[-MAX_REPEATED_TOOL_CALLS * 2:]

                # # Check if same tool called repeatedly (simple name-based detection)
                # if len(recent_tool_calls) >= MAX_REPEATED_TOOL_CALLS:
                #     last_n = recent_tool_calls[-MAX_REPEATED_TOOL_CALLS:]
                #     if len(set(last_n)) == 1:
                #         stuck_tool = last_n[0]
                #         self._log("warning", f"LOOP DETECTED: Tool '{stuck_tool}' called {MAX_REPEATED_TOOL_CALLS} times in a row")
                #         outcome.termination_reason = f"tool_loop:{stuck_tool}"
                #         outcome.error = (
                #             f"Model stuck calling '{stuck_tool}' repeatedly. "
                #             f"You must PIVOT: use file_read after search, or use [NEED_CONTEXT]."
                #         )
                #         break

                # continue
            # No tool calls - check for explicit action marker in content
           # content = self._extract_content(response)
        #    action = self._extract_action(content)

            
        # Determine success based on verifiable criteria
        self._determine_success(outcome, final_content, work_item)

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

    def _strip_action_marker(self, content: str) -> str:
        """Remove action markers from content."""
        import re
        # Remove [MARKER] style
        content = re.sub(r'\[(?:FINAL|NEED_CONTEXT|CONTINUE)\]', '', content, flags=re.IGNORECASE)
        # Remove ACTION: MARKER style
        content = re.sub(r'ACTION:\s*(?:FINAL|NEED_CONTEXT|CONTINUE)', '', content, flags=re.IGNORECASE)
        return content.strip()

    def _build_initial_messages(
        self, llm_context: Dict[str, Any], work_item: WorkItem
    ) -> List[Dict[str, Any]]:
        """Build initial message history for LLM."""
        messages: List[Dict[str, Any]] = []

        # System message with instructions
        system_content = llm_context.get("instructions", "")

        # Add action marker instructions with EXPLICIT PIVOT RULES
        action_instructions = """

═══════════════════════════════════════════════════════════════════════════════
                    PROGRESS & PIVOT RULES (MANDATORY)
═══════════════════════════════════════════════════════════════════════════════

A tool call ONLY counts as progress if it changes your next action.

After EVERY tool call, you must internally decide ONE of:
  • "This result enables a NEW concrete action" → state it, then do it
  • "This result shows the approach is WRONG" → PIVOT immediately
  • "This result is INSUFFICIENT" → request a DIFFERENT tool

═══════════════════════════════════════════════════════════════════════════════
                         FORBIDDEN BEHAVIOR
═══════════════════════════════════════════════════════════════════════════════

🚫 Calling the same tool with the same arguments after it already returned results
🚫 Repeating a tool call that did not enable a new step
🚫 Calling search_filesystem multiple times without calling file_read in between
🚫 "Exploring" or "investigating" without a concrete next action

If a tool returns information you ALREADY HAD, you MUST pivot.
If you cannot pivot, use [NEED_CONTEXT] and explicitly state:
  - What SPECIFIC information is missing
  - Which DIFFERENT tool will be called next and WHY

═══════════════════════════════════════════════════════════════════════════════
                    FILE ACCESS RULES (CRITICAL)
═══════════════════════════════════════════════════════════════════════════════

To READ code, you MUST call file_read with an EXPLICIT path.
  • search_filesystem only LOCATES candidates (gives paths, not content)
  • After search_filesystem, your NEXT action MUST be file_read OR a pivot

CORRECT SEQUENCE:
  1. search_filesystem → get list of paths
  2. file_read(path=<specific path from step 1>) → get actual content
  3. Now you can reason about the code

WRONG (WILL LOOP):
  1. search_filesystem → get list of paths
  2. search_filesystem again with different query → FORBIDDEN
  3. search_filesystem again... → INFINITE LOOP

═══════════════════════════════════════════════════════════════════════════════
                         DELTA REQUIREMENT
═══════════════════════════════════════════════════════════════════════════════

Before EVERY tool call, you must state in one line:
  Tool Intent: <what NEW information this will provide>
  Delta: <how this will change my next action>

If you cannot state a clear delta, DO NOT make the tool call.

═══════════════════════════════════════════════════════════════════════════════
                      ACTION MARKERS (REQUIRED)
═══════════════════════════════════════════════════════════════════════════════

When NOT calling tools, you MUST use one of:

[FINAL]
  • You have completed the objective
  • You MUST cite concrete evidence (file paths read, outputs received, artifacts created)
  • If you cannot cite evidence, do NOT use [FINAL]

[NEED_CONTEXT]
  • You need information you cannot obtain with available tools
  • You MUST specify: what is missing AND which different tool you will try next
  • This is NOT an excuse to stall - it requires a pivot plan

[CONTINUE]
  • RARE - only for complex multi-step reasoning
  • You MUST specify the IMMEDIATE next action
  • If used more than once, you will be terminated

═══════════════════════════════════════════════════════════════════════════════
                       VALID RESPONSE TYPES
═══════════════════════════════════════════════════════════════════════════════

1. TOOL CALL - Preferred when it will produce NEW information
2. [FINAL] + evidence - When objective is verifiably complete
3. [NEED_CONTEXT] + pivot plan - When stuck but have a different approach
4. [CONTINUE] + next action - RARE, for complex reasoning chains

═══════════════════════════════════════════════════════════════════════════════
                         OUTPUT QUALITY
═══════════════════════════════════════════════════════════════════════════════

• Be TERSE. No narration. State decision → act.
• If uncertain, make the smallest tool call to reduce uncertainty.
• If stuck, PIVOT immediately. Do not repeat failing approaches.
"""

        system_content += action_instructions

        if llm_context.get("known_facts"):
            system_content += f"\n\nKNOWN FACTS:\n{llm_context['known_facts']}"
        if llm_context.get("work_summary"):
            system_content += f"\n\nRECENT WORK:\n{llm_context['work_summary']}"

        messages.append({"role": "system", "content": system_content})

        # User message with objective
        messages.append(
            {"role": "user", "content": llm_context.get("objective", work_item.objective)}
        )

        return messages

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
        if outcome.tool_calls_made >= work_item.bounds.max_tool_calls:
            return "max_tool_calls"

        # Check LLM call limit
        if outcome.llm_calls_made >= work_item.bounds.max_llm_calls:
            return "max_llm_calls"

        # Check duration limit
        elapsed_ms = (time.time() - start_time) * 1000
        if elapsed_ms >= work_item.bounds.max_duration_ms:
            return "timeout"

        # Check iteration limit (defense against infinite loops)
        if iteration >= self.config.max_iterations:
            return "max_iterations"

        return None
    
    def _call_llm_no_tools(
        self, messages: List[Dict[str, Any]], work_item: WorkItem, outcome: WorkerOutcome
    ) -> Optional[Any]:
        """
        Force a synthesis step (no tool calls allowed) so the model must read tool outputs
        and produce a decision / explanation.
        """
        try:
            if hasattr(self.llm, "respond_with_messages"):
                # Pass tools=[] so the model can't tool-call.
                return self.llm.respond_with_messages(messages=messages, tools=[])
            if hasattr(self.llm, "respond"):
                # Same idea: omit tools entirely
                tail = messages[-10:]
                packed = "\n".join(
                    f"{m.get('role','?').upper()}: {m.get('content','')}"
                    for m in tail
                    if m.get("content")
                )
                system_msg = next((m["content"] for m in messages if m["role"] == "system"), "")
                return self.llm.respond(input=packed, instructions=system_msg, tools=[])
            return None
        except Exception as exc:
            error_msg = f"LLM(no-tools) failed: {type(exc).__name__}: {str(exc)[:200]}"
            outcome.observations.append(error_msg)
            outcome.error = error_msg
            self._log("error", error_msg)
            return None


    def _call_llm(self, messages: List[Dict[str, Any]], work_item: WorkItem, outcome: WorkerOutcome) -> Optional[Any]:
        """
        Call LLM with FULL message history so it can reason over tool outputs.
        """
        try:
            tools = self.tool_registry.get_definitions(enabled_only=True)

            # Preferred: message-based API (keeps full context window)
            if hasattr(self.llm, "respond_with_messages"):
                return self.llm.respond_with_messages(messages=messages, tools=tools)

            # Fallback: if only respond() exists, at least pack history into input.
            if hasattr(self.llm, "respond"):
                # Keep this simple but NOT brain-dead: include recent tool outputs too.
                # (Last ~8 messages is usually enough.)
                tail = messages[-8:]
                packed = "\n".join(
                    f"{m.get('role','?').upper()}: {m.get('content','')}"
                    for m in tail
                    if m.get("content")
                )

                system_msg = next((m["content"] for m in messages if m["role"] == "system"), "")
                return self.llm.respond(input=packed, instructions=system_msg, tools=tools)

            outcome.observations.append("LLM adapter missing respond methods")
            outcome.error = "LLM adapter missing respond methods"
            return None

        except Exception as exc:
            error_msg = f"LLM call failed: {type(exc).__name__}: {str(exc)[:200]}"
            outcome.observations.append(error_msg)
            outcome.error = error_msg
            self._log("error", error_msg)
            return None

    # def _cll_llm(
    #     self, messages: List[Dict[str, Any]], work_item: WorkItem, outcome: WorkerOutcome
    # ) -> Optional[Any]:
    #     """
    #     Call LLM with message history.
    #     Records errors in outcome for debugging instead of silently swallowing.
    #     FULL LOGGING of prompts and responses for debugging.
    #     """
    #     # ========== FULL LOGGING: LOG MESSAGES SENT ==========
    #     self._log("debug", f"LLM call starting for step {work_item.step_num}")
    #     self._log("debug", f"=== LLM REQUEST ({len(messages)} messages) ===")
    #     for i, msg in enumerate(messages):
    #         role = msg.get("role", "unknown")
    #         content = msg.get("content", "")
    #         tool_calls = msg.get("tool_calls", [])
    #         # Log full content for debugging
    #         content_preview = content[:500] if content else "(empty)"
    #         self._log("debug", f"  [{i}] {role.upper()}: {content_preview}")
    #         if tool_calls:
    #             self._log("debug", f"      tool_calls: {len(tool_calls)} calls")
    #             for tc in tool_calls:
    #                 tc_name = tc.get("function", {}).get("name", "unknown") if isinstance(tc, dict) else "unknown"
    #                 self._log("debug", f"        - {tc_name}")

    #     try:
    #         response = None
    #         # # Try message-based API first (preferred)
    #         # if hasattr(self.llm, "respond_with_messages"):
    #         #     # response = self.llm.respond_with_messages(
    #         #     #     messages=messages,
    #         #     #     tools=self.tool_registry.get_definitions(enabled_only=True),
    #         #     # )
    #         #     i = 0
    #         # # Fall back to simple respond API
    #         # elif hasattr(self.llm, "respond"):
    #         #     # Extract last user message for simple API
    #         user_msg = next(
    #             (m["content"] for m in reversed(messages) if m["role"] == "user"),
    #             work_item.objective,
    #         )
    #         system_msg = next(
    #             (m["content"] for m in messages if m["role"] == "system"), ""
    #         )
    #         response = self.llm.respond(
    #             input=user_msg,
    #             instructions=system_msg,
    #             tools=self.tool_registry.get_definitions(enabled_only=True),
    #             )
    #      ##   else:
    #         # outcome.observations.append("LLM adapter missing respond methods")
    #         # self._log("error", "LLM adapter missing respond methods")
    #         # return None

    #         # ========== FULL LOGGING: LOG RESPONSE RECEIVED ==========
    #         if response:
    #             response_content = getattr(response, "content", None) or ""
    #             response_tool_calls = getattr(response, "tool_calls", []) or []
    #             has_tools = len(response_tool_calls) > 0

    #             self._log("debug", f"=== LLM RESPONSE ===")
    #             self._log("debug", f"  content ({len(response_content)} chars): {response_content[:500] if response_content else '(empty)'}")
    #             self._log("debug", f"  has_tool_calls: {has_tools}")
    #             if has_tools:
    #                 for tc in response_tool_calls:
    #                     tc_name = getattr(tc, "name", "unknown")
    #                     tc_args = getattr(tc, "arguments", {})
    #                     self._log("debug", f"    TOOL CALL: {tc_name}")
    #                     self._log("debug", f"      args: {tc_args}")

    #         return response

    #     except Exception as exc:
    #         # Record the error for debugging instead of silently swallowing
    #         error_msg = f"LLM call failed: {type(exc).__name__}: {str(exc)[:200]}"
    #         outcome.observations.append(error_msg)
    #         outcome.error = error_msg
    #         self._log("error", error_msg)
    #         return None

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

    def _compute_tool_signature(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """
        Compute a stable signature for a tool call (name + args).
        Used to detect repeated calls with same arguments.
        """
        import hashlib
        # Sort args for stable ordering
        sorted_args = json.dumps(arguments, sort_keys=True, default=str)
        sig_str = f"{tool_name}:{sorted_args}"
        return hashlib.md5(sig_str.encode()).hexdigest()

    def _compute_result_hash(self, result: Optional[ToolResult]) -> str:
        """
        Compute a hash of tool result to detect if repeated call gave same result.
        """
        import hashlib
        if result is None:
            return "none"
        # Hash the output content
        output_str = str(result.output) if result.output else ""
        error_str = str(result.error) if result.error else ""
        combined = f"{result.is_success}:{output_str[:1000]}:{error_str}"
        return hashlib.md5(combined.encode()).hexdigest()

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

    def _process_tool_calls(
        self, response: Any, outcome: WorkerOutcome, work_item: WorkItem
    ) -> List[ToolCallRecord]:
        """Execute tool calls and return records. FULL LOGGING for debugging."""
        records: List[ToolCallRecord] = []

        tool_calls = getattr(response, "tool_calls", []) or []

        self._log("debug", f"=== PROCESSING {len(tool_calls)} TOOL CALLS ===")

        for tool_call in tool_calls:
            # Check if we've hit tool limit mid-batch
            if outcome.tool_calls_made >= work_item.bounds.max_tool_calls:
                self._log("warning", f"Hit tool call limit ({work_item.bounds.max_tool_calls}), skipping remaining")
                break

            # Robustly parse arguments (handles JSON string case)
            raw_args = getattr(tool_call, "arguments", {})
            parsed_args = self._parse_tool_arguments(raw_args)

            record = ToolCallRecord(
                call_id=getattr(tool_call, "id", str(uuid.uuid4())[:8]),
                tool_name=getattr(tool_call, "name", "unknown"),
                arguments=parsed_args,
            )

            # ========== FULL LOGGING: TOOL CALL DETAILS ==========
            self._log("debug", f"--- Executing Tool: {record.tool_name} ---")
            self._log("debug", f"  call_id: {record.call_id}")
            self._log("debug", f"  arguments: {json.dumps(parsed_args, default=str)[:500]}")

            try:
                result = self.tool_registry.execute(
                    record.tool_name, **record.arguments
                )
                record.result = result
                record.success = result.is_success

                outcome.tool_calls_made += 1
                if record.success:
                    outcome.tool_calls_succeeded += 1
                    output_preview = str(result.output)[:5000] if result.output else "(no output)"
                    self._log("debug", f"  result: SUCCESS")
                    self._log("debug", f"  output: {output_preview}")
                else:
                    outcome.tool_calls_failed += 1
                    self._log("warning", f"  result: FAILED - {result.error}")

                # Extract entity references from metadata
                if result.metadata:
                    path = result.metadata.get("path")
                    if path:
                        outcome.entity_refs.append(path)

                # Record evidence suggestion
                outcome.suggested_evidence.append(
                    {
                        "type": "tool_output",
                        "tool_name": record.tool_name,
                        "output": str(result.output)[:5000] if result.output else None,
                        "success": record.success,
                    }
                )

            except Exception as exc:
                record.success = False
                record.error = str(exc)
                outcome.tool_calls_made += 1
                outcome.tool_calls_failed += 1

            records.append(record)

        return records

    def _append_tool_messages(
        self,
        messages: List[Dict[str, Any]],
        response: Any,
        tool_records: List[ToolCallRecord],
    ) -> None:
        """
        Append assistant's tool call request and tool results to message history.
        This is critical for the LLM to see tool results on subsequent calls.
        """
        # Add assistant message with tool calls
        assistant_msg: Dict[str, Any] = {"role": "assistant"}

        # Include any text content from assistant
        if hasattr(response, "content") and response.content:
            assistant_msg["content"] = response.content

        # Include tool calls in format the LLM expects
        assistant_msg["tool_calls"] = [
            {
                "id": record.call_id,
                "type": "function",
                "function": {
                    "name": record.tool_name,
                    "arguments": record.arguments,
                },
            }
            for record in tool_records
        ]
        messages.append(assistant_msg)

        # Add tool result messages
        for record in tool_records:
            if record.result:
                content = str(record.result.output)[:5000] if record.result.output else ""
                if not record.success and record.result.error:
                    content = f"ERROR: {record.result.error}\n{content}"
            elif record.error:
                content = f"ERROR: {record.error}"
            else:
                content = "No output"

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": record.call_id,
                    "content": content,
                }
            )

    def _determine_success(
        self, outcome: WorkerOutcome, final_content: Optional[str], work_item: WorkItem
    ) -> None:
        """
        Determine success using completion_claim + evidence pattern.

        SEMANTICS:
        - success = True means "objective verifiably satisfied"
        - made_progress = True means "tools succeeded or facts discovered"
        - success_level provides 3-level granularity (SUCCESS/PARTIAL/FAILED)

        RULES:
        - SUCCESS: explicit [FINAL] + evidence → success=True, made_progress=True, status=COMPLETED
        - PARTIAL: progress made but no completion claim → success=False, made_progress=True, status=FAILED
        - FAILED: no progress → success=False, made_progress=False, status=FAILED

        completion_claim requires explicit [FINAL] marker by default.
        Set config.allow_implicit_finals=True to accept substantive responses without [FINAL].
        """
        outcome.final_response = final_content

        # Step 1: Collect completion evidence from successful tool outputs
        completion_evidence: List[str] = []

        # Entity refs are strong evidence (files touched, paths accessed)
        completion_evidence.extend(outcome.entity_refs)

        # Successful tool outputs are evidence
        for ev in outcome.suggested_evidence:
            if ev.get("success"):
                tool_name = ev.get("tool_name", "")
                evidence_id = f"{tool_name}:success"
                if evidence_id not in completion_evidence:
                    completion_evidence.append(evidence_id)

        outcome.completion_evidence = completion_evidence

        # Step 2: Determine completion_claim
        # By default, only explicit [FINAL] marker counts as a completion claim
      #  explicit_final = outcome.termination_reason == "completed"  # Had [FINAL] marker
        explicit_final = outcome.termination_reason in ("completed", "implicit_final")
        has_final_response = bool(final_content and len(final_content) > 30)

        if self.config.allow_implicit_finals:
            # Allow substantive responses without [FINAL] to count as claims
            outcome.completion_claim = explicit_final or has_final_response
        else:
            # Strict mode: only [FINAL] marker counts
            outcome.completion_claim = explicit_final

        # Step 3: Determine made_progress (separate from success)
        outcome.made_progress = (
            outcome.tool_calls_succeeded > 0 or
            len(outcome.suggested_facts) > 0 or
            len(completion_evidence) > 0
        )

        # Step 4: Apply rules to determine success_level and success
        # success = True ONLY for SUCCESS (objective verified satisfied)
        # PARTIAL/FAILED → success = False

        if outcome.completion_claim and len(completion_evidence) > 0:
            # SUCCESS: Claimed completion with evidence
            outcome.success_level = SuccessLevel.SUCCESS
            outcome.success = True
            outcome.verification_notes = f"Completion claimed with {len(completion_evidence)} evidence items"

        elif outcome.completion_claim and has_final_response and outcome.tool_calls_made == 0:
            # SUCCESS for Q&A: Substantive response without needing tools
            # This handles knowledge questions where no tool calls are required
            outcome.success_level = SuccessLevel.SUCCESS
            outcome.success = True
            outcome.made_progress = True
            outcome.verification_notes = "Substantive response provided (no tools required)"

        elif outcome.made_progress:
            # PARTIAL: Made progress but didn't claim completion (or claim without evidence)
            outcome.success_level = SuccessLevel.PARTIAL
            outcome.success = False  # Objective NOT satisfied
            notes_parts = [
                f"{outcome.tool_calls_succeeded} tools succeeded",
                f"{len(outcome.suggested_facts)} facts discovered",
            ]
            outcome.verification_notes = f"Partial progress: {', '.join(notes_parts)}"

            if outcome.completion_claim and len(completion_evidence) == 0:
                outcome.verification_notes += " (claimed completion but no evidence)"
                outcome.error = "Claimed completion but no verifiable evidence"
            elif not outcome.completion_claim:
                outcome.verification_notes += " (no explicit [FINAL] marker)"

        else:
            # FAILED: No progress
            outcome.success_level = SuccessLevel.FAILED
            outcome.success = False
            if outcome.tool_calls_failed > 0:
                outcome.verification_notes = f"All {outcome.tool_calls_failed} tool calls failed"
                outcome.error = f"All {outcome.tool_calls_failed} tool calls failed"
            elif outcome.tool_calls_made == 0 and not has_final_response:
                outcome.verification_notes = "No tools called and no substantive response"
                outcome.error = "No progress made"
            else:
                outcome.verification_notes = "Failed to complete objective"
                outcome.error = outcome.error or "Failed to complete objective"

        # Step 5: Create detailed VerificationResult for debugging
        outcome.verification_result = VerificationResult(
            passed=outcome.success,
            evidence_found=completion_evidence[:10],
            verification_method="completion_claim_evidence",
            notes=outcome.verification_notes,
            criteria_checked=["completion_claim", "completion_evidence"],
            criteria_passed=(
                ["completion_claim"] if outcome.completion_claim else []
            ) + (
                ["completion_evidence"] if len(completion_evidence) > 0 else []
            ),
            criteria_failed=(
                [] if outcome.completion_claim else ["completion_claim"]
            ) + (
                [] if len(completion_evidence) > 0 else ["completion_evidence"]
            ),
        )

        # Step 6: Map to StepStatus
        # Only SUCCESS → COMPLETED, everything else → FAILED
        if outcome.success_level == SuccessLevel.SUCCESS:
            outcome.status = StepStatus.COMPLETED
        else:
            # PARTIAL and FAILED both map to FAILED status
            # Wizard uses success_level and made_progress for nuanced decisions
            outcome.status = StepStatus.FAILED
