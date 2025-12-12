"""
Rubric definitions for grading tasks.

Provides standardized, reusable rubrics for each task category with:
- Discrete point assignments (summing to 100)
- Binary yes/no evaluation questions
- Automated checks where possible
- LLM-as-judge for subjective criteria
"""

from .category_rubrics import (
    MULTI_STEP_REASONING_RUBRIC,
    CODE_GENERATION_RUBRIC,
    CODE_DEBUG_RUBRIC,
    FILE_OPERATIONS_RUBRIC,
    SEARCH_SYNTHESIS_RUBRIC,
)

__all__ = [
    'MULTI_STEP_REASONING_RUBRIC',
    'CODE_GENERATION_RUBRIC',
    'CODE_DEBUG_RUBRIC',
    'FILE_OPERATIONS_RUBRIC',
    'SEARCH_SYNTHESIS_RUBRIC',
]
