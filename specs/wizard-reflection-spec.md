# Wizard Reflection Stage Specification

**Version:** 1.0.0
**Status:** Draft
**Authors:** Architecture Discussion
**Date:** 2025-12-30

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Design Philosophy](#3-design-philosophy)
4. [Architecture Overview](#4-architecture-overview)
5. [Type Definitions](#5-type-definitions)
6. [WizardReflector Component](#6-wizardreflector-component)
7. [Orchestration Loop Integration](#7-orchestration-loop-integration)
8. [User Clarification System](#8-user-clarification-system)
9. [Plan Scaffolding](#9-plan-scaffolding)
10. [Quality Enforcement](#10-quality-enforcement)
11. [Event System](#11-event-system)
12. [Error Handling & Recovery](#12-error-handling--recovery)
13. [Prompt Engineering](#13-prompt-engineering)
14. [Performance Considerations](#14-performance-considerations)
15. [Testing Strategy](#15-testing-strategy)
16. [Migration Path](#16-migration-path)
17. [Future Extensions](#17-future-extensions)
18. [Appendix](#18-appendix)

---

## 1. Executive Summary

### 1.1 Purpose

This specification defines the **Wizard Reflection Stage** - an intelligent reasoning layer that transforms the Wizard from a mechanical state machine into a true meta-agent capable of ensuring maximum user utility on every request.

### 1.2 Core Principle

> **Every request results in a properly formatted, high-quality response. There are no silent failures, no trivial give-ups, and no half-baked implementations.**

### 1.3 Key Capabilities

| Capability | Description |
|------------|-------------|
| **Post-Step Reflection** | LLM-powered reasoning after every Worker outcome |
| **Quality Enforcement** | Detection and remediation of errors, incomplete work |
| **Dynamic Scaffolding** | Insert additional steps to achieve excellence |
| **Intelligent Clarification** | User prompts only when truly necessary, with defaults |
| **Failure Triage** | Distinguish infrastructure vs. semantic failures |
| **Zero Silent Failures** | Every path leads to explicit user-facing outcome |

### 1.4 Success Metrics

- **Silent Failure Rate:** 0% (down from ~15% estimated)
- **Half-Baked Response Rate:** <5% (down from ~30% estimated)
- **Unnecessary Clarification Rate:** <10% of clarifications
- **User Satisfaction:** Measurable via feedback/ratings

---

## 2. Problem Statement

### 2.1 Current Architecture Limitations

The current Wizard implementation has fundamental limitations:

```
┌─────────────────────────────────────────────────────────────────┐
│                    CURRENT: DUMB STATE MACHINE                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Worker Outcome ──▶ Status Update ──▶ Next Step                │
│                          │                                       │
│                          ▼                                       │
│                    (No Reasoning)                                │
│                                                                  │
│   • Retry count only, no failure analysis                       │
│   • No quality assessment                                        │
│   • No scaffolding for excellence                               │
│   • Silent failures reach user as garbage                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Observed Failure Modes

#### 2.2.1 Excuse-Making LLM Behavior

Workers return `NEED_CONTEXT` with questions instead of executing:

```
Worker: "Before I implement, I need to know:
         1. Which web framework should I use?
         2. What testing framework is preferred?
         3. Should I use TypeScript or JavaScript?"

Result: Step fails, retried 3x, skipped. User sees nothing useful.
```

**Root Cause:** LLMs are trained to be helpful by asking, not by doing. No mechanism to override this or provide defaults.

#### 2.2.2 Silent Synthesis Failures

When all steps fail, synthesis produces garbage:

```python
# Current code in wizard.py
if not outcomes:
    fallback = f"Completed processing: {plan.goal}"  # Useless!
    return fallback
```

**Root Cause:** No intelligence applied to failed outcomes. System gives up silently.

#### 2.2.3 Context Window Metadata Leakage

TUI displays raw context metadata instead of proper responses:

```
"Tool Intent: read GraphdClient API for dashboard enrichment.
Delta: implement UI polling/live endpoints...
{"path":"src/harness/graphd/client.py"}<json to=functions.file_read>..."
```

**Root Cause:** `_extract_content()` fallback stringifies entire response objects.

#### 2.2.4 Half-Baked Implementations

Worker completes objective minimally, missing obvious follow-ups:

```
User: "Add a user authentication system"

Worker: [Writes auth.py with login function]
        "Done! I've added a login function."

Missing:
- No tests
- No logout
- No password hashing
- No session management
- No error handling
```

**Root Cause:** No post-completion reflection to scaffold excellence.

### 2.3 The Missing Component

The Wizard has access to:
- Global plan context
- Full outcome history
- Accumulated knowledge
- Plan mutation capabilities
- User communication channel

**None of this is leveraged for reasoning.** The Wizard needs an intelligence layer.

---

## 3. Design Philosophy

### 3.1 Core Tenets

#### 3.1.1 Bias Toward Action

> The system should DO things, not ask about them.

- Make reasonable assumptions when information is missing
- Only escalate to user when genuinely unknowable
- Every clarification request must have a default assumption
- "Which framework?" → Pick one and implement

#### 3.1.2 Quality Over Speed

> A slower, excellent response beats a fast, mediocre one.

- Additional LLM calls for reflection are worthwhile
- Scaffolding extra steps for quality is encouraged
- Incomplete work should be detected and remediated

#### 3.1.3 Explicit Over Silent

> Every path produces an explicit, user-facing outcome.

- No swallowed errors
- No empty responses
- No mysterious failures
- User always knows what happened and why

#### 3.1.4 Graceful Degradation

> When perfection isn't achievable, deliver the best possible outcome.

- Partial results are better than no results
- Explain what was achieved and what wasn't
- Provide next steps for user to continue

### 3.2 Decision Hierarchy

When the Wizard reflects, it should consider actions in this order:

```
1. ACCEPT          - Is the work sufficient? Ship it.
2. ACCEPT_EXTEND   - Good work, but can we do better? Scaffold more.
3. REDO            - Fixable issues? Try again with modifications.
4. CLARIFY_USER    - Genuinely blocked? Ask user (with default).
5. ABORT_STEP      - Step impossible? Skip and explain.
6. ABORT_GOAL      - Goal impossible? Explain why.
```

Lower options should be rare. Most outcomes should be ACCEPT or ACCEPT_EXTEND.

### 3.3 Anti-Patterns

The system must actively avoid:

| Anti-Pattern | Description | Mitigation |
|--------------|-------------|------------|
| **Question Avoidance** | LLM asks questions instead of implementing | Aggressive prompting, REDO with assumptions |
| **Premature Abort** | Giving up because task is hard | Scaffold more steps, REDO with hints |
| **Silent Failure** | Errors not surfaced to user | Explicit ABORT with explanation |
| **Over-Clarification** | Asking user for trivial decisions | Default assumptions, only ask for unknowables |
| **Half-Completion** | Doing minimum viable work | ACCEPT_EXTEND to scaffold excellence |

---

## 4. Architecture Overview

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WIZARD ORCHESTRATION LAYER                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        ORCHESTRATION LOOP                             │  │
│  │                                                                        │  │
│  │   ┌─────────┐     ┌─────────┐     ┌──────────────────┐               │  │
│  │   │ SELECT  │────▶│ WORKER  │────▶│ WIZARD REFLECTOR │               │  │
│  │   │  STEP   │     │ EXECUTE │     │                  │               │  │
│  │   └─────────┘     └─────────┘     │  ┌────────────┐  │               │  │
│  │        ▲                          │  │ Assess     │  │               │  │
│  │        │                          │  │ Quality    │  │               │  │
│  │        │                          │  └─────┬──────┘  │               │  │
│  │        │                          │        │         │               │  │
│  │        │                          │  ┌─────▼──────┐  │               │  │
│  │        │                          │  │ Detect     │  │               │  │
│  │        │                          │  │ Errors     │  │               │  │
│  │        │                          │  └─────┬──────┘  │               │  │
│  │        │                          │        │         │               │  │
│  │        │                          │  ┌─────▼──────┐  │               │  │
│  │        │                          │  │ Decide     │  │               │  │
│  │        │                          │  │ Action     │  │               │  │
│  │        │                          │  └─────┬──────┘  │               │  │
│  │        │                          │        │         │               │  │
│  │        │                          └────────┼─────────┘               │  │
│  │        │                                   │                          │  │
│  │        │         ┌─────────────────────────┼─────────────────────┐   │  │
│  │        │         ▼           ▼             ▼          ▼          ▼   │  │
│  │        │    ┌────────┐ ┌─────────┐   ┌─────────┐ ┌────────┐ ┌──────┐│  │
│  │        │    │ ACCEPT │ │ EXTEND  │   │  REDO   │ │CLARIFY │ │ABORT ││  │
│  │        │    └───┬────┘ └────┬────┘   └────┬────┘ └───┬────┘ └──┬───┘│  │
│  │        │        │           │             │          │         │    │  │
│  │        │        │      ┌────▼────┐   ┌────▼────┐ ┌───▼───┐     │    │  │
│  │        │        │      │Scaffold │   │ Modify  │ │ Emit  │     │    │  │
│  │        │        │      │ Steps   │   │ Context │ │ Event │     │    │  │
│  │        │        │      └────┬────┘   └────┬────┘ └───┬───┘     │    │  │
│  │        │        │           │             │          │         │    │  │
│  │        └────────┴───────────┴─────────────┴──────────┴─────────┘    │  │
│  │                                                                        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                │
│  │   PlanState    │  │  WorkLedger    │  │ KnowledgeStore │                │
│  │  (mutations)   │  │   (audit)      │  │   (facts)      │                │
│  └────────────────┘  └────────────────┘  └────────────────┘                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EVENT BUS / TUI                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  • ClarificationRequestEvent  (Wizard → TUI)                                │
│  • ClarificationResponseEvent (TUI → Wizard)                                │
│  • ProgressUpdateEvent        (Wizard → TUI)                                │
│  • StepCompletedEvent         (Wizard → TUI)                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Component Responsibilities

| Component | Responsibility | State Owned |
|-----------|---------------|-------------|
| **Wizard** | Orchestration loop, state management | PlanState, WorkLedger, KnowledgeStore |
| **WizardReflector** | Post-step reasoning, decision-making | None (stateless) |
| **Worker** | Bounded step execution | None (receives context, returns outcome) |
| **PolicyGate** | Patch validation | None (stateless) |
| **StagnationDetector** | Loop detection | Step history |

### 4.3 Data Flow

```
User Request
    │
    ▼
┌─────────┐
│ Planner │──────▶ WizardPlan
└─────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│                    WIZARD.ORCHESTRATE()                  │
│                                                          │
│  for each iteration:                                     │
│    1. Select ready step                                  │
│    2. Build ContextWindow                                │
│    3. Worker.execute() → WorkerOutcome                   │
│    4. WizardReflector.reflect() → ReflectionOutput  ◀── NEW
│    5. Apply reflection decision                          │
│    6. Update state stores                                │
│    7. Emit events                                        │
│                                                          │
└─────────────────────────────────────────────────────────┘
    │
    ▼
WizardResult
    │
    ▼
User Response
```

---

## 5. Type Definitions

### 5.1 Enumerations

```python
# src/harness/agent/wizard/types.py

from enum import Enum

class StepStatus(Enum):
    """
    Status of a plan step.

    State machine:
        PENDING ──▶ IN_PROGRESS ──▶ COMPLETED (terminal)
                          │
                          ├──▶ FAILED ──▶ PENDING (retry)
                          │            └──▶ SKIPPED (terminal)
                          │
                          └──▶ AWAITING_USER ──▶ PENDING (after response)
    """
    PENDING = "pending"              # Ready to execute
    IN_PROGRESS = "in_progress"      # Worker executing
    COMPLETED = "completed"          # Successfully finished (frozen)
    FAILED = "failed"                # Failed, can retry
    SKIPPED = "skipped"              # Permanently skipped (frozen)
    AWAITING_USER = "awaiting_user"  # Blocked on user clarification


class ReflectionVerdict(Enum):
    """
    Wizard's verdict after reflecting on a step outcome.

    Ordered by preference - higher options should be more common.
    """
    ACCEPT = "accept"                    # Quality sufficient, proceed
    ACCEPT_AND_EXTEND = "accept_extend"  # Good, scaffold more for excellence
    REDO = "redo"                        # Redo with modifications
    CLARIFY_USER = "clarify_user"        # Need user input (rare)
    ABORT_STEP = "abort_step"            # Skip this step
    ABORT_GOAL = "abort_goal"            # Cannot achieve goal (very rare)


class ClarificationUrgency(Enum):
    """Urgency level for user clarification requests."""
    LOW = "low"           # Can proceed with default after short timeout
    MEDIUM = "medium"     # Should wait for user, but has reasonable default
    HIGH = "high"         # Genuinely needs user input, no good default
    BLOCKING = "blocking" # Cannot proceed without user input


class FailureCategory(Enum):
    """Category of step failure for triage."""
    INFRASTRUCTURE = "infrastructure"  # Network, API, timeout errors
    SEMANTIC = "semantic"              # Wrong approach, misunderstanding
    CONTEXT = "context"                # Missing information
    CAPABILITY = "capability"          # Task beyond current abilities
    USER_INPUT = "user_input"          # Needs user decision
```

### 5.2 Data Classes

#### 5.2.1 Reflection Input/Output

```python
# src/harness/agent/wizard/reflection_types.py

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .types import (
    ReflectionVerdict,
    ClarificationUrgency,
    FailureCategory,
    GoalType,
)
from .plan_state import StepState
from .knowledge_store import KnowledgeFact
from .worker import WorkerOutcome


@dataclass
class ReflectionContext:
    """
    Global context available to the reflector.

    This represents everything the Wizard knows that individual
    Workers don't have access to.
    """
    # Goal information
    goal: str
    goal_type: GoalType
    goal_success_criteria: Optional[str] = None

    # Plan state
    total_steps: int = 0
    completed_steps: int = 0
    failed_steps: int = 0
    skipped_steps: int = 0
    remaining_steps: int = 0

    # Accumulated knowledge
    key_facts: List[KnowledgeFact] = field(default_factory=list)

    # Execution history
    total_iterations: int = 0
    total_tool_calls: int = 0
    total_llm_calls: int = 0
    elapsed_ms: float = 0.0


@dataclass
class StepContext:
    """Context specific to the current step being reflected on."""
    step_num: int
    objective: str
    tool_hint: Optional[str]
    phase: str
    attempt_count: int
    depends_on: List[int]
    is_required: bool

    # Previous attempts on this step
    previous_errors: List[str] = field(default_factory=list)


@dataclass
class WizardReflectionInput:
    """
    Complete input to the Wizard reflection stage.

    Provides all context needed for the reflector to make
    an informed decision about the step outcome.
    """
    # Global context
    global_context: ReflectionContext

    # Current step
    step_context: StepContext

    # Worker outcome
    outcome: WorkerOutcome

    # All steps for dependency analysis
    all_steps: List[StepState] = field(default_factory=list)

    # Recent outcomes for pattern detection
    recent_outcomes: List[WorkerOutcome] = field(default_factory=list)


@dataclass
class ScaffoldedStep:
    """A new step to be inserted into the plan."""
    objective: str
    tool_hint: Optional[str] = None
    phase: str = "execution"
    depends_on: List[int] = field(default_factory=list)
    required: bool = False
    rationale: str = ""  # Why this step is being added


@dataclass
class RedoModifications:
    """Modifications to apply when redoing a step."""
    new_objective: Optional[str] = None
    new_tool_hint: Optional[str] = None
    injected_context: Optional[str] = None
    additional_constraints: List[str] = field(default_factory=list)
    avoid_patterns: List[str] = field(default_factory=list)  # What to NOT do


@dataclass
class ClarificationRequest:
    """
    A request for user clarification.

    Always includes a default assumption to enable auto-proceed.
    """
    question: str
    options: List[str] = field(default_factory=list)
    default_assumption: str = ""  # REQUIRED - what we do if no response
    urgency: ClarificationUrgency = ClarificationUrgency.MEDIUM
    timeout_seconds: int = 60
    context: str = ""  # Additional context for the user

    # Tracking
    step_num: int = 0
    request_id: str = ""


@dataclass
class QualityAssessment:
    """Assessment of Worker output quality."""
    overall_score: float  # 0.0-1.0

    # Specific assessments
    completeness: float = 0.0      # Did it fully address the objective?
    correctness: float = 0.0       # Is the output correct/bug-free?
    clarity: float = 0.0           # Is the output clear and well-formatted?
    actionability: float = 0.0     # Can the user act on this?

    # Issues detected
    issues: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    # Suggestions
    improvement_suggestions: List[str] = field(default_factory=list)


@dataclass
class WizardReflectionOutput:
    """
    Complete output from the Wizard reflection stage.

    Determines what action the Wizard takes next.
    """
    # Primary decision
    verdict: ReflectionVerdict
    reasoning: str
    confidence: float  # 0.0-1.0

    # Quality assessment (always populated)
    quality: QualityAssessment = field(default_factory=QualityAssessment)

    # For ACCEPT_AND_EXTEND
    scaffolded_steps: List[ScaffoldedStep] = field(default_factory=list)

    # For REDO
    redo_modifications: Optional[RedoModifications] = None

    # For CLARIFY_USER
    clarification: Optional[ClarificationRequest] = None

    # For ABORT_STEP / ABORT_GOAL
    abort_reason: Optional[str] = None
    abort_category: Optional[FailureCategory] = None

    # User-facing message (always populated)
    user_message: str = ""

    # Metadata
    reflection_duration_ms: float = 0.0
    llm_tokens_used: int = 0
```

#### 5.2.2 Clarification Response

```python
@dataclass
class ClarificationResponse:
    """User's response to a clarification request."""
    request_id: str
    step_num: int

    # Response content (one of these is populated)
    selected_option: Optional[str] = None  # If user picked an option
    custom_text: Optional[str] = None      # If user typed custom response

    # Metadata
    used_default: bool = False      # True if timed out
    response_time_ms: float = 0.0   # How long user took

    @property
    def answer(self) -> str:
        """Get the actual answer content."""
        if self.custom_text:
            return self.custom_text
        if self.selected_option:
            return self.selected_option
        return ""
```

### 5.3 Protocol Definitions

```python
# src/harness/agent/wizard/protocols.py

from typing import Callable, Optional, Protocol

from .reflection_types import (
    WizardReflectionInput,
    WizardReflectionOutput,
    ClarificationRequest,
    ClarificationResponse,
)


class ReflectorProtocol(Protocol):
    """Protocol for the Wizard reflector component."""

    async def reflect(
        self,
        input: WizardReflectionInput,
    ) -> WizardReflectionOutput:
        """Reflect on a Worker outcome and decide next action."""
        ...


class ClarificationHandler(Protocol):
    """Protocol for handling user clarification requests."""

    def request_clarification(
        self,
        request: ClarificationRequest,
    ) -> None:
        """Emit a clarification request to the user."""
        ...

    def get_response(
        self,
        request_id: str,
        timeout_ms: int,
    ) -> Optional[ClarificationResponse]:
        """Get user's response to a clarification request."""
        ...


# Callback types
OnClarificationNeeded = Callable[[ClarificationRequest], None]
OnProgressUpdate = Callable[[str, int, int], None]  # message, step, total
OnStepCompleted = Callable[[int, str, bool], None]  # step_num, summary, success
```

---

## 6. WizardReflector Component

### 6.1 Class Definition

```python
# src/harness/agent/wizard/reflector.py

"""
WizardReflector - The intelligence layer of the Wizard.

This component reasons about Worker outcomes and decides what to do next.
It is called after EVERY step outcome, not just failures.

Design Principles:
1. Bias toward action - prefer ACCEPT/EXTEND over CLARIFY
2. Quality enforcement - catch errors, incomplete work
3. Excellence scaffolding - add steps to do great work
4. Explicit outcomes - never silently fail
"""

import json
import time
from dataclasses import dataclass
from typing import Any, List, Optional

from .reflection_types import (
    WizardReflectionInput,
    WizardReflectionOutput,
    ReflectionVerdict,
    QualityAssessment,
    ScaffoldedStep,
    RedoModifications,
    ClarificationRequest,
    ClarificationUrgency,
    FailureCategory,
)


@dataclass
class ReflectorConfig:
    """Configuration for the WizardReflector."""

    # Quality thresholds
    min_accept_quality: float = 0.6      # Below this, consider REDO
    excellence_threshold: float = 0.85    # Above this, don't scaffold

    # Behavior tuning
    max_redo_attempts: int = 2           # Max REDOs before escalating
    scaffold_aggressiveness: float = 0.5  # 0=minimal, 1=aggressive scaffolding

    # Clarification policy
    require_default_assumption: bool = True
    max_clarification_options: int = 4
    default_clarification_timeout: int = 60

    # LLM settings
    reflection_model: Optional[str] = None  # Override model for reflection
    max_reflection_tokens: int = 2000


class WizardReflector:
    """
    The reasoning core of the Wizard.

    Called after every Worker outcome to:
    1. Assess quality of the output
    2. Detect errors or issues
    3. Decide the appropriate action
    4. Format user-facing messages
    """

    def __init__(
        self,
        llm: Any,
        config: Optional[ReflectorConfig] = None,
        logger: Optional[Any] = None,
    ):
        self.llm = llm
        self.config = config or ReflectorConfig()
        self.logger = logger

    async def reflect(
        self,
        input: WizardReflectionInput,
    ) -> WizardReflectionOutput:
        """
        Reflect on a Worker outcome and decide next action.

        This is the core intelligence of the Wizard.

        Args:
            input: Complete reflection context

        Returns:
            ReflectionOutput with verdict and associated data
        """
        start_time = time.time()

        # Build the reflection prompt
        prompt = self._build_reflection_prompt(input)

        # Call LLM for reflection
        try:
            response = await self.llm.respond(
                prompt,
                response_format={"type": "json_object"},
                max_tokens=self.config.max_reflection_tokens,
            )

            output = self._parse_response(response, input)

        except Exception as e:
            # Fallback: accept with low confidence
            self._log("error", f"Reflection failed: {e}")
            output = self._create_fallback_output(input, str(e))

        output.reflection_duration_ms = (time.time() - start_time) * 1000

        self._log(
            "debug",
            f"Reflection complete: verdict={output.verdict.value}, "
            f"confidence={output.confidence:.2f}, "
            f"duration={output.reflection_duration_ms:.0f}ms"
        )

        return output

    def _build_reflection_prompt(self, input: WizardReflectionInput) -> str:
        """Build the reflection prompt with full context."""

        # Format step status summary
        step_summary = self._format_step_summary(input.all_steps)

        # Format knowledge facts
        facts_summary = self._format_facts(input.global_context.key_facts)

        # Format worker output
        worker_output = self._format_worker_output(input.outcome)

        # Format previous attempts if any
        previous_attempts = self._format_previous_attempts(
            input.step_context.previous_errors
        )

        return f"""You are the Wizard - the orchestrating intelligence ensuring maximum user utility.

A Worker just completed execution. Analyze the outcome and decide the next action.

═══════════════════════════════════════════════════════════════════════════════
GLOBAL CONTEXT
═══════════════════════════════════════════════════════════════════════════════

**User's Goal:** {input.global_context.goal}
**Goal Type:** {input.global_context.goal_type.value}

**Plan Progress:**
- Total Steps: {input.global_context.total_steps}
- Completed: {input.global_context.completed_steps}
- Failed: {input.global_context.failed_steps}
- Remaining: {input.global_context.remaining_steps}

**Execution Metrics:**
- Iterations: {input.global_context.total_iterations}
- Tool Calls: {input.global_context.total_tool_calls}
- Elapsed: {input.global_context.elapsed_ms:.0f}ms

**Key Facts Accumulated:**
{facts_summary}

**Step Status:**
{step_summary}

═══════════════════════════════════════════════════════════════════════════════
CURRENT STEP OUTCOME
═══════════════════════════════════════════════════════════════════════════════

**Step {input.step_context.step_num}:** {input.step_context.objective}
**Phase:** {input.step_context.phase}
**Tool Hint:** {input.step_context.tool_hint or "(none)"}
**Attempt:** {input.step_context.attempt_count}
**Required:** {"Yes" if input.step_context.is_required else "No"}

**Worker Success:** {input.outcome.success}
**Termination Reason:** {input.outcome.termination_reason}
**Error:** {input.outcome.error or "(none)"}

{previous_attempts}

**Worker Output:**
{worker_output}

═══════════════════════════════════════════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════════════════════════════════════════

Analyze this outcome and decide the next action. Consider:

1. **QUALITY**: Does the output fully address the objective? Is it correct?
2. **COMPLETENESS**: Is there more work needed for excellence?
3. **ERRORS**: Did the Worker make mistakes? Are there bugs?
4. **PROGRESS**: Are we making progress toward the goal?
5. **BLOCKERS**: Is there something fundamentally blocking progress?

═══════════════════════════════════════════════════════════════════════════════
DECISION OPTIONS (in order of preference)
═══════════════════════════════════════════════════════════════════════════════

**ACCEPT** - The work is sufficient. Proceed to next step.
  Use when: Output addresses objective, quality is acceptable.

**ACCEPT_EXTEND** - Work is good, but scaffold additional steps for excellence.
  Use when: Core work done, but obvious improvements possible.
  Examples:
  - Code written → add tests
  - Function added → add documentation
  - Feature implemented → add error handling
  - Question answered → add examples

**REDO** - Output is insufficient. Retry with modifications.
  Use when: Wrong approach, misunderstood objective, fixable errors.
  Provide: New objective, tool hint, or context to inject.

**CLARIFY_USER** - Genuinely need user input to proceed.
  Use when: Information is truly unknowable (user preferences, secrets, business decisions).
  MUST provide: default_assumption (what you'll do if user doesn't respond).
  DO NOT use for: Framework choices, library preferences, implementation approaches.

**ABORT_STEP** - This step is not achievable. Skip it.
  Use when: Step is genuinely impossible, not just difficult.

**ABORT_GOAL** - Fundamental blocker prevents achieving the goal.
  Use when: Missing required access, contradictory requirements.
  This is VERY RARE. Prefer scaffolding more steps.

═══════════════════════════════════════════════════════════════════════════════
ANTI-PATTERNS TO AVOID
═══════════════════════════════════════════════════════════════════════════════

❌ DO NOT CLARIFY for assumable things (frameworks, libraries, approaches)
❌ DO NOT ABORT because something is hard - scaffold more steps instead
❌ DO NOT ACCEPT half-baked work - REDO or EXTEND for quality
❌ DO NOT let "I need more info" be acceptable - Workers should gather info
❌ DO NOT repeat the same REDO without modifications

═══════════════════════════════════════════════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════════════════════════════════════════════

Respond with JSON:
{{
    "verdict": "accept" | "accept_extend" | "redo" | "clarify_user" | "abort_step" | "abort_goal",
    "reasoning": "Your detailed reasoning for this decision",
    "confidence": 0.0-1.0,

    "quality": {{
        "overall_score": 0.0-1.0,
        "completeness": 0.0-1.0,
        "correctness": 0.0-1.0,
        "clarity": 0.0-1.0,
        "issues": ["List of issues detected"],
        "errors": ["List of errors detected"],
        "improvement_suggestions": ["Suggestions for improvement"]
    }},

    "scaffolded_steps": [
        // For ACCEPT_EXTEND only
        {{
            "objective": "What this step should accomplish",
            "tool_hint": "Suggested tool (optional)",
            "phase": "execution" | "verification",
            "rationale": "Why this step is needed"
        }}
    ],

    "redo_modifications": {{
        // For REDO only
        "new_objective": "Clearer/modified objective (optional)",
        "new_tool_hint": "Different tool to try (optional)",
        "injected_context": "Additional context to provide (optional)",
        "avoid_patterns": ["Things the Worker should NOT do this time"]
    }},

    "clarification": {{
        // For CLARIFY_USER only
        "question": "The question to ask the user",
        "options": ["Option 1", "Option 2"],
        "default_assumption": "REQUIRED - what we do if no response",
        "urgency": "low" | "medium" | "high" | "blocking",
        "context": "Additional context for the user"
    }},

    "abort_reason": "For ABORT_STEP/ABORT_GOAL - why we're giving up",

    "user_message": "A well-formatted message to show the user about progress"
}}
"""

    def _format_step_summary(self, steps: List[Any]) -> str:
        """Format step status for the prompt."""
        lines = []
        for step in steps:
            status_icon = {
                "pending": "○",
                "in_progress": "◐",
                "completed": "●",
                "failed": "✗",
                "skipped": "⊘",
                "awaiting_user": "?"
            }.get(step.status.value, "?")

            lines.append(
                f"  {status_icon} Step {step.step_num}: {step.objective[:60]}"
            )
        return "\n".join(lines) if lines else "  (no steps)"

    def _format_facts(self, facts: List[Any]) -> str:
        """Format knowledge facts for the prompt."""
        if not facts:
            return "  (no facts accumulated)"

        lines = []
        for fact in facts[:10]:  # Limit to 10 most relevant
            value_str = str(fact.value)[:100]
            lines.append(f"  • {fact.key}: {value_str}")
        return "\n".join(lines)

    def _format_worker_output(self, outcome: Any) -> str:
        """Format worker output for the prompt."""
        parts = []

        # Final response
        if outcome.final_response:
            parts.append(f"**Response:**\n{outcome.final_response[:2000]}")

        # Tool results
        tool_results = []
        for fact in outcome.facts:
            if fact.tool_name:
                tool_results.append(
                    f"  • {fact.tool_name}: {str(fact.value)[:300]}"
                )
        if tool_results:
            parts.append(f"**Tool Results:**\n" + "\n".join(tool_results[:5]))

        return "\n\n".join(parts) if parts else "(no output)"

    def _format_previous_attempts(self, errors: List[str]) -> str:
        """Format previous attempt errors."""
        if not errors:
            return ""

        lines = ["**Previous Attempt Errors:**"]
        for i, error in enumerate(errors[-3:], 1):  # Last 3 attempts
            lines.append(f"  Attempt {i}: {error[:200]}")
        return "\n".join(lines)

    def _parse_response(
        self,
        response: str,
        input: WizardReflectionInput
    ) -> WizardReflectionOutput:
        """Parse LLM response into structured output."""
        try:
            data = json.loads(response)
        except json.JSONDecodeError as e:
            self._log("warning", f"Failed to parse reflection JSON: {e}")
            return self._create_fallback_output(input, f"JSON parse error: {e}")

        # Parse verdict
        verdict = self._parse_verdict(data.get("verdict", "accept"))

        # Parse quality assessment
        quality_data = data.get("quality", {})
        quality = QualityAssessment(
            overall_score=quality_data.get("overall_score", 0.5),
            completeness=quality_data.get("completeness", 0.5),
            correctness=quality_data.get("correctness", 0.5),
            clarity=quality_data.get("clarity", 0.5),
            issues=quality_data.get("issues", []),
            errors=quality_data.get("errors", []),
            improvement_suggestions=quality_data.get("improvement_suggestions", []),
        )

        # Parse scaffolded steps
        scaffolded_steps = []
        for step_data in data.get("scaffolded_steps", []):
            scaffolded_steps.append(ScaffoldedStep(
                objective=step_data.get("objective", ""),
                tool_hint=step_data.get("tool_hint"),
                phase=step_data.get("phase", "execution"),
                rationale=step_data.get("rationale", ""),
            ))

        # Parse redo modifications
        redo_data = data.get("redo_modifications")
        redo_modifications = None
        if redo_data and verdict == ReflectionVerdict.REDO:
            redo_modifications = RedoModifications(
                new_objective=redo_data.get("new_objective"),
                new_tool_hint=redo_data.get("new_tool_hint"),
                injected_context=redo_data.get("injected_context"),
                avoid_patterns=redo_data.get("avoid_patterns", []),
            )

        # Parse clarification request
        clarification_data = data.get("clarification")
        clarification = None
        if clarification_data and verdict == ReflectionVerdict.CLARIFY_USER:
            # Validate default assumption is present
            default = clarification_data.get("default_assumption", "")
            if not default and self.config.require_default_assumption:
                # Reject clarification without default
                self._log(
                    "warning",
                    "Clarification rejected: no default assumption"
                )
                # Convert to REDO with the default we invent
                verdict = ReflectionVerdict.REDO
                redo_modifications = RedoModifications(
                    injected_context="Make a reasonable assumption and proceed."
                )
            else:
                urgency_str = clarification_data.get("urgency", "medium")
                clarification = ClarificationRequest(
                    question=clarification_data.get("question", ""),
                    options=clarification_data.get("options", []),
                    default_assumption=default,
                    urgency=ClarificationUrgency(urgency_str),
                    context=clarification_data.get("context", ""),
                    step_num=input.step_context.step_num,
                )

        return WizardReflectionOutput(
            verdict=verdict,
            reasoning=data.get("reasoning", ""),
            confidence=data.get("confidence", 0.5),
            quality=quality,
            scaffolded_steps=scaffolded_steps,
            redo_modifications=redo_modifications,
            clarification=clarification,
            abort_reason=data.get("abort_reason"),
            user_message=data.get("user_message", ""),
        )

    def _parse_verdict(self, verdict_str: str) -> ReflectionVerdict:
        """Parse verdict string to enum."""
        mapping = {
            "accept": ReflectionVerdict.ACCEPT,
            "accept_extend": ReflectionVerdict.ACCEPT_AND_EXTEND,
            "extend": ReflectionVerdict.ACCEPT_AND_EXTEND,
            "redo": ReflectionVerdict.REDO,
            "clarify_user": ReflectionVerdict.CLARIFY_USER,
            "clarify": ReflectionVerdict.CLARIFY_USER,
            "abort_step": ReflectionVerdict.ABORT_STEP,
            "abort_goal": ReflectionVerdict.ABORT_GOAL,
        }
        return mapping.get(verdict_str.lower(), ReflectionVerdict.ACCEPT)

    def _create_fallback_output(
        self,
        input: WizardReflectionInput,
        error: str
    ) -> WizardReflectionOutput:
        """Create fallback output when reflection fails."""
        # If worker succeeded, accept; otherwise, retry
        if input.outcome.success:
            verdict = ReflectionVerdict.ACCEPT
            user_message = input.outcome.final_response or "Step completed."
        else:
            verdict = ReflectionVerdict.REDO
            user_message = "Retrying step due to reflection error."

        return WizardReflectionOutput(
            verdict=verdict,
            reasoning=f"Fallback due to reflection error: {error}",
            confidence=0.3,
            quality=QualityAssessment(overall_score=0.5),
            user_message=user_message,
        )

    def _log(self, level: str, msg: str, **kwargs) -> None:
        """Log with optional logger."""
        if self.logger:
            log_fn = getattr(self.logger, level, None)
            if log_fn:
                log_fn(msg, component="reflector", **kwargs)
```

### 6.2 Sync Wrapper

```python
# For synchronous usage in current codebase

class WizardReflectorSync:
    """Synchronous wrapper for WizardReflector."""

    def __init__(self, llm: Any, config: Optional[ReflectorConfig] = None):
        self._async_reflector = WizardReflector(llm, config)

    def reflect(self, input: WizardReflectionInput) -> WizardReflectionOutput:
        """Synchronous reflect call."""
        import asyncio

        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        return loop.run_until_complete(
            self._async_reflector.reflect(input)
        )
```

---

## 7. Orchestration Loop Integration

### 7.1 Modified Wizard Class

```python
# src/harness/agent/wizard/wizard.py (modifications)

class Wizard:
    """
    Outer-loop orchestrator with reflection stage.
    """

    def __init__(
        self,
        tool_registry: ToolRegistry,
        llm: Any,
        config: Optional[WizardConfig] = None,
        logger: Optional[Logger] = None,
    ):
        # ... existing init ...

        # NEW: Reflector component
        reflector_config = ReflectorConfig()
        self._reflector = WizardReflectorSync(llm, reflector_config, logger)

        # NEW: Clarification handling
        self._pending_clarifications: Dict[str, ClarificationRequest] = {}
        self._clarification_responses: Dict[str, ClarificationResponse] = {}
        self._on_clarification_needed: Optional[OnClarificationNeeded] = None

    def orchestrate(
        self,
        plan: WizardPlan,
        user_input: str,
        # ... existing params ...
        on_clarification_needed: Optional[OnClarificationNeeded] = None,
    ) -> WizardResult:
        """
        Main orchestration loop with reflection stage.
        """
        self._on_clarification_needed = on_clarification_needed

        # ... existing initialization ...

        while iteration < self.config.max_iterations:
            iteration += 1

            # ========== CHECK FOR CLARIFICATION RESPONSES ==========
            self._process_clarification_responses()

            # ========== CHECK FOR STEPS AWAITING USER ==========
            if self._has_steps_awaiting_user():
                # Don't block - check if responses available
                if not self._check_clarification_timeout():
                    continue

            # ========== HANDLE FAILED STEPS ==========
            # Note: Now smarter due to reflection verdicts
            self._handle_failed_steps()

            # ========== SELECT READY STEP ==========
            ready_steps = self._plan_state.get_ready_steps()
            if not ready_steps:
                consecutive_no_ready += 1
                if consecutive_no_ready >= self.config.deadlock_threshold:
                    break
                if not self._has_recoverable_steps():
                    break
                continue

            consecutive_no_ready = 0
            step = ready_steps[0]

            # ... existing work item creation, context building ...

            # ========== WORKER EXECUTION ==========
            try:
                outcome = self._worker.execute(
                    step_context_window,
                    work_item,
                    plan_version,
                    cache_params,
                    read_files=set(self._session_context.read_files),
                )
                # ... existing metric collection ...
            except Exception as exc:
                outcome = WorkerOutcome(
                    work_id=work_item.work_id,
                    step_num=step.step_num,
                    base_version=plan_version,
                    success=False,
                    error=f"Worker exception: {type(exc).__name__}: {str(exc)[:200]}",
                    termination_reason="exception",
                )

            # ════════════════════════════════════════════════════════════════
            # NEW: WIZARD REFLECTION STAGE
            # ════════════════════════════════════════════════════════════════
            reflection_output = self._reflect_on_outcome(
                plan, step, outcome, collected_outcomes
            )

            # ════════════════════════════════════════════════════════════════
            # ACT ON REFLECTION VERDICT
            # ════════════════════════════════════════════════════════════════
            self._apply_reflection_verdict(
                step,
                outcome,
                reflection_output,
                collected_outcomes,
                on_stream_chunk,
            )

            # ========== STAGNATION CHECK ==========
            # (After reflection, not before)
            signal = self._stagnation_detector.check(
                step.step_num, self._ledger, outcome
            )
            if signal.detected:
                self._handle_stagnation(signal)

        # ========== FINAL SYNTHESIS ==========
        final_response = self._synthesize_final_response(
            plan=plan,
            outcomes=collected_outcomes,
            on_stream=on_stream_chunk,
        )

        # ... existing result construction ...

    def _reflect_on_outcome(
        self,
        plan: WizardPlan,
        step: StepState,
        outcome: WorkerOutcome,
        previous_outcomes: List[WorkerOutcome],
    ) -> WizardReflectionOutput:
        """
        Build reflection input and invoke reflector.
        """
        # Build global context
        global_context = ReflectionContext(
            goal=plan.goal,
            goal_type=plan.goal_type,
            total_steps=len(self._plan_state.steps),
            completed_steps=sum(
                1 for s in self._plan_state.steps.values()
                if s.status == StepStatus.COMPLETED
            ),
            failed_steps=sum(
                1 for s in self._plan_state.steps.values()
                if s.status == StepStatus.FAILED
            ),
            remaining_steps=sum(
                1 for s in self._plan_state.steps.values()
                if s.status in (StepStatus.PENDING, StepStatus.IN_PROGRESS)
            ),
            key_facts=self._knowledge.get_top_facts(10),
            total_iterations=self._current_iteration,
            total_tool_calls=self._total_tool_calls,
        )

        # Build step context
        step_context = StepContext(
            step_num=step.step_num,
            objective=step.objective,
            tool_hint=step.tool_hint,
            phase=step.phase.value,
            attempt_count=step.attempt_count,
            depends_on=step.depends_on,
            is_required=step.required,
            previous_errors=self._get_step_errors(step.step_num),
        )

        # Build reflection input
        reflection_input = WizardReflectionInput(
            global_context=global_context,
            step_context=step_context,
            outcome=outcome,
            all_steps=list(self._plan_state.steps.values()),
            recent_outcomes=previous_outcomes[-5:],  # Last 5
        )

        # Invoke reflector
        return self._reflector.reflect(reflection_input)

    def _apply_reflection_verdict(
        self,
        step: StepState,
        outcome: WorkerOutcome,
        reflection: WizardReflectionOutput,
        collected_outcomes: List[WorkerOutcome],
        on_stream: Optional[Callable],
    ) -> None:
        """
        Apply the reflection verdict to update state.
        """
        self._log(
            "debug",
            f"Reflection verdict: {reflection.verdict.value} "
            f"(confidence={reflection.confidence:.2f})"
        )

        match reflection.verdict:

            case ReflectionVerdict.ACCEPT:
                self._handle_accept(step, outcome, reflection, collected_outcomes)

            case ReflectionVerdict.ACCEPT_AND_EXTEND:
                self._handle_accept_extend(
                    step, outcome, reflection, collected_outcomes
                )

            case ReflectionVerdict.REDO:
                self._handle_redo(step, outcome, reflection)

            case ReflectionVerdict.CLARIFY_USER:
                self._handle_clarify_user(step, reflection)

            case ReflectionVerdict.ABORT_STEP:
                self._handle_abort_step(step, reflection)

            case ReflectionVerdict.ABORT_GOAL:
                self._handle_abort_goal(reflection)

        # Stream user message if provided
        if reflection.user_message and on_stream:
            self._stream_content(reflection.user_message, on_stream)

        # Log quality issues
        if reflection.quality.issues:
            self._log("warning", f"Quality issues: {reflection.quality.issues}")
        if reflection.quality.errors:
            self._log("warning", f"Detected errors: {reflection.quality.errors}")

    def _handle_accept(
        self,
        step: StepState,
        outcome: WorkerOutcome,
        reflection: WizardReflectionOutput,
        collected_outcomes: List[WorkerOutcome],
    ) -> None:
        """Handle ACCEPT verdict."""
        self._plan_state.mark_step_complete(
            step.step_num,
            outcome.final_response or "Completed"
        )
        self._ingest_outcome_data(outcome)
        collected_outcomes.append(outcome)
        self._stagnation_detector.reset_step(step.step_num)

        self._log("info", f"Step {step.step_num} ACCEPTED")

    def _handle_accept_extend(
        self,
        step: StepState,
        outcome: WorkerOutcome,
        reflection: WizardReflectionOutput,
        collected_outcomes: List[WorkerOutcome],
    ) -> None:
        """Handle ACCEPT_AND_EXTEND verdict."""
        # First, accept the current step
        self._plan_state.mark_step_complete(
            step.step_num,
            outcome.final_response or "Completed"
        )
        self._ingest_outcome_data(outcome)
        collected_outcomes.append(outcome)

        # Then, scaffold new steps
        for scaffolded in reflection.scaffolded_steps:
            self._scaffold_new_step(scaffolded, after_step=step.step_num)

        self._log(
            "info",
            f"Step {step.step_num} ACCEPTED, scaffolded "
            f"{len(reflection.scaffolded_steps)} new steps"
        )

    def _handle_redo(
        self,
        step: StepState,
        outcome: WorkerOutcome,
        reflection: WizardReflectionOutput,
    ) -> None:
        """Handle REDO verdict."""
        mods = reflection.redo_modifications

        if mods:
            # Apply modifications
            if mods.new_objective:
                step.objective = mods.new_objective
            if mods.new_tool_hint:
                step.tool_hint = mods.new_tool_hint
            if mods.injected_context:
                self._session_context.add_message({
                    "role": "system",
                    "content": f"Additional guidance: {mods.injected_context}"
                })
            if mods.avoid_patterns:
                # Add to step constraints
                step.constraints = step.constraints or []
                step.constraints.extend([
                    f"DO NOT: {pattern}" for pattern in mods.avoid_patterns
                ])

        # Record the error for future attempts
        self._record_step_error(step.step_num, outcome.error or "Redo requested")

        # Reset for retry
        self._plan_state.reset_step_for_retry(step.step_num)

        self._log(
            "info",
            f"Step {step.step_num} marked for REDO "
            f"(attempt {step.attempt_count + 1})"
        )

    def _handle_clarify_user(
        self,
        step: StepState,
        reflection: WizardReflectionOutput,
    ) -> None:
        """Handle CLARIFY_USER verdict."""
        clarification = reflection.clarification
        if not clarification:
            self._log("error", "CLARIFY_USER without clarification request")
            # Fallback to REDO
            self._plan_state.reset_step_for_retry(step.step_num)
            return

        # Generate request ID
        import uuid
        clarification.request_id = f"clarify_{uuid.uuid4().hex[:8]}"
        clarification.step_num = step.step_num

        # Store pending clarification
        self._pending_clarifications[clarification.request_id] = clarification

        # Update step status
        step.status = StepStatus.AWAITING_USER
        step.clarification_request_id = clarification.request_id

        # Emit event to TUI
        if self._on_clarification_needed:
            self._on_clarification_needed(clarification)

        self._log(
            "info",
            f"Step {step.step_num} AWAITING_USER: {clarification.question[:50]}..."
        )

    def _handle_abort_step(
        self,
        step: StepState,
        reflection: WizardReflectionOutput,
    ) -> None:
        """Handle ABORT_STEP verdict."""
        self._plan_state.mark_step_skipped(
            step.step_num,
            f"Wizard decision: {reflection.abort_reason or 'Not achievable'}"
        )
        self._stagnation_detector.reset_step(step.step_num)

        self._log(
            "info",
            f"Step {step.step_num} ABORTED: {reflection.abort_reason}"
        )

    def _handle_abort_goal(
        self,
        reflection: WizardReflectionOutput,
    ) -> None:
        """Handle ABORT_GOAL verdict."""
        self._log(
            "error",
            f"GOAL ABORTED: {reflection.abort_reason}"
        )

        # Mark all pending steps as skipped
        for step in self._plan_state.steps.values():
            if step.status in (StepStatus.PENDING, StepStatus.IN_PROGRESS):
                self._plan_state.mark_step_skipped(
                    step.step_num,
                    "Goal aborted"
                )

        # This will cause the loop to terminate
        self._goal_aborted = True
        self._goal_abort_reason = reflection.abort_reason

    def _scaffold_new_step(
        self,
        scaffolded: ScaffoldedStep,
        after_step: int,
    ) -> None:
        """Insert a new scaffolded step into the plan."""
        # Find the next step number
        max_step = max(s.step_num for s in self._plan_state.steps.values())
        new_step_num = max_step + 1

        # Create the step
        from .types import WizardStep, StepPhase

        new_step = WizardStep(
            step_num=new_step_num,
            objective=scaffolded.objective,
            tool_hint=scaffolded.tool_hint,
            phase=StepPhase(scaffolded.phase),
            depends_on=scaffolded.depends_on or [after_step],
            required=scaffolded.required,
        )

        # Create patch to insert
        from .plan_patch import PlanPatch

        patch = PlanPatch.create_insert(
            objective=scaffolded.objective,
            tool_hint=scaffolded.tool_hint,
            insert_after=after_step,
            base_plan_version=self._plan_state.version,
            justification=scaffolded.rationale,
        )

        # Apply patch
        applied = self._plan_state.apply_patch(patch)
        if applied:
            self._log(
                "debug",
                f"Scaffolded step {new_step_num}: {scaffolded.objective[:50]}..."
            )
        else:
            self._log(
                "warning",
                f"Failed to scaffold step: {scaffolded.objective[:50]}..."
            )
```

### 7.2 Updated Step Status Handling

```python
def _has_steps_awaiting_user(self) -> bool:
    """Check if any steps are awaiting user clarification."""
    return any(
        s.status == StepStatus.AWAITING_USER
        for s in self._plan_state.steps.values()
    )

def _check_clarification_timeout(self) -> bool:
    """
    Check for timed-out clarifications and apply defaults.

    Returns True if any clarifications were resolved.
    """
    import time
    current_time = time.time()
    resolved = False

    for step in self._plan_state.steps.values():
        if step.status != StepStatus.AWAITING_USER:
            continue

        request_id = step.clarification_request_id
        if not request_id or request_id not in self._pending_clarifications:
            continue

        request = self._pending_clarifications[request_id]

        # Check for response
        if request_id in self._clarification_responses:
            response = self._clarification_responses.pop(request_id)
            self._apply_clarification_response(step, request, response)
            resolved = True
            continue

        # Check for timeout
        elapsed = current_time - request.created_at
        if elapsed > request.timeout_seconds:
            # Apply default assumption
            self._apply_default_assumption(step, request)
            resolved = True

    return resolved

def _apply_clarification_response(
    self,
    step: StepState,
    request: ClarificationRequest,
    response: ClarificationResponse,
) -> None:
    """Apply user's clarification response and resume step."""
    # Inject answer into context
    answer = response.answer or request.default_assumption
    self._session_context.add_message({
        "role": "user",
        "content": f"Clarification for '{request.question}':\n{answer}"
    })

    # Reset step to pending
    step.status = StepStatus.PENDING
    step.clarification_request_id = None

    # Remove from pending
    self._pending_clarifications.pop(request.request_id, None)

    self._log(
        "info",
        f"Step {step.step_num} resumed with clarification: {answer[:50]}..."
    )

def _apply_default_assumption(
    self,
    step: StepState,
    request: ClarificationRequest,
) -> None:
    """Apply default assumption after timeout."""
    self._session_context.add_message({
        "role": "system",
        "content": f"Assumption (user did not respond): {request.default_assumption}"
    })

    # Reset step to pending
    step.status = StepStatus.PENDING
    step.clarification_request_id = None

    # Remove from pending
    self._pending_clarifications.pop(request.request_id, None)

    self._log(
        "info",
        f"Step {step.step_num} resumed with default: {request.default_assumption[:50]}..."
    )
```

---

## 8. User Clarification System

### 8.1 Design Principles

1. **Clarification is a last resort** - Most decisions should be assumable
2. **Always have a default** - Every clarification auto-proceeds after timeout
3. **Be specific** - Vague questions are rejected
4. **Provide options** - Multiple choice when possible
5. **Explain context** - User should understand why we're asking

### 8.2 Clarification Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLARIFICATION FLOW                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Wizard Reflection                                               │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────┐                                            │
│  │ Verdict:        │                                            │
│  │ CLARIFY_USER    │                                            │
│  └────────┬────────┘                                            │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────────────────────────────┐                    │
│  │ Validate Clarification Request          │                    │
│  │ • Has question?                         │                    │
│  │ • Has default_assumption? (REQUIRED)    │                    │
│  │ • Options reasonable?                   │                    │
│  └────────┬────────────────────────────────┘                    │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────────────────────────────┐                    │
│  │ Step Status: AWAITING_USER              │                    │
│  │ Store pending clarification             │                    │
│  └────────┬────────────────────────────────┘                    │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────────────────────────────┐                    │
│  │ Emit ClarificationRequestEvent          │────────────────┐   │
│  │ to TUI/Frontend                         │                │   │
│  └─────────────────────────────────────────┘                │   │
│                                                              │   │
│  ┌───────────────────────────────────────────────────────────┼───┤
│  │                         TUI                               │   │
│  │                                                           ▼   │
│  │  ┌─────────────────────────────────────────────────────┐     │
│  │  │ Display Clarification UI                            │     │
│  │  │                                                     │     │
│  │  │  ┌─────────────────────────────────────────────┐   │     │
│  │  │  │ "Which database should I use?"              │   │     │
│  │  │  │                                             │   │     │
│  │  │  │  ○ PostgreSQL (Recommended)                 │   │     │
│  │  │  │  ○ MySQL                                    │   │     │
│  │  │  │  ○ SQLite                                   │   │     │
│  │  │  │  ○ Other: [_______________]                 │   │     │
│  │  │  │                                             │   │     │
│  │  │  │  Default: PostgreSQL (in 45s)               │   │     │
│  │  │  │                                             │   │     │
│  │  │  │  [Submit]                                   │   │     │
│  │  │  └─────────────────────────────────────────────┘   │     │
│  │  └─────────────────────────────────────────────────────┘     │
│  │                              │                                │
│  │                              ▼                                │
│  │  ┌─────────────────────────────────────────────────────┐     │
│  │  │ User selects option OR timeout                      │     │
│  │  └────────────────────────┬────────────────────────────┘     │
│  └───────────────────────────┼───────────────────────────────────┤
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────┐                    │
│  │ ClarificationResponseEvent              │                    │
│  │ OR Timeout → Use default                │                    │
│  └────────┬────────────────────────────────┘                    │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────────────────────────────┐                    │
│  │ Inject answer into SessionContext       │                    │
│  │ Step Status: PENDING                    │                    │
│  │ Continue orchestration                  │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 Clarification Validation Rules

```python
def _validate_clarification_request(
    self,
    request: ClarificationRequest,
) -> Tuple[bool, Optional[str]]:
    """
    Validate a clarification request.

    Returns (is_valid, rejection_reason).
    """
    # Must have a question
    if not request.question or len(request.question) < 10:
        return False, "Question too short or missing"

    # Must have default assumption
    if not request.default_assumption:
        return False, "Missing default assumption"

    # Options limit
    if len(request.options) > self.config.max_clarification_options:
        return False, f"Too many options (max {self.config.max_clarification_options})"

    # Check for assumable questions (anti-pattern)
    assumable_patterns = [
        r"which (framework|library|tool)",
        r"what (language|version)",
        r"(should|would) (i|you|we) use",
        r"prefer(red)?",
    ]
    question_lower = request.question.lower()
    for pattern in assumable_patterns:
        if re.search(pattern, question_lower):
            # These should be assumed, not asked
            return False, f"This can be assumed: {request.default_assumption}"

    return True, None
```

### 8.4 TUI Integration

```typescript
// tui-ts/clarification.tsx

interface ClarificationProps {
  request: ClarificationRequest;
  onResponse: (response: ClarificationResponse) => void;
}

const ClarificationPrompt: React.FC<ClarificationProps> = ({
  request,
  onResponse
}) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [customText, setCustomText] = useState('');
  const [timeLeft, setTimeLeft] = useState(request.timeout_seconds);

  // Countdown timer
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) {
          // Timeout - use default
          onResponse({
            request_id: request.request_id,
            step_num: request.step_num,
            selected_option: null,
            custom_text: null,
            used_default: true,
          });
          return 0;
        }
        return t - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const handleSubmit = () => {
    onResponse({
      request_id: request.request_id,
      step_num: request.step_num,
      selected_option: selected,
      custom_text: customText || null,
      used_default: false,
    });
  };

  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text bold color="yellow">Clarification Needed</Text>

      {request.context && (
        <Text dimColor>{request.context}</Text>
      )}

      <Text>{request.question}</Text>

      <Box flexDirection="column" marginTop={1}>
        {request.options.map((option, i) => (
          <SelectableOption
            key={i}
            label={option}
            selected={selected === option}
            onSelect={() => setSelected(option)}
          />
        ))}

        <TextInput
          placeholder="Or type custom response..."
          value={customText}
          onChange={setCustomText}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Default ({request.default_assumption}) in {timeLeft}s
        </Text>
      </Box>

      <Button onPress={handleSubmit}>Submit</Button>
    </Box>
  );
};
```

---

## 9. Plan Scaffolding

### 9.1 Scaffolding Philosophy

Scaffolding adds steps to achieve **excellence**, not just adequacy. The reflector should scaffold when:

1. **Testing needed** - Code was written but not tested
2. **Documentation needed** - Feature added but not documented
3. **Error handling needed** - Happy path works, edge cases missing
4. **Integration needed** - Component works in isolation, needs connection
5. **Verification needed** - Changes made, need to verify they work
6. **Cleanup needed** - Temporary state needs resolution

### 9.2 Scaffolding Examples

```python
# Example scaffolding decisions

# Scenario 1: Code written, no tests
# Worker output: "I've implemented the authentication module"
# Scaffolded steps:
[
    ScaffoldedStep(
        objective="Write unit tests for authentication module",
        tool_hint="file_write",
        phase="verification",
        rationale="Code needs test coverage for reliability"
    ),
    ScaffoldedStep(
        objective="Run tests and verify authentication works",
        tool_hint="bash_command",
        phase="verification",
        rationale="Confirm implementation correctness"
    ),
]

# Scenario 2: Function added, needs integration
# Worker output: "Added helper function calculate_tax()"
# Scaffolded steps:
[
    ScaffoldedStep(
        objective="Update calling code to use calculate_tax()",
        tool_hint="file_edit",
        phase="execution",
        rationale="Function needs to be connected to usage site"
    ),
]

# Scenario 3: Feature implemented, needs documentation
# Worker output: "Implemented user preferences API"
# Scaffolded steps:
[
    ScaffoldedStep(
        objective="Add docstrings and type hints to preferences API",
        tool_hint="file_edit",
        phase="execution",
        rationale="API needs documentation for maintainability"
    ),
    ScaffoldedStep(
        objective="Update README with preferences API usage",
        tool_hint="file_write",
        phase="execution",
        rationale="Users need to know how to use the new feature"
    ),
]
```

### 9.3 Scaffolding Limits

To prevent runaway scaffolding:

```python
@dataclass
class ScaffoldingLimits:
    """Limits on scaffolding to prevent explosion."""
    max_scaffolded_per_step: int = 3      # Max new steps per reflection
    max_total_scaffolded: int = 10        # Max total scaffolded in session
    max_plan_size: int = 20               # Max total steps in plan
    max_depth: int = 3                    # Max scaffolding chain depth
```

---

## 10. Quality Enforcement

### 10.1 Quality Dimensions

```python
@dataclass
class QualityDimensions:
    """Dimensions assessed in quality evaluation."""

    # Functional quality
    completeness: float      # Did it fully address the objective?
    correctness: float       # Is it correct/bug-free?

    # Structural quality
    clarity: float           # Is output clear and well-organized?
    maintainability: float   # Is code maintainable?

    # User utility
    actionability: float     # Can user act on this?
    relevance: float         # Is it relevant to the goal?
```

### 10.2 Quality Thresholds

```python
QUALITY_THRESHOLDS = {
    "accept": 0.6,           # Minimum to accept
    "excellence": 0.85,      # Above this, no scaffolding needed
    "redo_trigger": 0.4,     # Below this, trigger REDO
    "abort_trigger": 0.2,    # Below this after retries, consider abort
}
```

### 10.3 Error Detection Patterns

```python
ERROR_PATTERNS = {
    "syntax_error": [
        r"SyntaxError:",
        r"IndentationError:",
        r"unexpected token",
    ],
    "runtime_error": [
        r"TypeError:",
        r"AttributeError:",
        r"NameError:",
        r"KeyError:",
    ],
    "incomplete_code": [
        r"# TODO",
        r"pass\s*$",
        r"raise NotImplementedError",
        r"\.\.\.",  # Ellipsis placeholder
    ],
    "hardcoded_values": [
        r"localhost",
        r"127\.0\.0\.1",
        r"password\s*=\s*['\"]",
        r"api_key\s*=\s*['\"]",
    ],
}
```

---

## 11. Event System

### 11.1 Event Types

```python
# src/harness/agent/wizard/events.py

from dataclasses import dataclass
from enum import Enum
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
    timestamp: float
    step_num: Optional[int] = None
    data: Dict[str, Any] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.event_type.value,
            "timestamp": self.timestamp,
            "step_num": self.step_num,
            "data": self.data or {},
        }


# Specific event data structures

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
```

### 11.2 Event Emission

```python
class Wizard:
    def _emit_event(self, event: WizardEvent) -> None:
        """Emit event to registered handlers."""
        if self._event_handlers:
            for handler in self._event_handlers:
                try:
                    handler(event)
                except Exception as e:
                    self._log("warning", f"Event handler error: {e}")

        # Also log for debugging
        self._log("debug", f"Event: {event.event_type.value}", data=event.data)
```

---

## 12. Error Handling & Recovery

### 12.1 Error Categories

| Category | Examples | Recovery Strategy |
|----------|----------|-------------------|
| **Infrastructure** | Network timeout, API error | Retry with backoff |
| **Semantic** | Wrong approach, misunderstanding | REDO with modifications |
| **Context** | Missing information | Scaffold discovery step |
| **Capability** | Task beyond abilities | ABORT_STEP with explanation |
| **User Input** | Needs user decision | CLARIFY_USER |

### 12.2 Recovery Matrix

```python
RECOVERY_MATRIX = {
    # (termination_reason, attempt_count) -> action
    ("exception", 1): "retry",
    ("exception", 2): "retry",
    ("exception", 3): "abort_step",

    ("llm_error", 1): "retry",
    ("llm_error", 2): "retry",
    ("llm_error", 3): "abort_step",

    ("need_context_no_tools", 1): "redo_with_hints",
    ("need_context_no_tools", 2): "scaffold_discovery",
    ("need_context_no_tools", 3): "clarify_or_abort",

    ("max_continues", 1): "redo_simplified",
    ("max_continues", 2): "scaffold_substeps",
    ("max_continues", 3): "abort_step",

    ("no_action", 1): "redo_explicit",
    ("no_action", 2): "redo_explicit",
    ("no_action", 3): "abort_step",
}
```

### 12.3 Graceful Degradation

When reflection itself fails:

```python
def _create_fallback_output(
    self,
    input: WizardReflectionInput,
    error: str,
) -> WizardReflectionOutput:
    """
    Create fallback output when reflection fails.

    Principle: When in doubt, proceed with reasonable defaults.
    """
    if input.outcome.success:
        # Worker succeeded - accept and hope for the best
        return WizardReflectionOutput(
            verdict=ReflectionVerdict.ACCEPT,
            reasoning=f"Reflection failed ({error}), accepting successful outcome",
            confidence=0.3,
            user_message=input.outcome.final_response or "Step completed.",
        )
    else:
        # Worker failed - try one more time
        if input.step_context.attempt_count < 2:
            return WizardReflectionOutput(
                verdict=ReflectionVerdict.REDO,
                reasoning=f"Reflection failed ({error}), retrying step",
                confidence=0.3,
                redo_modifications=RedoModifications(
                    injected_context="Previous attempt failed. Try a simpler approach."
                ),
            )
        else:
            # Give up on this step
            return WizardReflectionOutput(
                verdict=ReflectionVerdict.ABORT_STEP,
                reasoning=f"Reflection failed and step has failed multiple times",
                confidence=0.3,
                abort_reason=f"Step failed after {input.step_context.attempt_count} attempts",
            )
```

---

## 13. Prompt Engineering

### 13.1 Reflection Prompt Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                    REFLECTION PROMPT STRUCTURE                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. ROLE DEFINITION                                             │
│     "You are the Wizard - the orchestrating intelligence..."    │
│                                                                  │
│  2. GLOBAL CONTEXT                                              │
│     • User's goal                                               │
│     • Goal type                                                 │
│     • Plan progress (completed/failed/remaining)                │
│     • Key facts accumulated                                     │
│     • Step status overview                                      │
│                                                                  │
│  3. CURRENT STEP OUTCOME                                        │
│     • Step details (objective, tool hint, attempt count)        │
│     • Worker success/failure                                    │
│     • Termination reason                                        │
│     • Previous attempt errors                                   │
│     • Worker output (truncated)                                 │
│                                                                  │
│  4. TASK DESCRIPTION                                            │
│     • What to analyze                                           │
│     • Quality dimensions                                        │
│                                                                  │
│  5. DECISION OPTIONS                                            │
│     • ACCEPT (when to use, examples)                           │
│     • ACCEPT_EXTEND (when to use, examples)                    │
│     • REDO (when to use, examples)                             │
│     • CLARIFY_USER (when to use, strict rules)                 │
│     • ABORT_STEP (when to use)                                 │
│     • ABORT_GOAL (when to use, rare)                           │
│                                                                  │
│  6. ANTI-PATTERNS                                               │
│     • Things to NOT do                                          │
│     • Common mistakes to avoid                                  │
│                                                                  │
│  7. RESPONSE FORMAT                                             │
│     • JSON schema                                               │
│     • Required fields                                           │
│     • Optional fields per verdict                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 13.2 Key Prompt Phrases

```python
# Phrases that enforce desired behavior

BIAS_TOWARD_ACTION = """
You are an IMPLEMENTER, not a consultant. Prefer action over asking.
If you can make a reasonable assumption, DO IT.
"""

QUALITY_ENFORCEMENT = """
Half-baked work is NOT acceptable. If code is incomplete, tests are missing,
or error handling is absent, scaffold additional steps.
"""

CLARIFICATION_RESTRICTION = """
CLARIFY_USER is a LAST RESORT. Only use when:
- Information is truly unknowable (API keys, business decisions)
- No reasonable default exists

DO NOT CLARIFY for:
- Framework/library choices (pick one)
- Implementation approaches (just implement)
- Testing strategies (use standard practices)
"""

ANTI_EXCUSE_MAKING = """
"I need more information" is NOT a valid Worker response.
Workers should use tools to gather information.
If a Worker asks questions instead of acting, REDO with explicit instructions.
"""
```

### 13.3 Dynamic Prompt Adjustments

```python
def _adjust_prompt_for_context(
    self,
    base_prompt: str,
    input: WizardReflectionInput,
) -> str:
    """Adjust prompt based on context."""
    adjustments = []

    # If this is a retry, emphasize different approach
    if input.step_context.attempt_count > 1:
        adjustments.append(
            "This step has been attempted before. "
            "If choosing REDO, ensure modifications are DIFFERENT from previous attempts."
        )

    # If near plan completion, emphasize finishing
    completion_pct = (
        input.global_context.completed_steps /
        input.global_context.total_steps
    )
    if completion_pct > 0.8:
        adjustments.append(
            "We are near completion. Bias toward ACCEPT unless quality is clearly insufficient."
        )

    # If many failures, emphasize pragmatism
    if input.global_context.failed_steps > 2:
        adjustments.append(
            "Several steps have failed. Consider if the goal is achievable. "
            "Be pragmatic about what can be accomplished."
        )

    if adjustments:
        adjustment_text = "\n\n**CONTEXTUAL GUIDANCE:**\n" + "\n".join(f"• {a}" for a in adjustments)
        return base_prompt + adjustment_text

    return base_prompt
```

---

## 14. Performance Considerations

### 14.1 LLM Call Costs

| Component | Calls per Step | Token Estimate | Notes |
|-----------|---------------|----------------|-------|
| Worker | 1-5 | 2000-10000 | Tool calls, synthesis |
| Reflector | 1 | 1000-2000 | Reflection prompt |
| **Total** | 2-6 | 3000-12000 | Per step |

**Impact:** +1 LLM call per step for reflection. On a 5-step plan, this is +5 calls. Acceptable cost for quality gains.

### 14.2 Latency Considerations

```python
# Reflection should complete within reasonable time
REFLECTION_TIMEOUT_MS = 10000  # 10 seconds max

# If reflection is slow, consider:
# 1. Smaller model for reflection (if available)
# 2. Caching common reflection patterns
# 3. Parallel reflection (for independent steps)
```

### 14.3 Caching Opportunities

```python
# Cache reflection patterns for common scenarios
REFLECTION_CACHE_PATTERNS = {
    # Pattern: (outcome_success, termination_reason) -> cached_verdict
    (True, "completed"): ReflectionVerdict.ACCEPT,  # Fast path
    (True, "implicit_final"): ReflectionVerdict.ACCEPT,
    (False, "exception"): ReflectionVerdict.REDO,  # Infrastructure retry
}

def _check_reflection_cache(
    self,
    input: WizardReflectionInput,
) -> Optional[WizardReflectionOutput]:
    """Check if we can use cached reflection for common patterns."""
    key = (input.outcome.success, input.outcome.termination_reason)

    if key in REFLECTION_CACHE_PATTERNS:
        cached_verdict = REFLECTION_CACHE_PATTERNS[key]

        # Only use cache for simple cases
        if cached_verdict == ReflectionVerdict.ACCEPT and input.outcome.success:
            return WizardReflectionOutput(
                verdict=cached_verdict,
                reasoning="Fast path: successful completion",
                confidence=0.8,
                user_message=input.outcome.final_response,
            )

    return None  # Need full reflection
```

### 14.4 Parallel Execution (Future)

```python
# When max_workers > 1, reflection can happen in parallel
# This requires careful coordination to avoid plan version conflicts

async def _reflect_parallel(
    self,
    outcomes: List[Tuple[StepState, WorkerOutcome]],
) -> List[WizardReflectionOutput]:
    """Reflect on multiple outcomes in parallel."""
    tasks = [
        self._reflector.reflect(self._build_reflection_input(step, outcome))
        for step, outcome in outcomes
    ]
    return await asyncio.gather(*tasks)
```

---

## 15. Testing Strategy

### 15.1 Unit Tests

```python
# tests/test_wizard_reflector.py

class TestWizardReflector:
    """Unit tests for WizardReflector."""

    def test_accept_successful_outcome(self):
        """Successful Worker outcome should be accepted."""
        input = create_reflection_input(
            outcome_success=True,
            termination_reason="completed",
            final_response="Task completed successfully.",
        )

        output = reflector.reflect(input)

        assert output.verdict == ReflectionVerdict.ACCEPT
        assert output.confidence > 0.5

    def test_redo_on_excuse_making(self):
        """Worker asking questions should trigger REDO."""
        input = create_reflection_input(
            outcome_success=False,
            termination_reason="need_context_no_tools",
            final_response="Which framework should I use?",
        )

        output = reflector.reflect(input)

        assert output.verdict == ReflectionVerdict.REDO
        assert output.redo_modifications is not None

    def test_clarification_requires_default(self):
        """CLARIFY_USER must have default assumption."""
        # Mock LLM to return CLARIFY without default
        mock_llm_response = {
            "verdict": "clarify_user",
            "clarification": {
                "question": "What API key?",
                # Missing default_assumption
            }
        }

        output = reflector._parse_response(json.dumps(mock_llm_response), input)

        # Should be converted to REDO
        assert output.verdict == ReflectionVerdict.REDO

    def test_scaffold_for_missing_tests(self):
        """Code without tests should trigger scaffolding."""
        input = create_reflection_input(
            outcome_success=True,
            final_response="def login(user, password): ...",
            # No mention of tests
        )

        output = reflector.reflect(input)

        assert output.verdict == ReflectionVerdict.ACCEPT_AND_EXTEND
        assert any("test" in s.objective.lower() for s in output.scaffolded_steps)

    def test_abort_after_max_retries(self):
        """Step should abort after max retries."""
        input = create_reflection_input(
            outcome_success=False,
            attempt_count=3,
            previous_errors=["Error 1", "Error 2", "Error 3"],
        )

        output = reflector.reflect(input)

        assert output.verdict in (
            ReflectionVerdict.ABORT_STEP,
            ReflectionVerdict.CLARIFY_USER,
        )
```

### 15.2 Integration Tests

```python
# tests/test_wizard_integration.py

class TestWizardIntegration:
    """Integration tests for Wizard with reflection."""

    def test_full_orchestration_with_reflection(self):
        """Test complete orchestration loop with reflection."""
        plan = create_test_plan(steps=[
            {"objective": "Read the config file"},
            {"objective": "Update the setting"},
            {"objective": "Verify the change"},
        ])

        result = wizard.orchestrate(
            plan=plan,
            user_input="Update the max_connections setting to 100",
        )

        assert result.success
        assert result.steps_completed == 3
        assert result.final_response  # Should have meaningful response

    def test_clarification_flow(self):
        """Test user clarification request and response."""
        clarification_received = []

        def on_clarification(request):
            clarification_received.append(request)
            # Simulate user response
            wizard.receive_clarification_response(
                ClarificationResponse(
                    request_id=request.request_id,
                    step_num=request.step_num,
                    selected_option="PostgreSQL",
                )
            )

        result = wizard.orchestrate(
            plan=create_plan_needing_clarification(),
            user_input="Set up the database",
            on_clarification_needed=on_clarification,
        )

        # Should have requested clarification
        assert len(clarification_received) > 0
        # But should have completed
        assert result.success

    def test_scaffolding_integration(self):
        """Test that scaffolded steps are actually executed."""
        plan = create_test_plan(steps=[
            {"objective": "Write a function to calculate tax"},
        ])

        result = wizard.orchestrate(
            plan=plan,
            user_input="Create a tax calculation function",
        )

        # Reflection should have scaffolded test step
        assert result.steps_completed > 1  # Original + scaffolded
```

### 15.3 Behavioral Tests

```python
# tests/test_wizard_behavior.py

class TestWizardBehavior:
    """Behavioral tests for Wizard decision-making."""

    def test_no_silent_failures(self):
        """Every path should produce explicit output."""
        scenarios = [
            # (plan, expected_has_response)
            (failing_plan(), True),
            (impossible_plan(), True),
            (empty_plan(), True),
        ]

        for plan, expected in scenarios:
            result = wizard.orchestrate(plan=plan, user_input="test")
            assert bool(result.final_response) == expected
            assert result.final_response != "Completed processing: test"  # Not fallback

    def test_no_excuse_making_accepted(self):
        """LLM excuse-making should not be accepted."""
        # Configure worker to return excuse-making responses
        mock_worker.configure_response(
            "Before I implement, I need to know which framework..."
        )

        result = wizard.orchestrate(
            plan=simple_implementation_plan(),
            user_input="Add a login feature",
        )

        # Should not contain the excuse-making text
        assert "before i implement" not in result.final_response.lower()
        assert "need to know" not in result.final_response.lower()

    def test_quality_enforcement(self):
        """Low-quality output should not be accepted."""
        mock_worker.configure_response(
            "def login(): pass  # TODO: implement"
        )

        result = wizard.orchestrate(
            plan=implementation_plan(),
            user_input="Implement login",
        )

        # Should have scaffolded or redone
        assert result.steps_completed > 1 or result.total_iterations > 1
```

---

## 16. Migration Path

### 16.1 Phase 1: Add Reflector (Non-Breaking)

1. Create `WizardReflector` class
2. Add reflection types
3. Add `_reflect_on_outcome()` method to Wizard
4. Gate behind feature flag: `WIZARD_REFLECTION_ENABLED=1`
5. Log reflection outputs without acting on them (shadow mode)

### 16.2 Phase 2: Enable Reflection Actions

1. Implement `_apply_reflection_verdict()` methods
2. Enable ACCEPT and REDO verdicts
3. Keep CLARIFY_USER, EXTEND, ABORT disabled
4. Monitor metrics

### 16.3 Phase 3: Enable Scaffolding

1. Enable ACCEPT_AND_EXTEND verdict
2. Implement `_scaffold_new_step()`
3. Add scaffolding limits
4. Monitor plan size growth

### 16.4 Phase 4: Enable Clarification

1. Add AWAITING_USER status
2. Implement clarification event flow
3. Add TUI clarification component
4. Enable CLARIFY_USER verdict

### 16.5 Phase 5: Full Rollout

1. Remove feature flags
2. Enable ABORT_GOAL
3. Tune quality thresholds based on data
4. Document and train users

---

## 17. Future Extensions

### 17.1 Learning from Outcomes

```python
# Future: Learn reflection patterns from feedback
class ReflectorLearner:
    """Learn better reflection from user feedback."""

    def record_feedback(
        self,
        reflection_output: WizardReflectionOutput,
        user_feedback: UserFeedback,
    ) -> None:
        """Record whether a reflection decision was good."""
        pass

    def suggest_adjustments(self) -> ReflectorConfig:
        """Suggest config adjustments based on feedback."""
        pass
```

### 17.2 Multi-Model Reflection

```python
# Future: Use different models for different reflection aspects
class MultiModelReflector:
    """Use specialized models for reflection."""

    def __init__(self):
        self.quality_model = load_model("quality-assessor")
        self.decision_model = load_model("decision-maker")
        self.scaffolding_model = load_model("plan-generator")
```

### 17.3 Proactive Scaffolding

```python
# Future: Scaffold before execution, not just after
class ProactiveScaffolder:
    """Analyze plan and scaffold before execution."""

    def analyze_plan(self, plan: WizardPlan) -> List[ScaffoldedStep]:
        """Identify steps that should be scaffolded proactively."""
        pass
```

---

## 18. Appendix

### 18.1 Glossary

| Term | Definition |
|------|------------|
| **Wizard** | Outer-loop orchestrator that owns global state |
| **Worker** | Bounded step executor, stateless |
| **Reflector** | Intelligence layer that reasons about outcomes |
| **Scaffolding** | Inserting new steps to improve quality |
| **Clarification** | Request for user input when blocked |
| **Verdict** | Reflector's decision about what to do next |
| **Triage** | Classifying failures by type |

### 18.2 File Structure

```
src/harness/agent/wizard/
├── __init__.py
├── wizard.py              # Main orchestrator (modified)
├── worker.py              # Step executor (unchanged)
├── reflector.py           # NEW: Reflection component
├── reflection_types.py    # NEW: Reflection data types
├── types.py               # Wizard types (extended)
├── plan_state.py          # Plan state management
├── knowledge_store.py     # Fact storage
├── work_ledger.py         # Audit trail
├── context_window.py      # Context building
├── plan_patch.py          # Plan mutation
├── policy_gate.py         # Patch validation
├── stagnation.py          # Loop detection
├── events.py              # NEW: Event types
└── protocols.py           # NEW: Protocol definitions
```

### 18.3 Configuration Reference

```python
@dataclass
class WizardConfig:
    # Existing
    max_workers: int = 1
    max_iterations: int = 50
    context_budget_tokens: int = 100_000
    compaction_threshold: float = 0.6
    max_retries_per_step: int = 3
    deadlock_threshold: int = 5

    # NEW: Reflection configuration
    reflection_enabled: bool = True
    reflection_model: Optional[str] = None
    reflection_timeout_ms: int = 10000

    # NEW: Quality thresholds
    min_accept_quality: float = 0.6
    excellence_threshold: float = 0.85

    # NEW: Scaffolding limits
    max_scaffolded_per_step: int = 3
    max_total_scaffolded: int = 10
    max_plan_size: int = 20

    # NEW: Clarification policy
    clarification_timeout_seconds: int = 60
    require_default_assumption: bool = True
    max_clarification_options: int = 4
```

### 18.4 Metrics to Track

```python
WIZARD_METRICS = {
    # Reflection metrics
    "reflection_count": "Total reflections performed",
    "reflection_duration_p50": "Median reflection latency",
    "reflection_duration_p99": "99th percentile reflection latency",

    # Verdict distribution
    "verdict_accept_count": "Steps accepted",
    "verdict_extend_count": "Steps accepted with scaffolding",
    "verdict_redo_count": "Steps redone",
    "verdict_clarify_count": "Clarifications requested",
    "verdict_abort_step_count": "Steps aborted",
    "verdict_abort_goal_count": "Goals aborted",

    # Quality metrics
    "avg_quality_score": "Average quality score",
    "quality_issues_detected": "Total quality issues found",
    "errors_detected": "Total errors caught",

    # Scaffolding metrics
    "scaffolded_steps_total": "Total steps scaffolded",
    "avg_scaffolded_per_accept": "Average steps scaffolded per ACCEPT_EXTEND",

    # Clarification metrics
    "clarification_response_rate": "% of clarifications answered by user",
    "clarification_timeout_rate": "% using default assumption",
    "avg_clarification_response_time": "Average user response time",

    # Outcome metrics
    "silent_failure_rate": "% of requests with no meaningful response",
    "goal_achievement_rate": "% of goals achieved",
    "user_satisfaction_score": "User feedback score",
}
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-12-30 | Architecture Discussion | Initial specification |

---

*End of Specification*
