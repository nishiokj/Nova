"""
Wizard is the outer-loop orchestrator that owns single-writer global state.
Dispatches bounded work to Workers and coordinates plan evolution.

The Wizard does NOT create plans - it receives a WizardPlan and executes it.
Planning is the caller's responsibility.
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Protocol

from .types import (
    StepStatus,
    WizardPlan,
    WizardReflection,
)
from .plan_state import PlanState
from .work_ledger import WorkLedger
from .knowledge_store import KnowledgeStore, KnowledgeFact, FactSource
from .evidence_store import EvidenceStore, EvidenceRecord
from .context_pack import ContextPackBuilder
from .work_item import WorkItem, WorkBounds
from .worker import Worker, WorkerConfig, WorkerOutcome
from .plan_patch import PlanPatch
from .policy_gate import PolicyGate
from .stagnation import StagnationDetector, StagnationSignal

# Synthesis module for final response generation
from ..synthesis import ResponseSynthesizer, SynthesisInput


class ToolRegistry(Protocol):
    """Protocol for tool registry - allows any compatible implementation."""
    def get_tool(self, name: str) -> Any: ...
    def list_tools(self, enabled_only: bool = True) -> List[Any]: ...
    def get_definitions(self, enabled_only: bool = True) -> List[Any]: ...
    def execute(self, name: str, **kwargs) -> Any: ...


class Logger(Protocol):
    """Protocol for logger - allows any compatible implementation."""
    def info(self, msg: str, **kwargs) -> None: ...
    def debug(self, msg: str, **kwargs) -> None: ...
    def warning(self, msg: str, **kwargs) -> None: ...
    def error(self, msg: str, **kwargs) -> None: ...


@dataclass
class WizardConfig:
    """Wizard configuration."""

    max_workers: int = 1  # Parallel workers (start with 1)
    max_iterations: int = 50
    context_budget_tokens: int = 100_000
    compaction_threshold: float = 0.5  # Compact when >50% budget
    max_retries_per_step: int = 3  # Max retries before skipping a failed step
    deadlock_threshold: int = 5  # Max consecutive iterations with no ready steps


@dataclass
class WizardResult:
    """Result of Wizard orchestration."""

    success: bool  # True if goal_achieved (required steps COMPLETED)
    final_response: str
    plan_state: PlanState
    ledger: WorkLedger

    # Metrics
    total_iterations: int
    total_tool_calls: int
    total_llm_calls: int
    duration_ms: float

    # Step counts (computed from plan_state)
    steps_completed: int = 0
    steps_skipped: int = 0
    steps_failed: int = 0

    @property
    def is_terminated(self) -> bool:
        """True if all steps reached terminal state (COMPLETED or SKIPPED)."""
        return self.plan_state.is_terminated()

    @property
    def goal_achieved(self) -> bool:
        """True if goal was achieved (required steps COMPLETED)."""
        return self.plan_state.goal_achieved()

    def to_reflection(self) -> WizardReflection:
        """Create a reflection on the execution."""
        return WizardReflection(
            plan_goal=self.plan_state.goal,
            goal_achieved=self.success,
            confidence=0.8 if self.success else 0.3,
            evidence=[self.ledger.summarize_tail()],
            gaps=[],
            suggestions=[],
            summary=self.final_response[:200] if self.final_response else "",
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization or interop."""
        return {
            "content": self.final_response,
            "structured_action": self.plan_state.goal,
            "total_duration_ms": self.duration_ms,
            "success": self.success,
            "error": None if self.success else "Wizard orchestration failed",
            "goal_achieved": self.success,
            "reflection": {
                "plan_goal": self.plan_state.goal,
                "goal_achieved": self.success,
                "confidence": 0.8 if self.success else 0.3,
                "evidence": [self.ledger.summarize_tail()],
            },
            "metadata": {
                "wizard": True,
                "iterations": self.total_iterations,
                "plan_version": self.plan_state.version,
                "steps_completed": self.steps_completed,
                "steps_skipped": self.steps_skipped,
                "steps_failed": self.steps_failed,
            },
        }


class Wizard:
    """
    Outer-loop orchestrator that owns global state.

    RESPONSIBILITIES:
    1. Own single-writer state (PlanState, WorkLedger, KnowledgeStore, EvidenceStore)
    2. Build ContextPack for each iteration
    3. Select and dispatch WorkItems to Workers
    4. Ingest WorkerOutcomes into stores
    5. Apply PlanPatches via PolicyGate
    6. Detect stagnation and escalate

    NOT RESPONSIBLE FOR:
    - Creating plans (caller provides WizardPlan)
    """

    def __init__(
        self,
        tool_registry: ToolRegistry,
        llm: Any,  # LLMAdapter
        config: Optional[WizardConfig] = None,
        logger: Optional[Logger] = None,
    ):
        self.tool_registry = tool_registry
        self.llm = llm
        self.config = config or WizardConfig()
        self.logger = logger

        # Single-writer state (created per orchestration)
        self._plan_state: Optional[PlanState] = None
        self._ledger: Optional[WorkLedger] = None
        self._knowledge: Optional[KnowledgeStore] = None
        self._evidence: Optional[EvidenceStore] = None

        # Components
        self._policy_gate = PolicyGate()
        self._stagnation_detector = StagnationDetector()
        self._context_builder: Optional[ContextPackBuilder] = None

        # Worker - allow_implicit_finals=True so Q&A without tools can succeed
        worker_config = WorkerConfig(allow_implicit_finals=True)
        self._worker = Worker(tool_registry, llm, worker_config, logger=logger)

        # Synthesizer for final response generation
        self._synthesizer = ResponseSynthesizer(llm=llm)

    def _log(self, level: str, msg: str, **kwargs) -> None:
        """Log with optional logger. Silently no-ops if logger is None."""
        if self.logger is None:
            return
        log_fn = getattr(self.logger, level, None)
        if log_fn:
            log_fn(msg, component="wizard", **kwargs)

    def orchestrate(
        self,
        plan: WizardPlan,
        budget: Optional[Dict[str, int]] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
        target_paths: Optional[List[str]] = None,
    ) -> WizardResult:
        """
        Main orchestration loop.

        Args:
            plan: The WizardPlan to execute (caller creates this)
            budget: Optional budget constraints
            on_stream_chunk: Optional callback for streaming responses
            target_paths: Explicit file paths from user (e.g. @mentions) - injected into ALL steps

        Returns:
            WizardResult with execution results

        The loop:
        1. Initialize state stores from plan
        2. Loop until complete or stagnated:
           a. Handle failed steps (retry or skip)
           b. Select ready WorkItems
           c. Build ContextPacks
           d. Dispatch to Workers (with try/except/finally)
           e. Ingest outcomes
           f. Check stagnation (AFTER ingest)
           g. Apply patches (with lifecycle tracking)
        3. Return result
        """
        start_time = time.time()
        total_tool_calls = 0
        total_llm_calls = 0
        chunk_index = 0

        # Collect all outcomes for synthesis
        collected_outcomes: List[WorkerOutcome] = []

        # Initialize state stores directly from the provided plan
        self._plan_state = PlanState.from_wizard_plan(plan)
        self._ledger = WorkLedger()
        self._knowledge = KnowledgeStore()
        self._evidence = EvidenceStore()

        # ========== INJECT TARGET PATHS INTO ALL STEPS ==========
        # If target_paths provided (e.g., from @mentions), inject them into every step
        # This ensures workers have authoritative file paths without searching
        if target_paths:
            self._log("info", f"Injecting {len(target_paths)} target paths into all steps")
            for step in self._plan_state.steps.values():
                # Merge with any existing target_paths, dedup
                existing = set(step.target_paths)
                for path in target_paths:
                    if path not in existing:
                        step.target_paths.append(path)
                        existing.add(path)
            self._log("debug", f"  Target paths: {target_paths}")

        self._context_builder = ContextPackBuilder(
            plan_state=self._plan_state,
            ledger=self._ledger,
            knowledge=self._knowledge,
            evidence=self._evidence,
        )

        # Seed knowledge with goal
        self._knowledge.upsert(
            KnowledgeFact(
                key="goal",
                value=plan.goal,
                confidence=1.0,
                source=FactSource.USER,
                is_pinned=True,
            )
        )

        iteration = 0
        final_response: Optional[str] = None
        consecutive_no_ready = 0  # Deadlock detection counter

        # ========== FULL PLAN LOGGING ==========
        self._log("info", f"Wizard starting: goal='{plan.goal[:80]}', steps={len(plan.steps)}")
        self._log("debug", f"=== FULL PLAN ===")
        self._log("debug", f"  goal: {plan.goal}")
        self._log("debug", f"  goal_type: {plan.goal_type}")
        self._log("debug", f"  reasoning: {plan.reasoning[:200] if plan.reasoning else '(none)'}")
        self._log("debug", f"  requires_tools: {plan.requires_tools}")
        for step in plan.steps:
            deps = f" (depends_on: {step.depends_on})" if step.depends_on else ""
            tool = f" [tool: {step.tool_hint}]" if step.tool_hint else ""
            required = " REQUIRED" if step.required else ""
            self._log("debug", f"  Step {step.step_num}: {step.objective[:80]}{tool}{deps}{required}")

        while iteration < self.config.max_iterations:
            iteration += 1

            # Check if all steps have reached terminal state
            # if self._plan_state.is_terminated():
            #     break

            # Handle failed steps: retry or skip (uses step.attempt_count)
            self._handle_failed_steps()

            # Get ready steps (dependencies satisfied, status PENDING)
            ready_steps = self._plan_state.get_ready_steps()
            if not ready_steps:
                consecutive_no_ready += 1

                # Deadlock detection: if no ready steps for K iterations, abort
                if consecutive_no_ready >= self.config.deadlock_threshold:
                    break

                # Check if we're stuck or just waiting
                if not self._has_recoverable_steps():
                    break
                continue

            # Reset deadlock counter when we have work
            consecutive_no_ready = 0

            step = ready_steps[0]

            work_bounds = WorkBounds()
            if budget:
                work_bounds.max_tool_calls = min(
                    work_bounds.max_tool_calls, budget.get("max_tool_calls", 5)
                )

            work_item = WorkItem.from_step_state(step, bounds=work_bounds)

            worker_id = str(uuid.uuid4())[:8]
            self._plan_state.mark_step_in_progress(step.step_num, worker_id)

            entry_id = self._ledger.record_dispatch(step.step_num, work_item, worker_id)

            context_pack = self._context_builder.build(
                step,
                work_item,
                budget_tokens=self.config.context_budget_tokens,
                worker_id=worker_id,
            )

            if self._context_builder.should_compact(
                context_pack.estimated_tokens, self.config.context_budget_tokens
            ):
                self._context_builder.compact()

            # Execute worker with try/except/finally to ensure cleanup
            self._log("debug", f"Dispatching step {step.step_num}: {step.objective[:60]}")
            outcome: Optional[WorkerOutcome] = None
            try:
                outcome = self._worker.execute(context_pack, work_item)
                total_tool_calls += outcome.tool_calls_made
                total_llm_calls += outcome.llm_calls_made
            except Exception as exc:
                # Create a failed outcome for the exception
                outcome = WorkerOutcome(
                    work_id=work_item.work_id,
                    worker_id=worker_id,
                    step_num=step.step_num,
                    success=False,
                    status=StepStatus.FAILED,
                    error=f"Worker exception: {type(exc).__name__}: {str(exc)[:200]}",
                    termination_reason="exception",
                )
            finally:
                # ALWAYS record completion and clear IN_PROGRESS
                if outcome:
                    self._ingest_outcome(outcome, entry_id)
                else:
                    # Fallback: create minimal failed outcome
                    self._ledger.record_completion(entry_id, WorkerOutcome(
                        work_id=work_item.work_id,
                        worker_id=worker_id,
                        step_num=step.step_num,
                        success=False,
                        status=StepStatus.FAILED,
                        error="Worker returned no outcome",
                    ))
                    self._plan_state.clear_in_progress(step.step_num)

            # Log outcome
            if outcome:
                status_str = "success" if outcome.success else "failed"
                self._log("debug", f"Step {step.step_num} {status_str}: tools={outcome.tool_calls_made}, llm={outcome.llm_calls_made}")

            # Check stagnation AFTER ingest (correct timing)
            if outcome:
                signal = self._stagnation_detector.check(step.step_num, self._ledger, outcome)
                if signal.detected:
                    self._handle_stagnation(signal)

                # Process patch hints from worker (with lifecycle tracking)
                self._process_patch_hints(outcome)

                # Collect successful outcomes for synthesis
                if outcome.success:
                    collected_outcomes.append(outcome)

        duration_ms = (time.time() - start_time) * 1000

        # Cleanup
        self._stagnation_detector.cleanup_all()

        # ========== FINAL RESPONSE SYNTHESIS ==========
        # Use the synthesizer to generate a proper final response
        final_response = self._synthesize_final_response(
            plan=plan,
            outcomes=collected_outcomes,
            on_stream=on_stream_chunk,
        )

        # Compute step counts
        steps_completed = sum(
            1 for s in self._plan_state.steps.values()
            if s.status == StepStatus.COMPLETED
        )
        steps_skipped = sum(
            1 for s in self._plan_state.steps.values()
            if s.status == StepStatus.SKIPPED
        )
        steps_failed = sum(
            1 for s in self._plan_state.steps.values()
            if s.status == StepStatus.FAILED
        )

        # Use goal_achieved() for success (not just is_terminated)
        goal_achieved = self._plan_state.goal_achieved()
        self._log(
            "info",
            f"Wizard complete: goal_achieved={goal_achieved}, "
            f"iterations={iteration}, completed={steps_completed}, "
            f"skipped={steps_skipped}, failed={steps_failed}, "
            f"duration={duration_ms:.0f}ms"
        )
        return WizardResult(
            success=self._plan_state.goal_achieved(),
            final_response=final_response or "Task processing complete.",
            plan_state=self._plan_state,
            ledger=self._ledger,
            total_iterations=iteration,
            total_tool_calls=total_tool_calls,
            total_llm_calls=total_llm_calls,
            duration_ms=duration_ms,
            steps_completed=steps_completed,
            steps_skipped=steps_skipped,
            steps_failed=steps_failed,
        )

    def _handle_failed_steps(self) -> None:
        """
        Handle FAILED steps by either retrying or skipping.
        Uses step.attempt_count (authoritative) instead of len(history) (can be evicted).
        """
        for step in list(self._plan_state.steps.values()):
            if step.status != StepStatus.FAILED:
                continue

            # Use step.attempt_count (authoritative, survives ledger eviction)
            if step.attempt_count < self.config.max_retries_per_step:
                # Reset for retry (attempt_count incremented on next dispatch)
                self._plan_state.reset_step_for_retry(step.step_num)
            else:
                # Max retries exceeded - skip the step
                self._plan_state.mark_step_skipped(
                    step.step_num,
                    f"Max retries ({self.config.max_retries_per_step}) exceeded after {step.attempt_count} attempts. Last error: {step.last_error or 'unknown'}"
                )
                self._stagnation_detector.reset_step(step.step_num)

    def _has_recoverable_steps(self) -> bool:
        """Check if there are any steps that can still make progress."""
        for step in self._plan_state.steps.values():
            # PENDING steps with satisfied deps will be handled
            if step.status == StepStatus.PENDING:
                return True
            # FAILED steps can be retried
            if step.status == StepStatus.FAILED:
                return True
            # IN_PROGRESS steps are being worked on
            if step.status == StepStatus.IN_PROGRESS:
                return True
        return False

    def _handle_stagnation(self, signal: StagnationSignal) -> None:
        """
        Handle stagnation by skipping the problematic step.
        Uses mark_step_skipped instead of REMOVE patch to properly satisfy dependencies.
        """
        if not signal.step_num:
            return

        # For severe stagnation (identical outputs, no progress), skip immediately
        if signal.severity >= 0.8:
            self._plan_state.mark_step_skipped(
                signal.step_num,
                f"Stagnation detected: {signal.reason}"
            )
            self._stagnation_detector.reset_step(signal.step_num)

    def _ingest_outcome(self, outcome: WorkerOutcome, entry_id: str) -> None:
        """Ingest worker outcome into stores."""
        self._ledger.record_completion(entry_id, outcome)

        if outcome.success:
            self._plan_state.mark_step_complete(
                outcome.step_num, outcome.final_response or "Completed"
            )
            self._stagnation_detector.reset_step(outcome.step_num)
        else:
            self._plan_state.mark_step_failed(outcome.step_num, outcome.error or "Unknown error")

        for fact_data in outcome.suggested_facts:
            fact = KnowledgeFact(
                key=fact_data.get("key", f"fact:{time.time()}"),
                value=fact_data.get("value"),
                confidence=fact_data.get("confidence", 0.7),
                source=FactSource.TOOL,
            )
            self._knowledge.upsert(fact)

        for evidence_data in outcome.suggested_evidence:
            evidence = EvidenceRecord(
                evidence_id=str(uuid.uuid4())[:8],
                step_num=outcome.step_num,
                evidence_type=evidence_data.get("type", "tool_output"),
                description=evidence_data.get("tool_name", "unknown"),
                tool_name=evidence_data.get("tool_name"),
                tool_output=evidence_data.get("output"),
            )
            self._evidence.record(evidence)

    def _process_patch_hints(self, outcome: WorkerOutcome) -> None:
        """
        Convert worker patch hints to patches and apply via PolicyGate.
        Records full patch lifecycle: propose → decision → apply.
        """
        for hint in outcome.patch_hints:
            if hint.get("action") == "add_step":
                patch = PlanPatch.create_insert(
                    base_version=self._plan_state.version,
                    objective=hint.get("objective", ""),
                    tool_hint=hint.get("tool_hint"),
                    justification=f"Worker hint: {hint.get('reason', '')}",
                    worker_id=outcome.worker_id,
                )

                # Phase 1: Record proposal
                self._ledger.record_patch_proposed(
                    patch_id=patch.patch_id,
                    source="worker",
                    patch_type="insert",
                    target_steps=[],  # INSERT doesn't target existing steps
                    justification=patch.justification,
                )

                # Phase 2: Get decision from PolicyGate
                decision = self._policy_gate.evaluate(patch, self._plan_state)

                # Record decision
                self._ledger.record_patch_decision(
                    patch_id=patch.patch_id,
                    approved=decision.approved,
                    rejection_reason=decision.reason if not decision.approved else None,
                )

                # Phase 3: Apply if approved
                if decision.approved:
                    applied = self._plan_state.apply_patch(patch)
                    if applied:
                        self._ledger.record_patch_applied(
                            patch_id=patch.patch_id,
                            resulting_version=self._plan_state.version,
                        )

    def _synthesize_final_response(
        self,
        plan: WizardPlan,
        outcomes: List[WorkerOutcome],
        on_stream: Optional[Callable[[str, int, bool], None]] = None,
    ) -> str:
        """
        Synthesize final response from collected outcomes.

        Uses the ResponseSynthesizer to:
        1. Collect tool outputs and step summaries from outcomes
        2. Generate a coherent final response
        3. Stream it via callback if provided

        Args:
            plan: The executed plan
            outcomes: Collected successful worker outcomes
            on_stream: Optional streaming callback

        Returns:
            Synthesized final response string
        """
        # If no outcomes, provide fallback
        if not outcomes:
            fallback = f"Completed processing: {plan.goal}"
            if on_stream:
                self._synthesizer.stream_content(fallback, on_stream)
            return fallback

        # Build synthesis input from outcomes
        tool_outputs = []
        step_summaries = []
        partial_response = None

        for outcome in outcomes:
            # Collect tool results
            for tool_name, output in outcome.tool_results.items():
                tool_outputs.append({
                    "tool": tool_name,
                    "output": str(output)[:1000]
                })

            # Use the last non-empty final response as partial
            if outcome.final_response:
                partial_response = outcome.final_response
                step_summaries.append(f"Step {outcome.step_num}: {outcome.final_response[:150]}")

        # Determine goal type
        goal_type = plan.goal_type.value if hasattr(plan.goal_type, 'value') else str(plan.goal_type)

        synthesis_input = SynthesisInput(
            goal=plan.goal,
            goal_type=goal_type,
            tool_outputs=tool_outputs,
            step_summaries=step_summaries,
            partial_response=partial_response,
        )

        # Use synthesizer with optional streaming
        result = self._synthesizer.synthesize(synthesis_input, on_stream=on_stream)

        self._log(
            "debug",
            f"Synthesis complete: method={result.synthesis_method}, "
            f"llm_called={result.llm_called}, duration={result.duration_ms:.0f}ms"
        )

        return result.content
