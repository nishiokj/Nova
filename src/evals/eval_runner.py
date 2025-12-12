"""
Main evaluation orchestration.

Coordinates task execution, grading, metrics computation, and result saving.
"""

import logging
from typing import List, Callable, Optional, Dict, Any
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import json

from .eval_task import EvalTask, EvalResult, EvalRun, create_error_result
from .isolation import TaskExecutor
from .grading import LLMJudge
from harness.llm_adapter import LLMAdapter


logger = logging.getLogger(__name__)


class EvalRunner:
    """
    Main evaluation orchestrator.

    Coordinates:
    1. Task execution with isolation
    2. Batched grading with LLM judge
    3. Metrics computation
    4. Result persistence
    """

    def __init__(
        self,
        agent_factory: Callable,
        judge_llm: LLMAdapter,
        output_dir: Path,
        batch_size: int = 5
    ):
        """
        Initialize evaluation runner.

        Args:
            agent_factory: Callable that creates fresh agent instances
            judge_llm: LLM adapter for judging (should be temperature=0)
            output_dir: Directory to save results
            batch_size: Number of tasks to grade in parallel (default 5)
        """
        self.agent_factory = agent_factory
        self.judge = LLMJudge(judge_llm)
        self.executor = TaskExecutor(agent_factory)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.batch_size = batch_size

    def run_evaluation(
        self,
        tasks: List[EvalTask],
        run_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        parallel_execution: bool = False,
        max_workers: int = 3
    ) -> EvalRun:
        """
        Run full evaluation suite.

        Args:
            tasks: List of tasks to evaluate
            run_id: Optional run identifier (auto-generated if not provided)
            config: Agent/model configuration metadata
            parallel_execution: Whether to execute tasks in parallel
            max_workers: Number of parallel workers for execution

        Returns:
            EvalRun with all results and metrics
        """
        if not run_id:
            run_id = f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

        if not config:
            config = {"agent_type": "unknown"}

        logger.info(f"Starting evaluation run: {run_id}")
        logger.info(f"Total tasks: {len(tasks)}")

        self._ensure_judge_ready()

        # Phase 1: Execute all tasks
        logger.info("Phase 1: Executing tasks...")
        if parallel_execution:
            execution_results = self._execute_tasks_parallel(tasks, max_workers)
        else:
            execution_results = self._execute_tasks_sequential(tasks)

        # Phase 2: Grade all tasks in batches
        logger.info(f"Phase 2: Grading tasks (batch size: {self.batch_size})...")
        eval_results = self._grade_tasks_batched(tasks, execution_results)

        # Phase 3: Compute metrics
        logger.info("Phase 3: Computing metrics...")
        from .metrics import MetricsCalculator
        metrics_calc = MetricsCalculator()
        overall_metrics = metrics_calc.calculate_metrics(eval_results)
        category_metrics = metrics_calc.calculate_category_metrics(eval_results, tasks)
        difficulty_metrics = metrics_calc.calculate_difficulty_metrics(eval_results, tasks)

        # Create eval run
        eval_run = EvalRun(
            run_id=run_id,
            timestamp=datetime.utcnow().isoformat(),
            config=config,
            task_results=eval_results,
            total_tasks=len(tasks),
            metrics=overall_metrics,
            category_metrics=category_metrics,
            difficulty_metrics=difficulty_metrics
        )

        # Save results
        result_file = self.output_dir / f"{run_id}.json"
        eval_run.save(str(result_file))
        logger.info(f"Results saved to: {result_file}")

        # Log summary
        logger.info(f"Evaluation complete!")
        logger.info(f"Pass rate: {overall_metrics['pass_rate']*100:.1f}%")
        logger.info(f"Mean score: {overall_metrics['mean_score']:.1f}/100")

        return eval_run

    def _ensure_judge_ready(self) -> None:
        """Ensure the judge LLM is initialized before running tasks."""
        logger.info("Phase 0: Initializing judge LLM...")
        try:
            self.judge.ensure_ready()
        except Exception:
            logger.error("Judge initialization failed; aborting evaluation.")
            raise

    def _execute_tasks_sequential(self, tasks: List[EvalTask]) -> List[Any]:
        """Execute tasks sequentially."""
        execution_results = []

        for i, task in enumerate(tasks, 1):
            logger.info(f"[{i}/{len(tasks)}] Executing {task.task_id}...")

            try:
                agent_response = self.executor.execute_task(task)
                execution_results.append(agent_response)
            except Exception as e:
                logger.error(f"Task {task.task_id} failed with exception: {e}")
                execution_results.append(None)

        return execution_results

    def _execute_tasks_parallel(
        self,
        tasks: List[EvalTask],
        max_workers: int
    ) -> List[Any]:
        """Execute tasks in parallel."""
        execution_results = [None] * len(tasks)

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Submit all tasks
            future_to_idx = {}
            for i, task in enumerate(tasks):
                future = executor.submit(self._execute_single_task, task, i + 1, len(tasks))
                future_to_idx[future] = i

            # Collect results as they complete
            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                try:
                    result = future.result()
                    execution_results[idx] = result
                except Exception as e:
                    logger.error(f"Task {tasks[idx].task_id} failed: {e}")
                    execution_results[idx] = None

        return execution_results

    def _execute_single_task(self, task: EvalTask, task_num: int, total: int) -> Any:
        """Execute a single task (helper for parallel execution)."""
        logger.info(f"[{task_num}/{total}] Executing {task.task_id}...")
        return self.executor.execute_task(task)

    def _grade_tasks_batched(
        self,
        tasks: List[EvalTask],
        execution_results: List[Any]
    ) -> List[EvalResult]:
        """
        Grade tasks in batches for efficiency.

        Batching allows the judge LLM to process multiple evaluations
        in parallel, significantly speeding up the grading phase.
        """
        eval_results = []
        total_tasks = len(tasks)

        # Process in batches
        for batch_start in range(0, total_tasks, self.batch_size):
            batch_end = min(batch_start + self.batch_size, total_tasks)
            batch_tasks = tasks[batch_start:batch_end]
            batch_responses = execution_results[batch_start:batch_end]

            logger.info(f"Grading batch {batch_start//self.batch_size + 1} "
                       f"(tasks {batch_start+1}-{batch_end})...")

            # Grade batch in parallel
            with ThreadPoolExecutor(max_workers=self.batch_size) as executor:
                futures = []
                for task, response in zip(batch_tasks, batch_responses):
                    future = executor.submit(self._grade_single_task, task, response)
                    futures.append(future)

                # Collect results
                for future in as_completed(futures):
                    try:
                        result = future.result()
                        eval_results.append(result)
                        # Log progress
                        score_str = f"{result.score:.1f}/100"
                        status = "PASS" if result.passed else "FAIL"
                        logger.info(f"  [{result.task_id}] {score_str} - {status}")
                    except Exception as e:
                        logger.error(f"Grading failed: {e}")

        return eval_results

    def _grade_single_task(self, task: EvalTask, agent_response: Any) -> EvalResult:
        """Grade a single task (helper for batched grading)."""
        if agent_response is None:
            # Task execution failed, create error result
            return create_error_result(task, Exception("Task execution failed"))

        return self.judge.grade_task(task, agent_response)

    def run_quick_evaluation(
        self,
        num_tasks: int = 10,
        run_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        strategy: str = "representative"
    ) -> EvalRun:
        """
        Run a quick evaluation with subset of tasks.

        Args:
            num_tasks: Number of tasks to run (default 10)
            run_id: Optional run identifier
            config: Agent/model configuration metadata
            strategy: How to select tasks:
                - "representative": Balanced across categories and difficulties
                - "random": Random selection
                - "first": First N tasks

        Returns:
            EvalRun with results
        """
        from .tasks.task_registry import get_all_tasks

        all_tasks = get_all_tasks()

        if strategy == "representative":
            selected_tasks = self._select_representative_tasks(all_tasks, num_tasks)
        elif strategy == "random":
            import random
            selected_tasks = random.sample(all_tasks, min(num_tasks, len(all_tasks)))
        elif strategy == "first":
            selected_tasks = all_tasks[:num_tasks]
        else:
            raise ValueError(f"Unknown strategy: {strategy}")

        if not run_id:
            run_id = f"quick_run_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

        logger.info(f"Running quick evaluation with {len(selected_tasks)} tasks")
        return self.run_evaluation(selected_tasks, run_id=run_id, config=config)

    def _select_representative_tasks(
        self,
        all_tasks: List[EvalTask],
        num_tasks: int
    ) -> List[EvalTask]:
        """
        Select representative subset of tasks balanced across categories and difficulties.

        Args:
            all_tasks: All available tasks
            num_tasks: Number to select

        Returns:
            Balanced subset of tasks
        """
        # Group by category and difficulty
        by_category = {}
        for task in all_tasks:
            key = (task.category, task.difficulty)
            if key not in by_category:
                by_category[key] = []
            by_category[key].append(task)

        # Calculate how many from each group
        groups = list(by_category.keys())
        tasks_per_group = max(1, num_tasks // len(groups))
        remainder = num_tasks % len(groups)

        selected = []
        for i, group in enumerate(groups):
            count = tasks_per_group + (1 if i < remainder else 0)
            group_tasks = by_category[group]
            selected.extend(group_tasks[:count])

            if len(selected) >= num_tasks:
                break

        return selected[:num_tasks]


class AgentFactory:
    """
    Factory for creating agent instances.

    Provides configuration metadata for tracking.
    """

    def __init__(
        self,
        agent_class: type,
        agent_config: Dict[str, Any],
        tool_registry: Any
    ):
        """
        Initialize agent factory.

        Args:
            agent_class: Agent class to instantiate
            agent_config: Configuration for agent
            tool_registry: Tool registry to use
        """
        self.agent_class = agent_class
        self.agent_config = agent_config
        self.tool_registry = tool_registry

    def __call__(self):
        """Create new agent instance."""
        return self.agent_class(
            config=self.agent_config,
            tool_registry=self.tool_registry
        )

    def get_config_description(self) -> Dict[str, Any]:
        """Get configuration metadata for logging."""
        config_desc = {
            "agent_class": self.agent_class.__name__,
        }

        # Extract relevant config details
        if hasattr(self.agent_config, 'llm_config'):
            llm_config = self.agent_config.llm_config
            config_desc.update({
                "model": llm_config.model,
                "provider": llm_config.provider,
                "temperature": llm_config.temperature,
            })

        if hasattr(self.agent_config, 'tier'):
            config_desc["tier"] = self.agent_config.tier

        return config_desc
