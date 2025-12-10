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
from .tool_registry import ToolRegistry, ToolResult, ToolStatus
from .logger import get_logger
from .agent_execution_logger import get_execution_logger


@dataclass
class ToolCallRecord:
    """Record of a single tool call made during step execution"""
    tool_name: str
    arguments: Dict[str, Any]
    result: ToolResult
    duration_ms: float
    timestamp: float


@dataclass
class StepContext:
    """
    Accumulated context during step execution.

    A step may involve multiple tool calls and reasoning rounds.
    This captures everything that happened within the step.
    """
    tool_calls_made: List[ToolCallRecord] = field(default_factory=list)
    tool_results: Dict[str, Any] = field(default_factory=dict)  # tool_name -> last result
    intermediate_reasoning: List[str] = field(default_factory=list)
    validation_checks: Dict[str, bool] = field(default_factory=dict)
    accumulated_data: Dict[str, Any] = field(default_factory=dict)  # Step's working memory

    def add_tool_result(self, tool_name: str, result: ToolResult):
        """Store tool result for this step"""
        self.tool_results[tool_name] = result

        # Could extract structured data based on tool type
        if result.is_success and result.output:
            # Store in accumulated_data with a key based on tool name
            key = f"{tool_name}_output"
            if key not in self.accumulated_data:
                self.accumulated_data[key] = []
            self.accumulated_data[key].append(result.output)

    def has_required_data(self, required: List[str]) -> bool:
        """Check if step has all required data in accumulated_data"""
        return all(key in self.accumulated_data for key in required)


@dataclass
class ValidationResult:
    """Result of validating a step's success criteria"""
    passed: bool
    details: str
    confidence: float = 1.0


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
    automated_checks: Optional[Dict[str, Any]] = None  # Automated validation config


@dataclass
class PlanStep:
    """
    A single step in an execution plan.

    A step is a unit of work (sub-goal), not a single tool call.
    It may involve 0-N tool calls plus reasoning to achieve its objective.
    """
    step_num: int
    objective: str                        # What this step should accomplish

    # Guidance (not strict requirements)
    tool_hint: Optional[str] = None       # Suggested primary tool
    tool_args_hint: Optional[Dict] = None # Suggested arguments

    # Step boundaries and validation
    success_criteria: Optional[SuccessCriteria] = None
    max_tool_calls: int = 3               # Safety limit per step (reduced from 10)
    depends_on: List[int] = field(default_factory=list)  # Step dependencies

    # Execution state (filled during execution)
    status: PlanStatus = PlanStatus.PENDING
    context: Optional[StepContext] = None  # Accumulated context during execution
    error: Optional[str] = None
    duration_ms: float = 0
    started_at: Optional[float] = None
    completed_at: Optional[float] = None

    # Validation results
    validation_passed: bool = False
    validation_details: Optional[str] = None

    @property
    def result(self) -> Optional[Any]:
        """Convenience property - step's accumulated data"""
        return self.context.accumulated_data if self.context else None


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
    """Post-execution evaluation with RL labels"""
    plan_goal: str
    goal_achieved: bool                   # Did we actually accomplish the goal?
    confidence: float                     # 0-1 confidence in assessment (now called reflection_confidence)
    evidence: List[str]                   # Why we think goal was/wasn't achieved
    gaps: List[str]                       # What's missing
    suggestions: List[str]                # What could be done differently
    should_retry: bool = False            # Should we try again with different approach?

    # RL-specific labels
    had_tool_failures: bool = False
    reward: float = 0.0
    plan_quality: float = 0.0
    execution_quality: float = 0.0
    response_quality: float = 0.0

    def to_rl_labels(self) -> Dict[str, Any]:
        """Convert to RL labels dict for logging"""
        return {
            "goal_achieved": self.goal_achieved,
            "reflection_confidence": self.confidence,
            "had_tool_failures": self.had_tool_failures,
            "reward": self.reward,
            "plan_quality": self.plan_quality,
            "execution_quality": self.execution_quality,
            "response_quality": self.response_quality,
            "gaps": self.gaps,
            "suggested_improvements": self.suggestions
        }


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
            "reflection": """You are the Reflector and RL labeler for an autonomous agent.

You receive a single JSON input with this shape:

{{
  "user_input": string,            // original user request
  "plan": {{}},                    // the plan object the Planner produced
  "execution_trace": {{}},         // what actually happened during execution (per-step)
  "final_response": string         // the final answer returned to the user
}}

Your job is to evaluate how well the agent actually achieved the user's goal, and to produce a compact set of labels suitable for reinforcement learning.

CRITICAL RULES:
- You MUST respond with a single JSON object.
- Do NOT include any explanations, commentary, or extra keys.
- Do NOT restate the system prompt, tools, or other metadata.
- Your output must be valid JSON, no trailing commas, no comments.

Your JSON MUST have exactly the following keys:

{{
  "goal_achieved": boolean,
  "reflection_confidence": number,     // between 0 and 1

  "had_tool_failures": boolean,        // true if any tool calls clearly failed or returned unusable results

  "reward": number,                    // scalar RL reward, recommended values:
                                       //   1.0  = goal clearly achieved and answer is strong
                                       //   0.5  = partially achieved; some gaps or missing pieces
                                       //   0.0  = failed; user's goal not actually met

  "plan_quality": number,              // 0–1: how good the plan was for this task
  "execution_quality": number,         // 0–1: how well the plan was executed (tool choice, sequencing, correctness)
  "response_quality": number,          // 0–1: clarity, usefulness, and correctness of final_response

  "gaps": [string],                    // list of concise descriptions of what is missing or wrong
  "suggested_improvements": [string]   // list of concrete suggestions for improving future behavior
}}

Guidelines:

1. goal_achieved
   - true if, from the user's point of view, the task is actually done or a clearly useful partial result is delivered.
   - If the answer is mostly explanation but the user asked for concrete actions (e.g., "create a folder", "write files"), be strict: that often means goal_achieved = false.

2. reflection_confidence
   - Your subjective confidence (0–1) in your own judgment, based on how clear the plan and execution_trace are.

3. had_tool_failures
   - true if tools returned errors, obviously wrong outputs, or the agent ignored critical tool failures.

4. reward
   - 1.0: task clearly done, no serious gaps.
   - 0.5: partially done or mostly correct but with meaningful missing pieces.
   - 0.0: not done, incoherent, or seriously wrong.

5. plan_quality, execution_quality, response_quality
   - Score each independently from 0 to 1.
   - Use 0.2 increments if you're unsure (e.g., 0.0, 0.2, 0.4, 0.6, 0.8, 1.0).

6. gaps and suggested_improvements
   - Keep items short and concrete.
   - Focus on things that can actually be improved by an RL policy: better tool choices, ordering, thoroughness, checking for missing actions, etc.

Again: Output ONLY the JSON object with these keys. No markdown, no natural language, no extra wrapping text."""
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
        exec_id: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None
    ) -> Plan:
        """
        Create an execution plan for the user's request.

        For simple requests, this is fast (pattern matching).
        For complex requests, uses LLM to decompose.

        IMPORTANT: If budget constraints are provided, the plan MUST fit within them.
        If the task cannot be completed within budget, we fail fast with a clear error.

        Args:
            user_input: The user's request
            context: Optional additional context
            tier: Execution tier (simple/standard/advanced)
            exec_id: Execution ID for logging
            budget: Budget constraints from router (max_tool_calls, max_tokens, max_steps)
        """
        # Fast path: detect simple patterns that don't need LLM planning
        simple_plan = self._try_simple_plan(user_input)
        if simple_plan:
            # Validate plan fits within budget constraints
            if budget:
                validation = self._validate_plan_budget(simple_plan, budget, tier)
                if not validation["fits"]:
                    self.logger.warning(
                        f"Plan exceeds {tier} budget: {validation['reason']}",
                        component="planner"
                    )
                    # Return a budget-exceeded plan that will fail fast
                    return self._create_budget_exceeded_plan(
                        user_input, budget, tier, validation["reason"]
                    )
            self.logger.debug(f"Using simple plan for: {user_input[:50]}", component="planner")
            return simple_plan

        # Complex path: use LLM to create plan
        plan = self._create_llm_plan(user_input, context, tier)

        # Validate LLM-generated plan fits within budget
        if budget:
            validation = self._validate_plan_budget(plan, budget, tier)
            if not validation["fits"]:
                self.logger.warning(
                    f"LLM plan exceeds {tier} budget: {validation['reason']}",
                    component="planner"
                )
                # Return a budget-exceeded plan that will fail fast
                return self._create_budget_exceeded_plan(
                    user_input, budget, tier, validation["reason"]
                )

        return plan

    def _validate_plan_budget(
        self,
        plan: Plan,
        budget: Dict[str, int],
        tier: str
    ) -> Dict[str, Any]:
        """
        Validate that a plan fits within budget constraints.

        Returns dict with:
          - fits: bool
          - reason: str (if doesn't fit)
        """
        max_tool_calls = budget.get("max_tool_calls", 999)
        max_steps = budget.get("max_steps", 999)

        # Count tools needed
        tools_needed = sum(1 for s in plan.steps if s.tool_hint)
        steps_needed = len(plan.steps)

        if tools_needed > max_tool_calls:
            return {
                "fits": False,
                "reason": f"Plan requires {tools_needed} tools but {tier} tier allows max {max_tool_calls}"
            }

        if steps_needed > max_steps:
            return {
                "fits": False,
                "reason": f"Plan requires {steps_needed} steps but {tier} tier allows max {max_steps}"
            }

        # For simple tier, NO tools should be used
        if tier == "simple" and plan.requires_tools:
            return {
                "fits": False,
                "reason": f"Simple tier cannot use tools, but plan requires: {[s.tool_hint for s in plan.steps if s.tool_hint]}"
            }

        return {"fits": True, "reason": None}

    def _create_budget_exceeded_plan(
        self,
        user_input: str,
        budget: Dict[str, int],
        tier: str,
        reason: str
    ) -> Plan:
        """
        Create a plan that immediately fails due to budget constraints.

        This is better than attempting execution and failing mid-way.
        The agent should recognize this and return a clear error.
        """
        return Plan(
            goal=f"BUDGET_EXCEEDED: {user_input[:100]}",
            goal_type="error",
            steps=[
                PlanStep(
                    step_num=1,
                    objective=f"Return error: Task cannot be completed within {tier} tier budget",
                    tool_hint=None,
                    success_criteria=SuccessCriteria(
                        description="Inform user of budget constraints"
                    )
                )
            ],
            success_criteria=SuccessCriteria(
                description="User informed of budget limitation"
            ),
            estimated_complexity=tier,
            requires_tools=False,
            reasoning=f"BUDGET_EXCEEDED: {reason}. Consider re-routing to a higher tier.",
            status=PlanStatus.FAILED  # Mark as already failed
        )

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
            "search", "look up", "find information", "google", "check online"
        ])
        # File/folder creation/modification keywords
        is_creation_task = any(kw in input_lower for kw in [
            "create file", "write file", "create folder", "make folder", "mkdir",
            "create directory", "build", "generate", "set up", "initialize",
            "instantiate", "implement"
        ])
        needs_files = any(kw in input_lower for kw in [
            "read file", "open file", "save", "delete file", "edit file", "modify"
        ])

        if is_simple_question and not needs_realtime and not needs_search and not needs_files and not is_creation_task:
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

        # Search/lookup requests (but NOT creation tasks)
        if (needs_search or needs_realtime) and not is_creation_task and not needs_files:
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
        # This includes creation tasks, file operations, and complex requests
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
                    # Create StepContext to store result (result is a read-only property)
                    plan.steps[0].context = StepContext(
                        accumulated_data={"response": response.content}
                    )
                    trace.steps_executed = plan.steps.copy()
            else:
                # Step-by-step execution
                trace = self._execute_plan_stepwise(
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

    def _execute_plan_stepwise(
        self,
        plan: Plan,
        messages: List[Message],
        tools: List[Any],
        trace: ExecutionTrace,
        req_id: Optional[str] = None,
        exec_id: Optional[str] = None
    ) -> ExecutionTrace:
        """
        Execute plan step-by-step.

        Each step is a unit of work that may involve multiple tool calls.
        We execute steps sequentially, respecting dependencies.
        """

        for step in plan.steps:
            # Check dependencies
            if not self._dependencies_met(step, plan.steps):
                step.status = PlanStatus.FAILED
                step.error = f"Dependencies not satisfied: {step.depends_on}"
                self.logger.error(f"Step {step.step_num} failed: dependencies not met", component="executor")
                trace.steps_executed.append(step)
                continue

            # Execute the step
            self._execute_step(step, messages, tools, trace, req_id, exec_id)
            trace.steps_executed.append(step)

            # Stop if critical step failed and no response yet
            if step.status == PlanStatus.FAILED and not trace.final_response:
                self.logger.error(f"Step {step.step_num} failed, stopping execution", component="executor")
                break

        # Get final response if we haven't already
        if not trace.final_response:
            response = self.llm.complete(messages, tools=None)
            trace.llm_calls += 1
            trace.final_response = response.content

        return trace

    def _execute_step(
        self,
        step: PlanStep,
        messages: List[Message],
        tools: List[Any],
        trace: ExecutionTrace,
        req_id: Optional[str] = None,
        exec_id: Optional[str] = None
    ):
        """
        Execute a single step (may involve multiple tool calls).

        A step is complete when:
        1. LLM stops requesting tools (has final answer), OR
        2. max_tool_calls reached for this step, OR
        3. Step validation passes
        """

        step.status = PlanStatus.IN_PROGRESS
        step.started_at = time.time()
        step.context = StepContext()

        self.logger.info(f"Starting step {step.step_num}: {step.objective}", component="executor")

        # Add step guidance to help LLM focus
        step_guidance = self._create_step_guidance(step)
        messages_with_guidance = messages.copy()
        messages_with_guidance.append(Message(
            role=MessageRole.SYSTEM,
            content=step_guidance
        ))

        # Log execution context
        if req_id and exec_id:
            step_id = f"step-{step.step_num}"
            # Extract tool names from tools list
            tool_names = []
            for t in tools[:5]:
                if isinstance(t, dict):
                    tool_names.append(t.get("function", {}).get("name", "unknown"))
                else:
                    tool_names.append(str(t))

            self.exec_logger.log_execution_context(
                req_id=req_id,
                exec_id=exec_id,
                step_id=step_id,
                step_num=step.step_num,
                step_objective=step.objective,
                tool_hint=step.tool_hint,
                messages=[{"role": m.role.value, "content": m.content[:200] if m.content else ""} for m in messages[-3:]],
                available_tools=tool_names,
                system_prompt_id="executor_step_guidance_v1",  # Fixed ID for step guidance
                tool_manifest_id="runtime_tools_v1",  # ID for runtime tool set
                dependencies=step.depends_on
            )

        tool_calls_in_step = 0
        step_complete = False
        tool_hint_executed = False  # Track if the suggested tool was called

        # Execute until step completes or hits limit
        while not step_complete and tool_calls_in_step < step.max_tool_calls:
            response = self.llm.complete(messages_with_guidance, tools=tools)
            trace.llm_calls += 1

            if not response.has_tool_calls:
                # LLM thinks step is done (no more tools needed)
                step_complete = True
                trace.final_response = response.content
                break

            # Process all tool calls in this LLM response
            for tool_call in response.tool_calls:
                if tool_calls_in_step >= step.max_tool_calls:
                    break

                # Log tool start
                self.logger.tool_call_start([{
                    "name": tool_call.name,
                    "params": tool_call.arguments
                }])

                # Execute tool
                start_time = time.time()
                result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)
                duration_ms = (time.time() - start_time) * 1000

                # Record in step context
                record = ToolCallRecord(
                    tool_name=tool_call.name,
                    arguments=tool_call.arguments,
                    result=result,
                    duration_ms=duration_ms,
                    timestamp=time.time()
                )
                step.context.tool_calls_made.append(record)
                step.context.add_tool_result(tool_call.name, result)

                tool_calls_in_step += 1
                trace.tool_calls += 1

                # Check if this was the suggested tool and it succeeded
                if step.tool_hint and tool_call.name == step.tool_hint and result.is_success:
                    tool_hint_executed = True

                # Log result
                if result.is_success:
                    self.logger.tool_call_end(tool_call.name, True, duration_ms, str(result.output)[:100])
                else:
                    trace.tool_failures += 1
                    self.logger.tool_call_end(tool_call.name, False, duration_ms, result.error)

                # Add to conversation
                messages_with_guidance.append(Message(
                    role=MessageRole.ASSISTANT,
                    content=response.content or "",
                    tool_calls=[{
                        "id": tool_call.id,
                        "type": "function",
                        "function": {"name": tool_call.name, "arguments": json.dumps(tool_call.arguments)}
                    }]
                ))
                messages_with_guidance.append(Message(
                    role=MessageRole.TOOL,
                    content=str(result.output if result.is_success else f"Error: {result.error}")[:2000],
                    tool_call_id=tool_call.id,
                    name=tool_call.name
                ))

                # Update main messages too (for next step)
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

            # HEURISTIC: If the suggested tool was executed successfully, consider step complete
            # This prevents the LLM from looping on the same tool repeatedly
            if tool_hint_executed and tool_calls_in_step >= 1:
                self.logger.debug(
                    f"Step {step.step_num}: Suggested tool '{step.tool_hint}' executed successfully. Marking step complete.",
                    component="executor"
                )
                step_complete = True
                # Generate a final response summarizing the step
                final_response = self.llm.complete(
                    messages_with_guidance + [Message(
                        MessageRole.SYSTEM,
                        "The step objective has been achieved. Provide a brief 1-sentence summary of what was accomplished. Do NOT call more tools."
                    )],
                    tools=None  # No tools for final summary
                )
                trace.llm_calls += 1
                trace.final_response = final_response.content
                break

        # Finalize step
        step.completed_at = time.time()
        step.duration_ms = (step.completed_at - step.started_at) * 1000

        # Determine step status
        if step_complete:
            step.status = PlanStatus.COMPLETED
        elif tool_calls_in_step >= step.max_tool_calls:
            step.status = PlanStatus.PARTIAL
            step.error = f"Max tool calls ({step.max_tool_calls}) reached before step completion"
        else:
            step.status = PlanStatus.FAILED
            step.error = "Step did not complete"

        # Validate step if criteria defined
        if step.success_criteria:
            validation = self._validate_step(step)
            step.validation_passed = validation.passed
            step.validation_details = validation.details

            if not validation.passed:
                step.status = PlanStatus.FAILED
                step.error = f"Validation failed: {validation.details}"

        # Log execution step result
        if req_id and exec_id:
            step_id = f"step-{step.step_num}"
            status = "completed" if step.status == PlanStatus.COMPLETED else "failed"
            failure_mode = None

            if step.status != PlanStatus.COMPLETED:
                if "dependencies" in str(step.error).lower():
                    failure_mode = "dependency_failed"
                elif "max tool calls" in str(step.error).lower():
                    failure_mode = "max_tool_calls_exceeded"
                elif "validation" in str(step.error).lower():
                    failure_mode = "validation_failed"
                else:
                    failure_mode = "step_execution_failed"

            # Log with detailed action and result
            if step.context.tool_calls_made:
                # Use the first tool call as representative
                first_call = step.context.tool_calls_made[0]
                self.exec_logger.log_execution_step(
                    req_id=req_id,
                    exec_id=exec_id,
                    step_id=step_id,
                    step_num=step.step_num,
                    status=status,
                    step_objective=step.objective,
                    tool_name=first_call.tool_name,
                    tool_args=first_call.arguments,
                    tool_success=first_call.result.is_success,
                    tool_output=first_call.result.output,
                    tool_error=first_call.result.error,
                    error=step.error,
                    failure_mode=failure_mode,
                    duration_ms=step.duration_ms
                )
            else:
                # No tools used
                self.exec_logger.log_execution_step(
                    req_id=req_id,
                    exec_id=exec_id,
                    step_id=step_id,
                    step_num=step.step_num,
                    status=status,
                    step_objective=step.objective,
                    error=step.error,
                    failure_mode=failure_mode,
                    duration_ms=step.duration_ms
                )

        self.logger.info(
            f"Step {step.step_num} {step.status.value}: {step.objective} "
            f"({tool_calls_in_step} tool calls, {step.duration_ms:.0f}ms)",
            component="executor"
        )

    def _create_step_guidance(self, step: PlanStep) -> str:
        """Create system message to guide LLM for this specific step"""
        guidance = f"""You are currently executing Step {step.step_num} of a multi-step plan.

STEP OBJECTIVE: {step.objective}

SUCCESS CRITERIA: {step.success_criteria.description if step.success_criteria else "Complete the objective"}

CRITICAL: This is a SINGLE FOCUSED STEP. Once you have the information or have executed the necessary action, respond with a brief summary WITHOUT calling more tools. Do not repeat tool calls.

"""

        if step.tool_hint:
            guidance += f"SUGGESTED ACTION: Call {step.tool_hint}"
            if step.tool_args_hint:
                guidance += f" with args: {json.dumps(step.tool_args_hint)}"
            guidance += f"\nAfter calling {step.tool_hint} successfully, provide a brief summary of the result and move on. Do NOT call additional tools unless absolutely necessary.\n"
        else:
            guidance += "This step is reasoning/synthesis only - no tools needed. Provide your analysis and move on.\n"

        return guidance

    def _validate_step(self, step: PlanStep) -> ValidationResult:
        """Validate if step achieved its success criteria"""
        if not step.success_criteria:
            return ValidationResult(passed=True, details="No criteria specified")

        criteria = step.success_criteria

        # Check required outputs exist
        if criteria.required_outputs:
            missing_outputs = []
            for required in criteria.required_outputs:
                if not step.context or required not in step.context.accumulated_data:
                    missing_outputs.append(required)

            if missing_outputs:
                return ValidationResult(
                    passed=False,
                    details=f"Missing required outputs: {missing_outputs}",
                    confidence=1.0
                )

        # Run automated checks if defined
        if criteria.automated_checks:
            for check_name, check_config in criteria.automated_checks.items():
                if check_name == "min_items":
                    # Check if any accumulated data has minimum number of items
                    min_count = check_config
                    total_items = sum(len(v) if isinstance(v, list) else 1 for v in step.context.accumulated_data.values())
                    if total_items < min_count:
                        return ValidationResult(
                            passed=False,
                            details=f"Expected at least {min_count} items, got {total_items}",
                            confidence=1.0
                        )

        # Basic validation passed
        return ValidationResult(
            passed=True,
            details="All required outputs present" if criteria.required_outputs else "Step completed",
            confidence=0.8  # Could use LLM for higher confidence
        )

    def _dependencies_met(self, step: PlanStep, all_steps: List[PlanStep]) -> bool:
        """Check if step's dependencies are completed"""
        if not step.depends_on:
            return True

        for dep_num in step.depends_on:
            dep_step = next((s for s in all_steps if s.step_num == dep_num), None)
            if not dep_step or dep_step.status != PlanStatus.COMPLETED:
                return False

        return True


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
        """Use LLM to evaluate complex task completion with RL labeling"""
        # Build structured input for the Reflector
        reflector_input = {
            "user_input": plan.goal,  # Using plan.goal as user_input proxy
            "plan": {
                "goal": plan.goal,
                "goal_type": plan.goal_type,
                "requires_tools": plan.requires_tools,
                "steps": [
                    {
                        "step_num": s.step_num,
                        "objective": s.objective,
                        "status": s.status.value
                    }
                    for s in plan.steps
                ],
                "success_criteria": plan.success_criteria.description
            },
            "execution_trace": {
                "tool_calls": trace.tool_calls,
                "tool_failures": trace.tool_failures,
                "steps_completed": len([s for s in trace.steps_executed if s.status == PlanStatus.COMPLETED]),
                "total_steps": len(plan.steps),
                "all_steps_succeeded": trace.all_steps_succeeded
            },
            "final_response": trace.final_response[:1500] if trace.final_response else "(no response)"
        }

        messages = [
            Message(MessageRole.SYSTEM, REFLECTION_PROMPT),
            Message(MessageRole.USER, json.dumps(reflector_input))
        ]

        try:
            response = self.llm.complete(messages)
            eval_data = self._parse_reflection(response.content)

            return Reflection(
                plan_goal=plan.goal,
                goal_achieved=eval_data.get("goal_achieved", False),
                confidence=eval_data.get("reflection_confidence", 0.5),
                evidence=[],  # Not in new format
                gaps=eval_data.get("gaps", []),
                suggestions=eval_data.get("suggested_improvements", []),
                should_retry=not eval_data.get("goal_achieved", True) and trace.tool_failures > 0,
                had_tool_failures=eval_data.get("had_tool_failures", trace.tool_failures > 0),
                reward=eval_data.get("reward", 0.0),
                plan_quality=eval_data.get("plan_quality", 0.0),
                execution_quality=eval_data.get("execution_quality", 0.0),
                response_quality=eval_data.get("response_quality", 0.0)
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
                suggestions=[],
                had_tool_failures=trace.tool_failures > 0,
                reward=1.0 if success else 0.0,
                plan_quality=0.5,
                execution_quality=0.5 if success else 0.2,
                response_quality=0.5 if success else 0.2
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
