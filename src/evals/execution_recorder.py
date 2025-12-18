"""
Execution recorder for evaluation HTML export.

Simplified to only capture data needed for HTML export.
All detailed logging is now handled by simple_logger.py.
"""

import json
import time
import hashlib
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
from dataclasses import asdict
from enum import Enum

from .eval_models import (
    TurnExecutionRecord,
    ReproducibilityContext,
    FullPrompt,
    PromptMessage,
    ToolCallTrace,
    ExecutionStepTrace,
    PerformanceMetrics,
    TurnFileState
)


def _make_json_serializable(obj: Any) -> Any:
    """
    Recursively convert an object to be JSON-serializable.
    Handles Enums, dataclasses, and nested structures.
    """
    if obj is None:
        return None
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, dict):
        return {k: _make_json_serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_make_json_serializable(item) for item in obj]
    if hasattr(obj, '__dataclass_fields__'):
        return _make_json_serializable(asdict(obj))
    return obj


class ExecutionRecorder:
    """
    Records complete execution traces for evaluation.

    Integrates with:
    - Agent execution (planning, execution, reflection)
    - PerfTracer (timing data)
    - FileStateTracker (file operations)
    - LLM API calls (full prompts and latency)

    Usage:
        recorder = ExecutionRecorder(output_dir)

        # Start recording turn
        recorder.start_turn(repro_context, user_prompt)

        # Record planning
        recorder.record_planning(prompt, plan, duration_ms)

        # Record execution steps
        recorder.record_step(step_num, tool_calls, duration_ms)

        # Record reflection
        recorder.record_reflection(prompt, reflection, duration_ms)

        # Finalize and write
        turn_record = recorder.finalize_turn(file_state, final_response)
        recorder.write_turn_record(turn_record)
    """

    def __init__(
        self,
        output_dir: Path,
        artifact_size_threshold: int = 10_000,  # 10KB
        redaction_level: Optional['RedactionLevel'] = None,
        max_history_messages: Optional[int] = None  # None = unlimited (full conversation)
    ):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.artifact_size_threshold = artifact_size_threshold
        self.redaction_level = redaction_level

        # Conversation history limit: None means capture full history
        # Set to an integer (e.g., 5) to limit for smaller log files
        # Default is None (full history) to meet "complete prompts" requirement
        self.max_history_messages = max_history_messages

        # Artifacts directory for large outputs
        self.artifacts_dir = self.output_dir / "artifacts"
        self.artifacts_dir.mkdir(exist_ok=True)

        # Current turn state
        self._current_record: Optional[TurnExecutionRecord] = None
        self._turn_start_time: float = 0.0
        self._phase_timings: Dict[str, float] = {}
        self._llm_calls: List[Dict[str, Any]] = []

    # ========================================================================
    # Turn lifecycle
    # ========================================================================

    def start_turn(
        self,
        repro_context: ReproducibilityContext,
        user_prompt: str,
        conversation_history: Optional[List[Dict]] = None
    ):
        """Start recording a new turn."""
        self._turn_start_time = time.time()
        self._phase_timings = {}
        self._llm_calls = []

        # Convert conversation history
        # If max_history_messages is None, capture full history (fixes "complete prompts" claim)
        # If set to an integer, truncate to that many messages
        history_messages = []
        if conversation_history:
            msgs_to_process = conversation_history
            if self.max_history_messages is not None:
                msgs_to_process = conversation_history[-self.max_history_messages:]

            for msg in msgs_to_process:
                history_messages.append(PromptMessage(
                    role=msg.get('role', 'user'),
                    content=msg.get('content', ''),
                    cached=msg.get('cached', False),
                    token_count=msg.get('token_count', 0)
                ))

        self._current_record = TurnExecutionRecord(
            repro_context=repro_context,
            user_prompt=user_prompt,
            conversation_history=history_messages
        )

    def finalize_turn(
        self,
        file_state: TurnFileState,
        final_response: str,
        success: bool = True,
        error: Optional[str] = None
    ) -> TurnExecutionRecord:
        """Finalize turn and return complete record."""
        if not self._current_record:
            raise RuntimeError("No turn in progress")

        # Calculate total timing
        total_ms = (time.time() - self._turn_start_time) * 1000

        # Build performance metrics, preserving perf_trace_tree if already set
        existing_perf_trace = None
        if self._current_record.performance:
            existing_perf_trace = self._current_record.performance.perf_trace_tree

        performance = PerformanceMetrics(
            planning_ms=self._phase_timings.get('planning', 0.0),
            execution_ms=self._phase_timings.get('execution', 0.0),
            reflection_ms=self._phase_timings.get('reflection', 0.0),
            total_turn_ms=total_ms,
            llm_calls=self._llm_calls,
            turn_number=self._current_record.repro_context.turn_number,
            perf_trace_tree=existing_perf_trace  # Preserve if set by record_perf_trace
        )

        # Update record
        self._current_record.file_state = file_state
        self._current_record.final_response = final_response
        self._current_record.performance = performance
        self._current_record.success = success
        self._current_record.error = error

        return self._current_record

    # ========================================================================
    # Phase recording
    # ========================================================================

    def record_planning(
        self,
        messages: List[Dict[str, Any]],
        plan: Dict[str, Any],
        plan_reasoning: str,
        duration_ms: float,
        tools: Optional[List[Dict]] = None,
        model_info: Optional[Dict] = None
    ):
        """Record planning phase."""
        if not self._current_record:
            raise RuntimeError("No turn in progress")

        # Build full prompt
        full_prompt = self._build_full_prompt(messages, tools, model_info)

        # Store
        self._current_record.full_prompt_planning = full_prompt
        self._current_record.plan = plan
        self._current_record.plan_reasoning = plan_reasoning

        # Timing
        self._phase_timings['planning'] = duration_ms

        # Record LLM call
        self._llm_calls.append({
            'phase': 'planning',
            'latency_ms': duration_ms,
            'tokens': full_prompt.total_tokens if full_prompt else 0
        })

    def record_execution(
        self,
        messages: List[Dict[str, Any]],
        steps: List[Dict[str, Any]],
        duration_ms: float,
        tools: Optional[List[Dict]] = None,
        model_info: Optional[Dict] = None
    ):
        """Record execution phase."""
        if not self._current_record:
            raise RuntimeError("No turn in progress")

        # Build full prompt
        full_prompt = self._build_full_prompt(messages, tools, model_info)

        # Convert steps to traces
        step_traces = [self._build_step_trace(step) for step in steps]

        # Store
        self._current_record.full_prompt_execution = full_prompt
        self._current_record.execution_steps = step_traces

        # Timing
        self._phase_timings['execution'] = duration_ms

        # Record LLM call (if execution used LLM)
        if messages:
            self._llm_calls.append({
                'phase': 'execution',
                'latency_ms': duration_ms,
                'tokens': full_prompt.total_tokens if full_prompt else 0
            })

    def record_reflection(
        self,
        messages: List[Dict[str, Any]],
        reflection: Dict[str, Any],
        duration_ms: float,
        tools: Optional[List[Dict]] = None,
        model_info: Optional[Dict] = None
    ):
        """Record reflection phase."""
        if not self._current_record:
            raise RuntimeError("No turn in progress")

        # Build full prompt
        full_prompt = self._build_full_prompt(messages, tools, model_info)

        # Store
        self._current_record.full_prompt_reflection = full_prompt
        self._current_record.reflection = reflection
        self._current_record.goal_achieved = reflection.get('goal_achieved', False)
        self._current_record.goal_confidence = reflection.get('confidence', 0.0)

        # Timing
        self._phase_timings['reflection'] = duration_ms

        # Record LLM call
        self._llm_calls.append({
            'phase': 'reflection',
            'latency_ms': duration_ms,
            'tokens': full_prompt.total_tokens if full_prompt else 0
        })

    def record_perf_trace(self, perf_trace: Dict[str, Any]):
        """Record PerfTracer output."""
        if not self._current_record:
            return

        self._current_record.performance.perf_trace_tree = perf_trace

    # ========================================================================
    # Private helpers
    # ========================================================================

    def _build_full_prompt(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict]] = None,
        model_info: Optional[Dict] = None
    ) -> FullPrompt:
        """Build FullPrompt from messages."""
        # Convert messages
        prompt_messages = []
        total_tokens = 0
        cached_tokens = 0

        for msg in messages:
            content = msg.get('content', '')
            if isinstance(content, list):
                # Multi-part content (text + images, etc.)
                content = self._serialize_content_parts(content)

            cached = msg.get('cached', False)
            token_count = self._estimate_tokens(content)

            prompt_messages.append(PromptMessage(
                role=msg.get('role', 'user'),
                content=content,
                cached=cached,
                token_count=token_count
            ))

            total_tokens += token_count
            if cached:
                cached_tokens += token_count

        # Extract model info
        model = model_info.get('model', 'unknown') if model_info else 'unknown'
        temperature = model_info.get('temperature', 0.0) if model_info else 0.0
        max_tokens = model_info.get('max_tokens', 0) if model_info else 0

        return FullPrompt(
            messages=prompt_messages,
            total_tokens=total_tokens,
            cached_tokens=cached_tokens,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=tools or []
        )

    def _build_step_trace(self, step: Dict[str, Any]) -> ExecutionStepTrace:
        """Build ExecutionStepTrace from step data."""
        step_num = step.get('step_number', 0)
        description = step.get('description', '')

        # Tool calls
        tool_call_traces = []
        for tc in step.get('tool_calls', []):
            trace = self._build_tool_call_trace(tc, step_num)
            tool_call_traces.append(trace)

        return ExecutionStepTrace(
            step_number=step_num,
            step_description=description,
            planned_action=step.get('planned_action', ''),
            tool_hint=step.get('tool_hint', ''),
            dependencies=step.get('dependencies', []),
            tool_calls=tool_call_traces,
            reasoning=step.get('reasoning', ''),
            success=step.get('success', True),
            postcondition_met=step.get('postcondition_met', True),
            error_message=step.get('error', None),
            duration_ms=step.get('duration_ms', 0.0)
        )

    def _build_tool_call_trace(
        self,
        tool_call: Dict[str, Any],
        step_num: int
    ) -> ToolCallTrace:
        """Build ToolCallTrace from tool call data."""
        tool_name = tool_call.get('name', 'unknown')
        arguments = tool_call.get('arguments', {})
        output = str(tool_call.get('output', ''))

        # Handle large outputs
        output_truncated = False
        output_artifact_path = None
        output_size = len(output)

        if output_size > self.artifact_size_threshold:
            # Write to artifact file
            output_truncated = True
            artifact_path = self._write_artifact(
                f"step{step_num}_{tool_name}_output.txt",
                output
            )
            output_artifact_path = str(artifact_path.relative_to(self.output_dir))
            output = output[:self.artifact_size_threshold]  # Keep first 10KB inline

        return ToolCallTrace(
            tool_name=tool_name,
            arguments=arguments,
            output=output,
            output_truncated=output_truncated,
            output_artifact_path=output_artifact_path,
            output_size_bytes=output_size,
            started_at=tool_call.get('started_at', ''),
            completed_at=tool_call.get('completed_at', ''),
            duration_ms=tool_call.get('duration_ms', 0.0),
            success=tool_call.get('success', True),
            error=tool_call.get('error', None),
            error_type=tool_call.get('error_type', None),
            step_number=step_num,
            parallel_group=tool_call.get('parallel_group', None)
        )

    def _write_artifact(self, filename: str, content: str) -> Path:
        """Write artifact to file."""
        artifact_path = self.artifacts_dir / filename
        artifact_path.write_text(content, encoding='utf-8')
        return artifact_path

    def _serialize_content_parts(self, parts: List[Dict]) -> str:
        """Serialize multi-part content to string."""
        serialized = []
        for part in parts:
            if part.get('type') == 'text':
                serialized.append(part.get('text', ''))
            elif part.get('type') == 'image':
                serialized.append(f"[IMAGE: {part.get('source', {}).get('type', 'unknown')}]")
            else:
                serialized.append(f"[{part.get('type', 'unknown').upper()}]")
        return '\n'.join(serialized)

    def _estimate_tokens(self, text: str) -> int:
        """Rough token estimation (4 chars per token)."""
        return len(text) // 4


# ============================================================================
# ID Generation (Stable IDs for multi-turn)
# ============================================================================

def generate_scenario_id(task_id: str, timestamp: Optional[str] = None) -> str:
    """
    Generate stable scenario ID.

    Format: {task_id}_{timestamp_hash}
    """
    if timestamp is None:
        timestamp = datetime.utcnow().isoformat()

    # Create deterministic hash from task + timestamp
    hash_input = f"{task_id}_{timestamp}"
    hash_digest = hashlib.sha256(hash_input.encode()).hexdigest()[:8]

    return f"{task_id}_{hash_digest}"


def generate_request_id(scenario_id: str) -> str:
    """
    Generate request ID for scenario.
    Stable across all turns in same scenario.
    """
    return f"req_{scenario_id}"


def generate_execution_id(scenario_id: str, turn_number: int) -> str:
    """Generate execution ID for specific turn."""
    return f"exec_{scenario_id}_t{turn_number}"
