"""
Real agent execution adapter for evaluation.

NOTE: This module needs refactoring to work with the Wizard architecture.
The old Executor/Reflector components have been replaced by Wizard/Worker.

TODO: Refactor to use wizard.orchestrate() instead of separate execute/reflect calls.
"""

import time
from typing import Dict, Any, List, Optional
from dataclasses import asdict
import json

from harness.agent.agent import Agent, TieredAgent
from harness.agent.plan_models import Plan, PlanStep, PlanStatus
from util.perf_trace import PerfTracer, get_tracer, reset_tracer

# Stub types for backwards compatibility during transition
# TODO: Remove after refactoring evals to use wizard
class ExecutionTrace:
    """Stub for backwards compatibility."""
    def __init__(self):
        self.step_results = []
        self.steps = []
        self.final_response = None

class Reflection:
    """Stub for backwards compatibility."""
    def __init__(self):
        self.goal_achieved = False
        self.confidence = 0.0
        self.evidence = []
        self.gaps = []

from .execution_recorder import ExecutionRecorder, _make_json_serializable
from util.llm_adapter import LLMAdapter
from .llm_instrumentation import (
    LLMCallCapture,
    InstrumentedLLMClient,
    InstrumentedLLMAdapter,
    CapturedLLMCall
)
from .simple_logger import SimpleEvalLogger


def _get_agent_model(agent: Agent) -> str:
    """Safely get model name from agent."""
    if hasattr(agent, '_llm_config') and agent._llm_config:
        return agent._llm_config.model
    if hasattr(agent, 'config') and agent.config:
        if hasattr(agent.config, 'llm_config') and agent.config.llm_config:
            return agent.config.llm_config.model
    return "unknown"


def _get_agent_tier(agent: Agent) -> str:
    """Safely get tier from agent."""
    if hasattr(agent, 'config') and agent.config:
        return getattr(agent.config, 'tier', 'standard')
    return "standard"


def _get_agent_temperature(agent: Agent) -> float:
    """Safely get temperature from agent."""
    if hasattr(agent, '_llm_config') and agent._llm_config:
        return getattr(agent._llm_config, 'temperature', 0.0)
    return 0.0


class AgentExecutionAdapter:
    """
    Adapter to run agent and capture complete execution traces.

    Captures EXACT prompts and responses from LLM API calls.
    Logs to simple, human-readable format.
    """

    def __init__(
        self,
        agent: TieredAgent,
        recorder: ExecutionRecorder,
        workspace_path: str,
        simple_logger: Optional[SimpleEvalLogger] = None
    ):
        self.agent = agent
        self.recorder = recorder
        self.workspace_path = workspace_path
        self.simple_logger = simple_logger

        # LLM call capture for real prompt recording (ALWAYS enabled)
        self._llm_capture: Optional[LLMCallCapture] = None
        self._setup_llm_instrumentation()

    def _setup_llm_instrumentation(self):
        """
        Set up LLM client instrumentation for real prompt capture.

        This wraps the agent's LLM client to intercept and record all API calls.
        """
        self._llm_capture = LLMCallCapture()

        if hasattr(self.agent, "_llm") and isinstance(self.agent._llm, InstrumentedLLMAdapter):
            return

        # Prefer instrumenting the LLMAdapter directly (captures Responses API calls)
        if hasattr(self.agent, "_llm") and isinstance(self.agent._llm, LLMAdapter):
            if not isinstance(self.agent._llm, InstrumentedLLMAdapter):
                instrumented = InstrumentedLLMAdapter(self.agent._llm, self._llm_capture)
                self.agent._llm = instrumented
                if hasattr(self.agent, "_planner") and self.agent._planner:
                    self.agent._planner.llm = instrumented
                if hasattr(self.agent, "_executor") and self.agent._executor:
                    self.agent._executor.llm = instrumented
                if hasattr(self.agent, "_reflector") and self.agent._reflector:
                    self.agent._reflector.llm = instrumented
            return

        # Find and wrap the agent's LLM client
        # Try common attribute names
        client_attrs = [
            '_llm_client', 'llm_client', '_client', 'client',
            '_anthropic', 'anthropic', '_llm'
        ]

        for attr in client_attrs:
            if hasattr(self.agent, attr):
                real_client = getattr(self.agent, attr)
                if real_client is not None:
                    try:
                        instrumented = InstrumentedLLMClient(real_client, self._llm_capture)
                        setattr(self.agent, attr, instrumented)
                        return
                    except Exception as e:
                        print(f"Warning: Could not instrument LLM client via {attr}: {e}")

        # If no client found, instrumentation won't capture real prompts
        # We'll fall back to synthetic prompts
        self._llm_capture = None

    def execute_turn(self, user_prompt: str) -> Dict[str, Any]:
        """
        Execute a complete agent turn and capture all traces.

        Returns:
            {
                'response': final response string,
                'tool_calls': list of tool calls for file tracker,
                'success': bool,
                'error': optional error string
            }
        """
        # CRITICAL: Reset PerfTracer at start of each turn to prevent span accumulation
        # Without this, later turns accumulate spans from earlier turns
        reset_tracer()

        # Get tracer instance for this turn
        tracer = get_tracer("eval_turn")

        # Clear LLM capture for new turn
        if self._llm_capture:
            self._llm_capture.clear()

        try:
            # Set working directory
            if hasattr(self.agent, '_context_state'):
                self.agent._context_state.working_directory = self.workspace_path

            # Execute with performance tracing
            with tracer.span("agent_turn"):
                # Planning phase
                plan_result = self._execute_planning(user_prompt)
                if not plan_result['success']:
                    # Planning failed - still return proper structure
                    return {
                        'response': '',
                        'tool_calls': [],
                        'success': False,
                        'error': plan_result['error']
                    }

                plan = plan_result['plan']

                # Execution phase
                exec_result = self._execute_execution(plan, user_prompt)
                if not exec_result['success']:
                    # Execution failed - still return proper structure
                    return {
                        'response': '',
                        'tool_calls': exec_result.get('tool_calls', []),
                        'success': False,
                        'error': exec_result['error']
                    }

                execution_trace = exec_result['trace']
                tool_calls = exec_result['tool_calls']

                # Reflection phase
                refl_result = self._execute_reflection(plan, execution_trace, user_prompt)

                # Get performance trace
                perf_trace = tracer.get_summary()
                if perf_trace:
                    self._safe_record_perf_trace(perf_trace)

                # Get final response
                final_response = execution_trace.final_response if execution_trace else ""

                # Log final response
                if self.simple_logger:
                    self.simple_logger.log_final_response(final_response)

                return {
                    'response': final_response,
                    'tool_calls': tool_calls,
                    'success': True,
                    'error': None
                }

        except Exception as e:
            import traceback
            error_msg = f"{str(e)}\n{traceback.format_exc()}"

            # CRITICAL: Still capture perf trace on error to preserve timing data
            # from any phases that completed before the error
            try:
                perf_trace = tracer.get_summary()
                if perf_trace:
                    self._safe_record_perf_trace(perf_trace)
            except Exception:
                pass  # Don't let perf capture failure mask the real error

            return {
                'response': '',
                'tool_calls': [],
                'success': False,
                'error': error_msg
            }

    def _safe_record_perf_trace(self, perf_trace: Dict[str, Any]):
        """
        Safely record perf trace, guarding against None performance object.

        This prevents AttributeError when record_perf_trace is called before
        finalize_turn has built the performance metrics object.
        """
        try:
            if not self.recorder._current_record:
                return

            # Initialize performance if needed (guards against None)
            if not self.recorder._current_record.performance:
                from .eval_models import PerformanceMetrics
                self.recorder._current_record.performance = PerformanceMetrics(
                    planning_ms=0.0,
                    execution_ms=0.0,
                    reflection_ms=0.0,
                    total_turn_ms=0.0,
                    llm_calls=[],
                    turn_number=self.recorder._current_record.repro_context.turn_number if self.recorder._current_record.repro_context else 0
                )

            self.recorder._current_record.performance.perf_trace_tree = perf_trace
        except Exception:
            pass  # Silently fail - perf data is nice to have, not critical

    def _execute_planning(self, user_prompt: str) -> Dict[str, Any]:
        """Execute planning phase and record."""
        start_time = time.time()

        # Set capture phase for real prompt attribution
        if self._llm_capture:
            self._llm_capture.set_phase('planning')

        try:
            # Use the agent's existing planner instance
            planner = getattr(self.agent, '_planner', None)

            if planner is None:
                # Fallback: create planner with agent's LLM and tool registry
                from harness.agent.planner import Planner
                if hasattr(self.agent, '_llm') and self.agent._llm and hasattr(self.agent, 'tool_registry'):
                    planner = Planner(self.agent._llm, self.agent.tool_registry)
                else:
                    raise RuntimeError("Agent has no planner and cannot create one (missing LLM or tool_registry)")

            # Call planner.create_plan
            plan = planner.create_plan(
                user_input=user_prompt,
                context=None,
                tier=_get_agent_tier(self.agent)
            )

            duration_ms = (time.time() - start_time) * 1000

            # Get messages - prefer real captured prompts over synthetic
            messages = self._get_captured_messages('planning')
            if not messages:
                # Fall back to synthetic prompts
                messages = self._build_planning_messages(user_prompt, plan)

            # Get tool schemas - prefer captured over reconstructed
            tool_schemas = self._get_captured_tools('planning')
            if not tool_schemas:
                tool_schemas = self._get_tool_schemas()

            # Record planning (for HTML export)
            self.recorder.record_planning(
                messages=messages,
                plan=_make_json_serializable(asdict(plan)) if hasattr(plan, '__dataclass_fields__') else vars(plan),
                plan_reasoning=plan.reasoning if hasattr(plan, 'reasoning') else "",
                duration_ms=duration_ms,
                tools=tool_schemas,
                model_info={
                    'model': _get_agent_model(self.agent),
                    'temperature': _get_agent_temperature(self.agent),
                    'max_tokens': 4096
                }
            )

            # Log to simple logger - ALWAYS log with whatever we have
            if self.simple_logger:
                captured_call = self._get_captured_call('planning') if self._llm_capture else None
                if captured_call:
                    # Use captured prompts
                    plan_response = self._format_plan_response(plan)
                    self.simple_logger.log_planning(
                        messages=captured_call.messages,
                        tools=captured_call.tools,
                        model=captured_call.model,
                        plan_response=plan_response,
                        duration_ms=duration_ms
                    )
                else:
                    # Fallback: use what we have
                    plan_response = self._format_plan_response(plan)
                    self.simple_logger.log_planning(
                        messages=messages,
                        tools=tool_schemas,
                        model=_get_agent_model(self.agent),
                        plan_response=plan_response,
                        duration_ms=duration_ms
                    )

            return {
                'success': True,
                'plan': plan,
                'error': None
            }

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000

            # Get messages even on failure - try captured, fall back to synthetic
            messages = self._get_captured_messages('planning')
            if not messages:
                # Try to build synthetic prompts even on failure
                messages = [
                    {
                        'role': 'system',
                        'content': 'Planning phase (failed before prompt could be constructed)',
                        'cached': False,
                        'token_count': 0
                    },
                    {
                        'role': 'user',
                        'content': user_prompt,
                        'cached': False,
                        'token_count': len(user_prompt) // 4
                    }
                ]

            tool_schemas = self._get_captured_tools('planning')
            if not tool_schemas:
                tool_schemas = self._get_tool_schemas()

            # Still record planning failure with timing
            self.recorder.record_planning(
                messages=messages,
                plan={},
                plan_reasoning=f"Planning failed: {str(e)}",
                duration_ms=duration_ms,
                tools=tool_schemas,
                model_info={'model': _get_agent_model(self.agent), 'temperature': _get_agent_temperature(self.agent), 'max_tokens': 4096}
            )

            # Log to simple logger with whatever we have
            if self.simple_logger:
                # Try to get captured call, but if not available, use what we have
                captured_call = self._get_captured_call('planning')
                if captured_call:
                    self.simple_logger.log_planning(
                        messages=captured_call.messages,
                        tools=captured_call.tools,
                        model=captured_call.model,
                        plan_response=f"PLANNING FAILED: {str(e)}",
                        duration_ms=duration_ms
                    )
                else:
                    # Fallback: log with synthetic prompts
                    self.simple_logger.log_planning(
                        messages=messages,
                        tools=tool_schemas,
                        model=_get_agent_model(self.agent),
                        plan_response=f"PLANNING FAILED: {str(e)}",
                        duration_ms=duration_ms
                    )

            return {
                'success': False,
                'plan': None,
                'error': str(e)
            }

    def _execute_execution(self, plan: Any, user_prompt: str) -> Dict[str, Any]:
        """Execute execution phase and record.

        NOTE: This method is deprecated. The old Executor has been replaced by Wizard.
        This stub implementation returns a minimal trace for compatibility.
        TODO: Refactor evals to use wizard.orchestrate() directly.
        """
        start_time = time.time()

        # Set capture phase for real prompt attribution
        if self._llm_capture:
            self._llm_capture.set_phase('execution')

        try:
            # The old Executor has been removed - use wizard flow instead via agent.run()
            # For now, return a stub trace
            raise NotImplementedError(
                "The Executor component has been removed. "
                "Evals should use agent.run() which uses Wizard orchestration. "
                "This adapter needs refactoring to work with the new architecture."
            )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000

            # Get messages even on failure
            messages = self._get_captured_messages('execution')
            if not messages:
                # Fallback: try to build execution messages
                messages = [
                    {
                        'role': 'system',
                        'content': 'Execution phase (failed before prompt could be constructed)',
                        'cached': False,
                        'token_count': 0
                    },
                    {
                        'role': 'user',
                        'content': user_prompt,
                        'cached': False,
                        'token_count': len(user_prompt) // 4
                    }
                ]

            tool_schemas = self._get_captured_tools('execution')
            if not tool_schemas:
                tool_schemas = self._get_tool_schemas()

            # Still record execution failure with timing
            self.recorder.record_execution(
                messages=messages,
                steps=[],
                duration_ms=duration_ms,
                tools=tool_schemas,
                model_info={'model': _get_agent_model(self.agent), 'temperature': _get_agent_temperature(self.agent), 'max_tokens': 4096}
            )

            # Log to simple logger
            if self.simple_logger:
                # Try captured calls first
                exec_calls = self._llm_capture.get_calls(phase='execution') if self._llm_capture else []
                if exec_calls:
                    for i, call in enumerate(exec_calls, 1):
                        self.simple_logger.log_execution_step(
                            step_number=i,
                            messages=call.messages,
                            tools=call.tools,
                            model=call.model,
                            step_response=f"EXECUTION FAILED: {call.response_content}",
                            duration_ms=call.latency_ms
                        )
                else:
                    # Fallback: log error with synthetic prompts
                    self.simple_logger.log_execution_step(
                        step_number=1,
                        messages=messages,
                        tools=tool_schemas,
                        model=_get_agent_model(self.agent),
                        step_response=f"EXECUTION FAILED: {str(e)}",
                        duration_ms=duration_ms
                    )

            return {
                'success': False,
                'trace': None,
                'tool_calls': [],
                'error': str(e)
            }

    def _execute_reflection(self, plan: Any, trace: Any, user_prompt: str) -> Dict[str, Any]:
        """Execute reflection phase and record."""
        start_time = time.time()

        # Set capture phase for real prompt attribution
        if self._llm_capture:
            self._llm_capture.set_phase('reflection')

        try:
            # Use the agent's existing reflector instance
            reflector = getattr(self.agent, '_reflector', None)

            if reflector is None:
                # Fallback: create reflector with agent's LLM
                from harness.agent.reflector import Reflector
                if hasattr(self.agent, '_llm') and self.agent._llm:
                    reflector = Reflector(llm=self.agent._llm)
                else:
                    raise RuntimeError("Agent has no reflector and cannot create one (missing LLM)")

            # Reflect on the execution
            reflection = reflector.reflect(
                plan=plan,
                trace=trace
            )

            duration_ms = (time.time() - start_time) * 1000

            # Get messages - prefer real captured prompts over synthetic
            messages = self._get_captured_messages('reflection')
            if not messages:
                # Fall back to synthetic prompts
                messages = self._build_reflection_messages(plan, trace, reflection)

            # Get tool schemas - prefer captured over reconstructed
            tool_schemas = self._get_captured_tools('reflection')
            if not tool_schemas:
                tool_schemas = self._get_tool_schemas()

            # Record reflection (for HTML export)
            self.recorder.record_reflection(
                messages=messages,
                reflection=_make_json_serializable(asdict(reflection)) if hasattr(reflection, '__dataclass_fields__') else vars(reflection),
                duration_ms=duration_ms,
                tools=tool_schemas,
                model_info={
                    'model': _get_agent_model(self.agent),
                    'temperature': _get_agent_temperature(self.agent),
                    'max_tokens': 4096
                }
            )

            # Log to simple logger - ALWAYS log
            if self.simple_logger:
                captured_call = self._get_captured_call('reflection') if self._llm_capture else None
                reflection_response = self._format_reflection_response(reflection)
                if captured_call:
                    # Use captured prompts
                    self.simple_logger.log_reflection(
                        messages=captured_call.messages,
                        tools=captured_call.tools,
                        model=captured_call.model,
                        reflection_response=reflection_response,
                        duration_ms=duration_ms
                    )
                else:
                    # Fallback: use what we have
                    self.simple_logger.log_reflection(
                        messages=messages,
                        tools=tool_schemas,
                        model=_get_agent_model(self.agent),
                        reflection_response=reflection_response,
                        duration_ms=duration_ms
                    )

            return {
                'success': True,
                'reflection': reflection,
                'error': None
            }

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000

            # Get messages even on failure
            messages = self._get_captured_messages('reflection')
            if not messages:
                # Fallback
                messages = [
                    {
                        'role': 'system',
                        'content': 'Reflection phase (failed before prompt could be constructed)',
                        'cached': False,
                        'token_count': 0
                    }
                ]

            tool_schemas = self._get_captured_tools('reflection')
            if not tool_schemas:
                tool_schemas = self._get_tool_schemas()

            # Still record reflection failure with timing
            self.recorder.record_reflection(
                messages=messages,
                reflection={'goal_achieved': False, 'confidence': 0.0, 'error': str(e)},
                duration_ms=duration_ms,
                tools=tool_schemas,
                model_info={'model': _get_agent_model(self.agent), 'temperature': _get_agent_temperature(self.agent), 'max_tokens': 4096}
            )

            # Log to simple logger
            if self.simple_logger:
                captured_call = self._get_captured_call('reflection')
                if captured_call:
                    self.simple_logger.log_reflection(
                        messages=captured_call.messages,
                        tools=captured_call.tools,
                        model=captured_call.model,
                        reflection_response=f"REFLECTION FAILED: {str(e)}",
                        duration_ms=duration_ms
                    )
                else:
                    # Fallback
                    self.simple_logger.log_reflection(
                        messages=messages,
                        tools=tool_schemas,
                        model=_get_agent_model(self.agent),
                        reflection_response=f"REFLECTION FAILED: {str(e)}",
                        duration_ms=duration_ms
                    )

            return {
                'success': False,
                'reflection': None,
                'error': str(e)
            }

    # ========================================================================
    # Helper methods for real prompt capture
    # ========================================================================

    def _get_captured_call(self, phase: str) -> Optional[CapturedLLMCall]:
        """Get the captured LLM call for a phase."""
        if not self._llm_capture:
            return None

        calls = self._llm_capture.get_calls(phase=phase)
        if not calls:
            return None

        # Return the last call for this phase (most recent)
        return calls[-1]

    def _format_plan_response(self, plan: Any) -> str:
        """Format plan object into readable text."""
        if not plan:
            return "No plan created"

        lines = []
        lines.append(f"Goal: {getattr(plan, 'goal', 'unknown')}")
        lines.append(f"Goal Type: {getattr(plan, 'goal_type', 'unknown')}")
        lines.append(f"Requires Tools: {getattr(plan, 'requires_tools', False)}")
        lines.append(f"Complexity: {getattr(plan, 'estimated_complexity', 'unknown')}")
        lines.append(f"Reasoning: {getattr(plan, 'reasoning', 'none')}")
        lines.append("")

        steps = getattr(plan, 'steps', [])
        if steps:
            lines.append(f"Steps ({len(steps)}):")
            for step in steps:
                step_num = getattr(step, 'step_num', '?')
                objective = getattr(step, 'objective', 'unknown')
                tool_hint = getattr(step, 'tool_hint', None)
                tool_note = f" [Tool: {tool_hint}]" if tool_hint else ""
                lines.append(f"  {step_num}. {objective}{tool_note}")

        return "\n".join(lines)

    def _format_execution_response(self, trace: Any) -> str:
        """Format execution trace into readable text."""
        if not trace:
            return "No execution trace"

        lines = []
        if hasattr(trace, 'final_response'):
            lines.append(f"Final Response: {trace.final_response}")
            lines.append("")

        steps = getattr(trace, 'steps', [])
        if steps:
            lines.append(f"Steps Executed ({len(steps)}):")
            for i, step in enumerate(steps, 1):
                lines.append(f"\nStep {i}:")
                lines.append(f"  Description: {getattr(step, 'description', 'unknown')}")

                tool_calls = getattr(step, 'tool_calls', [])
                if tool_calls:
                    lines.append(f"  Tool Calls ({len(tool_calls)}):")
                    for tc in tool_calls:
                        tool_name = getattr(tc, 'tool_name', 'unknown')
                        success = getattr(tc, 'success', True)
                        status = "✓" if success else "✗"
                        lines.append(f"    {status} {tool_name}")

        return "\n".join(lines)

    def _format_reflection_response(self, reflection: Any) -> str:
        """Format reflection into readable text."""
        if not reflection:
            return "No reflection"

        lines = []
        lines.append(f"Goal Achieved: {getattr(reflection, 'goal_achieved', False)}")
        lines.append(f"Confidence: {getattr(reflection, 'confidence', 0.0)}")
        lines.append(f"Reasoning: {getattr(reflection, 'reasoning', 'none')}")

        return "\n".join(lines)

    def _get_captured_messages(self, phase: str) -> Optional[List[Dict[str, Any]]]:
        """
        Get real captured messages for a phase from LLM instrumentation.

        Returns None if no capture available, allowing fallback to synthetic prompts.
        """
        if not self._llm_capture:
            return None

        calls = self._llm_capture.get_calls(phase=phase)
        if not calls:
            return None

        # Aggregate all messages from calls in this phase
        all_messages = []
        for call in calls:
            for msg in call.messages:
                # Add token count from the call if available
                msg_with_tokens = dict(msg)
                if 'token_count' not in msg_with_tokens:
                    # Estimate if not available
                    content = msg_with_tokens.get('content', '')
                    if isinstance(content, str):
                        msg_with_tokens['token_count'] = len(content) // 4
                    else:
                        msg_with_tokens['token_count'] = 0
                all_messages.append(msg_with_tokens)

        return all_messages if all_messages else None

    def _get_captured_tools(self, phase: str) -> Optional[List[Dict[str, Any]]]:
        """
        Get real captured tool schemas for a phase from LLM instrumentation.

        Returns None if no capture available, allowing fallback to reconstructed schemas.
        """
        if not self._llm_capture:
            return None

        calls = self._llm_capture.get_calls(phase=phase)
        if not calls:
            return None

        # Get tools from the first call (they should be consistent across calls)
        for call in calls:
            if call.tools:
                return call.tools

        return None

    # ========================================================================
    # Helper methods for synthetic prompts (fallback)
    # ========================================================================

    def _build_planning_messages(self, user_prompt: str, plan: Any) -> List[Dict[str, Any]]:
        """Build approximate planning messages."""
        # In real implementation, would capture actual LLM messages
        # For now, construct from available data
        messages = []

        # System message
        if hasattr(self.agent, '_get_system_prompt'):
            system_prompt = self.agent._get_system_prompt()
            messages.append({
                'role': 'system',
                'content': system_prompt,
                'cached': False,
                'token_count': len(system_prompt) // 4
            })

        # User message
        messages.append({
            'role': 'user',
            'content': user_prompt,
            'cached': False,
            'token_count': len(user_prompt) // 4
        })

        return messages

    def _build_execution_messages(self, plan: Any, trace: Any, serialized_context: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Build execution messages using the actual serialized context that was sent to the LLM.

        Using str(plan) pulls in full tool outputs and prior traces, which can explode token
        counts and misrepresent the true prompt. Instead, mirror the real instructions/input
        we provided to the executor.
        """
        messages: List[Dict[str, Any]] = []

        instructions = serialized_context.get("instructions", "")
        if instructions:
            messages.append({
                "role": "system",
                "content": instructions,
                "cached": False,
                "token_count": len(instructions) // 4
            })

        input_block = serialized_context.get("input", "")
        # Responses API may supply a list of role/content blocks; handle both cases.
        if isinstance(input_block, list):
            for msg in input_block:
                role = msg.get("role", "user")
                content = msg.get("content", "")
                messages.append({
                    "role": role,
                    "content": content,
                    "cached": False,
                    "token_count": len(content) // 4
                })
        elif input_block:
            content = str(input_block)
            messages.append({
                "role": "user",
                "content": content,
                "cached": False,
                "token_count": len(content) // 4
            })

        return messages

    def _build_reflection_messages(self, plan: Any, trace: Any, reflection: Any) -> List[Dict[str, Any]]:
        """
        Build reflection messages with compact summaries to avoid leaking full tool outputs
        into recorded prompts.
        """
        messages: List[Dict[str, Any]] = []

        plan_summary = self._summarize_plan(plan)
        trace_summary = self._summarize_trace(trace)
        content = f"Plan summary:\n{plan_summary}\n\nExecution summary:\n{trace_summary}"

        messages.append({
            "role": "system",
            "content": content,
            "cached": False,
            "token_count": len(content) // 4
        })

        return messages

    def _extract_tool_calls(self, trace: Any) -> List[Dict[str, Any]]:
        """Extract tool calls from execution trace for file tracker."""
        tool_calls = []

        if not hasattr(trace, 'steps'):
            return tool_calls

        for step in trace.steps:
            if not hasattr(step, 'tool_calls'):
                continue

            for tc in step.tool_calls:
                tool_calls.append({
                    'tool_name': tc.tool_name if hasattr(tc, 'tool_name') else 'unknown',
                    'arguments': tc.arguments if hasattr(tc, 'arguments') else {},
                    'output': tc.output if hasattr(tc, 'output') else '',
                    'success': tc.success if hasattr(tc, 'success') else True,
                    'duration_ms': getattr(tc, 'duration_ms', 0.0),
                    'started_at': getattr(tc, 'started_at', ''),
                    'completed_at': getattr(tc, 'completed_at', ''),
                    'error': getattr(tc, 'error', None),
                    'error_type': getattr(tc, 'error_type', None)
                })

        return tool_calls

    def _convert_steps(self, steps: List[Any]) -> List[Dict[str, Any]]:
        """Convert execution steps to dicts."""
        converted = []

        for i, step in enumerate(steps):
            step_dict = {
                'step_number': i + 1,
                'description': getattr(step, 'description', ''),
                'planned_action': getattr(step, 'action', ''),
                'tool_hint': getattr(step, 'tool', ''),
                'dependencies': getattr(step, 'dependencies', []),
                'tool_calls': self._convert_tool_calls(step),
                'reasoning': getattr(step, 'reasoning', ''),
                'success': getattr(step, 'success', True),
                'postcondition_met': getattr(step, 'postcondition_met', True),
                'error': getattr(step, 'error', None),
                'duration_ms': getattr(step, 'duration_ms', 0.0)
            }
            converted.append(step_dict)

        return converted

    def _convert_tool_calls(self, step: Any) -> List[Dict[str, Any]]:
        """Convert tool calls from a step."""
        tool_calls = []

        if not hasattr(step, 'tool_calls'):
            return tool_calls

        for tc in step.tool_calls:
            tool_calls.append({
                'name': tc.tool_name if hasattr(tc, 'tool_name') else 'unknown',
                'arguments': tc.arguments if hasattr(tc, 'arguments') else {},
                'output': tc.output if hasattr(tc, 'output') else '',
                'success': tc.success if hasattr(tc, 'success') else True,
                'error': getattr(tc, 'error', None),
                'error_type': getattr(tc, 'error_type', None),
                'duration_ms': getattr(tc, 'duration_ms', 0.0),
                'started_at': getattr(tc, 'started_at', ''),
                'completed_at': getattr(tc, 'completed_at', ''),
                'parallel_group': getattr(tc, 'parallel_group', None)
            })

        return tool_calls

    def _get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Get tool schemas from agent."""
        if not hasattr(self.agent, 'tool_registry'):
            return []

        # Get tool definitions from the registry
        tool_defs = self.agent.tool_registry.get_definitions(enabled_only=True)

        schemas = []
        for tool_def in tool_defs:
            schema = {
                'name': tool_def.name,
                'description': tool_def.description,
                'parameters': tool_def.parameters
            }
            schemas.append(schema)

        return schemas

    # ========================================================================
    # Compact summarizers used for fallback prompts
    # ========================================================================

    def _summarize_plan(self, plan: Any, max_steps: int = 8) -> str:
        """Produce a short, stable plan summary without tool outputs."""
        if not plan:
            return "No plan available."

        lines = [
            f"Goal: {getattr(plan, 'goal', 'unknown')}",
            f"Type: {getattr(plan, 'goal_type', 'unknown')}"
        ]

        steps = getattr(plan, "steps", []) or []
        if steps:
            lines.append("Steps:")
            for step in steps[:max_steps]:
                status_obj = getattr(step, "status", None)
                status = status_obj.value if hasattr(status_obj, "value") else status_obj or "pending"
                tool_hint = getattr(step, "tool_hint", None)
                tool_note = f" [{tool_hint}]" if tool_hint else ""
                objective = getattr(step, "objective", "unknown objective")
                lines.append(f"- {getattr(step, 'step_num', '?')}. {objective}{tool_note} (status: {status})")

            if len(steps) > max_steps:
                lines.append(f"... {len(steps) - max_steps} more steps not shown.")

        return "\n".join(lines)

    def _summarize_trace(self, trace: Any, max_steps: int = 8, max_tools: int = 3, max_final_chars: int = 400) -> str:
        """Produce a compact execution trace summary."""
        if not trace:
            return "No execution trace."

        lines: List[str] = []

        final_response = getattr(trace, "final_response", None)
        if final_response:
            snippet = str(final_response)
            if len(snippet) > max_final_chars:
                snippet = snippet[:max_final_chars].rstrip() + "..."
            lines.append(f"Final response: {snippet}")

        steps = getattr(trace, "step_results", None) or getattr(trace, "steps_executed", [])
        if steps:
            lines.append("Step results:")
            for step in steps[:max_steps]:
                status_obj = getattr(step, "status", None)
                status = status_obj.value if hasattr(status_obj, "value") else status_obj or "unknown"
                tool_names: List[str] = []
                for record in getattr(step, "tool_calls_made", []) or []:
                    name = getattr(record, "tool_name", None)
                    if name:
                        tool_names.append(name)

                tools_display = ", ".join(tool_names[:max_tools]) if tool_names else "none"
                if len(tool_names) > max_tools:
                    tools_display += f" (+{len(tool_names) - max_tools} more)"

                lines.append(f"- Step {getattr(step, 'step_num', '?')}: {status}; tools: {tools_display}")

            if len(steps) > max_steps:
                lines.append(f"... {len(steps) - max_steps} more steps not shown.")

        return "\n".join(lines) if lines else "No execution steps recorded."
