"""
Task definitions for evaluation system.

Contains 50+ tasks organized by category:
- multi_step_reasoning: Complex reasoning and synthesis tasks
- code_operations: Code generation, debugging, and execution
- file_operations: File manipulation and data processing
- search_synthesis: Web search and information synthesis
"""

from .task_registry import get_all_tasks, get_tasks_by_category, get_task_by_id

__all__ = [
    'get_all_tasks',
    'get_tasks_by_category',
    'get_task_by_id',
]
