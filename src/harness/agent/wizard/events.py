"""
Wizard event types and payloads.

Events are emitted by Wizard for observability. Emission is optional and
pluggable via callbacks; Wizard does not depend on any event bus.
"""

from dataclasses import dataclass, field
from enum import Enum
import time
from typing import Any, Dict, List, Optional


class WizardEventType(Enum):
    """Types of events emitted by the Wizard."""

    # Goal events
    GOAL_STARTED = "goal_started"
    GOAL_ACHIEVED = "goal_achieved"
    GOAL_ABORTED = "goal_aborted"

    # Progress events
    STEP_STARTED = "step_started"
    STEP_COMPLETED = "step_completed"
    STEP_FAILED = "step_failed"
    STEP_SKIPPED = "step_skipped"

    # Tool events
    TOOL_CALL = "tool_call"

    # Reflection events
    REFLECTION_STARTED = "reflection_started"
    REFLECTION_COMPLETED = "reflection_completed"

    # Scaffolding events
    STEPS_SCAFFOLDED = "steps_scaffolded"

    # User input events (tool-driven, replaces callback-based clarification)
    USER_INPUT_REQUESTED = "user_input_requested"
    USER_INPUT_RECEIVED = "user_input_received"

    # Quality events
    QUALITY_ISSUE_DETECTED = "quality_issue_detected"
    ERROR_DETECTED = "error_detected"

    # LLM call tracking (for dashboard observability)
    LLM_CALL = "llm_call"

    # Plan versioning (for dashboard plan carousel)
    PLAN_SNAPSHOT = "plan_snapshot"
    PLAN_PATCHED = "plan_patched"

    # Context window metrics (for dashboard token widget)
    CONTEXT_WINDOW_UPDATE = "context_window_update"


@dataclass
class WizardEvent:
    """Base event structure."""

    event_type: WizardEventType
    timestamp: float = field(default_factory=time.time)
    step_num: Optional[int] = None
    data: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.event_type.value,
            "timestamp": self.timestamp,
            "step_num": self.step_num,
            "data": self.data or {},
        }


@dataclass
class StepCompletedData:
    step_num: int
    objective: str
    outcome_summary: str
    quality_score: float
    verdict: str
    scaffolded_count: int


@dataclass
class UserInputRequestedData:
    """Data for USER_INPUT_REQUESTED event."""
    step_num: int
    question: str
    options: List[str]
    context: str


@dataclass
class QualityIssueData:
    step_num: int
    issues: List[str]
    errors: List[str]
    severity: str  # low, medium, high


@dataclass
class LLMCallData:
    """Data for LLM_CALL event - tracks individual LLM API calls."""

    agent_type: str  # "wizard", "worker", "planner", "reflector", "synthesizer"
    step_num: Optional[int]
    prompt_preview: str  # First 500 chars of prompt
    response_preview: str  # First 500 chars of response
    total_tokens: int
    prompt_tokens: int
    completion_tokens: int
    duration_ms: float
    model: str
    tool_calls_count: int


@dataclass
class PlanSnapshotData:
    """Data for PLAN_SNAPSHOT event - full plan state for versioning."""

    version: int
    snapshot_type: str  # "initial", "pre_patch", "post_patch"
    steps: List[Dict[str, Any]]
    goal: str
    trigger: str  # What caused the snapshot


@dataclass
class ContextWindowUpdateData:
    """Data for CONTEXT_WINDOW_UPDATE event - token usage metrics."""

    total_tokens: int
    max_tokens: int  # Default 200000
    percentage_used: float
    message_count: int
