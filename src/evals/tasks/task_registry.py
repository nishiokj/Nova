"""
Central registry for all evaluation tasks.

Provides access to all 52 tasks organized by category.
"""

from typing import List, Optional, Dict
from evals.eval_task import EvalTask

from evals.tasks.multi_step_reasoning import MULTI_STEP_TASKS
from evals.tasks.code_operations import CODE_TASKS
from evals.tasks.file_operations import FILE_TASKS
from evals.tasks.search_synthesis import SEARCH_TASKS


# All tasks in one place
ALL_TASKS = MULTI_STEP_TASKS + CODE_TASKS + FILE_TASKS + SEARCH_TASKS


def get_all_tasks() -> List[EvalTask]:
    """
    Get all evaluation tasks.

    Returns:
        List of all 52 EvalTask objects
    """
    return ALL_TASKS.copy()


def get_tasks_by_category(category: str) -> List[EvalTask]:
    """
    Get tasks filtered by category.

    Args:
        category: One of "multi_step_reasoning", "code_ops", "file_ops", "search_synthesis"

    Returns:
        List of EvalTask objects in that category
    """
    return [task for task in ALL_TASKS if task.category == category]


def get_tasks_by_difficulty(difficulty: str) -> List[EvalTask]:
    """
    Get tasks filtered by difficulty.

    Args:
        difficulty: One of "simple", "standard", "advanced"

    Returns:
        List of EvalTask objects at that difficulty level
    """
    return [task for task in ALL_TASKS if task.difficulty == difficulty]


def get_tasks_by_tag(tag: str) -> List[EvalTask]:
    """
    Get tasks filtered by tag.

    Args:
        tag: Tag to filter by (e.g., "python", "algorithms", "research")

    Returns:
        List of EvalTask objects with that tag
    """
    return [task for task in ALL_TASKS if tag in task.tags]


def get_task_by_id(task_id: str) -> Optional[EvalTask]:
    """
    Get a specific task by its ID.

    Args:
        task_id: Task identifier (e.g., "multi_step_001")

    Returns:
        EvalTask object or None if not found
    """
    for task in ALL_TASKS:
        if task.task_id == task_id:
            return task
    return None


def get_task_statistics() -> Dict[str, int]:
    """
    Get statistics about the task collection.

    Returns:
        Dictionary with task counts by various attributes
    """
    stats = {
        "total_tasks": len(ALL_TASKS),
        "by_category": {},
        "by_difficulty": {},
        "by_tool_usage": {}
    }

    # Count by category
    for task in ALL_TASKS:
        category = task.category
        stats["by_category"][category] = stats["by_category"].get(category, 0) + 1

    # Count by difficulty
    for task in ALL_TASKS:
        difficulty = task.difficulty
        stats["by_difficulty"][difficulty] = stats["by_difficulty"].get(difficulty, 0) + 1

    # Count by tool requirements
    for task in ALL_TASKS:
        if task.requires_tools:
            for tool in task.requires_tools:
                stats["by_tool_usage"][tool] = stats["by_tool_usage"].get(tool, 0) + 1

    return stats


def print_task_summary():
    """Print a summary of all tasks."""
    stats = get_task_statistics()

    print("=" * 60)
    print("EVALUATION TASK SUMMARY")
    print("=" * 60)
    print(f"\nTotal Tasks: {stats['total_tasks']}")

    print("\nBy Category:")
    for category, count in sorted(stats["by_category"].items()):
        print(f"  {category:25s}: {count:2d} tasks")

    print("\nBy Difficulty:")
    for difficulty, count in sorted(stats["by_difficulty"].items()):
        print(f"  {difficulty:25s}: {count:2d} tasks")

    print("\nTool Requirements:")
    for tool, count in sorted(stats["by_tool_usage"].items(), key=lambda x: x[1], reverse=True):
        print(f"  {tool:25s}: {count:2d} tasks")

    print("\n" + "=" * 60)


# Print summary when module is run directly
if __name__ == "__main__":
    print_task_summary()

    print("\nSample Tasks:")
    print("\n1. Multi-Step Reasoning:")
    multi_tasks = get_tasks_by_category("multi_step_reasoning")
    for task in multi_tasks[:2]:
        print(f"   [{task.task_id}] {task.difficulty:8s} - {task.prompt[:60]}...")

    print("\n2. Code Operations:")
    code_tasks = get_tasks_by_category("code_ops")
    for task in code_tasks[:2]:
        print(f"   [{task.task_id}] {task.difficulty:8s} - {task.prompt[:60]}...")

    print("\n3. File Operations:")
    file_tasks = get_tasks_by_category("file_ops")
    for task in file_tasks[:2]:
        print(f"   [{task.task_id}] {task.difficulty:8s} - {task.prompt[:60]}...")

    print("\n4. Search & Synthesis:")
    search_tasks = get_tasks_by_category("search_synthesis")
    for task in search_tasks[:2]:
        print(f"   [{task.task_id}] {task.difficulty:8s} - {task.prompt[:60]}...")
