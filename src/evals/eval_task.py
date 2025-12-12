"""
Core data structures for evaluation system.

Defines tasks, rubrics, and results with strict typing and validation.
"""

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from datetime import datetime
import json


@dataclass
class RubricCriterion:
    """
    A single grading criterion within a rubric.

    Each criterion specifies how to evaluate one aspect of the agent's response,
    with a discrete point value and evaluation method.
    """
    criterion_id: str
    description: str  # What this criterion measures
    points: int  # Max points for this criterion

    # Evaluation method
    eval_type: str  # "exact_match", "contains", "regex", "file_exists", "python_test", "llm_judge"
    eval_config: Dict[str, Any] = field(default_factory=dict)  # Config for evaluation method

    # For llm_judge type
    judge_question: Optional[str] = None  # Binary yes/no question for judge

    def __post_init__(self):
        """Validate criterion configuration."""
        valid_types = ["exact_match", "contains", "regex", "file_exists", "python_test", "llm_judge"]
        if self.eval_type not in valid_types:
            raise ValueError(f"Invalid eval_type: {self.eval_type}. Must be one of {valid_types}")

        if self.eval_type == "llm_judge" and not self.judge_question:
            raise ValueError(f"Criterion {self.criterion_id} requires judge_question for llm_judge eval_type")

        if self.points <= 0:
            raise ValueError(f"Criterion {self.criterion_id} must have positive points")


@dataclass
class GradingRubric:
    """
    Discrete, uncontestable grading criteria for a task.

    Designed for maximum reproducibility - same agent output
    should always get same score.
    """
    rubric_id: str
    criteria: List[RubricCriterion]
    pass_threshold: int = 70  # Minimum score to pass (0-100)

    # Optional validation rules
    requires_exact_match: bool = False  # Some tasks need exact answers
    case_sensitive: bool = False

    def __post_init__(self):
        """Validate rubric configuration."""
        # Ensure criteria sum to 100 points
        total_points = sum(c.points for c in self.criteria)
        if total_points != 100:
            raise ValueError(
                f"Rubric {self.rubric_id} criteria must sum to 100 points, got {total_points}"
            )

        if not (0 <= self.pass_threshold <= 100):
            raise ValueError(f"pass_threshold must be 0-100, got {self.pass_threshold}")

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "rubric_id": self.rubric_id,
            "criteria": [
                {
                    "criterion_id": c.criterion_id,
                    "description": c.description,
                    "points": c.points,
                    "eval_type": c.eval_type,
                    "eval_config": c.eval_config,
                    "judge_question": c.judge_question
                }
                for c in self.criteria
            ],
            "pass_threshold": self.pass_threshold,
            "requires_exact_match": self.requires_exact_match,
            "case_sensitive": self.case_sensitive
        }


@dataclass
class EvalTask:
    """
    Definition of a single evaluation task.

    Each task defines what input to give the agent, what the expected
    behavior is, and how to grade the result.
    """
    # Required fields (no defaults)
    task_id: str  # Unique identifier (e.g., "multi_step_001")
    category: str  # "multi_step_reasoning", "code_ops", "file_ops", "search_synthesis"
    difficulty: str  # "simple", "standard", "advanced"
    prompt: str  # Input given to agent
    expected_behavior: str  # Natural language description of correct behavior

    # Optional fields (with defaults)
    context: Optional[Dict[str, Any]] = None  # Additional context (files, env vars, etc.)
    success_criteria: List[str] = field(default_factory=list)  # Discrete success conditions
    rubric: Optional[GradingRubric] = None  # How to grade this task
    timeout_seconds: int = 120
    max_retries: int = 0
    requires_tools: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    notes: str = ""

    def __post_init__(self):
        """Validate task configuration."""
        valid_categories = ["multi_step_reasoning", "code_ops", "file_ops", "search_synthesis"]
        if self.category not in valid_categories:
            raise ValueError(f"Invalid category: {self.category}. Must be one of {valid_categories}")

        valid_difficulties = ["simple", "standard", "advanced"]
        if self.difficulty not in valid_difficulties:
            raise ValueError(f"Invalid difficulty: {self.difficulty}. Must be one of {valid_difficulties}")

        if self.timeout_seconds <= 0:
            raise ValueError(f"timeout_seconds must be positive, got {self.timeout_seconds}")

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "task_id": self.task_id,
            "category": self.category,
            "difficulty": self.difficulty,
            "prompt": self.prompt,
            "context": self.context,
            "expected_behavior": self.expected_behavior,
            "success_criteria": self.success_criteria,
            "rubric": self.rubric.to_dict() if self.rubric else None,
            "timeout_seconds": self.timeout_seconds,
            "max_retries": self.max_retries,
            "requires_tools": self.requires_tools,
            "tags": self.tags,
            "notes": self.notes
        }


@dataclass
class EvalResult:
    """
    Result of running a single eval task.

    Contains the agent's response, execution details, and grading results.
    """
    task_id: str
    timestamp: str

    # Execution details
    agent_response: Any  # AgentResponse object (imported at runtime to avoid circular deps)
    execution_time_ms: float
    tools_used: List[str]

    # Grading
    score: float  # 0-100
    criterion_scores: Dict[str, float]  # Breakdown by criterion
    passed: bool  # Whether task passed threshold

    # Judge reasoning (for transparency)
    judge_reasoning: str
    judge_raw_response: str = ""  # Full judge output for debugging

    # Failure analysis
    failure_mode: Optional[str] = None  # If failed, what went wrong
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        # Convert agent_response to dict if it has to_dict method
        agent_response_dict = None
        if self.agent_response:
            if hasattr(self.agent_response, 'to_dict'):
                agent_response_dict = self.agent_response.to_dict()
            else:
                agent_response_dict = str(self.agent_response)

        return {
            "task_id": self.task_id,
            "timestamp": self.timestamp,
            "agent_response": agent_response_dict,
            "execution_time_ms": self.execution_time_ms,
            "tools_used": self.tools_used,
            "score": self.score,
            "criterion_scores": self.criterion_scores,
            "passed": self.passed,
            "judge_reasoning": self.judge_reasoning,
            "judge_raw_response": self.judge_raw_response,
            "failure_mode": self.failure_mode,
            "error": self.error
        }

    def to_json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=2)


@dataclass
class EvalRun:
    """
    Aggregate results from running full eval suite.

    Contains all task results plus computed metrics and analysis.
    """
    run_id: str
    timestamp: str
    config: Dict[str, Any]  # Agent/model configuration tested

    # Results
    task_results: List[EvalResult]
    total_tasks: int

    # Aggregate metrics
    metrics: Dict[str, Any]  # pass_rate, avg_score, etc.

    # Categorized metrics
    category_metrics: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    difficulty_metrics: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "run_id": self.run_id,
            "timestamp": self.timestamp,
            "config": self.config,
            "task_results": [r.to_dict() for r in self.task_results],
            "total_tasks": self.total_tasks,
            "metrics": self.metrics,
            "category_metrics": self.category_metrics,
            "difficulty_metrics": self.difficulty_metrics
        }

    def to_json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=2)

    def save(self, filepath: str):
        """Save run results to JSON file."""
        with open(filepath, 'w') as f:
            f.write(self.to_json())

    @classmethod
    def load(cls, filepath: str) -> 'EvalRun':
        """Load run results from JSON file."""
        with open(filepath, 'r') as f:
            data = json.load(f)

        # Reconstruct task_results (simplified - AgentResponse not fully reconstructed)
        task_results = []
        for result_data in data['task_results']:
            task_results.append(EvalResult(
                task_id=result_data['task_id'],
                timestamp=result_data['timestamp'],
                agent_response=result_data.get('agent_response'),
                execution_time_ms=result_data['execution_time_ms'],
                tools_used=result_data['tools_used'],
                score=result_data['score'],
                criterion_scores=result_data['criterion_scores'],
                passed=result_data['passed'],
                judge_reasoning=result_data['judge_reasoning'],
                judge_raw_response=result_data.get('judge_raw_response', ''),
                failure_mode=result_data.get('failure_mode'),
                error=result_data.get('error')
            ))

        return cls(
            run_id=data['run_id'],
            timestamp=data['timestamp'],
            config=data['config'],
            task_results=task_results,
            total_tasks=data['total_tasks'],
            metrics=data['metrics'],
            category_metrics=data.get('category_metrics', {}),
            difficulty_metrics=data.get('difficulty_metrics', {})
        )


def create_error_result(task: EvalTask, error: Exception) -> EvalResult:
    """Create an EvalResult for a task that failed with an exception."""
    return EvalResult(
        task_id=task.task_id,
        timestamp=datetime.utcnow().isoformat(),
        agent_response=None,
        execution_time_ms=0.0,
        tools_used=[],
        score=0.0,
        criterion_scores={},
        passed=False,
        judge_reasoning=f"Task failed with exception: {type(error).__name__}",
        judge_raw_response="",
        failure_mode="exception",
        error=str(error)
    )
