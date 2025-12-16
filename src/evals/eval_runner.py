"""
Main evaluation orchestration.

Coordinates task execution, grading, metrics computation, and result saving.
"""

import sys
from pathlib import Path

# Add src to path for standalone execution
_src_dir = Path(__file__).parent.parent
if str(_src_dir) not in sys.path:
    sys.path.insert(0, str(_src_dir))

import logging
import uuid
from typing import List, Callable, Optional, Dict, Any
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import json

from evals.eval_task import EvalTask, EvalResult, EvalRun, create_error_result
from evals.isolation import TaskExecutor
from evals.grading import LLMJudge
from util.llm_adapter import LLMAdapter
from harness.agent.agent import AgentResponse


logger = logging.getLogger(__name__)


class HarnessAgentAdapter:
    """
    Adapter that lets evals treat AgentHarness like a regular agent.

    Exposes a run(user_input, context) method that internally calls
    harness.process() and extracts the AgentResponse for grading.
    """

    def __init__(self, harness: Any, default_tier: str = "standard", logger_obj: Optional[logging.Logger] = None):
        self._harness = harness
        self._default_tier = default_tier or "standard"
        self._logger = logger_obj or logging.getLogger(__name__)
        self.tool_registry = getattr(harness, "tool_registry", None)
        self.tiered_agent = getattr(harness, "agent", None)

    def run(self, user_input: str, context: Optional[str] = None) -> AgentResponse:
        """Invoke the harness and always return an AgentResponse."""
        response = self._harness.process(
            speech_text=user_input,
            tier=self._resolve_tier(),
            context=context,
            request_id=f"eval_{uuid.uuid4().hex[:8]}"
        )
        return self._extract_agent_response(response)

    def _resolve_tier(self) -> str:
        runtime_config = getattr(self._harness, "config", None)
        if runtime_config and hasattr(runtime_config, "get"):
            tier = runtime_config.get("agent.tier")
            if tier:
                return tier
        return self._default_tier

    def _extract_agent_response(self, harness_response: Any) -> AgentResponse:
        if harness_response is None:
            raise RuntimeError("Harness returned no response")

        agent_response = getattr(harness_response, "agent_response", None)
        if agent_response:
            return agent_response

        metadata = getattr(harness_response, "metadata", {}) or {}
        self._logger.warning("Harness response missing agent_response; synthesizing fallback AgentResponse")
        return AgentResponse(
            content=getattr(harness_response, "full_response", ""),
            success=False,
            error=metadata.get("error") or "Harness returned no agent_response",
            goal_achieved=False,
            total_duration_ms=getattr(harness_response, "duration_ms", 0),
            tools_used=metadata.get("tools_used", []),
            metadata=metadata
        )


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
        self.agent_factory = agent_factory  # Backwards compatibility for callers that inspect this attribute
        self._raw_agent_factory = agent_factory
        self.agent_metadata = getattr(agent_factory, "config", {})
        self._default_tier = self._infer_default_tier()
        self._backend_hint = getattr(agent_factory, "execution_backend", None)
        self._execution_backend: Optional[str] = None
        self.judge = LLMJudge(judge_llm)
        self.executor = TaskExecutor(self._create_agent_instance)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.batch_size = batch_size
        self._current_run_artifact_root: Optional[Path] = None

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

        run_dir = self.output_dir / run_id
        artifact_root = run_dir / "artifacts"
        artifact_root.mkdir(parents=True, exist_ok=True)
        self._current_run_artifact_root = artifact_root

        try:
            run_config = dict(config) if config else {}
            if "agent_type" not in run_config:
                if isinstance(self.agent_metadata, dict) and self.agent_metadata.get("agent_type"):
                    run_config["agent_type"] = self.agent_metadata["agent_type"]
                else:
                    run_config["agent_type"] = "unknown"

            logger.info(f"Starting evaluation run: {run_id}")
            logger.info(f"Total tasks: {len(tasks)}")

            self._ensure_judge_ready()

            # Phase 1: Execute all tasks
            logger.info("Phase 1: Executing tasks...")
            if parallel_execution:
                execution_results = self._execute_tasks_parallel(tasks, max_workers)
            else:
                execution_results = self._execute_tasks_sequential(tasks)
            run_config["execution_backend"] = self._get_execution_backend()

            # Phase 2: Grade all tasks in batches
            logger.info(f"Phase 2: Grading tasks (batch size: {self.batch_size})...")
            eval_results = self._grade_tasks_batched(tasks, execution_results)

            # Phase 3: Compute metrics
            logger.info("Phase 3: Computing metrics...")
            from evals.metrics import MetricsCalculator
            metrics_calc = MetricsCalculator()
            overall_metrics = metrics_calc.calculate_metrics(eval_results)
            category_metrics = metrics_calc.calculate_category_metrics(eval_results, tasks)
            difficulty_metrics = metrics_calc.calculate_difficulty_metrics(eval_results, tasks)

            # Create eval run
            eval_run = EvalRun(
                run_id=run_id,
                timestamp=datetime.utcnow().isoformat(),
                config=run_config,
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
        finally:
            self._current_run_artifact_root = None

    def _ensure_judge_ready(self) -> None:
        """Ensure the judge LLM is initialized before running tasks."""
        logger.info("Phase 0: Initializing judge LLM...")
        try:
            self.judge.ensure_ready()
        except Exception:
            logger.error("Judge initialization failed; aborting evaluation.")
            raise

    def _infer_default_tier(self) -> str:
        """Derive default tier from factory metadata or fall back to standard."""
        metadata = self.agent_metadata
        if isinstance(metadata, dict):
            for key in ("tier", "default_tier"):
                tier = metadata.get(key)
                if tier:
                    return tier
        return "standard"

    def _create_agent_instance(self):
        """Instantiate an agent/harness instance compatible with TaskExecutor."""
        raw_agent = self._raw_agent_factory()
        return self._normalize_agent_instance(raw_agent)

    def _normalize_agent_instance(self, agent_instance: Any):
        """
        Wrap harness/process targets so TaskExecutor always sees a run() interface.
        """
        run_attr = getattr(agent_instance, "run", None)
        process_attr = getattr(agent_instance, "process", None)

        if callable(run_attr):
            backend = "agent"
            wrapped = agent_instance
        elif callable(process_attr):
            backend = "harness"
            wrapped = HarnessAgentAdapter(
                agent_instance,
                default_tier=self._default_tier,
                logger_obj=logger
            )
        else:
            raise TypeError(
                f"Agent factory must return object with run() or process(); got {type(agent_instance)}"
            )

        self._record_execution_backend(backend)
        return wrapped

    def _record_execution_backend(self, backend: str) -> None:
        """Track which execution backend is actually being used for this run."""
        if not self._execution_backend:
            self._execution_backend = backend
            logger.info("Eval runner using %s backend for task execution", backend)
        elif self._execution_backend != backend:
            logger.warning(
                "Agent factory produced inconsistent backends (%s vs %s)",
                self._execution_backend,
                backend
            )

    def _get_execution_backend(self) -> str:
        """Best-effort description of which module handled task execution."""
        return self._execution_backend or self._backend_hint or "agent"

    def _get_artifact_dir(self, task: EvalTask, index: int) -> Optional[Path]:
        """Build a per-task artifact directory for preserved files."""
        if not self._current_run_artifact_root:
            return None

        safe_task_id = task.task_id.replace("/", "_")
        dir_name = f"{index:03d}_{safe_task_id}"
        return self._current_run_artifact_root / dir_name

    def _execute_tasks_sequential(self, tasks: List[EvalTask]) -> List[Any]:
        """Execute tasks sequentially."""
        execution_results = []

        for i, task in enumerate(tasks, 1):
            logger.info(f"[{i}/{len(tasks)}] Executing {task.task_id}...")

            try:
                artifact_dir = self._get_artifact_dir(task, i)
                agent_response = self.executor.execute_task(task, artifact_dir=artifact_dir)
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
                artifact_dir = self._get_artifact_dir(task, i + 1)
                future = executor.submit(
                    self._execute_single_task,
                    task,
                    i + 1,
                    len(tasks),
                    artifact_dir
                )
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

    def _execute_single_task(
        self,
        task: EvalTask,
        task_num: int,
        total: int,
        artifact_dir: Optional[Path]
    ) -> Any:
        """Execute a single task (helper for parallel execution)."""
        logger.info(f"[{task_num}/{total}] Executing {task.task_id}...")
        return self.executor.execute_task(task, artifact_dir=artifact_dir)

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
        from evals.tasks.task_registry import get_all_tasks

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
