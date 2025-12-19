# Wizard Orchestration Layer - Implementation Specification

## Overview

Replaces the rigid Plan→Execute→Reflect pipeline with an adaptive Wizard (outer loop) + Workers (inner loop) architecture. The Wizard owns single-writer global state and delegates bounded work to stateless Workers.

## Non-negotiable Invariants

1. **Single-writer global state**: Only the Wizard may mutate global plan/state. Workers NEVER directly mutate the plan or global state.
2. **Append-only ledgers**: All worker outputs are appended to an immutable ledger (audit trail). No rewriting history.
3. **Versioned plan swaps**: A plan may be replaced/updated only via a versioned patch/apply mechanism guarded by policy. Never "silently" overwrite.
4. **Immutable step objectives**: Steps have immutable objective text once created. Replanning changes the future step list, not the objective of an existing step.
5. **Bounded autonomy**: Workers can call tools and propose plan changes, but the Wizard decides.
6. **No stalls / no trivial questions**: Make reasonable assumptions, proceed, and encode uncertainties in structured outputs. Do not block on minor clarifications.

---

## Architecture

```
User Request
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                        WIZARD                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  PlanState  │  │ WorkLedger  │  │ KnowledgeStore      │  │
│  │  (v1→v2→..) │  │ (append)    │  │ EvidenceStore       │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                           │                                  │
│         ┌─────────────────┼─────────────────┐               │
│         ▼                 ▼                 ▼               │
│   ┌──────────┐      ┌──────────┐      ┌──────────┐         │
│   │ContextPack│      │ WorkItem │      │ PolicyGate│         │
│   └──────────┘      └──────────┘      └──────────┘         │
│         │                 │                 ▲               │
│         └────────┬────────┘                 │               │
│                  ▼                          │               │
│            ┌──────────┐              ┌──────────┐           │
│            │  WORKER  │─────────────▶│ PlanPatch│           │
│            │(stateless)│              └──────────┘           │
│            └──────────┘                                      │
│                  │                                           │
│                  ▼                                           │
│         ┌───────────────┐                                   │
│         │ WorkerOutcome │                                   │
│         └───────────────┘                                   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
AgentResponse
```

---

## File Structure

```
src/harness/agent/wizard/
├── __init__.py           # Public exports
├── wizard.py             # Main Wizard orchestrator
├── worker.py             # Stateless Worker executor
├── plan_state.py         # Versioned plan state
├── work_ledger.py        # Append-only work history
├── knowledge_store.py    # Accumulated facts
├── evidence_store.py     # Execution evidence
├── context_pack.py       # Worker context assembly
├── work_item.py          # Bounded work units
├── plan_patch.py         # Plan mutation protocol
├── policy_gate.py        # Patch validation
└── stagnation.py         # Stagnation detection
```

---

## Type Imports from Existing Code

```python
# From plan_models.py
from harness.agent.plan_models import (
    Plan, PlanStep, PlanStatus, PlanPhase,
    SuccessCriteria, StepResult, ExecutionTrace,
    Reflection, ToolCallRecord, Discovery, DiscoveryType
)

# From tool_registry.py
from harness.agent.tool_registry import ToolRegistry, ToolResult, ToolStatus

# From agent.py
from harness.agent.agent import AgentResponse

# From util/llm_adapter.py
from util.llm_adapter import LLMAdapter, Message, MessageRole
```

---

## Module Specifications

### 1. plan_state.py - Versioned Plan State

```python
"""
Versioned, single-writer plan state.
Only Wizard may modify. Steps become frozen once DONE.
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, TYPE_CHECKING

from harness.agent.plan_models import Plan, PlanStep, PlanStatus, PlanPhase

if TYPE_CHECKING:
    from .plan_patch import PlanPatch


@dataclass
class StepState:
    """Runtime state for a single step."""
    step_num: int
    status: PlanStatus
    objective: str              # IMMUTABLE once created
    tool_hint: Optional[str]
    depends_on: List[int]
    phase: PlanPhase

    # Lifecycle
    is_frozen: bool = False     # True when DONE - cannot be modified
    started_at: Optional[float] = None
    completed_at: Optional[float] = None

    # Worker tracking
    worker_id: Optional[str] = None
    outcome_summary: Optional[str] = None

    @classmethod
    def from_plan_step(cls, step: PlanStep) -> "StepState":
        """Create StepState from existing PlanStep."""
        return cls(
            step_num=step.step_num,
            status=step.status,
            objective=step.objective,
            tool_hint=step.tool_hint,
            depends_on=list(step.depends_on),
            phase=step.phase,
        )


@dataclass
class PlanState:
    """
    Single-writer global plan state owned by Wizard.

    INVARIANTS:
    - version increments on every modification
    - frozen steps cannot be modified
    - only FUTURE steps can be patched
    """
    plan_id: str
    version: int
    goal: str
    goal_type: str
    steps: Dict[int, StepState]

    # Phase tracking
    discovery_complete: bool = False
    execution_complete: bool = False

    # Timestamps
    created_at: float = field(default_factory=time.time)
    last_modified: float = field(default_factory=time.time)

    @classmethod
    def from_plan(cls, plan: Plan) -> "PlanState":
        """Create PlanState from Planner output."""
        steps = {
            s.step_num: StepState.from_plan_step(s)
            for s in plan.steps
        }
        return cls(
            plan_id=str(uuid.uuid4()),
            version=1,
            goal=plan.goal,
            goal_type=plan.goal_type,
            steps=steps,
        )

    def get_ready_steps(self) -> List[StepState]:
        """Get steps whose dependencies are satisfied and status is PENDING."""
        ready = []
        for step in self.steps.values():
            if step.status != PlanStatus.PENDING:
                continue
            if step.is_frozen:
                continue
            # Check all dependencies are COMPLETED
            deps_satisfied = all(
                self.steps.get(dep, StepState(0, PlanStatus.COMPLETED, "", None, [], PlanPhase.EXECUTION)).status == PlanStatus.COMPLETED
                for dep in step.depends_on
            )
            if deps_satisfied:
                ready.append(step)
        return ready

    def can_modify_step(self, step_num: int) -> bool:
        """Only PENDING steps that are not frozen can be modified."""
        step = self.steps.get(step_num)
        if step is None:
            return False
        return not step.is_frozen and step.status == PlanStatus.PENDING

    def freeze_step(self, step_num: int):
        """Mark step as frozen (DONE). Cannot be undone."""
        step = self.steps.get(step_num)
        if step:
            step.is_frozen = True
            step.completed_at = time.time()

    def mark_step_in_progress(self, step_num: int, worker_id: str):
        """Mark step as IN_PROGRESS with worker assignment."""
        step = self.steps.get(step_num)
        if step and self.can_modify_step(step_num):
            step.status = PlanStatus.IN_PROGRESS
            step.worker_id = worker_id
            step.started_at = time.time()
            self._bump_version()

    def mark_step_complete(self, step_num: int, outcome_summary: str):
        """Mark step as COMPLETED and freeze it."""
        step = self.steps.get(step_num)
        if step:
            step.status = PlanStatus.COMPLETED
            step.outcome_summary = outcome_summary
            step.completed_at = time.time()
            self.freeze_step(step_num)
            self._bump_version()

    def mark_step_failed(self, step_num: int, error: str):
        """Mark step as FAILED."""
        step = self.steps.get(step_num)
        if step:
            step.status = PlanStatus.FAILED
            step.outcome_summary = f"FAILED: {error}"
            self._bump_version()

    def apply_patch(self, patch: "PlanPatch") -> bool:
        """
        Apply patch atomically with version check.
        Returns True if successful, False if rejected.
        """
        # Version mismatch check
        if patch.base_plan_version != self.version:
            return False

        # Validate all operations target modifiable steps
        for op in patch.operations:
            if op.type.value not in ("insert",):  # INSERT doesn't need existing step
                if not self.can_modify_step(op.target_step):
                    return False

        # Apply operations
        for op in patch.operations:
            self._apply_operation(op)

        self._bump_version()
        return True

    def _apply_operation(self, op: "PatchOperation"):
        """Apply a single patch operation."""
        from .plan_patch import PatchType

        if op.type == PatchType.INSERT and op.new_step:
            # Find next step number
            next_num = max(self.steps.keys(), default=0) + 1
            new_state = StepState(
                step_num=next_num,
                status=PlanStatus.PENDING,
                objective=op.new_step.get("objective", ""),
                tool_hint=op.new_step.get("tool_hint"),
                depends_on=op.new_step.get("depends_on", []),
                phase=PlanPhase(op.new_step.get("phase", "execution")),
            )
            self.steps[next_num] = new_state

        elif op.type == PatchType.REPLACE and op.target_step in self.steps:
            step = self.steps[op.target_step]
            if op.new_objective:
                # Note: This violates immutability - only allow for PENDING steps
                if step.status == PlanStatus.PENDING:
                    step.objective = op.new_objective
            if op.new_tool_hint is not None:
                step.tool_hint = op.new_tool_hint

        elif op.type == PatchType.REMOVE and op.target_step in self.steps:
            step = self.steps[op.target_step]
            if step.status == PlanStatus.PENDING and not step.is_frozen:
                step.status = PlanStatus.SKIPPED

    def _bump_version(self):
        """Increment version and update timestamp."""
        self.version += 1
        self.last_modified = time.time()

    def is_complete(self) -> bool:
        """Check if all steps are complete or skipped."""
        return all(
            s.status in (PlanStatus.COMPLETED, PlanStatus.SKIPPED)
            for s in self.steps.values()
        )
```

---

### 2. work_ledger.py - Append-only Work History

```python
"""
Append-only work ledger for audit trail and debugging.
All worker dispatches and outcomes are recorded permanently.
"""

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .work_item import WorkItem
    from .worker import WorkerOutcome


class EntryStatus(Enum):
    """Status of a ledger entry."""
    PENDING = "pending"
    DISPATCHED = "dispatched"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class LedgerEntry:
    """Single entry in the append-only work ledger."""
    entry_id: str
    step_num: int
    worker_id: str
    work_item_summary: str
    dispatched_at: float

    # Filled on completion
    completed_at: Optional[float] = None
    status: EntryStatus = EntryStatus.PENDING
    outcome_summary: Optional[str] = None

    # Extracted observations
    observations: List[str] = field(default_factory=list)
    entity_refs: List[str] = field(default_factory=list)

    # Metrics
    tool_calls_made: int = 0
    llm_calls_made: int = 0
    duration_ms: float = 0


class WorkLedger:
    """
    Append-only work history owned by Wizard.

    INVARIANTS:
    - Entries can only be appended, never removed or modified
    - Exception: completion data can be added to a DISPATCHED entry
    """

    def __init__(self, max_entries: int = 1000):
        self._entries: List[LedgerEntry] = []
        self._by_step: Dict[int, List[str]] = {}  # step_num -> [entry_ids]
        self._by_id: Dict[str, LedgerEntry] = {}
        self._max_entries = max_entries

    def record_dispatch(
        self,
        step_num: int,
        work_item: "WorkItem",
        worker_id: str
    ) -> str:
        """
        Record work dispatch. Returns entry_id.
        This is the ONLY way to add entries.
        """
        entry_id = str(uuid.uuid4())[:8]
        entry = LedgerEntry(
            entry_id=entry_id,
            step_num=step_num,
            worker_id=worker_id,
            work_item_summary=work_item.objective[:100],
            dispatched_at=time.time(),
            status=EntryStatus.DISPATCHED,
        )

        self._entries.append(entry)
        self._by_id[entry_id] = entry
        self._by_step.setdefault(step_num, []).append(entry_id)

        return entry_id

    def record_completion(self, entry_id: str, outcome: "WorkerOutcome"):
        """
        Record completion of a dispatched work item.
        Only modifies completion fields - does not remove or replace entry.
        """
        entry = self._by_id.get(entry_id)
        if entry is None or entry.status != EntryStatus.DISPATCHED:
            return

        entry.completed_at = time.time()
        entry.status = EntryStatus.COMPLETED if outcome.success else EntryStatus.FAILED
        entry.outcome_summary = outcome.final_response[:200] if outcome.final_response else None
        entry.observations = list(outcome.observations)
        entry.entity_refs = list(outcome.entity_refs)
        entry.tool_calls_made = outcome.tool_calls_made
        entry.duration_ms = outcome.duration_ms

    def get_step_history(self, step_num: int) -> List[LedgerEntry]:
        """Get all entries for a step in chronological order."""
        entry_ids = self._by_step.get(step_num, [])
        return [self._by_id[eid] for eid in entry_ids]

    def get_recent_entries(self, n: int = 10) -> List[LedgerEntry]:
        """Get N most recent entries."""
        return list(self._entries[-n:])

    def summarize_tail(self, n: int = 5) -> str:
        """
        brief_summarize_work_done() - compact summary for context injection.
        Returns ~200 tokens max.
        """
        entries = self.get_recent_entries(n)
        if not entries:
            return "RECENT WORK: None"

        lines = ["RECENT WORK:"]
        for e in entries:
            status = "OK" if e.status == EntryStatus.COMPLETED else e.status.value.upper()
            summary = e.work_item_summary[:50]
            lines.append(f"- Step {e.step_num}: {summary} [{status}]")

        return "\n".join(lines)

    @property
    def total_entries(self) -> int:
        return len(self._entries)
```

---

### 3. knowledge_store.py - Accumulated Facts

```python
"""
Append-only knowledge store for accumulated facts.
Facts can be added or superseded but never deleted.
"""

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class FactSource(Enum):
    """Where a fact came from."""
    TOOL = "tool"
    INFERENCE = "inference"
    USER = "user"
    COMPACTION = "compaction"


@dataclass
class KnowledgeFact:
    """A single accumulated fact."""
    key: str              # Canonicalized key (e.g., "file:/path:exists")
    value: Any
    confidence: float     # 0.0 to 1.0
    source: FactSource
    timestamp: float = field(default_factory=time.time)

    # Provenance
    derived_from_entry: Optional[str] = None  # LedgerEntry ID
    tool_name: Optional[str] = None

    # Lifecycle
    ttl_seconds: Optional[int] = None
    is_pinned: bool = False  # Pinned facts survive compaction


class KnowledgeStore:
    """
    Append-only knowledge base owned by Wizard.

    Facts are keyed by canonicalized strings.
    New facts supersede old facts with same key.
    """

    def __init__(self, max_facts: int = 500):
        self._facts: Dict[str, KnowledgeFact] = {}
        self._history: List[KnowledgeFact] = []  # All facts ever added
        self._max_facts = max_facts

    def upsert(self, fact: KnowledgeFact):
        """
        Insert or update a fact.
        If key exists, new fact supersedes (but old is kept in history).
        """
        self._history.append(fact)
        self._facts[fact.key] = fact

        # Evict oldest non-pinned if over limit
        if len(self._facts) > self._max_facts:
            self._evict_oldest()

    def get(self, key: str) -> Optional[KnowledgeFact]:
        """Get fact by key, checking TTL."""
        fact = self._facts.get(key)
        if fact is None:
            return None

        # Check TTL
        if fact.ttl_seconds is not None:
            age = time.time() - fact.timestamp
            if age > fact.ttl_seconds:
                del self._facts[key]
                return None

        return fact

    def query_by_prefix(self, prefix: str) -> List[KnowledgeFact]:
        """Query facts by key prefix (e.g., 'file:')."""
        return [f for k, f in self._facts.items() if k.startswith(prefix)]

    def evict_expired(self):
        """Remove all expired facts."""
        now = time.time()
        to_remove = []
        for key, fact in self._facts.items():
            if fact.ttl_seconds is not None:
                if now - fact.timestamp > fact.ttl_seconds:
                    to_remove.append(key)
        for key in to_remove:
            del self._facts[key]

    def compact(self, budget_tokens: int) -> str:
        """
        Compact store to fit within token budget.
        Returns summary of compacted facts.
        """
        # Simple implementation: summarize and clear non-pinned facts
        summaries = []
        to_remove = []

        for key, fact in self._facts.items():
            if not fact.is_pinned:
                summaries.append(f"{key}: {str(fact.value)[:50]}")
                to_remove.append(key)

        for key in to_remove:
            del self._facts[key]

        if summaries:
            summary_text = "Compacted facts: " + "; ".join(summaries[:10])
            # Add compaction summary as a new pinned fact
            compaction_fact = KnowledgeFact(
                key=f"compaction:{int(time.time())}",
                value=summary_text,
                confidence=0.8,
                source=FactSource.COMPACTION,
                is_pinned=True,
            )
            self.upsert(compaction_fact)
            return summary_text

        return ""

    def _evict_oldest(self):
        """Evict oldest non-pinned fact."""
        oldest_key = None
        oldest_time = float('inf')

        for key, fact in self._facts.items():
            if not fact.is_pinned and fact.timestamp < oldest_time:
                oldest_time = fact.timestamp
                oldest_key = key

        if oldest_key:
            del self._facts[oldest_key]

    @property
    def fact_count(self) -> int:
        return len(self._facts)
```

---

### 4. evidence_store.py - Execution Evidence

```python
"""
Evidence store for execution artifacts and verification.
Records tool outputs, file changes, and validation results.
"""

import hashlib
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class EvidenceRecord:
    """Single evidence record."""
    evidence_id: str
    step_num: int
    evidence_type: str  # "file_created", "test_passed", "search_result", etc.
    description: str

    # Optional structured data
    path: Optional[str] = None
    content_hash: Optional[str] = None
    tool_name: Optional[str] = None
    tool_output: Optional[str] = None  # Truncated output

    # Timestamp
    recorded_at: float = field(default_factory=time.time)

    # Verification status
    verified: bool = False
    verification_method: Optional[str] = None
    verification_result: Optional[str] = None


class EvidenceStore:
    """
    Append-only evidence store owned by Wizard.
    Records proof of work done for reflection and verification.
    """

    def __init__(self, max_records: int = 500):
        self._records: Dict[str, EvidenceRecord] = {}
        self._by_step: Dict[int, List[str]] = {}
        self._max_records = max_records

    def record(self, evidence: EvidenceRecord):
        """Record new evidence."""
        if not evidence.evidence_id:
            evidence.evidence_id = str(uuid.uuid4())[:8]

        self._records[evidence.evidence_id] = evidence
        self._by_step.setdefault(evidence.step_num, []).append(evidence.evidence_id)

    def record_tool_output(
        self,
        step_num: int,
        tool_name: str,
        output: Any,
        evidence_type: str = "tool_output"
    ) -> str:
        """Convenience method to record tool output as evidence."""
        output_str = str(output)[:1000]  # Truncate
        content_hash = hashlib.sha256(output_str.encode()).hexdigest()[:16]

        evidence = EvidenceRecord(
            evidence_id=str(uuid.uuid4())[:8],
            step_num=step_num,
            evidence_type=evidence_type,
            description=f"{tool_name} output",
            tool_name=tool_name,
            tool_output=output_str,
            content_hash=content_hash,
        )
        self.record(evidence)
        return evidence.evidence_id

    def record_file_change(
        self,
        step_num: int,
        path: str,
        action: str,  # "created", "modified", "deleted"
        content_hash: Optional[str] = None
    ) -> str:
        """Record file system change as evidence."""
        evidence = EvidenceRecord(
            evidence_id=str(uuid.uuid4())[:8],
            step_num=step_num,
            evidence_type=f"file_{action}",
            description=f"File {action}: {path}",
            path=path,
            content_hash=content_hash,
        )
        self.record(evidence)
        return evidence.evidence_id

    def get_for_step(self, step_num: int) -> List[EvidenceRecord]:
        """Get all evidence for a step."""
        evidence_ids = self._by_step.get(step_num, [])
        return [self._records[eid] for eid in evidence_ids if eid in self._records]

    def verify_evidence(
        self,
        evidence_id: str,
        method: str,
        result: str,
        passed: bool
    ):
        """Mark evidence as verified."""
        evidence = self._records.get(evidence_id)
        if evidence:
            evidence.verified = passed
            evidence.verification_method = method
            evidence.verification_result = result

    def get_unverified(self, step_num: Optional[int] = None) -> List[EvidenceRecord]:
        """Get unverified evidence, optionally filtered by step."""
        records = self._records.values()
        if step_num is not None:
            evidence_ids = self._by_step.get(step_num, [])
            records = [self._records[eid] for eid in evidence_ids if eid in self._records]
        return [r for r in records if not r.verified]

    @property
    def record_count(self) -> int:
        return len(self._records)
```

---

### 5. work_item.py - Bounded Work Units

```python
"""
Work items are bounded units of work dispatched to Workers.
Each has clear success criteria and resource limits.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class WorkBounds:
    """Resource bounds for a work unit."""
    max_tool_calls: int = 5
    max_duration_ms: float = 60_000
    max_llm_calls: int = 3


@dataclass
class WorkItemCriteria:
    """Success criteria for a work item."""
    description: str = ""
    required_outputs: List[str] = field(default_factory=list)
    postconditions: List[str] = field(default_factory=list)
    verification_hints: List[str] = field(default_factory=list)


@dataclass
class WorkItem:
    """
    Bounded work unit dispatched to Worker.

    Workers receive WorkItems and return WorkerOutcomes.
    WorkItems are immutable once created.
    """
    work_id: str
    step_num: int
    objective: str

    # Guidance (not strict requirements)
    tool_hint: Optional[str] = None
    tool_args_hint: Optional[Dict[str, Any]] = None

    # Boundaries
    bounds: WorkBounds = field(default_factory=WorkBounds)
    success_criteria: WorkItemCriteria = field(default_factory=WorkItemCriteria)

    # Context references (not full content)
    preconditions_met: List[str] = field(default_factory=list)

    @classmethod
    def from_step_state(
        cls,
        step: "StepState",
        bounds: Optional[WorkBounds] = None
    ) -> "WorkItem":
        """Create WorkItem from StepState."""
        from .plan_state import StepState

        return cls(
            work_id=str(uuid.uuid4())[:8],
            step_num=step.step_num,
            objective=step.objective,
            tool_hint=step.tool_hint,
            bounds=bounds or WorkBounds(),
            success_criteria=WorkItemCriteria(
                description=f"Complete: {step.objective}"
            ),
        )
```

---

### 6. context_pack.py - Worker Context Assembly

```python
"""
Context packs are immutable bundles sent to Workers.
Contains everything a Worker needs to execute a WorkItem.
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .knowledge_store import KnowledgeFact
    from .evidence_store import EvidenceRecord
    from .plan_state import PlanState, StepState
    from .work_ledger import WorkLedger
    from .knowledge_store import KnowledgeStore
    from .evidence_store import EvidenceStore
    from .work_item import WorkItem


@dataclass
class ContextPack:
    """
    Immutable context bundle sent to Workers.
    Workers cannot modify the ContextPack.
    """
    pack_id: str
    step_num: int
    worker_id: str

    # Instructions
    instructions: str        # System prompt
    objective: str           # What worker should accomplish

    # Knowledge context
    relevant_facts: List["KnowledgeFact"] = field(default_factory=list)
    relevant_evidence: List["EvidenceRecord"] = field(default_factory=list)

    # Work history (summarized)
    work_summary: str = ""   # From brief_summarize_work_done()

    # Artifacts (file contents, search results)
    artifacts: Dict[str, str] = field(default_factory=dict)

    # Bounds
    max_tool_calls: int = 5
    max_duration_ms: float = 60_000

    # Token usage estimate
    estimated_tokens: int = 0

    def to_llm_context(self) -> Dict[str, Any]:
        """Convert to format for LLM call."""
        context = {
            "instructions": self.instructions,
            "objective": self.objective,
            "work_summary": self.work_summary,
        }

        # Add relevant facts
        if self.relevant_facts:
            facts_text = "\n".join(
                f"- {f.key}: {f.value}" for f in self.relevant_facts
            )
            context["known_facts"] = facts_text

        # Add artifacts
        if self.artifacts:
            context["artifacts"] = self.artifacts

        return context


class ContextPackBuilder:
    """
    Builds ContextPacks from global state.
    Handles context selection and compaction.
    """

    def __init__(
        self,
        plan_state: "PlanState",
        ledger: "WorkLedger",
        knowledge: "KnowledgeStore",
        evidence: "EvidenceStore",
        token_estimator: Optional[Any] = None,
    ):
        self.plan_state = plan_state
        self.ledger = ledger
        self.knowledge = knowledge
        self.evidence = evidence
        self.token_estimator = token_estimator

    def build(
        self,
        step: "StepState",
        work_item: "WorkItem",
        budget_tokens: int = 100_000
    ) -> ContextPack:
        """Build context pack within token budget."""
        worker_id = str(uuid.uuid4())[:8]

        # Build work summary
        work_summary = self.ledger.summarize_tail(n=5)

        # Get relevant facts (simple: all facts for now)
        relevant_facts = list(self.knowledge._facts.values())[:20]

        # Get relevant evidence from dependencies
        relevant_evidence = []
        for dep_num in step.depends_on:
            relevant_evidence.extend(self.evidence.get_for_step(dep_num))

        # Build instructions
        instructions = self._build_instructions(step, work_item)

        # Estimate tokens (rough)
        estimated_tokens = len(instructions) // 4 + len(work_summary) // 4

        return ContextPack(
            pack_id=str(uuid.uuid4())[:8],
            step_num=step.step_num,
            worker_id=worker_id,
            instructions=instructions,
            objective=work_item.objective,
            relevant_facts=relevant_facts,
            relevant_evidence=relevant_evidence,
            work_summary=work_summary,
            max_tool_calls=work_item.bounds.max_tool_calls,
            max_duration_ms=work_item.bounds.max_duration_ms,
            estimated_tokens=estimated_tokens,
        )

    def _build_instructions(self, step: "StepState", work_item: "WorkItem") -> str:
        """Build system instructions for worker."""
        lines = [
            f"GOAL: {self.plan_state.goal}",
            f"CURRENT STEP: {step.step_num}",
            f"OBJECTIVE: {work_item.objective}",
            "",
            "CONSTRAINTS:",
            f"- Max tool calls: {work_item.bounds.max_tool_calls}",
            f"- Max duration: {work_item.bounds.max_duration_ms}ms",
            "",
            "You are a Worker executing a bounded work item.",
            "Return observations, entity references, and patch hints.",
            "Do NOT attempt to modify the plan directly.",
        ]

        if work_item.tool_hint:
            lines.append(f"\nSUGGESTED TOOL: {work_item.tool_hint}")

        return "\n".join(lines)

    def should_compact(self, current_tokens: int, budget_tokens: int) -> bool:
        """Check if compaction needed (>50% budget)."""
        return current_tokens > budget_tokens * 0.5

    def compact(self) -> str:
        """Compact context by summarizing and persisting."""
        # Summarize ledger tail
        summary = self.ledger.summarize_tail(n=10)

        # Compact knowledge store
        knowledge_summary = self.knowledge.compact(budget_tokens=10000)

        return f"{summary}\n{knowledge_summary}"
```

---

### 7. worker.py - Stateless Inner Loop

```python
"""
Stateless Worker that executes bounded work items.
Workers NEVER mutate global state - all results go through WorkerOutcome.
"""

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from harness.agent.plan_models import PlanStatus
from harness.agent.tool_registry import ToolRegistry, ToolResult

from .context_pack import ContextPack
from .work_item import WorkItem


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

    # Completion status
    success: bool
    status: PlanStatus

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

    # Metrics
    tool_calls_made: int = 0
    llm_calls_made: int = 0
    duration_ms: float = 0


@dataclass
class WorkerConfig:
    """Worker configuration."""
    max_iterations: int = 10
    enable_adaptive_reasoning: bool = True


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
        config: Optional[WorkerConfig] = None
    ):
        self.tool_registry = tool_registry
        self.llm = llm
        self.config = config or WorkerConfig()

    def execute(
        self,
        context_pack: ContextPack,
        work_item: WorkItem
    ) -> WorkerOutcome:
        """
        Execute work item within bounds.

        CRITICAL: Worker NEVER mutates context_pack or global state.
        All observations go into WorkerOutcome.
        """
        start_time = time.time()

        outcome = WorkerOutcome(
            work_id=work_item.work_id,
            worker_id=context_pack.worker_id,
            step_num=work_item.step_num,
            success=False,
            status=PlanStatus.IN_PROGRESS,
        )

        try:
            # Build prompt from context pack
            llm_context = context_pack.to_llm_context()

            # Execute tool-calling loop
            tool_calls = 0
            final_content = None

            while tool_calls < work_item.bounds.max_tool_calls:
                # Get LLM decision
                response = self.llm.respond(
                    input=llm_context.get("objective", work_item.objective),
                    instructions=llm_context.get("instructions", ""),
                    tools=self.tool_registry.get_definitions(enabled_only=True)
                )

                outcome.llm_calls_made += 1

                # Check for tool calls
                if response.has_tool_calls:
                    for tool_call in response.tool_calls:
                        result = self.tool_registry.execute(
                            tool_call.name,
                            **tool_call.arguments
                        )
                        tool_calls += 1
                        outcome.tool_calls_made += 1

                        # Record observation
                        status_str = "success" if result.is_success else "failed"
                        outcome.observations.append(
                            f"Tool {tool_call.name}: {status_str}"
                        )

                        # Extract entity refs from metadata
                        if result.metadata:
                            path = result.metadata.get("path")
                            if path:
                                outcome.entity_refs.append(path)

                        # Suggest evidence
                        outcome.suggested_evidence.append({
                            "type": "tool_output",
                            "tool_name": tool_call.name,
                            "output": str(result.output)[:500] if result.output else None,
                            "success": result.is_success,
                        })
                else:
                    # No tool calls - LLM is done
                    final_content = response.content
                    break

            # Determine success
            outcome.success = final_content is not None or tool_calls > 0
            outcome.status = PlanStatus.COMPLETED if outcome.success else PlanStatus.FAILED
            outcome.final_response = final_content

        except Exception as e:
            outcome.success = False
            outcome.status = PlanStatus.FAILED
            outcome.error = str(e)

        outcome.duration_ms = (time.time() - start_time) * 1000
        return outcome
```

---

### 8. plan_patch.py - Plan Mutation Protocol

```python
"""
Plan patches are bounded mutations to FUTURE steps only.
All patches must pass through PolicyGate before application.
"""

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class PatchType(Enum):
    """Types of plan mutations."""
    INSERT = "insert"      # Add new step
    REPLACE = "replace"    # Replace step objective/hints
    REORDER = "reorder"    # Change step order
    SPLIT = "split"        # Split one step into multiple
    REMOVE = "remove"      # Remove pending step


@dataclass
class PatchOperation:
    """Single operation within a patch."""
    type: PatchType
    target_step: int       # Step being modified (or insert_after for INSERT)

    # For INSERT
    new_step: Optional[Dict[str, Any]] = None
    insert_after: Optional[int] = None

    # For REPLACE
    new_objective: Optional[str] = None
    new_tool_hint: Optional[str] = None

    # For REORDER
    new_position: Optional[int] = None

    # For SPLIT
    sub_steps: Optional[List[Dict[str, Any]]] = None


@dataclass
class PlanPatch:
    """
    Proposed modification to plan.
    Must pass PolicyGate before application.
    """
    patch_id: str
    base_plan_version: int  # Version this patch was created against

    operations: List[PatchOperation] = field(default_factory=list)

    justification: str = ""
    risk_flags: List[str] = field(default_factory=list)

    # Source tracking
    suggested_by_worker: Optional[str] = None
    suggested_at: float = field(default_factory=time.time)

    @classmethod
    def create_insert(
        cls,
        base_version: int,
        objective: str,
        tool_hint: Optional[str] = None,
        insert_after: int = -1,
        justification: str = "",
        worker_id: Optional[str] = None
    ) -> "PlanPatch":
        """Create a patch that inserts a new step."""
        return cls(
            patch_id=str(uuid.uuid4())[:8],
            base_plan_version=base_version,
            operations=[
                PatchOperation(
                    type=PatchType.INSERT,
                    target_step=insert_after,
                    new_step={
                        "objective": objective,
                        "tool_hint": tool_hint,
                        "phase": "execution",
                    },
                    insert_after=insert_after,
                )
            ],
            justification=justification,
            suggested_by_worker=worker_id,
        )

    @classmethod
    def create_remove(
        cls,
        base_version: int,
        step_num: int,
        justification: str = "",
        worker_id: Optional[str] = None
    ) -> "PlanPatch":
        """Create a patch that removes a pending step."""
        return cls(
            patch_id=str(uuid.uuid4())[:8],
            base_plan_version=base_version,
            operations=[
                PatchOperation(
                    type=PatchType.REMOVE,
                    target_step=step_num,
                )
            ],
            justification=justification,
            suggested_by_worker=worker_id,
        )
```

---

### 9. policy_gate.py - Patch Validation

```python
"""
PolicyGate validates PlanPatches before application.
Enforces version checking, rate limiting, and thrash detection.
"""

import time
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from .plan_state import PlanState
    from .plan_patch import PlanPatch


class PolicyViolation(Enum):
    """Types of policy violations."""
    VERSION_MISMATCH = "version_mismatch"
    MODIFYING_DONE_STEP = "modifying_done_step"
    RATE_LIMITED = "rate_limited"
    THRASH_DETECTED = "thrash_detected"
    INVALID_OPERATION = "invalid_operation"


@dataclass
class PolicyDecision:
    """Result of policy evaluation."""
    approved: bool
    violation: Optional[PolicyViolation] = None
    reason: Optional[str] = None


class PolicyGate:
    """
    Validates PlanPatches before application.

    RULES:
    1. Reject if base_plan_version != current_plan_version
    2. Reject if patch changes DONE (frozen) steps
    3. Rate limit: max N patches per M seconds
    4. Thrash detection: same step modified repeatedly
    """

    def __init__(
        self,
        max_patches_per_window: int = 5,
        window_seconds: float = 60.0,
        thrash_threshold: int = 3
    ):
        self.max_patches_per_window = max_patches_per_window
        self.window_seconds = window_seconds
        self.thrash_threshold = thrash_threshold

        # Patch history: (timestamp, target_steps)
        self._patch_history: List[Tuple[float, List[int]]] = []

    def evaluate(
        self,
        patch: "PlanPatch",
        plan_state: "PlanState"
    ) -> PolicyDecision:
        """
        Evaluate patch against all policies.
        Returns decision with approval status and any violation.
        """
        # Rule 1: Version mismatch
        version_check = self._check_version(patch, plan_state)
        if version_check:
            return PolicyDecision(
                approved=False,
                violation=version_check,
                reason=f"Patch version {patch.base_plan_version} != current {plan_state.version}"
            )

        # Rule 2: Modifying done steps
        done_check = self._check_done_steps(patch, plan_state)
        if done_check:
            return PolicyDecision(
                approved=False,
                violation=done_check,
                reason="Cannot modify frozen/completed steps"
            )

        # Rule 3: Rate limiting
        rate_check = self._check_rate_limit()
        if rate_check:
            return PolicyDecision(
                approved=False,
                violation=rate_check,
                reason=f"Rate limited: >{self.max_patches_per_window} patches in {self.window_seconds}s"
            )

        # Rule 4: Thrash detection
        target_steps = [op.target_step for op in patch.operations]
        thrash_check = self._check_thrash(target_steps)
        if thrash_check:
            return PolicyDecision(
                approved=False,
                violation=thrash_check,
                reason="Thrash detected: same step modified repeatedly"
            )

        # All checks passed - record this patch
        self._record_patch(target_steps)

        return PolicyDecision(approved=True)

    def _check_version(
        self,
        patch: "PlanPatch",
        plan_state: "PlanState"
    ) -> Optional[PolicyViolation]:
        """Check for version mismatch."""
        if patch.base_plan_version != plan_state.version:
            return PolicyViolation.VERSION_MISMATCH
        return None

    def _check_done_steps(
        self,
        patch: "PlanPatch",
        plan_state: "PlanState"
    ) -> Optional[PolicyViolation]:
        """Check if patch modifies done/frozen steps."""
        from .plan_patch import PatchType

        for op in patch.operations:
            # INSERT doesn't need existing step
            if op.type == PatchType.INSERT:
                continue

            step = plan_state.steps.get(op.target_step)
            if step and step.is_frozen:
                return PolicyViolation.MODIFYING_DONE_STEP

        return None

    def _check_rate_limit(self) -> Optional[PolicyViolation]:
        """Check if we're over the rate limit."""
        self._clean_old_history()

        if len(self._patch_history) >= self.max_patches_per_window:
            return PolicyViolation.RATE_LIMITED

        return None

    def _check_thrash(self, target_steps: List[int]) -> Optional[PolicyViolation]:
        """Check for thrash pattern (same step modified repeatedly)."""
        self._clean_old_history()

        for step in target_steps:
            count = sum(
                1 for _, steps in self._patch_history
                if step in steps
            )
            if count >= self.thrash_threshold:
                return PolicyViolation.THRASH_DETECTED

        return None

    def _clean_old_history(self):
        """Remove patches outside the time window."""
        cutoff = time.time() - self.window_seconds
        self._patch_history = [
            (t, s) for t, s in self._patch_history
            if t > cutoff
        ]

    def _record_patch(self, target_steps: List[int]):
        """Record a patch for rate limiting and thrash detection."""
        self._patch_history.append((time.time(), target_steps))
```

---

### 10. stagnation.py - Stagnation Detection

```python
"""
Stagnation detection for identifying and handling stuck execution.
Detects retry loops, identical outputs, and global stagnation.
"""

import hashlib
from dataclasses import dataclass
from typing import Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .work_ledger import WorkLedger, EntryStatus
    from .worker import WorkerOutcome
    from .plan_state import PlanState
    from .plan_patch import PlanPatch


@dataclass
class StagnationSignal:
    """Signal indicating stagnation detected."""
    detected: bool
    severity: float  # 0.0 to 1.0
    reason: str
    step_num: Optional[int] = None
    suggested_action: str = ""


class StagnationDetector:
    """
    Detects execution stagnation for escalation.

    SIGNALS:
    1. Too many retries on same step
    2. Identical outputs (spinning)
    3. No progress across multiple steps
    """

    def __init__(
        self,
        max_retries_per_step: int = 3,
        max_identical_outputs: int = 3,
        no_progress_threshold: int = 10
    ):
        self.max_retries_per_step = max_retries_per_step
        self.max_identical_outputs = max_identical_outputs
        self.no_progress_threshold = no_progress_threshold

        # Track output hashes per step
        self._output_hashes: Dict[int, List[str]] = {}

    def check(
        self,
        step_num: int,
        ledger: "WorkLedger",
        outcome: Optional["WorkerOutcome"] = None
    ) -> StagnationSignal:
        """
        Check for stagnation signals.
        Returns signal if stagnation detected.
        """
        from .work_ledger import EntryStatus

        # Signal 1: Too many retries
        history = ledger.get_step_history(step_num)
        if len(history) >= self.max_retries_per_step:
            return StagnationSignal(
                detected=True,
                severity=0.8,
                reason=f"Step {step_num} retried {len(history)} times",
                step_num=step_num,
                suggested_action="skip_step"
            )

        # Signal 2: Identical outputs
        if outcome and outcome.final_response:
            output_hash = hashlib.md5(
                outcome.final_response.encode()
            ).hexdigest()[:8]

            self._output_hashes.setdefault(step_num, []).append(output_hash)
            hashes = self._output_hashes[step_num]

            if len(hashes) >= self.max_identical_outputs:
                recent = hashes[-self.max_identical_outputs:]
                if len(set(recent)) == 1:
                    return StagnationSignal(
                        detected=True,
                        severity=0.9,
                        reason=f"Step {step_num} producing identical outputs",
                        step_num=step_num,
                        suggested_action="pivot_approach"
                    )

        # Signal 3: Global stagnation (no completions recently)
        recent = ledger.get_recent_entries(self.no_progress_threshold)
        if len(recent) >= self.no_progress_threshold:
            completed = sum(
                1 for e in recent
                if e.status == EntryStatus.COMPLETED
            )
            if completed == 0:
                return StagnationSignal(
                    detected=True,
                    severity=1.0,
                    reason="No steps completed in recent work items",
                    suggested_action="abort_or_simplify"
                )

        return StagnationSignal(detected=False, severity=0.0, reason="")

    def escalate(
        self,
        signal: StagnationSignal,
        plan_state: "PlanState"
    ) -> Optional["PlanPatch"]:
        """
        Generate escalation patch based on stagnation signal.
        Returns patch to skip step or add recovery step.
        """
        from .plan_patch import PlanPatch

        if not signal.detected:
            return None

        if signal.suggested_action == "skip_step" and signal.step_num:
            return PlanPatch.create_remove(
                base_version=plan_state.version,
                step_num=signal.step_num,
                justification=f"Stagnation: {signal.reason}"
            )

        # For other cases, could add recovery steps
        return None

    def reset_step(self, step_num: int):
        """Reset tracking for a step (called on successful completion)."""
        self._output_hashes.pop(step_num, None)
```

---

### 11. wizard.py - Main Orchestrator

```python
"""
Wizard is the outer-loop orchestrator that owns single-writer global state.
Dispatches bounded work to Workers and coordinates plan evolution.
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from harness.agent.plan_models import Plan, PlanStatus, Reflection
from harness.agent.tool_registry import ToolRegistry
from harness.agent.agent import AgentResponse, AgentStep

from .plan_state import PlanState
from .work_ledger import WorkLedger
from .knowledge_store import KnowledgeStore, KnowledgeFact, FactSource
from .evidence_store import EvidenceStore, EvidenceRecord
from .context_pack import ContextPackBuilder
from .work_item import WorkItem, WorkBounds
from .worker import Worker, WorkerConfig, WorkerOutcome
from .plan_patch import PlanPatch
from .policy_gate import PolicyGate, PolicyDecision
from .stagnation import StagnationDetector, StagnationSignal


@dataclass
class WizardConfig:
    """Wizard configuration."""
    max_workers: int = 1              # Parallel workers (start with 1)
    max_iterations: int = 50
    context_budget_tokens: int = 100_000
    compaction_threshold: float = 0.5  # Compact when >50% budget


@dataclass
class WizardResult:
    """Result of Wizard orchestration."""
    success: bool
    final_response: str
    plan_state: PlanState
    ledger: WorkLedger

    # Metrics
    total_iterations: int
    total_tool_calls: int
    total_llm_calls: int
    duration_ms: float

    # For compatibility
    steps_completed: int = 0
    steps_failed: int = 0

    def to_agent_response(self) -> AgentResponse:
        """Convert to AgentResponse for interoperability."""
        return AgentResponse(
            content=self.final_response,
            structured_action=self.plan_state.goal,
            steps=[],  # Could convert ledger entries to AgentSteps
            total_duration_ms=self.duration_ms,
            tools_used=[],  # Could extract from ledger
            success=self.success,
            error=None if self.success else "Wizard orchestration failed",
            plan=None,  # Could reconstruct Plan from PlanState
            reflection=Reflection(
                plan_goal=self.plan_state.goal,
                goal_achieved=self.success,
                confidence=0.8 if self.success else 0.3,
                evidence=[self.ledger.summarize_tail()],
                gaps=[],
                suggestions=[],
            ),
            goal_achieved=self.success,
            metadata={
                "wizard": True,
                "iterations": self.total_iterations,
                "plan_version": self.plan_state.version,
            }
        )


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
    """

    def __init__(
        self,
        tool_registry: ToolRegistry,
        llm: Any,  # LLMAdapter
        planner: Any,  # Planner
        config: Optional[WizardConfig] = None
    ):
        self.tool_registry = tool_registry
        self.llm = llm
        self.planner = planner
        self.config = config or WizardConfig()

        # Single-writer state (created per orchestration)
        self._plan_state: Optional[PlanState] = None
        self._ledger: Optional[WorkLedger] = None
        self._knowledge: Optional[KnowledgeStore] = None
        self._evidence: Optional[EvidenceStore] = None

        # Components
        self._policy_gate = PolicyGate()
        self._stagnation_detector = StagnationDetector()
        self._context_builder: Optional[ContextPackBuilder] = None

        # Worker
        self._worker = Worker(tool_registry, llm, WorkerConfig())

    def orchestrate(
        self,
        user_input: str,
        context: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None
    ) -> WizardResult:
        """
        Main orchestration loop.

        1. Create plan via Planner
        2. Initialize state stores
        3. Loop until complete or stagnated:
           a. Select ready WorkItems
           b. Build ContextPacks
           c. Dispatch to Workers
           d. Ingest outcomes
           e. Apply patches
           f. Check stagnation
        4. Return result
        """
        start_time = time.time()
        total_tool_calls = 0
        total_llm_calls = 0

        # Step 1: Create plan
        plan = self.planner.create_plan(
            user_input=user_input,
            context=context,
            budget=budget
        )

        # Step 2: Initialize state
        self._initialize_state(plan)

        # Step 3: Main loop
        iteration = 0
        final_response = None

        while iteration < self.config.max_iterations:
            iteration += 1

            # Check completion
            if self._plan_state.is_complete():
                break

            # Select ready steps
            ready_steps = self._plan_state.get_ready_steps()
            if not ready_steps:
                # No steps ready - might be blocked or done
                break

            # Process first ready step (single worker for now)
            step = ready_steps[0]

            # Create work item
            work_bounds = WorkBounds()
            if budget:
                work_bounds.max_tool_calls = min(
                    work_bounds.max_tool_calls,
                    budget.get("max_tool_calls", 5)
                )

            work_item = WorkItem.from_step_state(step, bounds=work_bounds)

            # Mark step in progress
            worker_id = str(uuid.uuid4())[:8]
            self._plan_state.mark_step_in_progress(step.step_num, worker_id)

            # Record dispatch in ledger
            entry_id = self._ledger.record_dispatch(
                step.step_num, work_item, worker_id
            )

            # Build context and dispatch
            context_pack = self._context_builder.build(
                step, work_item,
                budget_tokens=self.config.context_budget_tokens
            )

            # Check compaction
            if self._context_builder.should_compact(
                context_pack.estimated_tokens,
                self.config.context_budget_tokens
            ):
                self._context_builder.compact()

            # Execute worker
            outcome = self._worker.execute(context_pack, work_item)

            # Update metrics
            total_tool_calls += outcome.tool_calls_made
            total_llm_calls += outcome.llm_calls_made

            # Ingest outcome
            self._ingest_outcome(outcome, entry_id)

            # Process patch hints
            self._process_patch_hints(outcome)

            # Check stagnation
            signal = self._stagnation_detector.check(
                step.step_num, self._ledger, outcome
            )
            if signal.detected:
                escalation_patch = self._stagnation_detector.escalate(
                    signal, self._plan_state
                )
                if escalation_patch:
                    decision = self._policy_gate.evaluate(
                        escalation_patch, self._plan_state
                    )
                    if decision.approved:
                        self._plan_state.apply_patch(escalation_patch)

            # Capture final response from last successful step
            if outcome.final_response:
                final_response = outcome.final_response

        # Build result
        duration_ms = (time.time() - start_time) * 1000

        return WizardResult(
            success=self._plan_state.is_complete(),
            final_response=final_response or "Task processing complete.",
            plan_state=self._plan_state,
            ledger=self._ledger,
            total_iterations=iteration,
            total_tool_calls=total_tool_calls,
            total_llm_calls=total_llm_calls,
            duration_ms=duration_ms,
        )

    def _initialize_state(self, plan: Plan):
        """Initialize all state stores from plan."""
        self._plan_state = PlanState.from_plan(plan)
        self._ledger = WorkLedger()
        self._knowledge = KnowledgeStore()
        self._evidence = EvidenceStore()

        # Initialize context builder
        self._context_builder = ContextPackBuilder(
            plan_state=self._plan_state,
            ledger=self._ledger,
            knowledge=self._knowledge,
            evidence=self._evidence,
        )

        # Add initial knowledge from plan
        self._knowledge.upsert(KnowledgeFact(
            key="goal",
            value=plan.goal,
            confidence=1.0,
            source=FactSource.USER,
            is_pinned=True,
        ))

    def _ingest_outcome(self, outcome: WorkerOutcome, entry_id: str):
        """Ingest worker outcome into stores."""
        # Update ledger
        self._ledger.record_completion(entry_id, outcome)

        # Update plan state
        if outcome.success:
            self._plan_state.mark_step_complete(
                outcome.step_num,
                outcome.final_response or "Completed"
            )
            self._stagnation_detector.reset_step(outcome.step_num)
        else:
            self._plan_state.mark_step_failed(
                outcome.step_num,
                outcome.error or "Unknown error"
            )

        # Ingest suggested facts
        for fact_data in outcome.suggested_facts:
            fact = KnowledgeFact(
                key=fact_data.get("key", f"fact:{time.time()}"),
                value=fact_data.get("value"),
                confidence=fact_data.get("confidence", 0.7),
                source=FactSource.TOOL,
            )
            self._knowledge.upsert(fact)

        # Ingest suggested evidence
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

    def _process_patch_hints(self, outcome: WorkerOutcome):
        """Convert worker patch hints to patches and apply via PolicyGate."""
        for hint in outcome.patch_hints:
            # Convert hint to patch
            if hint.get("action") == "add_step":
                patch = PlanPatch.create_insert(
                    base_version=self._plan_state.version,
                    objective=hint.get("objective", ""),
                    tool_hint=hint.get("tool_hint"),
                    justification=f"Worker hint: {hint.get('reason', '')}",
                    worker_id=outcome.worker_id,
                )

                # Evaluate and apply
                decision = self._policy_gate.evaluate(patch, self._plan_state)
                if decision.approved:
                    self._plan_state.apply_patch(patch)
```

---

## Integration Point

Add to `agent.py`:

```python
# In Agent.__init__:
self._use_wizard = os.getenv("AGENT_USE_WIZARD", "0") == "1"
self._wizard: Optional["Wizard"] = None

if self._use_wizard and self._llm:
    from .wizard import Wizard, WizardConfig
    self._wizard = Wizard(
        tool_registry=self.tool_registry,
        llm=self._llm,
        planner=self._planner,
        config=WizardConfig()
    )

# In Agent.run():
if self._use_wizard and self._wizard:
    result = self._wizard.orchestrate(user_input, context, budget, on_stream_chunk)
    return result.to_agent_response()
# else: existing Plan→Execute→Reflect path
```

---

## Feature Flag

Enable with: `AGENT_USE_WIZARD=1`

This preserves the existing Plan→Execute→Reflect path while allowing opt-in to the new Wizard orchestration.

---

## Example Trace

```
1. User: "Add logging to auth.py"

2. Wizard: Create plan via Planner
   - Step 1: Read auth.py to understand structure
   - Step 2: Add logging imports and calls
   - Step 3: Verify changes compile

3. Wizard: Initialize PlanState v1, empty ledger/stores

4. Iteration 1:
   - Select Step 1 (PENDING, deps satisfied)
   - Create WorkItem: "Read auth.py to understand structure"
   - Build ContextPack with goal + objective
   - Dispatch to Worker
   - Worker executes file_read, returns WorkerOutcome:
     - success=True
     - observations=["Tool file_read: success"]
     - entity_refs=["auth.py"]
     - suggested_evidence=[{type: "file_read", output: "..."}]
   - Ingest:
     - Ledger: record completion
     - PlanState: mark Step 1 COMPLETED, freeze
     - Evidence: record file_read output

5. Iteration 2:
   - Select Step 2 (PENDING, deps [1] satisfied)
   - Create WorkItem: "Add logging imports and calls"
   - Build ContextPack with work_summary from ledger
   - Dispatch to Worker
   - Worker executes file_write, returns WorkerOutcome:
     - success=True
     - patch_hints=[{action: "add_step", objective: "run tests"}]
   - Ingest outcome
   - Process patch hint:
     - Create PlanPatch (INSERT step 4)
     - PolicyGate.evaluate() → approved
     - PlanState.apply_patch() → v2, Step 4 added

6. Continue until all steps complete

7. Return WizardResult:
   - success=True
   - final_response="Added logging to auth.py"
   - Convert to AgentResponse
```
