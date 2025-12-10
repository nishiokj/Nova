"""
Evaluation system for testing agent performance across different models and configurations.

This package provides a comprehensive evaluation framework with:
- 50+ test tasks covering multi-step reasoning, code operations, file operations, and search
- LLM-as-judge grading with discrete, reproducible rubrics
- Real tool execution with proper isolation
- Statistical metrics and visualization
- Modular design for easy agent/model swapping
"""

from .eval_task import EvalTask, GradingRubric, RubricCriterion, EvalResult, EvalRun
from .grading import LLMJudge
from .isolation import IsolatedEnvironment, TaskExecutor

__all__ = [
    'EvalTask',
    'GradingRubric',
    'RubricCriterion',
    'EvalResult',
    'EvalRun',
    'LLMJudge',
    'IsolatedEnvironment',
    'TaskExecutor',
]

# Import additional modules when they're available
try:
    from .eval_runner import EvalRunner
    __all__.append('EvalRunner')
except ImportError:
    pass

try:
    from .metrics import MetricsCalculator, RunComparator
    __all__.extend(['MetricsCalculator', 'RunComparator'])
except ImportError:
    pass

try:
    from .visualization import EvalVisualizer
    __all__.append('EvalVisualizer')
except ImportError:
    pass
