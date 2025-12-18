"""
Structured data models for human-reviewable evaluation system.

Addresses critical findings:
1. Full prompts, tool args/outputs (no truncation, with artifact links)
2. Deterministic file state evidence per turn (git diff, snapshots)
3. Session handling with stable IDs across multi-turn scenarios
4. Integrated performance metrics (PerfTracer + LLM API timings)
5. Reproducibility contract (task_id, commit, seed, workspace)
6. Annotation schema for human review
"""

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Literal
from datetime import datetime
from enum import Enum


# ============================================================================
# Reproducibility Contract
# ============================================================================

@dataclass
class ReproducibilityContext:
    """
    Ensures evaluation runs are fully reproducible.
    All fields needed to recreate exact conditions.
    """
    # Task identification
    task_id: str
    scenario_id: str  # For multi-turn: scenario_id.turn_id
    turn_number: int  # 1-indexed

    # Request/execution IDs (stable across turns in same scenario)
    request_id: str  # Stable per scenario
    execution_id: str  # Unique per turn

    # Agent configuration
    tier: str  # simple, standard, advanced
    model: str  # e.g., claude-sonnet-4-5
    temperature: float
    max_tokens: int

    # Environment
    workspace_path: str  # Isolated sandbox path
    git_commit: str  # Current commit hash
    git_branch: str
    python_version: str

    # Randomness control
    random_seed: Optional[int] = None

    # Timestamps
    started_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    completed_at: Optional[str] = None

    # System state
    env_vars: Dict[str, str] = field(default_factory=dict)  # Filtered safe vars


# ============================================================================
# File State Evidence
# ============================================================================

@dataclass
class FileSnapshot:
    """Captures file state at a point in time."""
    path: str
    content: str
    size_bytes: int
    sha256: str
    exists: bool
    modified_at: str


@dataclass
class FileOperation:
    """Represents a file operation performed by the agent."""
    operation: Literal["create", "modify", "delete", "read"]
    path: str
    tool_name: str
    step_number: int
    before_snapshot: Optional[FileSnapshot] = None
    after_snapshot: Optional[FileSnapshot] = None


@dataclass
class TurnFileState:
    """
    Deterministic file state evidence per turn.
    Addresses: "Final state/files created" will be wrong today
    """
    # Git-based evidence (defaults allow creation without args for default_factory)
    git_diff: str = ""  # Full git diff for this turn
    git_status: str = ""  # Files changed/added/deleted

    # File operations detected
    operations: List[FileOperation] = field(default_factory=list)

    # Snapshots of all touched files
    files_before: Dict[str, FileSnapshot] = field(default_factory=dict)  # path -> snapshot
    files_after: Dict[str, FileSnapshot] = field(default_factory=dict)

    # Working directory state
    working_dir: str = ""
    directory_listing: List[str] = field(default_factory=list)


# ============================================================================
# Full Prompt Capture
# ============================================================================

@dataclass
class PromptMessage:
    """Single message in the prompt."""
    role: Literal["system", "user", "assistant"]
    content: str  # Full content, no truncation
    cached: bool = False
    token_count: int = 0


@dataclass
class FullPrompt:
    """
    Complete prompt sent to LLM, no truncation.
    Addresses: "Human-review export won't have full evidence"
    """
    messages: List[PromptMessage]
    total_tokens: int
    cached_tokens: int

    # Model parameters
    model: str
    temperature: float
    max_tokens: int

    # Tool schemas
    tools: List[Dict[str, Any]] = field(default_factory=list)  # Full tool definitions

    # System prompt details
    system_prompt_id: Optional[str] = None
    system_prompt_version: Optional[str] = None


# ============================================================================
# Tool Trace (Full Detail)
# ============================================================================

@dataclass
class ToolCallTrace:
    """
    Complete tool call with full args and outputs.
    No truncation - use artifact links for large outputs.
    """
    tool_name: str
    arguments: Dict[str, Any]  # Full args

    # Output handling
    output: str  # First 10k chars inline
    output_truncated: bool
    output_artifact_path: Optional[str] = None  # Path to full output file if truncated
    output_size_bytes: int = 0

    # Timing
    started_at: str = ""
    completed_at: str = ""
    duration_ms: float = 0.0

    # Status
    success: bool = True
    error: Optional[str] = None
    error_type: Optional[str] = None

    # Context
    step_number: int = 0
    parallel_group: Optional[int] = None  # If run in parallel with other tools


@dataclass
class ExecutionStepTrace:
    """Complete trace of a single execution step."""
    step_number: int
    step_description: str

    # Planning
    planned_action: str
    tool_hint: str
    dependencies: List[int] = field(default_factory=list)

    # Execution
    tool_calls: List[ToolCallTrace] = field(default_factory=list)
    reasoning: str = ""  # Agent's reasoning for this step

    # Verification
    success: bool = True
    postcondition_met: bool = True
    error_message: Optional[str] = None

    # Timing
    duration_ms: float = 0.0


# ============================================================================
# Performance Metrics
# ============================================================================

@dataclass
class PerformanceMetrics:
    """
    Integrated performance data from PerfTracer and LLM API.
    Addresses: "Latency tracking overlaps/misses"
    """
    # Phase timings (from PerfTracer)
    planning_ms: float = 0.0
    execution_ms: float = 0.0
    reflection_ms: float = 0.0
    total_turn_ms: float = 0.0

    # Per-step breakdown
    step_timings: List[Dict[str, float]] = field(default_factory=list)  # [{step_num, duration_ms}]

    # LLM API calls
    llm_calls: List[Dict[str, Any]] = field(default_factory=list)  # [{phase, latency_ms, tokens}]

    # Tool execution
    tool_latencies: Dict[str, List[float]] = field(default_factory=dict)  # tool_name -> [durations]

    # Cumulative (for multi-turn)
    cumulative_turn_ms: float = 0.0  # Sum across all turns in scenario
    turn_number: int = 1

    # Detailed trace tree (from PerfTracer)
    perf_trace_tree: Optional[Dict[str, Any]] = None


# ============================================================================
# Structured Execution Record (Per Turn)
# ============================================================================

@dataclass
class TurnExecutionRecord:
    """
    Complete structured record for a single turn.
    This is the primary artifact for human review.

    Addresses all critical findings:
    - Full prompts and tool traces
    - File state evidence
    - Performance metrics
    - Reproducibility context
    - Stable IDs for linking
    """
    # Identification & linking
    repro_context: ReproducibilityContext

    # User input
    user_prompt: str
    conversation_history: List[PromptMessage] = field(default_factory=list)  # Last N turns

    # Planning phase
    full_prompt_planning: Optional[FullPrompt] = None
    plan: Optional[Dict[str, Any]] = None  # Full Plan object serialized
    plan_reasoning: str = ""

    # Execution phase
    full_prompt_execution: Optional[FullPrompt] = None
    execution_steps: List[ExecutionStepTrace] = field(default_factory=list)

    # Reflection phase
    full_prompt_reflection: Optional[FullPrompt] = None
    reflection: Optional[Dict[str, Any]] = None  # Full Reflection object
    goal_achieved: bool = False
    goal_confidence: float = 0.0

    # File state
    file_state: TurnFileState = field(default_factory=TurnFileState)

    # Performance
    performance: PerformanceMetrics = field(default_factory=PerformanceMetrics)

    # Final output
    final_response: str = ""

    # Status
    success: bool = True
    error: Optional[str] = None

    # Metadata
    logged_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())


# ============================================================================
# Multi-Turn Scenario Record
# ============================================================================

@dataclass
class ScenarioExecutionRecord:
    """
    Complete record for a multi-turn scenario.
    Aggregates all turns with stable IDs.
    """
    scenario_id: str
    task_id: str

    # Turns in order
    turns: List[TurnExecutionRecord] = field(default_factory=list)

    # Aggregate metrics
    total_turns: int = 0
    successful_turns: int = 0
    total_latency_ms: float = 0.0

    # File state evolution
    initial_workspace_state: Dict[str, FileSnapshot] = field(default_factory=dict)
    final_workspace_state: Dict[str, FileSnapshot] = field(default_factory=dict)
    all_file_operations: List[FileOperation] = field(default_factory=list)

    # Overall success
    scenario_passed: bool = False
    failure_reason: Optional[str] = None

    # Reproducibility
    repro_context: ReproducibilityContext = field(default_factory=lambda: ReproducibilityContext(
        task_id="", scenario_id="", turn_number=0, request_id="", execution_id="",
        tier="", model="", temperature=0.0, max_tokens=0, workspace_path="",
        git_commit="", git_branch="", python_version=""
    ))


# ============================================================================
# Human Review Annotation
# ============================================================================

class ReviewTag(str, Enum):
    """Standardized tags for human review."""
    # Correctness
    CORRECT = "correct"
    INCORRECT = "incorrect"
    PARTIAL = "partial"

    # Error types
    PLANNING_ERROR = "planning_error"
    EXECUTION_ERROR = "execution_error"
    TOOL_MISUSE = "tool_misuse"
    REASONING_ERROR = "reasoning_error"

    # Performance
    SLOW_PLANNING = "slow_planning"
    SLOW_EXECUTION = "slow_execution"
    SLOW_REFLECTION = "slow_reflection"

    # Edge cases
    EDGE_CASE_HANDLED = "edge_case_handled"
    EDGE_CASE_FAILED = "edge_case_failed"

    # Quality
    OVER_ENGINEERED = "over_engineered"
    UNDER_ENGINEERED = "under_engineered"
    GOOD_SOLUTION = "good_solution"


@dataclass
class StepAnnotation:
    """Human annotation for a specific step."""
    step_number: int
    correct: bool
    notes: str = ""
    tags: List[ReviewTag] = field(default_factory=list)


@dataclass
class TurnAnnotation:
    """Human review annotation for a turn."""
    turn_number: int

    # Overall assessment
    passed: bool
    confidence: float  # 0.0 to 1.0

    # Detailed feedback
    notes: str = ""
    tags: List[ReviewTag] = field(default_factory=list)

    # Step-level annotations
    step_annotations: List[StepAnnotation] = field(default_factory=list)

    # Reviewer info
    reviewer: str = ""
    reviewed_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())


@dataclass
class ScenarioAnnotation:
    """Complete human review for a scenario."""
    scenario_id: str
    task_id: str

    # Overall verdict
    passed: bool
    confidence: float
    summary: str = ""

    # Turn-level annotations
    turn_annotations: List[TurnAnnotation] = field(default_factory=list)

    # Aggregate tags
    all_tags: List[ReviewTag] = field(default_factory=list)

    # Reviewer
    reviewer: str = ""
    reviewed_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())


# ============================================================================
# Evaluation Result
# ============================================================================

@dataclass
class EvaluationResult:
    """
    Complete evaluation result combining execution and human review.
    This is the final artifact exported to HTML.
    """
    scenario: ScenarioExecutionRecord
    annotation: Optional[ScenarioAnnotation] = None

    # LLM judge (optional, for comparison with human)
    llm_judge_score: Optional[float] = None
    llm_judge_reasoning: Optional[str] = None

    # Export metadata
    exported_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    export_format: str = "html"
    redacted: bool = False  # True if secrets were redacted
