"""
Planner/Executor/Reflector architecture for structured agent execution.

This module provides:
- Planner: Creates explicit execution plans with success criteria
- Executor: Executes plans step-by-step with validation
- Reflector: Evaluates execution against original goals

The key insight is that success should be measured against the GOAL,
not just whether tools ran without exceptions.
"""

import json
import time
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List
from enum import Enum

from .llm_adapter import LLMAdapter, Message, MessageRole, LLMResponse, ToolCall
from .tool_registry import ToolRegistry, ToolResult
from .logger import get_logger
from .agent_execution_logger import get_execution_logger


class PlanStatus(Enum):
    """Status of a plan or step"""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    PARTIAL = "partial"


@dataclass
class SuccessCriteria:
    """Defines what success looks like for a step or plan"""
    description: str                      # Human-readable success condition
    required_outputs: List[str] = field(default_factory=list)  # What must be produced
    validation_hints: List[str] = field(default_factory=list)  # How to validate


@dataclass
class PlanStep:
    """A single step in an execution plan"""
    step_num: int
    objective: str                        # What this step should accomplish
    tool_hint: Optional[str] = None       # Suggested tool (or None for reasoning)
    tool_args_hint: Optional[Dict] = None # Suggested arguments
    success_criteria: Optional[SuccessCriteria] = None
    depends_on: List[int] = field(default_factory=list)  # Step dependencies

    # Filled during execution
    status: PlanStatus = PlanStatus.PENDING
    result: Optional[Any] = None
    error: Optional[str] = None
    duration_ms: float = 0


@dataclass
class Plan:
    """
    An explicit execution plan created before running.

    Key difference from current approach: we know WHAT we're trying to do
    and HOW we'll know if we succeeded BEFORE we start.
    """
    goal: str                             # The user's actual goal
    goal_type: str                        # "question", "task", "creation", "search"
    steps: List[PlanStep]                 # Ordered steps to achieve goal
    success_criteria: SuccessCriteria     # How we know the whole plan succeeded
    estimated_complexity: str             # "simple", "standard", "advanced"
    requires_tools: bool                  # Does this need external tools?
    reasoning: str                        # Why this plan

    # Metadata
    created_at: float = field(default_factory=time.time)
    status: PlanStatus = PlanStatus.PENDING

    def to_dict(self) -> Dict[str, Any]:
        return {
            "goal": self.goal,
            "goal_type": self.goal_type,
            "steps": [
                {
                    "step_num": s.step_num,
                    "objective": s.objective,
                    "tool_hint": s.tool_hint,
                    "status": s.status.value
                }
                for s in self.steps
            ],
            "success_criteria": self.success_criteria.description,
            "complexity": self.estimated_complexity,
            "requires_tools": self.requires_tools
        }


@dataclass
class ExecutionTrace:
    """Record of what happened during execution"""
    plan: Plan
    steps_executed: List[PlanStep]
    llm_calls: int = 0
    tool_calls: int = 0
    tool_failures: int = 0
    final_response: Optional[str] = None
    total_duration_ms: float = 0

    @property
    def had_failures(self) -> bool:
        return self.tool_failures > 0

    @property
    def all_steps_succeeded(self) -> bool:
        return all(s.status == PlanStatus.COMPLETED for s in self.steps_executed)


@dataclass
class Reflection:
    """Post-execution evaluation"""
    plan_goal: str
    goal_achieved: bool                   # Did we actually accomplish the goal?
    confidence: float                     # 0-1 confidence in assessment
    evidence: List[str]                   # Why we think goal was/wasn't achieved
    gaps: List[str]                       # What's missing
    suggestions: List[str]                # What could be done differently
    should_retry: bool = False            # Should we try again with different approach?


# =============================================================================
# PLANNER: Creates execution plans with explicit success criteria
# =============================================================================

def _load_planner_prompts():
    """Load planner prompts from config file"""
    import json
    from pathlib import Path

    config_path = Path(__file__).parent.parent / "config" / "prompts_config.json"
    try:
        with open(config_path, 'r') as f:
            data = json.load(f)
            return data.get("planner_prompts", {})
    except Exception:
        # Fallback to hardcoded defaults
        return {
            "planning": """You are a planning assistant. Given a user request, create an execution plan.

IMPORTANT: Your job is to determine:
1. What is the user's ACTUAL GOAL? (not just what they said, but what they want to achieve)
2. What steps are needed to achieve this goal?
3. How will we KNOW if we succeeded?

Respond with a JSON plan:
```json
{{
  "goal": "Clear statement of what user wants to achieve",
  "goal_type": "question|task|creation|search",
  "requires_tools": true/false,
  "steps": [
    {{
      "step_num": 1,
      "objective": "What this step accomplishes",
      "tool_hint": "tool_name or null for reasoning",
      "tool_args_hint": {{"arg": "value"}} or null
    }}
  ],
  "success_criteria": "How we know the goal was achieved",
  "reasoning": "Why this plan will work"
}}
```

GUIDELINES:
- For simple questions (capital of X, math, facts): goal_type="question", requires_tools=false, 1 step
- For searches/lookups: goal_type="search", requires_tools=true, include search step
- For file operations: goal_type="task", requires_tools=true, include file tool steps
- For creation tasks: goal_type="creation", may need multiple steps

Available tools: {tools}

User request: {user_input}
{context}""",
            "reflection": """Evaluate if the goal was achieved.

GOAL: {goal}
SUCCESS CRITERIA: {success_criteria}

EXECUTION SUMMARY:
- Tool calls: {tool_calls} ({tool_failures} failed)
- Steps completed: {steps_completed}/{total_steps}

FINAL RESPONSE:
{response}

Evaluate honestly:
1. Was the GOAL actually achieved? (yes/no)
2. Confidence (0-1): How sure are you?
3. Evidence: What indicates success or failure?
4. Gaps: What's missing or wrong?

Respond with JSON:
```json
{{
  "goal_achieved": true/false,
  "confidence": 0.0-1.0,
  "evidence": ["reason1", "reason2"],
  "gaps": ["gap1", "gap2"],
  "suggestions": ["suggestion1"]
}}
```"""
        }

# Load planner prompts from config
_PLANNER_PROMPTS = _load_planner_prompts()
PLANNING_PROMPT = _PLANNER_PROMPTS.get("planning", "")
REFLECTION_PROMPT = _PLANNER_PROMPTS.get("reflection", "")


class Planner:
    """
    Creates explicit execution plans before running.

    The key insight: know what success looks like BEFORE you start.
    """

    def __init__(self, llm: LLMAdapter, tool_registry: ToolRegistry):
        self.llm = llm
        self.tool_registry = tool_registry
        self.logger = get_logger()
        self.exec_logger = get_execution_logger()

    def create_plan(
        self,
        user_input: str,
        context: Optional[str] = None,
        tier: str = "standard",
        exec_id: Optional[str] = None
    ) -> Plan:
        """
        Create an execution plan for the user's request.

        For simple requests, this is fast (pattern matching).
        For complex requests, uses LLM to decompose.
        """
        # Fast path: detect simple patterns that don't need LLM planning
        simple_plan = self._try_simple_plan(user_input)
        if simple_plan:
            self.logger.debug(f"Using simple plan for: {user_input[:50]}", component="planner")
            return simple_plan

        # Complex path: use LLM to create plan
        return self._create_llm_plan(user_input, context, tier)

    def _try_simple_plan(self, user_input: str) -> Optional[Plan]:
        """
        Fast pattern matching for simple requests.
        Avoids LLM call for obvious cases.
        """
        input_lower = user_input.lower().strip()

        # Simple factual questions (no tools needed)
        question_starters = [
            "what is", "what's", "what does", "who is", "who's", "when did", "when was",
            "where is", "where's", "how many", "how much", "define", "explain",
            "what are", "why is", "why do", "can you tell me"
        ]

        # Check for simple question that doesn't need real-time data
        is_simple_question = any(input_lower.startswith(q) for q in question_starters)
        needs_realtime = any(kw in input_lower for kw in [
            "weather", "stock", "price", "news", "today", "current", "now",
            "latest", "recent", "live"
        ])
        needs_search = any(kw in input_lower for kw in [
            "search", "look up", "find", "google", "check online"
        ])
        needs_files = any(kw in input_lower for kw in [
            "create file", "write file", "read file", "open file", "save",
            "create folder", "delete file", "edit file"
        ])

        if is_simple_question and not needs_realtime and not needs_search and not needs_files:
            return Plan(
                goal=f"Answer: {user_input}",
                goal_type="question",
                steps=[
                    PlanStep(
                        step_num=1,
                        objective="Answer the question from knowledge",
                        tool_hint=None,
                        success_criteria=SuccessCriteria(
                            description="Provide accurate, direct answer"
                        )
                    )
                ],
                success_criteria=SuccessCriteria(
                    description="Question answered accurately and concisely"
                ),
                estimated_complexity="simple",
                requires_tools=False,
                reasoning="Simple factual question - answer from knowledge"
            )

        # Search/lookup requests
        if needs_search or needs_realtime:
            return Plan(
                goal=f"Find information: {user_input}",
                goal_type="search",
                steps=[
                    PlanStep(
                        step_num=1,
                        objective="Search for current/relevant information",
                        tool_hint="fast_answer",
                        tool_args_hint={"query": user_input},
                        success_criteria=SuccessCriteria(
                            description="Find relevant, current information"
                        )
                    ),
                    PlanStep(
                        step_num=2,
                        objective="Synthesize findings into answer",
                        tool_hint=None,
                        depends_on=[1],
                        success_criteria=SuccessCriteria(
                            description="Provide clear answer based on search results"
                        )
                    )
                ],
                success_criteria=SuccessCriteria(
                    description="User gets accurate, current information"
                ),
                estimated_complexity="standard",
                requires_tools=True,
                reasoning="Needs current/external information"
            )

        # Not a simple pattern - need LLM planning
        return None

    def _create_llm_plan(
        self,
        user_input: str,
        context: Optional[str],
        tier: str
    ) -> Plan:
        """Use LLM to create a plan for complex requests"""
        tools = self.tool_registry.list_tools(enabled_only=True)
        tool_descriptions = "\n".join([f"- {t.name}: {t.description}" for t in tools])

        context_str = f"\nContext: {context}" if context else ""

        prompt = PLANNING_PROMPT.format(
            tools=tool_descriptions,
            user_input=user_input,
            context=context_str
        )

        messages = [
            Message(MessageRole.SYSTEM, "You are a planning assistant. Output valid JSON only."),
            Message(MessageRole.USER, prompt)
        ]

        try:
            response = self.llm.complete(messages)
            plan_data = self._parse_plan_response(response.content, user_input)

            # Convert to Plan object
            steps = []
            for i, step_data in enumerate(plan_data.get("steps", [])):
                steps.append(PlanStep(
                    step_num=step_data.get("step_num", i + 1),
                    objective=step_data.get("objective", "Execute step"),
                    tool_hint=step_data.get("tool_hint"),
                    tool_args_hint=step_data.get("tool_args_hint"),
                    success_criteria=SuccessCriteria(
                        description=step_data.get("success_criteria", "Step completed")
                    )
                ))

            # Ensure at least one step
            if not steps:
                steps = [PlanStep(
                    step_num=1,
                    objective="Process user request",
                    success_criteria=SuccessCriteria(description="Request handled")
                )]

            return Plan(
                goal=plan_data.get("goal", user_input),
                goal_type=plan_data.get("goal_type", "task"),
                steps=steps,
                success_criteria=SuccessCriteria(
                    description=plan_data.get("success_criteria", "Goal achieved")
                ),
                estimated_complexity=tier,
                requires_tools=plan_data.get("requires_tools", False),
                reasoning=plan_data.get("reasoning", "LLM-generated plan")
            )

        except Exception as e:
            self.logger.error(f"Plan creation failed: {e}", component="planner")
            # Fallback plan
            return Plan(
                goal=user_input,
                goal_type="task",
                steps=[PlanStep(
                    step_num=1,
                    objective="Handle user request",
                    success_criteria=SuccessCriteria(description="Request processed")
                )],
                success_criteria=SuccessCriteria(description="Request handled"),
                estimated_complexity=tier,
                requires_tools=False,
                reasoning="Fallback plan due to planning error"
            )

    def _parse_plan_response(self, content: str, user_input: str) -> Dict[str, Any]:
        """Parse LLM response to extract plan JSON"""
        # Try to extract JSON from response
        try:
            # Look for JSON block
            if "```json" in content:
                json_str = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                json_str = content.split("```")[1].split("```")[0]
            else:
                json_str = content

            self.logger.debug(f"Attempting to parse JSON (length {len(json_str)}): {json_str[:200]}", component="planner")
            result = json.loads(json_str.strip())
            self.logger.debug(f"Successfully parsed JSON, type: {type(result)}", component="planner")
            return result
        except (json.JSONDecodeError, IndexError) as e:
            self.logger.debug(f"JSON parse failed ({type(e).__name__}): {e}. Returning fallback plan.", component="planner")
            # Return minimal plan structure
            return {
                "goal": user_input,
                "goal_type": "task",
                "requires_tools": False,
                "steps": [{"step_num": 1, "objective": "Process request"}],
                "success_criteria": "Request handled",
                "reasoning": "Could not parse plan"
            }
        except Exception as e:
            self.logger.error(f"Unexpected error in _parse_plan_response: {type(e).__name__}: {e}", component="planner")
            raise


# =============================================================================
# EXECUTOR: Runs plans step by step
# =============================================================================

class Executor:
    """
    Executes plans and tracks what actually happened.

    Key difference from current approach: we're executing against a PLAN
    with known success criteria, not just reacting to LLM tool calls.
    """

    def __init__(
        self,
        llm: LLMAdapter,
        tool_registry: ToolRegistry,
        max_tool_calls: int = 5
    ):
        self.llm = llm
        self.tool_registry = tool_registry
        self.max_tool_calls = max_tool_calls
        self.logger = get_logger()
        self.exec_logger = get_execution_logger()

    def execute(
        self,
        plan: Plan,
        messages: List[Message],
        tools: List[Any],
        req_id: Optional[str] = None,
        exec_id: Optional[str] = None
    ) -> ExecutionTrace:
        """
        Execute a plan and return trace of what happened.
        """
        trace = ExecutionTrace(
            plan=plan,
            steps_executed=[]
        )

        start_time = time.time()
        plan.status = PlanStatus.IN_PROGRESS

        try:
            if not plan.requires_tools:
                # Simple execution - just get LLM response
                response = self.llm.complete(messages, tools=None)
                trace.llm_calls += 1
                trace.final_response = response.content

                # Mark plan step as completed
                if plan.steps:
                    plan.steps[0].status = PlanStatus.COMPLETED
                    plan.steps[0].result = response.content
                    trace.steps_executed = plan.steps.copy()
            else:
                # Tool-based execution
                trace = self._execute_with_tools(
                    plan,
                    messages,
                    tools,
                    trace,
                    req_id=req_id,
                    exec_id=exec_id
                )

                # Determine overall plan status
                if trace.all_steps_succeeded:
                    plan.status = PlanStatus.COMPLETED
                elif trace.had_failures:
                    plan.status = PlanStatus.PARTIAL if trace.final_response else PlanStatus.FAILED
                else:
                    plan.status = PlanStatus.COMPLETED

        except Exception as e:
            self.logger.error(f"Execution failed: {e}", component="executor")
            plan.status = PlanStatus.FAILED
            trace.final_response = f"Execution error: {str(e)}"

        trace.total_duration_ms = (time.time() - start_time) * 1000
        return trace

    def _execute_with_tools(
        self,
        plan: Plan,
        messages: List[Message],
        tools: List[Any],
        trace: ExecutionTrace,
        req_id: Optional[str] = None,
        exec_id: Optional[str] = None
    ) -> ExecutionTrace:
        """Execute plan that requires tools"""

        tool_calls_made = 0
        current_step_idx = 0

        # Initial LLM call
        response = self.llm.complete(messages, tools=tools)
        trace.llm_calls += 1

        while response.has_tool_calls and tool_calls_made < self.max_tool_calls:
            for tool_call in response.tool_calls:
                if tool_calls_made >= self.max_tool_calls:
                    break

                # Log tool start
                self.logger.tool_call_start([{
                    "name": tool_call.name,
                    "params": tool_call.arguments
                }])

                # Execute tool
                start = time.time()
                result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)
                duration_ms = (time.time() - start) * 1000

                trace.tool_calls += 1
                tool_calls_made += 1

                # Log result
                if result.is_success:
                    self.logger.tool_call_end(tool_call.name, True, duration_ms, str(result.output)[:100])
                else:
                    trace.tool_failures += 1
                    self.logger.tool_call_end(tool_call.name, False, duration_ms, result.error)

                # Track in plan step if we can match it
                if current_step_idx < len(plan.steps):
                    step = plan.steps[current_step_idx]
                    step.status = PlanStatus.COMPLETED if result.is_success else PlanStatus.FAILED
                    step.result = result.output if result.is_success else None
                    step.error = result.error if not result.is_success else None
                    step.duration_ms = duration_ms
                    trace.steps_executed.append(step)

                    # ========== LOG EXECUTION STEP ==========
                    if req_id and exec_id:
                        step_id = f"step-{step.step_num}"

                        # Log execution context before execution
                        self.exec_logger.log_execution_context(
                            req_id=req_id,
                            exec_id=exec_id,
                            step_id=step_id,
                            step_num=step.step_num,
                            step_objective=step.objective,
                            tool_hint=step.tool_hint,
                            messages=[{"role": m.role.value, "content": m.content[:200] if m.content else ""} for m in messages[-3:]],  # Last 3 messages
                            available_tools=[t.get("function", {}).get("name", "unknown") if isinstance(t, dict) else str(t) for t in tools[:5]],  # First 5 tools
                            dependencies=step.depends_on
                        )

                        # Log step execution result
                        status = "completed" if result.is_success else "failed"
                        failure_mode = None
                        if not result.is_success:
                            if "timeout" in str(result.error).lower():
                                failure_mode = "timeout"
                            elif "permission" in str(result.error).lower():
                                failure_mode = "permission_error"
                            elif result.metadata and result.metadata.get("status") == ToolStatus.DISABLED:
                                failure_mode = "tool_disabled"
                            else:
                                failure_mode = "tool_execution_failed"

                        self.exec_logger.log_execution_step(
                            req_id=req_id,
                            exec_id=exec_id,
                            step_id=step_id,
                            step_num=step.step_num,
                            status=status,
                            step_objective=step.objective,
                            tool_used=tool_call.name,
                            tool_result=result.output if result.is_success else None,
                            error=result.error if not result.is_success else None,
                            failure_mode=failure_mode,
                            duration_ms=duration_ms
                        )

                    current_step_idx += 1

                # Add to messages
                messages.append(Message(
                    role=MessageRole.ASSISTANT,
                    content=response.content or "",
                    tool_calls=[{
                        "id": tool_call.id,
                        "type": "function",
                        "function": {"name": tool_call.name, "arguments": json.dumps(tool_call.arguments)}
                    }]
                ))
                messages.append(Message(
                    role=MessageRole.TOOL,
                    content=str(result.output if result.is_success else f"Error: {result.error}")[:2000],
                    tool_call_id=tool_call.id,
                    name=tool_call.name
                ))

            # Get next response
            if tool_calls_made < self.max_tool_calls:
                response = self.llm.complete(messages, tools=tools)
                trace.llm_calls += 1
            else:
                # Force final answer
                response = self.llm.complete(messages, tools=None)
                trace.llm_calls += 1

        trace.final_response = response.content
        return trace


# =============================================================================
# REFLECTOR: Evaluates execution against goals
# =============================================================================

class Reflector:
    """
    Evaluates execution against the original goal.

    This is the key to avoiding silent failures - we explicitly check
    if we accomplished what the user actually wanted.
    """

    def __init__(self, llm: LLMAdapter):
        self.llm = llm
        self.logger = get_logger()

    def reflect(self, plan: Plan, trace: ExecutionTrace) -> Reflection:
        """
        Evaluate if the plan's goal was actually achieved.
        """
        # Fast path: obvious failures
        if trace.final_response is None or not trace.final_response.strip():
            return Reflection(
                plan_goal=plan.goal,
                goal_achieved=False,
                confidence=1.0,
                evidence=["No response generated"],
                gaps=["Execution produced no output"],
                suggestions=["Retry with different approach"]
            )

        # Fast path: all tools failed
        if trace.tool_calls > 0 and trace.tool_failures == trace.tool_calls:
            return Reflection(
                plan_goal=plan.goal,
                goal_achieved=False,
                confidence=0.95,
                evidence=[f"All {trace.tool_calls} tool calls failed"],
                gaps=["Could not execute any tools successfully"],
                suggestions=["Check tool parameters", "Try alternative tools"],
                should_retry=True
            )

        # For simple questions, trust the response
        if plan.goal_type == "question" and not plan.requires_tools:
            return Reflection(
                plan_goal=plan.goal,
                goal_achieved=True,
                confidence=0.9,
                evidence=["Direct answer provided"],
                gaps=[],
                suggestions=[]
            )

        # For complex tasks, use LLM to evaluate
        return self._llm_reflect(plan, trace)

    def _llm_reflect(self, plan: Plan, trace: ExecutionTrace) -> Reflection:
        """Use LLM to evaluate complex task completion"""
        prompt = REFLECTION_PROMPT.format(
            goal=plan.goal,
            success_criteria=plan.success_criteria.description,
            tool_calls=trace.tool_calls,
            tool_failures=trace.tool_failures,
            steps_completed=len([s for s in trace.steps_executed if s.status == PlanStatus.COMPLETED]),
            total_steps=len(plan.steps),
            response=trace.final_response[:1500] if trace.final_response else "(no response)"
        )

        messages = [
            Message(MessageRole.SYSTEM, "You evaluate task completion. Be honest and critical. Output JSON."),
            Message(MessageRole.USER, prompt)
        ]

        try:
            response = self.llm.complete(messages)
            eval_data = self._parse_reflection(response.content)

            return Reflection(
                plan_goal=plan.goal,
                goal_achieved=eval_data.get("goal_achieved", False),
                confidence=eval_data.get("confidence", 0.5),
                evidence=eval_data.get("evidence", []),
                gaps=eval_data.get("gaps", []),
                suggestions=eval_data.get("suggestions", []),
                should_retry=not eval_data.get("goal_achieved", True) and trace.tool_failures > 0
            )
        except Exception as e:
            self.logger.error(f"Reflection failed: {e}", component="reflector")
            # Fallback: use heuristics
            success = trace.tool_failures == 0 and trace.final_response and len(trace.final_response) > 20
            return Reflection(
                plan_goal=plan.goal,
                goal_achieved=success,
                confidence=0.6,
                evidence=["Heuristic evaluation"],
                gaps=[] if success else ["Could not verify goal completion"],
                suggestions=[]
            )

    def _parse_reflection(self, content: str) -> Dict[str, Any]:
        """Parse reflection JSON from LLM response"""
        try:
            if "```json" in content:
                json_str = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                json_str = content.split("```")[1].split("```")[0]
            else:
                json_str = content
            return json.loads(json_str.strip())
        except (json.JSONDecodeError, IndexError):
            return {"goal_achieved": False, "confidence": 0.3, "evidence": ["Parse error"]}
