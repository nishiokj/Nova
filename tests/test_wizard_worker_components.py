import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import pytest

from harness.agent.plan_models import PlanPhase, PlanStatus
from harness.agent.tool_registry import ToolResult, ToolStatus
from harness.agent.wizard.context_pack import ContextPack, ContextPackBuilder
from harness.agent.wizard.evidence_store import EvidenceRecord, EvidenceStore
from harness.agent.wizard.knowledge_store import FactSource, KnowledgeFact, KnowledgeStore
from harness.agent.wizard.plan_state import StepState
from harness.agent.wizard.work_item import WorkBounds, WorkItem
from harness.agent.wizard.work_ledger import EntryStatus, WorkLedger
from harness.agent.wizard.worker import Worker, WorkerConfig, WorkerOutcome


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@dataclass
class StubToolCall:
    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class StubResponse:
    content: str = ""
    tool_calls: List[StubToolCall] = field(default_factory=list)

    @property
    def has_tool_calls(self) -> bool:
        return bool(self.tool_calls)


class SequenceLLM:
    """Simple LLM stub that returns predetermined responses."""

    def __init__(self, responses: List[StubResponse]):
        self._responses = list(responses)
        self.calls: List[List[Dict[str, Any]]] = []

    def respond_with_messages(
        self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None
    ) -> Optional[StubResponse]:
        self.calls.append(messages)
        if not self._responses:
            return None
        return self._responses.pop(0)


class StubToolRegistry:
    """Minimal tool registry stub."""

    def __init__(self, results: Optional[Dict[str, ToolResult]] = None, raise_for: Optional[set] = None):
        self.results = results or {}
        self.raise_for = raise_for or set()
        self.calls: List[Dict[str, Any]] = []

    def get_definitions(self, enabled_only: bool = True) -> List[Dict[str, Any]]:
        return []

    def execute(self, name: str, **kwargs) -> ToolResult:
        self.calls.append({"name": name, "kwargs": kwargs})
        if name in self.raise_for:
            raise RuntimeError("tool failed")
        return self.results.get(
            name,
            ToolResult(status=ToolStatus.SUCCESS, output="ok", metadata={"path": kwargs.get("path")}),
        )


class DummyPlanState:
    """Bare-minimum plan state substitute for ContextPackBuilder."""

    def __init__(self, goal: str = "Ship it"):
        self.goal = goal


# ---------------------------------------------------------------------------
# WorkItem + ContextPackBuilder
# ---------------------------------------------------------------------------


def test_work_item_from_step_state_preserves_objective_and_bounds():
    bounds = WorkBounds(max_tool_calls=2, max_duration_ms=500, max_llm_calls=1)
    step = StepState(
        step_num=3,
        status=PlanStatus.PENDING,
        objective="Verify repository structure",
        tool_hint="search_filesystem",
        depends_on=[],
        phase=PlanPhase.EXECUTION,
    )

    work_item = WorkItem.from_step_state(step, bounds=bounds)

    assert work_item.step_num == step.step_num
    assert work_item.objective == step.objective
    assert work_item.tool_hint == step.tool_hint
    assert work_item.bounds is bounds
    assert len(work_item.work_id) == 8  # uuid truncated
    assert work_item.success_criteria.description.endswith(step.objective)


def test_context_pack_builder_filters_expired_facts_and_collects_evidence():
    knowledge = KnowledgeStore()
    expired = KnowledgeFact(
        key="fact:old",
        value="stale",
        confidence=0.2,
        source=FactSource.USER,
        ttl_seconds=1,
        timestamp=time.time() - 10,
    )
    fresh = KnowledgeFact(
        key="fact:fresh",
        value="use me",
        confidence=0.9,
        source=FactSource.TOOL,
    )
    knowledge.upsert(expired)
    knowledge.upsert(fresh)

    evidence = EvidenceStore()
    evidence.record(
        EvidenceRecord(
            evidence_id="ev1",
            step_num=1,
            evidence_type="tool_output",
            description="dependency evidence",
            tool_output="details",
        )
    )

    ledger = WorkLedger()
    step = StepState(
        step_num=2,
        status=PlanStatus.PENDING,
        objective="Summarize findings",
        tool_hint=None,
        depends_on=[1],
        phase=PlanPhase.EXECUTION,
    )
    work_item = WorkItem(
        work_id="work-1",
        step_num=step.step_num,
        objective=step.objective,
    )

    builder = ContextPackBuilder(
        plan_state=DummyPlanState(goal="Deliver insights"),
        ledger=ledger,
        knowledge=knowledge,
        evidence=evidence,
    )

    context_pack = builder.build(step, work_item, worker_id="worker-1")

    assert knowledge.fact_count == 1  # expired fact was evicted
    assert len(context_pack.relevant_facts) == 1
    assert context_pack.relevant_facts[0].key == "fact:fresh"
    assert len(context_pack.relevant_evidence) == 1

    llm_context = context_pack.to_llm_context()
    assert "GOAL: Deliver insights" in llm_context["instructions"]
    assert "fact:fresh" in llm_context["known_facts"]
    assert context_pack.estimated_tokens > 0


# ---------------------------------------------------------------------------
# WorkLedger
# ---------------------------------------------------------------------------


def test_work_ledger_records_dispatch_and_completion():
    ledger = WorkLedger()
    work_item = WorkItem(work_id="work-1", step_num=1, objective="Do something important")

    entry_id = ledger.record_dispatch(step_num=1, work_item=work_item, worker_id="worker-7")
    entries = ledger.get_step_history(1)
    assert len(entries) == 1
    assert entries[0].status == EntryStatus.DISPATCHED

    outcome = WorkerOutcome(
        work_id=work_item.work_id,
        worker_id="worker-7",
        step_num=1,
        success=True,
        status=PlanStatus.COMPLETED,
        final_response="all done",
        observations=["checked files"],
        entity_refs=["/tmp/example"],
        tool_calls_made=2,
        tool_calls_succeeded=2,
        llm_calls_made=1,
        duration_ms=25.0,
    )

    ledger.record_completion(entry_id, outcome)
    completed_entries = ledger.get_step_history(1)

    assert completed_entries[0].status == EntryStatus.COMPLETED
    assert completed_entries[0].outcome_summary == "all done"
    assert completed_entries[0].observations == ["checked files"]
    assert completed_entries[0].tool_calls_made == 2
    assert completed_entries[0].llm_calls_made == 1


def test_work_ledger_evicts_oldest_completed_entries():
    ledger = WorkLedger(max_entries=2)
    work_item = WorkItem(work_id="work-1", step_num=1, objective="First")
    entry1 = ledger.record_dispatch(step_num=1, work_item=work_item, worker_id="w1")
    outcome1 = WorkerOutcome(
        work_id=work_item.work_id,
        worker_id="w1",
        step_num=1,
        success=True,
        status=PlanStatus.COMPLETED,
    )
    ledger.record_completion(entry1, outcome1)

    work_item2 = WorkItem(work_id="work-2", step_num=2, objective="Second")
    entry2 = ledger.record_dispatch(step_num=2, work_item=work_item2, worker_id="w2")
    outcome2 = WorkerOutcome(
        work_id=work_item2.work_id,
        worker_id="w2",
        step_num=2,
        success=True,
        status=PlanStatus.COMPLETED,
    )
    ledger.record_completion(entry2, outcome2)

    work_item3 = WorkItem(work_id="work-3", step_num=3, objective="Third")
    entry3 = ledger.record_dispatch(step_num=3, work_item=work_item3, worker_id="w3")

    assert ledger.total_entries == 2
    assert entry1 not in {e.entry_id for e in ledger.get_recent_entries(5)}
    assert entry2 in ledger._by_id  # newer completed entry should remain
    assert ledger._by_id[entry3].status == EntryStatus.DISPATCHED


# ---------------------------------------------------------------------------
# Worker execution
# ---------------------------------------------------------------------------


def _make_context_and_item(bounds: Optional[WorkBounds] = None):
    work_item = WorkItem(
        work_id="item-1",
        step_num=1,
        objective="Solve the task",
        bounds=bounds or WorkBounds(),
    )
    context_pack = ContextPack(
        pack_id="pack-1",
        step_num=1,
        worker_id="worker-1",
        instructions="Follow the plan",
        objective="Solve the task",
        max_tool_calls=work_item.bounds.max_tool_calls,
        max_duration_ms=work_item.bounds.max_duration_ms,
    )
    return context_pack, work_item


def test_worker_returns_final_response_without_tools():
    """
    Test worker returning final response without tool calls.

    NOTE: The stricter verification requires evidence for SUCCESS.
    Without tool calls, there's no evidence, so this results in PARTIAL success
    (completion_claim=True but no completion_evidence).

    This is the expected behavior per the verification spec:
    - SUCCESS requires: completion_claim AND completion_evidence
    - PARTIAL: progress made but not fully verified
    """
    context_pack, work_item = _make_context_and_item()
    tool_registry = StubToolRegistry()
    # Long response with implicit final (no explicit marker)
    llm = SequenceLLM(
        [
            StubResponse(
                content=(
                    "All set. I reviewed the provided context and produced a detailed answer "
                    "without needing additional tool calls."
                )
            )
        ]
    )

    worker = Worker(tool_registry=tool_registry, llm=llm, config=WorkerConfig(max_iterations=3))
    outcome = worker.execute(context_pack=context_pack, work_item=work_item)

    # Without tool calls, there's no evidence - this is PARTIAL success
    assert outcome.completion_claim is True  # Claimed completion
    assert len(outcome.completion_evidence) == 0  # But no evidence
    assert outcome.success is False  # Strict verification fails without evidence
    assert outcome.status == PlanStatus.COMPLETED  # Status can still be COMPLETED for flow
    assert "All set." in outcome.final_response
    assert outcome.llm_calls_made == 1
    assert outcome.tool_calls_made == 0
    assert outcome.termination_reason == "implicit_final"


def test_worker_processes_tools_and_tracks_entity_refs():
    """
    Test worker executing tool calls and tracking entity references.

    The worker needs a [FINAL] marker or long enough response to terminate cleanly.
    """
    context_pack, work_item = _make_context_and_item()
    tool_call = StubToolCall(id=uuid.uuid4().hex[:8], name="file_read", arguments={"path": "/tmp/file.txt"})
    llm = SequenceLLM(
        [
            StubResponse(tool_calls=[tool_call]),
            # Use [FINAL] marker to explicitly signal completion
            StubResponse(content="[FINAL] Here is the summary based on the file content I read."),
        ]
    )
    tool_registry = StubToolRegistry(
        results={
            "file_read": ToolResult(
                status=ToolStatus.SUCCESS, output="data", metadata={"path": "/tmp/file.txt"}
            )
        }
    )

    worker = Worker(tool_registry=tool_registry, llm=llm, config=WorkerConfig(max_iterations=3))
    outcome = worker.execute(context_pack=context_pack, work_item=work_item)

    assert outcome.success is True
    assert "summary" in outcome.final_response.lower()  # [FINAL] marker is stripped
    assert outcome.tool_calls_made == 1
    assert outcome.tool_calls_succeeded == 1
    assert "/tmp/file.txt" in outcome.entity_refs
    assert "Tool file_read: success" in outcome.observations
    assert outcome.llm_calls_made == 2
    assert outcome.termination_reason == "completed"


def test_worker_stops_when_llm_call_limit_hit_after_failed_tool():
    """
    Test worker stops when a limit is reached after a failed tool call.

    With max_tool_calls=1 and max_llm_calls=1, the tool call limit is hit first
    because tool calls are checked before the next LLM call.
    """
    bounds = WorkBounds(max_tool_calls=1, max_llm_calls=1)
    context_pack, work_item = _make_context_and_item(bounds=bounds)
    tool_call = StubToolCall(id="call1", name="failing_tool", arguments={})
    llm = SequenceLLM([StubResponse(tool_calls=[tool_call])])
    tool_registry = StubToolRegistry(
        results={
            "failing_tool": ToolResult(
                status=ToolStatus.ERROR, output=None, error="boom"
            )
        }
    )

    worker = Worker(tool_registry=tool_registry, llm=llm, config=WorkerConfig(max_iterations=2))
    outcome = worker.execute(context_pack=context_pack, work_item=work_item)

    assert outcome.success is False
    assert outcome.status == PlanStatus.FAILED
    # Error message format changed - check for key parts
    assert "failed" in outcome.error.lower()
    assert outcome.tool_calls_failed == 1
    assert "Tool failing_tool: failed" in outcome.observations
    # Tool call limit hit first (checked after tool execution, before next LLM call)
    assert outcome.termination_reason == "max_tool_calls"
