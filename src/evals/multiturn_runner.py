"""
Multi-turn evaluation runner.

Orchestrates:
1. Sandboxed workspace creation
2. Isolated agent sessions
3. File state tracking
4. Complete execution recording
5. Performance metrics
6. Reproducibility guarantees

Addresses all critical findings for robust production-ready evaluation.
"""

import json
import time
from pathlib import Path
from typing import Dict, Any, List, Optional
from dataclasses import asdict
from datetime import datetime

from .eval_models import (
    ScenarioExecutionRecord,
    TurnExecutionRecord,
    EvaluationResult,
    ReproducibilityContext
)
from .sandboxed_workspace import (
    SandboxedWorkspace,
    WorkspaceConfig,
    IsolatedAgentSession
)
from .file_state_tracker import FileStateTracker
from .execution_recorder import (
    ExecutionRecorder,
    generate_scenario_id,
    generate_request_id,
    generate_execution_id,
    _make_json_serializable
)
from .redaction import redact_execution_record, RedactionLevel
from .simple_logger import SimpleEvalLogger


class MultiTurnTask:
    """Definition of a multi-turn evaluation task."""

    def __init__(
        self,
        task_id: str,
        name: str,
        category: str,
        turns: List[Dict[str, Any]],
        difficulty: str = "standard",
        expected_final_state: Optional[Dict[str, Any]] = None
    ):
        self.task_id = task_id
        self.name = name
        self.category = category
        self.turns = turns
        self.difficulty = difficulty
        self.expected_final_state = expected_final_state


class MultiTurnEvalRunner:
    """
    Runs multi-turn evaluations with complete tracking and isolation.

    Usage:
        runner = MultiTurnEvalRunner(
            output_dir="evals/results/multiturn_run1",
            tier="standard",
            model="claude-sonnet-4-5"
        )

        # Define multi-turn task
        task = MultiTurnTask(
            task_id="code_dev_001",
            name="Incremental Code Development",
            category="multi_turn_code_dev",
            turns=[
                {"prompt": "Create a Calculator class", "expected_actions": ["file_write"]},
                {"prompt": "Add multiply method", "expected_actions": ["file_read", "file_write"]},
                {"prompt": "Write tests", "expected_actions": ["file_write", "bash_execute"]}
            ]
        )

        # Run evaluation
        result = runner.run_task(task)

        # Export for human review
        html_path = runner.export_html(result)
        print(f"Review at: {html_path}")
    """

    def __init__(
        self,
        output_dir: str,
        tier: str = "standard",
        model: str = "claude-sonnet-4-5",
        temperature: float = 0.0,
        random_seed: Optional[int] = None,
        redaction_level: RedactionLevel = RedactionLevel.STANDARD,
        preserve_artifacts: bool = True,
        log_dir: Optional[str] = None
    ):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Keep run-specific logs inside the eval output directory
        self.log_dir = Path(log_dir) if log_dir else self.output_dir / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

        self.tier = tier
        self.model = model
        self.temperature = temperature
        self.random_seed = random_seed
        self.redaction_level = redaction_level
        self.preserve_artifacts = preserve_artifacts

        # Subdirectories
        self.records_dir = self.output_dir / "records"
        self.records_dir.mkdir(exist_ok=True)

        self.artifacts_dir = self.output_dir / "artifacts"
        self.artifacts_dir.mkdir(exist_ok=True)

        self.html_dir = self.output_dir / "html"
        self.html_dir.mkdir(exist_ok=True)

    def run_task(self, task: MultiTurnTask) -> EvaluationResult:
        """
        Run a multi-turn task with complete isolation and tracking.

        Returns:
            EvaluationResult with full scenario execution record
        """
        print(f"\n{'='*70}")
        print(f"Running Multi-Turn Task: {task.name}")
        print(f"Task ID: {task.task_id}")
        print(f"Turns: {len(task.turns)}")
        print(f"Tier: {self.tier} | Model: {self.model}")
        print(f"{'='*70}\n")

        # Generate scenario ID
        scenario_id = generate_scenario_id(task.task_id)
        request_id = generate_request_id(scenario_id)

        # Create workspace
        workspace_config = WorkspaceConfig(
            base_path=self.artifacts_dir / scenario_id,
            cleanup_on_exit=False,  # Preserve for review
            use_git=True,
            preserve_artifacts=self.preserve_artifacts
        )

        with SandboxedWorkspace(workspace_config) as workspace:
            workspace.initialize_git()

            # Create trackers
            file_tracker = FileStateTracker(str(workspace.workspace_path))
            recorder = ExecutionRecorder(
                output_dir=self.records_dir / scenario_id,
                redaction_level=self.redaction_level
            )

            # Create isolated agent session
            session = IsolatedAgentSession(
                workspace=workspace,
                tier=self.tier,
                model=self.model,
                temperature=self.temperature,
                random_seed=self.random_seed,
                log_dir=self.log_dir
            )

            # Capture initial state and commit
            initial_state = file_tracker.capture_initial_state()
            last_commit_hash = workspace.commit("Initial state")

            # Execute turns
            turn_records = []
            conversation_history = []

            for turn_idx, turn_def in enumerate(task.turns, 1):
                print(f"\n--- Turn {turn_idx}/{len(task.turns)} ---")
                print(f"Prompt: {turn_def['prompt'][:100]}...")

                # Generate log file path for this turn
                log_file = self.output_dir / "logs" / scenario_id / f"turn_{turn_idx}.log"

                # Execute turn - pass the previous turn's commit hash for accurate per-turn diffs
                turn_record = self._execute_turn(
                    turn_number=turn_idx,
                    turn_def=turn_def,
                    scenario_id=scenario_id,
                    request_id=request_id,
                    workspace=workspace,
                    session=session,
                    file_tracker=file_tracker,
                    recorder=recorder,
                    conversation_history=conversation_history,
                    previous_commit=last_commit_hash,  # CRITICAL: Pass commit for per-turn diffs
                    log_file=log_file
                )

                turn_records.append(turn_record)

                # Update conversation
                conversation_history.append({
                    'role': 'user',
                    'content': turn_def['prompt']
                })
                conversation_history.append({
                    'role': 'assistant',
                    'content': turn_record.final_response
                })

                # Commit after turn and track the hash for next turn's diff baseline
                last_commit_hash = workspace.commit(f"After turn {turn_idx}")

                print(f"Turn {turn_idx} completed: {'✓' if turn_record.success else '✗'}")
                print(f"Latency: {turn_record.performance.total_turn_ms:.0f}ms")
                print(f"Log: {log_file}")

            # Capture final state
            final_state = file_tracker._snapshot_workspace()

            # Build scenario record
            scenario_record = ScenarioExecutionRecord(
                scenario_id=scenario_id,
                task_id=task.task_id,
                turns=turn_records,
                total_turns=len(turn_records),
                successful_turns=sum(1 for t in turn_records if t.success),
                total_latency_ms=sum(t.performance.total_turn_ms for t in turn_records),
                initial_workspace_state=initial_state,
                final_workspace_state=final_state,
                all_file_operations=file_tracker.get_all_operations(),
                scenario_passed=all(t.success for t in turn_records),
                repro_context=turn_records[0].repro_context if turn_records else None
            )

            # Build evaluation result
            result = EvaluationResult(
                scenario=scenario_record,
                annotation=None,  # Will be filled during human review
                redacted=False
            )

            # Write full result
            self._write_result(result)

            print(f"\n{'='*70}")
            print(f"Task Complete: {scenario_record.scenario_passed}")
            print(f"Successful turns: {scenario_record.successful_turns}/{scenario_record.total_turns}")
            print(f"Total latency: {scenario_record.total_latency_ms:.0f}ms")
            print(f"{'='*70}\n")

            return result

    def _execute_turn(
        self,
        turn_number: int,
        turn_def: Dict[str, Any],
        scenario_id: str,
        request_id: str,
        workspace: SandboxedWorkspace,
        session: IsolatedAgentSession,
        file_tracker: FileStateTracker,
        recorder: ExecutionRecorder,
        conversation_history: List[Dict],
        previous_commit: Optional[str] = None,
        log_file: Optional[Path] = None
    ) -> TurnExecutionRecord:
        """Execute a single turn."""
        execution_id = generate_execution_id(scenario_id, turn_number)

        # Build reproducibility context
        repro_context = workspace.get_repro_context(
            task_id=turn_def.get('task_id', scenario_id),
            scenario_id=scenario_id,
            turn_number=turn_number,
            request_id=request_id,
            execution_id=execution_id,
            tier=self.tier,
            model=self.model,
            temperature=self.temperature,
            max_tokens=4096,
            random_seed=self.random_seed
        )

        # Start recording
        user_prompt = turn_def['prompt']
        recorder.start_turn(repro_context, user_prompt, conversation_history)

        turn_start = time.time()

        try:
            # Get agent
            agent = session.get_agent()

            # Create simple logger for this turn (if log_file provided)
            simple_logger = None
            if log_file:
                simple_logger = SimpleEvalLogger(log_file)

            # Execute with real adapter
            from .agent_adapter import AgentExecutionAdapter
            adapter = AgentExecutionAdapter(
                agent=agent,
                recorder=recorder,
                workspace_path=str(workspace.workspace_path),
                simple_logger=simple_logger
            )

            result = adapter.execute_turn(user_prompt)

            response = result['response']
            tool_calls = result['tool_calls']
            success = result['success']
            error = result['error']

        except Exception as e:
            print(f"Error executing turn: {e}")
            import traceback
            traceback.print_exc()
            response = ""
            tool_calls = []
            success = False
            error = str(e)

        turn_duration = (time.time() - turn_start) * 1000

        # Capture file state with actual tool calls
        # Pass previous_commit for accurate per-turn diffs (fixes accumulation bug)
        file_state = file_tracker.capture_turn_state(
            turn_number,
            tool_calls,
            previous_commit=previous_commit
        )

        # Finalize turn
        turn_record = recorder.finalize_turn(
            file_state=file_state,
            final_response=response,
            success=success,
            error=error
        )

        return turn_record

    def _write_result(self, result: EvaluationResult):
        """Write evaluation result to disk (with redaction)."""
        scenario_id = result.scenario.scenario_id

        # CRITICAL: Apply redaction before persisting
        # Use _make_json_serializable to handle Enums like PlanPhase
        result_dict = _make_json_serializable(asdict(result))
        redactions = []

        for turn_record in result_dict['scenario']['turns']:
            turn_record, turn_redactions = redact_execution_record(
                turn_record,
                level=self.redaction_level
            )
            redactions.extend(turn_redactions)

        result_dict['redacted'] = True

        # Write redacted result as JSON
        result_path = self.records_dir / f"{scenario_id}_result.json"
        with open(result_path, 'w') as f:
            json.dump(result_dict, f, indent=2)

        print(f"Wrote result to: {result_path}")
        if redactions:
            print(f"Redacted {len(redactions)} sensitive items")

    def export_html(
        self,
        result: EvaluationResult,
        redact: bool = True
    ) -> Path:
        """
        Export result as HTML for human review.

        Args:
            result: Evaluation result
            redact: Whether to redact sensitive info

        Returns:
            Path to HTML file
        """
        scenario_id = result.scenario.scenario_id

        # Redact if requested
        # Use _make_json_serializable to handle Enums like PlanPhase
        result_dict = _make_json_serializable(asdict(result))
        redactions = []

        if redact:
            for turn_record in result_dict['scenario']['turns']:
                turn_record, turn_redactions = redact_execution_record(
                    turn_record,
                    level=self.redaction_level
                )
                redactions.extend(turn_redactions)

            result_dict['redacted'] = True

        # Generate HTML (will implement in next file)
        from .html_exporter import HTMLExporter

        exporter = HTMLExporter()
        html_path = self.html_dir / f"{scenario_id}.html"

        exporter.export(
            result_dict=result_dict,
            output_path=html_path,
            redactions=redactions,
            records_dir=self.records_dir
        )

        return html_path

    def run_task_suite(
        self,
        tasks: List[MultiTurnTask],
        _parallel: bool = False
    ) -> List[EvaluationResult]:
        """
        Run multiple tasks.

        Args:
            tasks: List of tasks to run
            parallel: Whether to run in parallel (TODO)

        Returns:
            List of evaluation results
        """
        results = []

        for task in tasks:
            try:
                result = self.run_task(task)
                results.append(result)
            except Exception as e:
                print(f"Error running task {task.task_id}: {e}")
                import traceback
                traceback.print_exc()

        return results


# ============================================================================
# Convenience functions
# ============================================================================

def load_multiturn_tasks(tasks_file: Path) -> List[MultiTurnTask]:
    """Load multi-turn tasks from JSON file."""
    with open(tasks_file) as f:
        data = json.load(f)

    tasks = []
    for task_def in data['tasks']:
        task = MultiTurnTask(
            task_id=task_def['task_id'],
            name=task_def['name'],
            category=task_def['category'],
            turns=task_def['turns'],
            difficulty=task_def.get('difficulty', 'standard'),
            expected_final_state=task_def.get('expected_final_state')
        )
        tasks.append(task)

    return tasks
