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
from .eval_runner import EvalRunner, AgentFactory
from .agent_loader import create_agent_from_config, load_agent_config, list_available_agents, print_available_agents
from .metrics import MetricsCalculator, RunComparator
from .visualization import EvalVisualizer
from .agent_interface import EvalAgentProtocol, EvalAgentResponse, validate_agent_response, wrap_response

__all__ = [
    # Core data structures
    'EvalTask',
    'GradingRubric',
    'RubricCriterion',
    'EvalResult',
    'EvalRun',

    # Agent interface (for interoperability)
    'EvalAgentProtocol',
    'EvalAgentResponse',
    'validate_agent_response',
    'wrap_response',

    # Evaluation components
    'LLMJudge',
    'IsolatedEnvironment',
    'TaskExecutor',
    'EvalRunner',
    'AgentFactory',

    # Configuration loaders
    'create_agent_from_config',
    'load_agent_config',
    'list_available_agents',
    'print_available_agents',

    # Analysis tools
    'MetricsCalculator',
    'RunComparator',
    'EvalVisualizer',
]
