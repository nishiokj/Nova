"""
Context packs are immutable bundles sent to Workers.
Contains everything a Worker needs to execute a WorkItem.
"""

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


@dataclass(frozen=True)
class ContextPack:
    """
    Immutable context bundle sent to Workers.
    Workers cannot modify the ContextPack (enforced via frozen=True).
    """

    pack_id: str
    step_num: int
    worker_id: str

    # Instructions
    instructions: str  # System prompt
    objective: str  # What worker should accomplish

    # Knowledge context - using tuples for true immutability
    relevant_facts: tuple = field(default_factory=tuple)
    relevant_evidence: tuple = field(default_factory=tuple)

    # Work history (summarized)
    work_summary: str = ""  # From brief_summarize_work_done()

    # Artifacts (file contents, search results) - frozen dict not available, use tuple of pairs
    artifacts: tuple = field(default_factory=tuple)

    # Bounds
    max_tool_calls: int = 5
    max_duration_ms: float = 60_000

    # Token usage estimate
    estimated_tokens: int = 0

    def to_llm_context(self) -> Dict[str, Any]:
        """Convert to format for LLM call."""
        context: Dict[str, Any] = {
            "instructions": self.instructions,
            "objective": self.objective,
            "work_summary": self.work_summary,
        }

        if self.relevant_facts:
            facts_text = "\n".join(
                f"- {fact.key}: {fact.value}" for fact in self.relevant_facts
            )
            context["known_facts"] = facts_text

        if self.artifacts:
            # Convert tuple of (key, value) pairs back to dict for LLM context
            context["artifacts"] = dict(self.artifacts)

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
        budget_tokens: int = 100_000,
        worker_id: Optional[str] = None,
    ) -> ContextPack:
        """Build context pack within token budget."""
        worker_id = worker_id or str(uuid.uuid4())[:8]

        # Evict expired facts before building context
        self.knowledge.evict_expired()

        work_summary = self.ledger.summarize_tail(n=5)

        # Use public API to get facts (filters expired, limits results)
        relevant_facts = self.knowledge.get_recent_facts(limit=20)

        relevant_evidence = []
        for dep_num in step.depends_on:
            relevant_evidence.extend(self.evidence.get_for_step(dep_num))

        instructions = self._build_instructions(step, work_item)

        # More accurate token estimation including all content
        estimated_tokens = self._estimate_tokens(
            instructions, work_summary, relevant_facts, relevant_evidence
        )

        return ContextPack(
            pack_id=str(uuid.uuid4())[:8],
            step_num=step.step_num,
            worker_id=worker_id,
            instructions=instructions,
            objective=work_item.objective,
            relevant_facts=tuple(relevant_facts),  # Convert to tuple for immutability
            relevant_evidence=tuple(relevant_evidence),  # Convert to tuple for immutability
            work_summary=work_summary,
            max_tool_calls=work_item.bounds.max_tool_calls,
            max_duration_ms=work_item.bounds.max_duration_ms,
            estimated_tokens=estimated_tokens,
        )

    def _estimate_tokens(
        self,
        instructions: str,
        work_summary: str,
        facts: List["KnowledgeFact"],
        evidence: List["EvidenceRecord"],
    ) -> int:
        """
        Estimate token count for context.
        Uses ~4 chars per token as rough approximation.
        """
        total_chars = len(instructions) + len(work_summary)

        # Add facts content
        for fact in facts:
            total_chars += len(str(fact.key)) + len(str(fact.value))

        # Add evidence content
        for ev in evidence:
            total_chars += len(ev.description)
            if ev.tool_output:
                total_chars += len(ev.tool_output)

        # Rough token estimate (4 chars per token)
        return total_chars // 4

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
        summary = self.ledger.summarize_tail(n=10)
        knowledge_summary = self.knowledge.compact(budget_tokens=10000)

        return f"{summary}\n{knowledge_summary}"
