# """
# Reflector - evaluates execution against the original goal (with RL labels).

# This module intentionally contains no logging. Logging is handled by the Agent.
# """

# import json
# from typing import Any, Dict, List, Optional

# from util.llm_adapter import LLMAdapter
# from util.perf_trace import get_tracer
# from .plan_models import ExecutionTrace, Plan, PlanStatus, Reflection, StepResult
# from .prompts import REFLECTION_PROMPT, format_prompt


# class Reflector:
#     """
#     Evaluates execution against the original goal.

#     This is the key to avoiding silent failures - we explicitly check
#     if we accomplished what the user actually wanted.
#     """

#     def __init__(self, llm: LLMAdapter, tool_registry: 'ToolRegistry'):
#         self.llm = llm
#         self.tool_registry = tool_registry
#         self._tracer = get_tracer()
#         # NO logger - Reflector doesn't log, Agent does

#     def reflect(
#         self,
#         plan: Plan,
#         trace: ExecutionTrace,
#         file_operations: Optional[List[Dict[str, Any]]] = None
#     ) -> Reflection:
#         """
#         Evaluate if the plan's goal was actually achieved.
#         """
#         # Fast path: obvious failures
#         if trace.final_response is None or not trace.final_response.strip():
#             return Reflection(
#                 plan_goal=plan.goal,
#                 goal_achieved=False,
#                 confidence=1.0,
#                 evidence=["No response generated"],
#                 gaps=["Execution produced no output"],
#                 suggestions=["Retry with different approach"]
#             )

#         # Fast path: all tools failed
#         if trace.tool_calls > 0 and trace.tool_failures == trace.tool_calls:
#             return Reflection(
#                 plan_goal=plan.goal,
#                 goal_achieved=False,
#                 confidence=0.95,
#                 evidence=[f"All {trace.tool_calls} tool calls failed"],
#                 gaps=["Could not execute any tools successfully"],
#                 suggestions=["Check tool parameters", "Try alternative tools"],
#                 should_retry=True
#             )

#         # OPTIMIZATION: Fast path for simple tasks - skip expensive LLM reflection
#         # Simple questions: no tools, just answered from knowledge
#         if plan.goal_type == "question" and not plan.requires_tools:
#             return Reflection(
#                 plan_goal=plan.goal,
#                 goal_achieved=True,
#                 confidence=0.9,
#                 evidence=["Direct answer provided"],
#                 gaps=[],
#                 suggestions=[],
#                 reward=1.0,
#                 plan_quality=1.0,
#                 execution_quality=1.0,
#                 response_quality=0.9
#             )

#         # Simple tool tasks: single tool used successfully (e.g., search, file read)
#         if (plan.goal_type in ("search", "question") and
#             trace.tool_calls > 0 and
#             trace.tool_failures == 0 and
#             trace.final_response and
#             len(trace.final_response) > 20):
#             return Reflection(
#                 plan_goal=plan.goal,
#                 goal_achieved=True,
#                 confidence=0.95,
#                 evidence=["Tool executed successfully with result"],
#                 gaps=[],
#                 suggestions=[],
#                 reward=1.0,
#                 plan_quality=1.0,
#                 execution_quality=1.0,
#                 response_quality=0.9
#             )

#         # Heuristic: if execution produced tangible artifacts/tests, trust that evidence
#         heuristic_reflection = self._auto_reflect_from_trace(plan, trace, file_operations)
#         if heuristic_reflection:
#             return heuristic_reflection

#         # For complex tasks, use LLM to evaluate
#         return self._llm_reflect(plan, trace, file_operations=file_operations)

#     def _llm_reflect(
#         self,
#         plan: Plan,
#         trace: ExecutionTrace,
#         file_operations: Optional[List[Dict[str, Any]]] = None
#     ) -> Reflection:
#         """Use LLM to evaluate complex task completion with RL labeling"""
#         # Build structured input for the Reflector
#         step_summaries = self._build_step_summaries(plan, trace)
#         artifact_summary = self._summarize_artifacts_for_llm(file_operations)

#         reflector_input = {
#             "user_input": plan.goal,  # Using plan.goal as user_input proxy
#             "plan": {
#                 "goal": plan.goal,
#                 "goal_type": plan.goal_type,
#                 "requires_tools": plan.requires_tools,
#                 "steps": [
#                     {
#                         "step_num": s.step_num,
#                         "objective": s.objective,
#                         "status": s.status.value
#                     }
#                     for s in plan.steps
#                 ],
#                 "success_criteria": plan.success_criteria.description
#             },
#             "execution_trace": {
#                 "tool_calls": trace.tool_calls,
#                 "tool_failures": trace.tool_failures,
#                 "steps_completed": len([s for s in trace.steps_executed if s.status == PlanStatus.COMPLETED]),
#                 "total_steps": len(plan.steps),
#                 "all_steps_succeeded": trace.all_steps_succeeded,
#                 "steps": step_summaries
#             },
#             "final_response": trace.final_response[:1500] if trace.final_response else "(no response)"
#         }
#         if artifact_summary:
#             reflector_input["artifacts"] = artifact_summary

#         # Get tools for LLM (so it knows what tools are available)
#         tools = self.tool_registry.list_tools(enabled_only=True)
#         tool_defs = [t.to_definition() for t in tools]
#         tools_internally_tagged = [td.to_responses_format() for td in tool_defs]

#         try:
#             reflection_instructions = format_prompt(
#                 REFLECTION_PROMPT,
#                 goal=plan.goal,
#                 goal_type=plan.goal_type,
#                 success_criteria=plan.success_criteria.description if plan.success_criteria else "",
#                 tool_calls=trace.tool_calls,
#                 tool_failures=trace.tool_failures,
#                 steps_completed=len([s for s in trace.steps_executed if s.status == PlanStatus.COMPLETED]),
#                 total_steps=len(plan.steps),
#                 response=trace.final_response or "(no response)"
#             ) or REFLECTION_PROMPT
#             with self._tracer.span("llm_respond_reflection"):
#                 response = self.llm.respond(
#                     input=json.dumps(reflector_input),
#                     instructions=reflection_instructions,
#                     tools=tools_internally_tagged
#                 )
#             with self._tracer.span("parse_reflection"):
#                 eval_data = self._parse_reflection(response.content)

#             return Reflection(
#                 plan_goal=plan.goal,
#                 goal_achieved=eval_data.get("goal_achieved", False),
#                 confidence=eval_data.get("reflection_confidence", 0.5),
#                 evidence=[],  # Not in new format
#                 gaps=eval_data.get("gaps", []),
#                 suggestions=eval_data.get("suggested_improvements", []),
#                 should_retry=not eval_data.get("goal_achieved", True) and trace.tool_failures > 0,
#                 had_tool_failures=eval_data.get("had_tool_failures", trace.tool_failures > 0),
#                 reward=eval_data.get("reward", 0.0),
#                 plan_quality=eval_data.get("plan_quality", 0.0),
#                 execution_quality=eval_data.get("execution_quality", 0.0),
#                 response_quality=eval_data.get("response_quality", 0.0)
#             )
#         except Exception:
#             # Fallback: use heuristics
#             # Agent will handle exception logging
#             success = trace.tool_failures == 0 and trace.final_response and len(trace.final_response) > 20
#             return Reflection(
#                 plan_goal=plan.goal,
#                 goal_achieved=success,
#                 confidence=0.6,
#                 evidence=["Heuristic evaluation"],
#                 gaps=[] if success else ["Could not verify goal completion"],
#                 suggestions=[],
#                 had_tool_failures=trace.tool_failures > 0,
#                 reward=1.0 if success else 0.0,
#                 plan_quality=0.5,
#                 execution_quality=0.5 if success else 0.2,
#                 response_quality=0.5 if success else 0.2
#             )

#     def _auto_reflect_from_trace(
#         self,
#         plan: Plan,
#         trace: ExecutionTrace,
#         file_operations: Optional[List[Dict[str, Any]]]
#     ) -> Optional[Reflection]:
#         """
#         Lightweight heuristics that mark success when evidence is obvious.
#         """
#         if not trace.final_response:
#             return None

#         all_steps_completed = bool(plan.steps) and all(
#             step.status == PlanStatus.COMPLETED for step in plan.steps
#         )
#         if all_steps_completed:
#             return self._build_success_reflection(
#                 plan,
#                 trace,
#                 file_operations,
#                 confidence=0.9,
#                 note="All planned steps completed"
#             )

#         test_note = self._detect_successful_tests(trace)
#         file_writes = self._extract_file_writes(file_operations)
#         if test_note and file_writes:
#             return self._build_success_reflection(
#                 plan,
#                 trace,
#                 file_operations,
#                 confidence=0.8,
#                 note="Files created and tests reported success",
#                 test_note=test_note
#             )

#         return None

#     def _build_success_reflection(
#         self,
#         plan: Plan,
#         trace: ExecutionTrace,
#         file_operations: Optional[List[Dict[str, Any]]],
#         confidence: float,
#         note: str,
#         test_note: Optional[str] = None
#     ) -> Reflection:
#         """Construct a Reflection object that records clear success evidence."""
#         evidence = [note]
#         file_summary = self._summarize_file_ops_simple(file_operations)
#         if file_summary:
#             evidence.append(file_summary)
#         if test_note:
#             evidence.append(test_note)

#         had_failures = trace.tool_failures > 0
#         return Reflection(
#             plan_goal=plan.goal,
#             goal_achieved=True,
#             confidence=confidence,
#             evidence=evidence,
#             gaps=[],
#             suggestions=[],
#             should_retry=False,
#             had_tool_failures=had_failures,
#             reward=1.0 if not had_failures else 0.85,
#             plan_quality=1.0 if not had_failures else 0.9,
#             execution_quality=0.95 if not had_failures else 0.8,
#             response_quality=0.85 if trace.final_response else 0.6
#         )

#     def _extract_file_writes(
#         self,
#         file_operations: Optional[List[Dict[str, Any]]]
#     ) -> List[str]:
#         """Return list of paths that appear to have been written/appended."""
#         if not file_operations:
#             return []

#         writes = []
#         for op in file_operations:
#             action = (op.get("action") or "").lower()
#             if action in {"write", "append", "file_write", "create"}:
#                 path = op.get("path")
#                 if path:
#                     writes.append(path)
#         return writes

#     def _summarize_file_ops_simple(
#         self,
#         file_operations: Optional[List[Dict[str, Any]]]
#     ) -> Optional[str]:
#         """Create a concise human-readable summary of file work."""
#         writes = self._extract_file_writes(file_operations)
#         if writes:
#             display = ", ".join(writes[:3])
#             if len(writes) > 3:
#                 display += ", ..."
#             return f"Files written: {display}"
#         return None

#     def _detect_successful_tests(self, trace: ExecutionTrace) -> Optional[str]:
#         """Look for obvious signs of passing tests in tool outputs."""
#         success_phrases = [
#             "all tests passed",
#             "tests passed",
#             "ok (",
#             "ok\n",
#             "successfully ran",
#             "passed in"
#         ]
#         failure_phrases = ["fail", "traceback", "assert", "error"]

#         for step_result in trace.step_results:
#             for record in step_result.tool_calls_made:
#                 if record.tool_name not in {"python_execute", "bash_execute"}:
#                     continue
#                 output = str(record.result.output or "")
#                 lower_output = output.lower()
#                 if any(phrase in lower_output for phrase in success_phrases):
#                     if not any(failure in lower_output for failure in failure_phrases):
#                         snippet = self._truncate_text(output, max_len=200)
#                         return f"Test output from {record.tool_name}: {snippet}"
#         return None

#     def _build_step_summaries(
#         self,
#         plan: Plan,
#         trace: ExecutionTrace
#     ) -> List[Dict[str, Any]]:
#         """Summarize per-step execution for inclusion in reflection prompt."""
#         summaries: List[Dict[str, Any]] = []
#         plan_map = {step.step_num: step for step in plan.steps}

#         for step_result in trace.step_results[:8]:  # limit for prompt size
#             plan_step = plan_map.get(step_result.step_num)
#             summary: Dict[str, Any] = {
#                 "step_num": step_result.step_num,
#                 "status": step_result.status.value,
#                 "objective": plan_step.objective if plan_step else None,
#                 "error": step_result.error
#             }
#             if step_result.final_response:
#                 summary["final_response"] = self._truncate_text(step_result.final_response, max_len=300)

#             tool_calls = []
#             for record in step_result.tool_calls_made[:4]:
#                 tool_calls.append({
#                     "tool": record.tool_name,
#                     "status": record.result.status.value if hasattr(record.result.status, "value") else str(record.result.status),
#                     "output": self._truncate_text(str(record.result.output or ""), max_len=150),
#                     "error": record.result.error
#                 })
#             if tool_calls:
#                 summary["tool_calls"] = tool_calls

#             summaries.append(summary)

#         return summaries

#     def _summarize_artifacts_for_llm(
#         self,
#         file_operations: Optional[List[Dict[str, Any]]]
#     ) -> Optional[List[Dict[str, Any]]]:
#         """Convert file operation logs into concise artifact descriptors."""
#         if not file_operations:
#             return None

#         artifacts = []
#         for op in file_operations[:10]:
#             artifacts.append({
#                 "path": op.get("path"),
#                 "action": op.get("action"),
#                 "tool": op.get("tool")
#             })
#         return artifacts

#     @staticmethod
#     def _truncate_text(value: str, max_len: int = 120) -> str:
#         """Truncate long strings for prompts/evidence."""
#         text = value.strip()
#         if len(text) <= max_len:
#             return text
#         return text[:max_len - 3] + "..."

#     def _parse_reflection(self, content: str) -> Dict[str, Any]:
#         """Parse reflection JSON from LLM response"""
#         try:
#             if "```json" in content:
#                 json_str = content.split("```json")[1].split("```")[0]
#             elif "```" in content:
#                 json_str = content.split("```")[1].split("```")[0]
#             else:
#                 json_str = content
#             return json.loads(json_str.strip())
#         except (json.JSONDecodeError, IndexError):
#             return {"goal_achieved": False, "confidence": 0.3, "evidence": ["Parse error"]}
