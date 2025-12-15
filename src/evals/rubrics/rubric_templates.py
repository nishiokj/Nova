"""
Reusable rubric templates and utilities for creating task-specific rubrics.

Provides template functions for common patterns.
"""

from evals.eval_task import GradingRubric, RubricCriterion
from typing import Dict, Any


def template_file_path(rubric: GradingRubric, file_path: str) -> GradingRubric:
    """
    Template a rubric's file_path placeholders with actual path.

    Args:
        rubric: Base rubric with ${file_path} placeholder
        file_path: Actual file path to substitute

    Returns:
        New rubric with templated values
    """
    new_criteria = []

    for criterion in rubric.criteria:
        new_config = criterion.eval_config.copy()

        # Replace ${file_path} in eval_config
        if "path" in new_config and "${file_path}" in new_config["path"]:
            new_config["path"] = new_config["path"].replace("${file_path}", file_path)

        new_criteria.append(RubricCriterion(
            criterion_id=criterion.criterion_id,
            description=criterion.description,
            points=criterion.points,
            eval_type=criterion.eval_type,
            eval_config=new_config,
            judge_question=criterion.judge_question
        ))

    return GradingRubric(
        rubric_id=rubric.rubric_id,
        criteria=new_criteria,
        pass_threshold=rubric.pass_threshold,
        requires_exact_match=rubric.requires_exact_match,
        case_sensitive=rubric.case_sensitive
    )


def template_rubric(rubric: GradingRubric, **kwargs) -> GradingRubric:
    """
    Template a rubric with arbitrary key-value replacements.

    Args:
        rubric: Base rubric with ${key} placeholders
        **kwargs: Key-value pairs for template replacement

    Returns:
        New rubric with templated values
    """
    new_criteria = []

    for criterion in rubric.criteria:
        new_config = criterion.eval_config.copy()

        # Replace all placeholders in eval_config
        for key in list(new_config.keys()):
            value = new_config[key]

            if isinstance(value, str):
                for template_key, template_value in kwargs.items():
                    placeholder = f"${{{template_key}}}"
                    if placeholder in value:
                        new_config[key] = value.replace(placeholder, str(template_value))

        new_criteria.append(RubricCriterion(
            criterion_id=criterion.criterion_id,
            description=criterion.description,
            points=criterion.points,
            eval_type=criterion.eval_type,
            eval_config=new_config,
            judge_question=criterion.judge_question
        ))

    return GradingRubric(
        rubric_id=rubric.rubric_id,
        criteria=new_criteria,
        pass_threshold=rubric.pass_threshold,
        requires_exact_match=rubric.requires_exact_match,
        case_sensitive=rubric.case_sensitive
    )


def combine_rubrics(rubric1: GradingRubric, rubric2: GradingRubric, weight1: float = 0.5) -> GradingRubric:
    """
    Combine two rubrics with weighted criteria.

    Useful for tasks that span multiple categories.

    Args:
        rubric1: First rubric
        rubric2: Second rubric
        weight1: Weight for first rubric (0-1), second gets (1 - weight1)

    Returns:
        Combined rubric with weighted criteria summing to 100
    """
    weight2 = 1.0 - weight1

    combined_criteria = []

    # Add weighted criteria from rubric1
    for criterion in rubric1.criteria:
        new_points = int(criterion.points * weight1)
        if new_points > 0:
            combined_criteria.append(RubricCriterion(
                criterion_id=f"{rubric1.rubric_id}_{criterion.criterion_id}",
                description=criterion.description,
                points=new_points,
                eval_type=criterion.eval_type,
                eval_config=criterion.eval_config,
                judge_question=criterion.judge_question
            ))

    # Add weighted criteria from rubric2
    for criterion in rubric2.criteria:
        new_points = int(criterion.points * weight2)
        if new_points > 0:
            combined_criteria.append(RubricCriterion(
                criterion_id=f"{rubric2.rubric_id}_{criterion.criterion_id}",
                description=criterion.description,
                points=new_points,
                eval_type=criterion.eval_type,
                eval_config=criterion.eval_config,
                judge_question=criterion.judge_question
            ))

    # Adjust to sum to 100
    total = sum(c.points for c in combined_criteria)
    if total != 100:
        # Proportionally adjust
        for criterion in combined_criteria:
            criterion.points = int(criterion.points * 100 / total)

        # Handle rounding by adding/subtracting from largest
        total = sum(c.points for c in combined_criteria)
        if total != 100:
            combined_criteria[0].points += (100 - total)

    return GradingRubric(
        rubric_id=f"{rubric1.rubric_id}_x_{rubric2.rubric_id}",
        criteria=combined_criteria,
        pass_threshold=70
    )
