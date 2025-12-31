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

    # Progress events
    STEP_STARTED = "step_started"
    STEP_COMPLETED = "step_completed"
    STEP_FAILED = "step_failed"
    STEP_SKIPPED = "step_skipped"

    # Reflection events
    REFLECTION_STARTED = "reflection_started"
    REFLECTION_COMPLETED = "reflection_completed"

    # Scaffolding events
    STEPS_SCAFFOLDED = "steps_scaffolded"

    # Clarification events
    CLARIFICATION_REQUESTED = "clarification_requested"
    CLARIFICATION_RECEIVED = "clarification_received"
    CLARIFICATION_TIMEOUT = "clarification_timeout"

    # Quality events
    QUALITY_ISSUE_DETECTED = "quality_issue_detected"
    ERROR_DETECTED = "error_detected"

    # Goal events
    GOAL_ACHIEVED = "goal_achieved"
    GOAL_ABORTED = "goal_aborted"


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
class ClarificationRequestedData:
    request_id: str
    step_num: int
    question: str
    options: List[str]
    default_assumption: str
    timeout_seconds: int


@dataclass
class QualityIssueData:
    step_num: int
    issues: List[str]
    errors: List[str]
    severity: str  # low, medium, high
