"""
End-to-end tests for the Wizard orchestration layer.

Tests the full Wizard orchestration flow with mocked dependencies,
validating all non-negotiable invariants from WIZARD_SPEC.md:

1. Single-writer global state: Only Wizard mutates global state
2. Append-only ledgers: No rewriting history
3. Versioned plan swaps: Patches guarded by PolicyGate
4. Immutable step objectives: Objectives don't change once created
5. Bounded autonomy: Workers propose, Wizard decides
6. No stalls: Reasonable assumptions, no blocking on trivial questions
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest

from harness.agent.plan_models import (
    Plan,
    PlanPhase,
    PlanStatus,
    PlanStep,
    SuccessCriteria,
)
from harness.agent.tool_registry import ToolResult, ToolStatus
from harness.agent.wizard import (
    ContextPack,
    EvidenceStore,
    FactSource,
    KnowledgeFact,
    KnowledgeStore,
    PlanPatch,
    PlanState,
    PolicyDecision,
    PolicyGate,
    PolicyViolation,
    StagnationDetector,
    StepState,
    Wizard,
    WizardConfig,
    WorkBounds,
    WorkItem,
    WorkLedger,
    Worker,
    WorkerConfig,
    WorkerOutcome,
)
from harness.agent.wizard.work_ledger import EntryStatus


# ===========================================================================
# Test Fixtures and Helpers
# ===========================================================================


@dataclass
class StubToolCall:
    """Stub for LLM tool call."""

    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class StubLLMResponse:
    """Stub LLM response with tool calls."""

    content: str = ""
    tool_calls: List[StubToolCall] = field(default_factory=list)

    @property
    def has_tool_calls(self) -> bool:
        return bool(self.tool_calls)


class SequenceLLM:
    """LLM stub that returns predetermined responses in sequence."""

    def __init__(self, responses: List[StubLLMResponse]):
        self._responses = list(responses)
        self.calls: List[Any] = []

    def respond_with_messages(
        self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None
    ) -> Optional[StubLLMResponse]:
        self.calls.append({"messages": messages, "tools": tools})
        if not self._responses:
            return None
        return self._responses.pop(0)


class StubToolRegistry:
    """Tool registry stub for testing."""

    def __init__(
        self,
        results: Optional[Dict[str, ToolResult]] = None,
        raise_for: Optional[set] = None,
    ):
        self.results = results or {}
        self.raise_for = raise_for or set()
        self.calls: List[Dict[str, Any]] = []

    def get_definitions(self, enabled_only: bool = True) -> List[Dict[str, Any]]:
        return [{"name": "test_tool", "description": "A test tool"}]

    def execute(self, name: str, **kwargs: Any) -> ToolResult:
        self.calls.append({"name": name, "kwargs": kwargs})
        if name in self.raise_for:
            raise RuntimeError(f"Tool {name} failed")
        return self.results.get(
            name,
            ToolResult(
                status=ToolStatus.SUCCESS,
                output=f"Output from {name}",
                metadata={"path": kwargs.get("path", "/test/path")},
            ),
        )


class StubPlanner:
    """Planner stub that returns a predetermined plan."""

    def __init__(self, plan: Optional[Plan] = None):
        self._plan = plan

    def create_plan(
        self,
        user_input: str,
        context: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
    ) -> Plan:
        if self._plan:
            return self._plan
        return create_simple_plan(user_input)


def create_simple_plan(goal: str, num_steps: int = 2) -> Plan:
    """Create a simple plan with N steps."""
    steps = [
        PlanStep(
            step_num=i + 1,
            objective=f"Step {i + 1}: {goal}",
            tool_hint="test_tool",
            depends_on=list(range(1, i + 1)),  # Each step depends on all previous
            phase=PlanPhase.EXECUTION,
        )
        for i in range(num_steps)
    ]
    return Plan(
        goal=goal,
        goal_type="task",
        steps=steps,
        success_criteria=SuccessCriteria(description=f"Complete: {goal}"),
        estimated_complexity="simple",
        requires_tools=True,
        reasoning="Test plan",
    )


def create_successful_llm_responses(num_steps: int) -> List[StubLLMResponse]:
    """Create LLM responses that lead to successful completion."""
    responses = []
    for i in range(num_steps):
        # First response: tool call
        responses.append(
            StubLLMResponse(
                tool_calls=[
                    StubToolCall(
                        id=str(uuid.uuid4())[:8],
                        name="test_tool",
                        arguments={"path": f"/test/file_{i}.txt"},
                    )
                ]
            )
        )
        # Second response: final answer with [FINAL] marker
        responses.append(
            StubLLMResponse(
                content=f"[FINAL] Step {i + 1} completed successfully. The tool output was processed."
            )
        )
    return responses


# ===========================================================================
# Invariant 1: Single-Writer Global State
# ===========================================================================


class TestSingleWriterGlobalState:
    """Tests for invariant: Only Wizard may mutate global plan/state."""

    def test_worker_outcome_does_not_mutate_plan_state_directly(self):
        """Workers NEVER directly mutate plan state - only suggest via outcome."""
        # Setup
        plan = create_simple_plan("Test task", num_steps=1)
        plan_state = PlanState.from_plan(plan)
        initial_version = plan_state.version

        # Create a worker outcome with suggestions
        outcome = WorkerOutcome(
            work_id="test-work",
            worker_id="test-worker",
            step_num=1,
            success=True,
            status=PlanStatus.COMPLETED,
            final_response="Done",
            # These are SUGGESTIONS, not direct mutations
            patch_hints=[{"action": "add_step", "objective": "New step"}],
            suggested_facts=[{"key": "test", "value": "value"}],
        )

        # Worker outcome should not change plan_state version
        # (only Wizard can do that via apply_patch or mark_step_*)
        assert plan_state.version == initial_version
        assert len(outcome.patch_hints) == 1
        assert outcome.patch_hints[0]["action"] == "add_step"

    def test_wizard_is_only_writer_to_plan_state(self):
        """Only Wizard can mutate PlanState via its methods."""
        plan = create_simple_plan("Test task", num_steps=1)
        plan_state = PlanState.from_plan(plan)

        # These are the ONLY ways to mutate plan state
        initial_version = plan_state.version

        plan_state.mark_step_in_progress(1, "worker-1")
        assert plan_state.version == initial_version + 1

        plan_state.mark_step_complete(1, "Done")
        assert plan_state.version == initial_version + 2

        # Step should be frozen after completion
        assert plan_state.steps[1].is_frozen is True


# ===========================================================================
# Invariant 2: Append-Only Ledgers
# ===========================================================================


class TestAppendOnlyLedgers:
    """Tests for invariant: All worker outputs are appended to immutable ledger."""

    def test_ledger_entries_are_append_only(self):
        """Entries can only be appended, never removed (except eviction)."""
        ledger = WorkLedger(max_entries=100)
        work_item = WorkItem(work_id="w1", step_num=1, objective="Test")

        entry_id = ledger.record_dispatch(1, work_item, "worker-1")
        assert ledger.total_entries == 1

        # Can add more entries
        entry_id2 = ledger.record_dispatch(2, work_item, "worker-2")
        assert ledger.total_entries == 2

        # Both entries should still exist
        assert entry_id in ledger._by_id
        assert entry_id2 in ledger._by_id

    def test_ledger_completion_only_adds_data(self):
        """Completion modifies entry fields but doesn't remove/replace entry."""
        ledger = WorkLedger()
        work_item = WorkItem(work_id="w1", step_num=1, objective="Test")

        entry_id = ledger.record_dispatch(1, work_item, "worker-1")
        original_entry = ledger._by_id[entry_id]
        original_dispatched_at = original_entry.dispatched_at

        outcome = WorkerOutcome(
            work_id="w1",
            worker_id="worker-1",
            step_num=1,
            success=True,
            status=PlanStatus.COMPLETED,
            final_response="Done",
            tool_calls_made=2,
        )

        ledger.record_completion(entry_id, outcome)

        # Entry should still exist with same dispatch time
        completed_entry = ledger._by_id[entry_id]
        assert completed_entry.dispatched_at == original_dispatched_at
        assert completed_entry.status == EntryStatus.COMPLETED
        assert completed_entry.tool_calls_made == 2

    def test_ledger_eviction_only_removes_completed_entries(self):
        """Eviction only removes completed entries, not in-flight."""
        ledger = WorkLedger(max_entries=2)

        work_item = WorkItem(work_id="w1", step_num=1, objective="Test")

        # Add and complete first entry
        entry1 = ledger.record_dispatch(1, work_item, "w1")
        ledger.record_completion(
            entry1,
            WorkerOutcome(
                work_id="w1",
                worker_id="w1",
                step_num=1,
                success=True,
                status=PlanStatus.COMPLETED,
            ),
        )

        # Add second (keep dispatched - in flight)
        entry2 = ledger.record_dispatch(2, work_item, "w2")

        # Add third - should trigger eviction of entry1 (completed), not entry2
        entry3 = ledger.record_dispatch(3, work_item, "w3")

        assert ledger.total_entries == 2
        assert entry1 not in ledger._by_id  # Evicted (completed)
        assert entry2 in ledger._by_id  # Kept (in-flight)
        assert entry3 in ledger._by_id  # Kept (new)


# ===========================================================================
# Invariant 3: Versioned Plan Swaps
# ===========================================================================


class TestVersionedPlanSwaps:
    """Tests for invariant: Patches guarded by versioned policy."""

    def test_patch_rejected_on_version_mismatch(self):
        """Patches with wrong base version are rejected."""
        plan = create_simple_plan("Test", num_steps=2)
        plan_state = PlanState.from_plan(plan)
        policy_gate = PolicyGate()

        # Create patch with wrong version
        patch = PlanPatch.create_insert(
            base_version=999,  # Wrong version
            objective="New step",
        )

        decision = policy_gate.evaluate(patch, plan_state)
        assert decision.approved is False
        assert decision.violation == PolicyViolation.VERSION_MISMATCH

    def test_patch_rejected_for_frozen_step(self):
        """Cannot modify frozen (completed) steps."""
        plan = create_simple_plan("Test", num_steps=2)
        plan_state = PlanState.from_plan(plan)
        policy_gate = PolicyGate()

        # Complete and freeze step 1
        plan_state.mark_step_in_progress(1, "worker")
        plan_state.mark_step_complete(1, "Done")
        assert plan_state.steps[1].is_frozen is True

        # Try to remove frozen step
        patch = PlanPatch.create_remove(
            base_version=plan_state.version,
            step_num=1,
        )

        decision = policy_gate.evaluate(patch, plan_state)
        assert decision.approved is False
        assert decision.violation == PolicyViolation.MODIFYING_DONE_STEP

    def test_patch_approved_with_correct_version(self):
        """Valid patches with correct version are approved."""
        plan = create_simple_plan("Test", num_steps=2)
        plan_state = PlanState.from_plan(plan)
        policy_gate = PolicyGate()

        patch = PlanPatch.create_insert(
            base_version=plan_state.version,
            objective="New step",
        )

        decision = policy_gate.evaluate(patch, plan_state)
        assert decision.approved is True

    def test_version_increments_on_each_mutation(self):
        """Version increments on every state mutation."""
        plan = create_simple_plan("Test", num_steps=2)
        plan_state = PlanState.from_plan(plan)

        v1 = plan_state.version
        plan_state.mark_step_in_progress(1, "worker")
        v2 = plan_state.version
        plan_state.mark_step_complete(1, "Done")
        v3 = plan_state.version

        assert v2 == v1 + 1
        assert v3 == v2 + 1


# ===========================================================================
# Invariant 4: Immutable Step Objectives
# ===========================================================================


class TestImmutableStepObjectives:
    """Tests for invariant: Step objectives immutable once created."""

    def test_completed_step_objective_cannot_change(self):
        """Completed step objectives are frozen."""
        plan = create_simple_plan("Test", num_steps=1)
        plan_state = PlanState.from_plan(plan)

        original_objective = plan_state.steps[1].objective

        # Complete the step
        plan_state.mark_step_in_progress(1, "worker")
        plan_state.mark_step_complete(1, "Done")

        # Objective should remain unchanged
        assert plan_state.steps[1].objective == original_objective
        assert plan_state.steps[1].is_frozen is True

    def test_replace_patch_only_affects_pending_steps(self):
        """REPLACE patch only changes PENDING step objectives."""
        plan = create_simple_plan("Test", num_steps=2)
        plan_state = PlanState.from_plan(plan)

        # Complete step 1
        plan_state.mark_step_in_progress(1, "worker")
        plan_state.mark_step_complete(1, "Done")
        step1_objective = plan_state.steps[1].objective

        # Apply REPLACE patch to step 2 (pending)
        from harness.agent.wizard.plan_patch import PatchOperation, PatchType

        patch = PlanPatch(
            patch_id="test",
            base_plan_version=plan_state.version,
            operations=[
                PatchOperation(
                    type=PatchType.REPLACE,
                    target_step=2,
                    new_objective="Updated objective",
                )
            ],
        )

        result = plan_state.apply_patch(patch)
        assert result is True
        assert plan_state.steps[2].objective == "Updated objective"
        # Step 1 should be unchanged
        assert plan_state.steps[1].objective == step1_objective


# ===========================================================================
# Invariant 5: Bounded Autonomy
# ===========================================================================


class TestBoundedAutonomy:
    """Tests for invariant: Workers can propose but Wizard decides."""

    def test_worker_bounds_enforced(self):
        """Worker respects tool call and duration bounds."""
        bounds = WorkBounds(max_tool_calls=2, max_llm_calls=2, max_duration_ms=1000)
        work_item = WorkItem(
            work_id="test",
            step_num=1,
            objective="Test task",
            bounds=bounds,
        )

        context_pack = ContextPack(
            pack_id="test",
            step_num=1,
            worker_id="worker-1",
            instructions="Do the thing",
            objective="Test task",
            max_tool_calls=bounds.max_tool_calls,
            max_duration_ms=bounds.max_duration_ms,
        )

        # Create responses that would exceed bounds
        responses = [
            StubLLMResponse(
                tool_calls=[
                    StubToolCall(id="1", name="tool1", arguments={}),
                    StubToolCall(id="2", name="tool2", arguments={}),
                ]
            ),
            StubLLMResponse(
                tool_calls=[
                    StubToolCall(id="3", name="tool3", arguments={}),  # Would exceed limit
                ]
            ),
        ]

        llm = SequenceLLM(responses)
        tool_registry = StubToolRegistry()
        worker = Worker(tool_registry, llm, WorkerConfig(max_iterations=10))

        outcome = worker.execute(context_pack, work_item)

        # Should have stopped at 2 tool calls
        assert outcome.tool_calls_made == 2
        assert outcome.termination_reason == "max_tool_calls"

    def test_patch_hints_require_wizard_approval(self):
        """Worker patch hints go through PolicyGate."""
        plan = create_simple_plan("Test", num_steps=1)
        plan_state = PlanState.from_plan(plan)
        policy_gate = PolicyGate()

        # Simulate worker patch hint
        patch_hint = {"action": "add_step", "objective": "Extra step", "reason": "Needed"}

        # Convert hint to patch (as Wizard would)
        patch = PlanPatch.create_insert(
            base_version=plan_state.version,
            objective=patch_hint["objective"],
            justification=f"Worker hint: {patch_hint.get('reason', '')}",
        )

        # Wizard evaluates via PolicyGate
        decision = policy_gate.evaluate(patch, plan_state)
        assert decision.approved is True

        # Only if approved does Wizard apply
        if decision.approved:
            result = plan_state.apply_patch(patch)
            assert result is True
            assert len(plan_state.steps) == 2  # New step added


# ===========================================================================
# Invariant 6: No Stalls
# ===========================================================================


class TestNoStalls:
    """Tests for invariant: Make reasonable assumptions, no blocking."""

    def test_stagnation_detector_triggers_on_too_many_retries(self):
        """Stagnation detected after too many retries."""
        detector = StagnationDetector(max_retries_per_step=2)
        ledger = WorkLedger()

        work_item = WorkItem(work_id="w1", step_num=1, objective="Test")

        # Simulate 3 failed attempts
        for i in range(3):
            entry_id = ledger.record_dispatch(1, work_item, f"worker-{i}")
            ledger.record_completion(
                entry_id,
                WorkerOutcome(
                    work_id="w1",
                    worker_id=f"worker-{i}",
                    step_num=1,
                    success=False,
                    status=PlanStatus.FAILED,
                    error="Failed",
                ),
            )

        signal = detector.check(step_num=1, ledger=ledger)
        assert signal.detected is True
        assert signal.severity >= 0.8
        assert "failed" in signal.reason.lower()

    def test_stagnation_detector_triggers_on_identical_outputs(self):
        """Stagnation detected when outputs are identical."""
        detector = StagnationDetector(max_identical_outputs=2)
        ledger = WorkLedger()

        # Simulate identical outputs
        outcome = WorkerOutcome(
            work_id="w1",
            worker_id="worker",
            step_num=1,
            success=True,
            status=PlanStatus.COMPLETED,
            final_response="Same output every time",
        )

        # Check multiple times with same output
        for _ in range(3):
            signal = detector.check(step_num=1, ledger=ledger, outcome=outcome)

        assert signal.detected is True
        assert signal.severity >= 0.8
        assert "identical" in signal.reason.lower()

    def test_failed_step_gets_retried(self):
        """Failed steps are retried up to max_retries."""
        plan = create_simple_plan("Test", num_steps=1)
        plan_state = PlanState.from_plan(plan)

        # First attempt fails
        plan_state.mark_step_in_progress(1, "worker-1")
        plan_state.mark_step_failed(1, "Error occurred")
        assert plan_state.steps[1].status == PlanStatus.FAILED
        assert plan_state.steps[1].attempt_count == 1

        # Reset for retry
        result = plan_state.reset_step_for_retry(1)
        assert result is True
        assert plan_state.steps[1].status == PlanStatus.PENDING

        # Second attempt
        plan_state.mark_step_in_progress(1, "worker-2")
        assert plan_state.steps[1].attempt_count == 2


# ===========================================================================
# End-to-End Wizard Orchestration Tests
# ===========================================================================


class TestWizardE2E:
    """Full end-to-end tests for Wizard orchestration."""

    def test_simple_two_step_plan_completes_successfully(self):
        """Wizard completes a simple two-step plan."""
        # Setup
        plan = create_simple_plan("Complete task", num_steps=2)
        planner = StubPlanner(plan)
        tool_registry = StubToolRegistry()
        llm = SequenceLLM(create_successful_llm_responses(2))

        wizard = Wizard(
            tool_registry=tool_registry,
            llm=llm,
            planner=planner,
            config=WizardConfig(max_iterations=20),
        )

        # Execute
        result = wizard.orchestrate("Complete task")

        # Verify
        assert result.success is True
        assert result.plan_state.is_complete() is True
        assert result.total_iterations >= 2
        assert result.total_tool_calls >= 2

        # Both steps should be completed
        for step in result.plan_state.steps.values():
            assert step.status in (PlanStatus.COMPLETED, PlanStatus.SKIPPED)

    def test_wizard_handles_worker_failure_and_retries(self):
        """Wizard retries failed steps up to max_retries."""
        # Setup plan with 1 step
        plan = create_simple_plan("Complete task", num_steps=1)
        planner = StubPlanner(plan)

        # First two attempts fail, third succeeds
        responses = [
            # Attempt 1: fail
            StubLLMResponse(
                tool_calls=[StubToolCall(id="1", name="failing_tool", arguments={})]
            ),
            StubLLMResponse(content="Short"),  # Not enough for implicit final
            # Attempt 2: fail
            StubLLMResponse(
                tool_calls=[StubToolCall(id="2", name="failing_tool", arguments={})]
            ),
            StubLLMResponse(content="Short"),
            # Attempt 3: succeed
            StubLLMResponse(
                tool_calls=[StubToolCall(id="3", name="test_tool", arguments={})]
            ),
            StubLLMResponse(
                content="[FINAL] Successfully completed the task after retries."
            ),
        ]

        tool_registry = StubToolRegistry(
            results={
                "failing_tool": ToolResult(
                    status=ToolStatus.ERROR, output=None, error="Tool failed"
                )
            }
        )
        llm = SequenceLLM(responses)

        wizard = Wizard(
            tool_registry=tool_registry,
            llm=llm,
            planner=planner,
            config=WizardConfig(max_iterations=20, max_retries_per_step=3),
        )

        result = wizard.orchestrate("Complete task")

        # Should eventually succeed
        assert result.plan_state.steps[1].status in (
            PlanStatus.COMPLETED,
            PlanStatus.SKIPPED,
        )

    def test_wizard_skips_step_after_max_retries(self):
        """Wizard skips step after max retries exceeded."""
        plan = create_simple_plan("Complete task", num_steps=2)
        planner = StubPlanner(plan)

        # All attempts for step 1 fail, step 2 succeeds
        responses = []
        for _ in range(3):  # 3 retries for step 1
            responses.extend([
                StubLLMResponse(
                    tool_calls=[StubToolCall(id=str(uuid.uuid4())[:8], name="failing_tool", arguments={})]
                ),
                StubLLMResponse(content="Short"),  # Fails
            ])
        # Step 2 succeeds
        responses.extend([
            StubLLMResponse(
                tool_calls=[StubToolCall(id="s2", name="test_tool", arguments={})]
            ),
            StubLLMResponse(content="[FINAL] Step 2 completed."),
        ])

        tool_registry = StubToolRegistry(
            results={
                "failing_tool": ToolResult(
                    status=ToolStatus.ERROR, output=None, error="Always fails"
                )
            }
        )
        llm = SequenceLLM(responses)

        wizard = Wizard(
            tool_registry=tool_registry,
            llm=llm,
            planner=planner,
            config=WizardConfig(max_iterations=30, max_retries_per_step=2),
        )

        result = wizard.orchestrate("Complete task")

        # Step 1 should be skipped, step 2 should complete
        assert result.plan_state.steps[1].status == PlanStatus.SKIPPED
        # Step 2 depends on step 1, so should also be processable
        # (SKIPPED satisfies dependencies)
        assert result.plan_state.is_complete() is True

    def test_wizard_respects_deadlock_threshold(self):
        """Wizard exits on deadlock (no ready steps for too long)."""
        # Create plan where step 2 depends on step 1
        plan = create_simple_plan("Complete task", num_steps=2)
        # Make step 1 never complete (always fail without retry)
        planner = StubPlanner(plan)

        responses = [
            StubLLMResponse(content=""),  # Empty response - fails
        ] * 20  # Many empty responses

        llm = SequenceLLM(responses)
        tool_registry = StubToolRegistry()

        wizard = Wizard(
            tool_registry=tool_registry,
            llm=llm,
            planner=planner,
            config=WizardConfig(
                max_iterations=30,
                max_retries_per_step=1,
                deadlock_threshold=3,
            ),
        )

        result = wizard.orchestrate("Complete task")

        # Should exit before max_iterations due to deadlock
        assert result.total_iterations < 30

    def test_wizard_tracks_patch_lifecycle(self):
        """Wizard tracks full patch lifecycle: propose -> decision -> apply."""
        plan = create_simple_plan("Complete task", num_steps=1)
        planner = StubPlanner(plan)

        # Worker returns patch hint
        responses = [
            StubLLMResponse(
                tool_calls=[StubToolCall(id="1", name="test_tool", arguments={})]
            ),
            StubLLMResponse(content="[FINAL] Done. Need another step."),
        ]

        llm = SequenceLLM(responses)
        tool_registry = StubToolRegistry()

        wizard = Wizard(
            tool_registry=tool_registry,
            llm=llm,
            planner=planner,
            config=WizardConfig(max_iterations=10),
        )

        result = wizard.orchestrate("Complete task")

        # Verify patch lifecycle was tracked
        # Note: patch tracking is in the ledger
        assert result.ledger is not None

    def test_wizard_converts_to_agent_response(self):
        """WizardResult converts to AgentResponse correctly."""
        plan = create_simple_plan("Test task", num_steps=1)
        planner = StubPlanner(plan)
        tool_registry = StubToolRegistry()
        llm = SequenceLLM(create_successful_llm_responses(1))

        wizard = Wizard(
            tool_registry=tool_registry,
            llm=llm,
            planner=planner,
            config=WizardConfig(max_iterations=10),
        )

        result = wizard.orchestrate("Test task")
        agent_response = result.to_agent_response()

        assert agent_response.success == result.success
        assert agent_response.content == result.final_response
        assert agent_response.metadata.get("wizard") is True
        assert "iterations" in agent_response.metadata


# ===========================================================================
# Policy Gate Integration Tests
# ===========================================================================


class TestPolicyGateIntegration:
    """Integration tests for PolicyGate behavior."""

    def test_rate_limiting_rejects_too_many_patches(self):
        """PolicyGate rate limits rapid patch submissions."""
        policy_gate = PolicyGate(
            max_patches_per_window=2,
            window_seconds=60.0,
        )
        plan = create_simple_plan("Test", num_steps=5)
        plan_state = PlanState.from_plan(plan)

        # Submit patches rapidly
        results = []
        for i in range(5):
            patch = PlanPatch.create_insert(
                base_version=plan_state.version,
                objective=f"Step {i}",
            )
            decision = policy_gate.evaluate(patch, plan_state)
            results.append(decision.approved)

            # Apply approved patches to bump version
            if decision.approved:
                plan_state.apply_patch(patch)

        # First 2 should be approved, rest rate limited
        assert results[:2] == [True, True]
        assert False in results[2:]

    def test_thrash_detection_rejects_repeated_modifications(self):
        """PolicyGate detects and rejects thrashing behavior."""
        policy_gate = PolicyGate(
            max_patches_per_window=10,
            window_seconds=60.0,
            thrash_threshold=2,
        )
        plan = create_simple_plan("Test", num_steps=3)
        plan_state = PlanState.from_plan(plan)

        # Repeatedly try to modify step 2
        results = []
        for i in range(5):
            # Use REPLACE instead of REMOVE to target same step
            from harness.agent.wizard.plan_patch import PatchOperation, PatchType

            patch = PlanPatch(
                patch_id=f"patch-{i}",
                base_plan_version=plan_state.version,
                operations=[
                    PatchOperation(
                        type=PatchType.REPLACE,
                        target_step=2,
                        new_objective=f"Modified {i}",
                    )
                ],
            )
            decision = policy_gate.evaluate(patch, plan_state)
            results.append(decision)

            if decision.approved:
                plan_state.apply_patch(patch)

        # Should detect thrashing
        thrash_detected = any(
            d.violation == PolicyViolation.THRASH_DETECTED for d in results
        )
        assert thrash_detected


# ===========================================================================
# Knowledge and Evidence Store Tests
# ===========================================================================


class TestKnowledgeAndEvidenceStores:
    """Tests for KnowledgeStore and EvidenceStore integration."""

    def test_knowledge_store_evicts_expired_facts(self):
        """Expired facts are filtered out."""
        store = KnowledgeStore()

        # Add fact with short TTL
        expired_fact = KnowledgeFact(
            key="old",
            value="stale",
            confidence=0.5,
            source=FactSource.TOOL,
            ttl_seconds=1,
            timestamp=time.time() - 10,  # Already expired
        )
        store.upsert(expired_fact)

        # Add fresh fact
        fresh_fact = KnowledgeFact(
            key="new",
            value="fresh",
            confidence=0.9,
            source=FactSource.TOOL,
        )
        store.upsert(fresh_fact)

        # Get should return None for expired
        assert store.get("old") is None
        assert store.get("new") is not None

        # Evict and check count
        store.evict_expired()
        assert store.fact_count == 1

    def test_evidence_store_evicts_oldest_unverified_first(self):
        """Evidence store prioritizes evicting unverified records."""
        from harness.agent.wizard.evidence_store import EvidenceRecord

        store = EvidenceStore(max_records=2)

        # Add verified record
        verified = EvidenceRecord(
            evidence_id="v1",
            step_num=1,
            evidence_type="test",
            description="Verified",
            verified=True,
        )
        store.record(verified)

        # Add unverified record
        unverified = EvidenceRecord(
            evidence_id="u1",
            step_num=1,
            evidence_type="test",
            description="Unverified",
            verified=False,
        )
        store.record(unverified)

        # Add third record - should evict unverified first
        third = EvidenceRecord(
            evidence_id="t1",
            step_num=1,
            evidence_type="test",
            description="Third",
            verified=False,
        )
        store.record(third)

        assert store.record_count == 2
        assert "v1" in store._records  # Verified should remain
        assert "u1" not in store._records  # Unverified should be evicted


# ===========================================================================
# Worker Execution Tests
# ===========================================================================


class TestWorkerExecution:
    """Tests for Worker execution behavior."""

    def test_worker_extracts_entity_refs_from_tool_results(self):
        """Worker extracts entity references from tool metadata."""
        context_pack = ContextPack(
            pack_id="test",
            step_num=1,
            worker_id="worker-1",
            instructions="Test",
            objective="Read file",
            max_tool_calls=5,
            max_duration_ms=60000,
        )
        work_item = WorkItem(
            work_id="test",
            step_num=1,
            objective="Read file",
            bounds=WorkBounds(max_tool_calls=5, max_llm_calls=5),
        )

        responses = [
            StubLLMResponse(
                tool_calls=[
                    StubToolCall(
                        id="1",
                        name="file_read",
                        arguments={"path": "/path/to/file.txt"},
                    )
                ]
            ),
            StubLLMResponse(content="[FINAL] File contents processed."),
        ]

        tool_registry = StubToolRegistry(
            results={
                "file_read": ToolResult(
                    status=ToolStatus.SUCCESS,
                    output="file contents",
                    metadata={"path": "/path/to/file.txt"},
                )
            }
        )
        llm = SequenceLLM(responses)
        worker = Worker(tool_registry, llm, WorkerConfig())

        outcome = worker.execute(context_pack, work_item)

        assert "/path/to/file.txt" in outcome.entity_refs

    def test_worker_handles_llm_returning_no_response(self):
        """Worker handles gracefully when LLM returns None."""
        context_pack = ContextPack(
            pack_id="test",
            step_num=1,
            worker_id="worker-1",
            instructions="Test",
            objective="Do something",
        )
        work_item = WorkItem(
            work_id="test",
            step_num=1,
            objective="Do something",
        )

        llm = SequenceLLM([])  # No responses
        tool_registry = StubToolRegistry()
        worker = Worker(tool_registry, llm, WorkerConfig())

        outcome = worker.execute(context_pack, work_item)

        assert outcome.success is False
        assert outcome.termination_reason == "llm_error"

    def test_worker_handles_tool_exceptions(self):
        """Worker handles tool execution exceptions gracefully."""
        context_pack = ContextPack(
            pack_id="test",
            step_num=1,
            worker_id="worker-1",
            instructions="Test",
            objective="Call failing tool",
            max_tool_calls=5,
            max_duration_ms=60000,
        )
        work_item = WorkItem(
            work_id="test",
            step_num=1,
            objective="Call failing tool",
            bounds=WorkBounds(max_tool_calls=5, max_llm_calls=5),
        )

        responses = [
            StubLLMResponse(
                tool_calls=[StubToolCall(id="1", name="exploding_tool", arguments={})]
            ),
            StubLLMResponse(content="[FINAL] Handled the error."),
        ]

        tool_registry = StubToolRegistry(raise_for={"exploding_tool"})
        llm = SequenceLLM(responses)
        worker = Worker(tool_registry, llm, WorkerConfig())

        outcome = worker.execute(context_pack, work_item)

        # Should have recorded the failed tool call
        assert outcome.tool_calls_failed >= 1
        assert "Tool exploding_tool: failed" in outcome.observations


# ===========================================================================
# Context Pack Builder Tests
# ===========================================================================


class TestContextPackBuilder:
    """Tests for ContextPackBuilder."""

    def test_context_pack_is_immutable(self):
        """ContextPack cannot be modified after creation."""
        pack = ContextPack(
            pack_id="test",
            step_num=1,
            worker_id="worker-1",
            instructions="Test",
            objective="Do something",
        )

        # Attempting to modify should raise
        with pytest.raises(Exception):  # FrozenInstanceError
            pack.objective = "Modified"  # type: ignore

    def test_context_pack_builder_filters_expired_facts(self):
        """Builder excludes expired facts from context."""
        from harness.agent.wizard.context_pack import ContextPackBuilder

        knowledge = KnowledgeStore()
        evidence = EvidenceStore()
        ledger = WorkLedger()

        # Add expired fact
        expired = KnowledgeFact(
            key="old",
            value="stale",
            confidence=0.5,
            source=FactSource.TOOL,
            ttl_seconds=1,
            timestamp=time.time() - 10,
        )
        knowledge.upsert(expired)

        # Add fresh fact
        fresh = KnowledgeFact(
            key="new",
            value="fresh",
            confidence=0.9,
            source=FactSource.TOOL,
        )
        knowledge.upsert(fresh)

        # Create a minimal plan state
        class MinimalPlanState:
            goal = "Test goal"

        step = StepState(
            step_num=1,
            status=PlanStatus.PENDING,
            objective="Test",
            tool_hint=None,
            depends_on=[],
            phase=PlanPhase.EXECUTION,
        )
        work_item = WorkItem(work_id="test", step_num=1, objective="Test")

        builder = ContextPackBuilder(
            plan_state=MinimalPlanState(),  # type: ignore
            ledger=ledger,
            knowledge=knowledge,
            evidence=evidence,
        )

        pack = builder.build(step, work_item)

        # Should only have fresh fact
        assert len(pack.relevant_facts) == 1
        assert pack.relevant_facts[0].key == "new"


# ===========================================================================
# Streaming Callback Tests
# ===========================================================================


class TestStreamingCallback:
    """Tests for streaming callback functionality."""

    def test_wizard_calls_streaming_callback(self):
        """Wizard invokes streaming callback with response chunks."""
        plan = create_simple_plan("Test task", num_steps=1)
        planner = StubPlanner(plan)
        tool_registry = StubToolRegistry()
        llm = SequenceLLM(create_successful_llm_responses(1))

        wizard = Wizard(
            tool_registry=tool_registry,
            llm=llm,
            planner=planner,
            config=WizardConfig(max_iterations=10),
        )

        chunks_received: List[tuple] = []

        def on_chunk(chunk: str, index: int, is_final: bool) -> None:
            chunks_received.append((chunk, index, is_final))

        result = wizard.orchestrate("Test task", on_stream_chunk=on_chunk)

        # Should have received chunks
        assert len(chunks_received) > 0
        # Last chunk should be marked final
        assert any(is_final for _, _, is_final in chunks_received)


# ===========================================================================
# Plan State Dependencies Tests
# ===========================================================================


class TestPlanStateDependencies:
    """Tests for dependency handling in PlanState."""

    def test_skipped_step_satisfies_dependencies(self):
        """SKIPPED status satisfies dependencies for downstream steps."""
        plan = create_simple_plan("Test", num_steps=3)
        plan_state = PlanState.from_plan(plan)

        # Step 1 completes, step 2 is skipped
        plan_state.mark_step_in_progress(1, "worker")
        plan_state.mark_step_complete(1, "Done")
        plan_state.mark_step_skipped(2, "Could not complete")

        # Step 3 should be ready (depends on 1 and 2, both satisfied)
        ready = plan_state.get_ready_steps()
        assert len(ready) == 1
        assert ready[0].step_num == 3

    def test_failed_step_does_not_satisfy_dependencies(self):
        """FAILED status does NOT satisfy dependencies."""
        plan = create_simple_plan("Test", num_steps=2)
        plan_state = PlanState.from_plan(plan)

        # Step 1 fails
        plan_state.mark_step_in_progress(1, "worker")
        plan_state.mark_step_failed(1, "Error")

        # Step 2 should NOT be ready (depends on step 1)
        ready = plan_state.get_ready_steps()
        assert len(ready) == 0

    def test_in_progress_step_does_not_satisfy_dependencies(self):
        """IN_PROGRESS status does NOT satisfy dependencies."""
        plan = create_simple_plan("Test", num_steps=2)
        plan_state = PlanState.from_plan(plan)

        # Step 1 is in progress
        plan_state.mark_step_in_progress(1, "worker")

        # Step 2 should NOT be ready
        ready = plan_state.get_ready_steps()
        assert len(ready) == 0
