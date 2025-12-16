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
from typing import Dict, Any, Optional, List, Callable
from enum import Enum
from concurrent.futures import ThreadPoolExecutor, as_completed

from util.llm_adapter import LLMAdapter, Message, MessageRole, LLMResponse, ToolCall
from .tool_registry import ToolRegistry, ToolResult, ToolStatus
# NO logger imports - Planner/Executor/Reflector don't log, Agent does


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


class PlanPhase(Enum):
    """Execution phase for a plan step"""
    DISCOVERY = "discovery"
    EXECUTION = "execution"


@dataclass
class SuccessCriteria:
    """Defines what success looks like for a step or plan"""
    description: str                      # Human-readable success condition
    required_outputs: List[str] = field(default_factory=list)  # What must be produced
    validation_hints: List[str] = field(default_factory=list)  # How to validate
    automated_checks: Optional[Dict[str, Any]] = None  # Automated validation config


@dataclass
class StepResult:
    """
    Result from executing a single step.

    Returned by Executor - does NOT mutate the original PlanStep.
    Agent interprets this result and updates plan state accordingly.
    """
    step_num: int
    status: PlanStatus
    tool_calls_made: List[ToolCallRecord] = field(default_factory=list)
    llm_messages: List[Message] = field(default_factory=list)  # Messages to append to conversation
    accumulated_data: Dict[str, Any] = field(default_factory=dict)  # Step's working memory
    final_response: Optional[str] = None  # If step generated final response
    error: Optional[str] = None  # Error message if step failed
    duration_ms: float = 0
    phase: PlanPhase = PlanPhase.EXECUTION
    context: Optional[StepContext] = None

    # Validation results (can be filled by Agent after executor returns)
    validation_passed: bool = False
    validation_details: Optional[str] = None


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
    phase: PlanPhase = PlanPhase.EXECUTION              # Discovery vs execution phase

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
    discovery_plan: List[PlanStep] = field(default_factory=list)
    execution_plan: List[PlanStep] = field(default_factory=list)
    discovery_required: bool = True
    assumptions: List[str] = field(default_factory=list)

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
                    "status": s.status.value,
                    "phase": s.phase.value
                }
                for s in self.steps
            ],
            "success_criteria": self.success_criteria.description,
            "complexity": self.estimated_complexity,
            "requires_tools": self.requires_tools,
            "discovery_required": self.discovery_required,
            "assumptions": self.assumptions
        }


@dataclass
class ExecutionTrace:
    """Record of what happened during execution"""
    plan: Plan
    step_results: List[StepResult] = field(default_factory=list)  # Results from executor
    llm_calls: int = 0
    tool_calls: int = 0
    tool_failures: int = 0
    final_response: Optional[str] = None
    total_duration_ms: float = 0

    # Legacy accessor for backwards compatibility during migration
    @property
    def steps_executed(self) -> List[StepResult]:
        """Alias for step_results - for backwards compatibility"""
        return self.step_results

    @property
    def had_failures(self) -> bool:
        return self.tool_failures > 0

    @property
    def all_steps_succeeded(self) -> bool:
        return all(s.status == PlanStatus.COMPLETED for s in self.step_results)


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
            "planning": """You are a ruthless planning assistant obsessed with user intent.

MANDATORY STRUCTURE:
- Always create TWO explicit plans: a discovery plan (what to inspect/measure) and an execution plan (what to build/change after discovery).
- Discovery is required for every real task involving code/files/systems. Only skip when the request is trivially self-contained (e.g., factual question already answerable from memory).
- Be explicit about assumptions; list them upfront so the executor can challenge them later if evidence contradicts them.

Your job:
1. Clarify what the user truly needs.
2. Define the discovery steps necessary to understand the context (repo layout, configs, relevant files, constraints, reproduction steps, etc.).
3. Define the execution steps that use discovery evidence to implement/answer.
4. Describe success criteria and explicit assumptions.

Respond with valid JSON:
```json
{{
  "goal": "Clear statement of what user wants to achieve",
  "goal_type": "question|task|creation|search",
  "requires_tools": true/false,
  "discovery_plan": [
    {{
      "step_num": 1,
      "objective": "Very concrete discovery action (e.g., inspect repo root, read config file, run tests)",
      "tool_hint": "list_files|file_read|search_filesystem|bash_execute|python_execute|null",
      "tool_args_hint": {{"arg": "value"}} or null,
      "success_criteria": {{
        "description": "What evidence must be collected",
        "required_outputs": ["list_files_output"],
        "validation_hints": ["ls output includes project directories"]
      }}
    }}
  ],
  "execution_plan": [
    {{
      "step_num": 1,
      "objective": "Concrete change or synthesis leveraging discovery",
      "tool_hint": "tool_name or null",
      "tool_args_hint": {{"arg": "value"}} or null,
      "depends_on": [1, 2],
      "success_criteria": {{
        "description": "Definition of done",
        "required_outputs": ["file_write_output"]
      }}
    }}
  ],
  "success_criteria": "How we know the overall goal was achieved",
  "reasoning": "Why this plan will work",
  "assumptions": ["List explicit assumptions about the repo/task/user constraints"],
  "discovery_required": true/false
}}
```

GUIDELINES:
- Discovery steps should mention concrete inspections: list directories, read README/requirements, search for symbols, inspect configs, reproduce failures, check OS/runtime constraints.
- Execution steps must reference discovery outputs via depends_on. Global step numbers should enumerate discovery steps first, then execution steps.
- For self-contained Q&A with no tools, mark discovery_required=false and leave discovery_plan empty.
- Prefer high-signal tools (list_files, file_read, search_filesystem, bash_execute) for discovery. Do not skip them when touching a repo.

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
        # NO logger - Planner doesn't log, Agent does

    def create_plan(
        self,
        user_input: str,
        context: Optional[str] = None,
        tier: str = "standard",
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
                    # Return a budget-exceeded plan that will fail fast
                    return self._create_budget_exceeded_plan(
                        user_input, budget, tier, validation["reason"]
                    )
            return simple_plan

        # Complex path: use LLM to create plan
        plan = self._create_llm_plan(user_input, context, tier)

        # Validate LLM-generated plan fits within budget
        if budget:
            validation = self._validate_plan_budget(plan, budget, tier)
            if not validation["fits"]:
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
        plan = Plan(
            goal=f"BUDGET_EXCEEDED: {user_input[:100]}",
            goal_type="error",
            steps=[
                PlanStep(
                    step_num=1,
                    objective=f"Return error: Task cannot be completed within {tier} tier budget",
                    tool_hint=None,
                    phase=PlanPhase.EXECUTION,
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
            discovery_required=False,
            status=PlanStatus.FAILED  # Mark as already failed
        )
        return self._finalize_plan(plan, user_input)

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
            plan = Plan(
                goal=f"Answer: {user_input}",
                goal_type="question",
                steps=[
                    PlanStep(
                        step_num=1,
                        objective="Answer the question from knowledge",
                        tool_hint=None,
                        phase=PlanPhase.EXECUTION,
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
                reasoning="Simple factual question - answer from knowledge",
                discovery_required=False,
                assumptions=["Question appears self-contained and does not require repository inspection"]
            )
            return self._finalize_plan(plan, user_input)

        # Search/lookup requests (but NOT creation tasks)
        if (needs_search or needs_realtime) and not is_creation_task and not needs_files:
            plan = Plan(
                goal=f"Find information: {user_input}",
                goal_type="search",
                steps=[
                    PlanStep(
                        step_num=1,
                        objective="Search for current/relevant information",
                        tool_hint="fast_answer",
                        tool_args_hint={"query": user_input},
                        phase=PlanPhase.DISCOVERY,
                        success_criteria=SuccessCriteria(
                            description="Find relevant, current information"
                        )
                    ),
                    PlanStep(
                        step_num=2,
                        objective="Synthesize findings into answer",
                        tool_hint=None,
                        phase=PlanPhase.EXECUTION,
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
                reasoning="Needs current/external information",
                assumptions=["External data required; fast_answer expected to provide up-to-date context"]
            )
            return self._finalize_plan(plan, user_input)

        # Not a simple pattern - need LLM planning
        # This includes creation tasks, file operations, and complex requests
        return None

    def _create_llm_plan(
        self,
        user_input: str,
        context: Optional[str],
        tier: str
    ) -> Plan:
        """Use LLM to create a plan for complex requests with explicit discovery/execution phases"""
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

            discovery_steps = self._build_phase_steps(
                plan_data.get("discovery_plan"),
                PlanPhase.DISCOVERY
            )
            execution_steps = self._build_phase_steps(
                plan_data.get("execution_plan"),
                PlanPhase.EXECUTION
            )

            # Backwards compatibility: fall back to legacy `steps`
            if not discovery_steps and not execution_steps and plan_data.get("steps"):
                inferred = self._build_phase_steps(plan_data.get("steps"), PlanPhase.EXECUTION)
                execution_steps.extend(inferred)

            steps = discovery_steps + execution_steps
            if not steps:
                steps = [PlanStep(
                    step_num=1,
                    objective="Process user request",
                    success_criteria=SuccessCriteria(description="Request handled"),
                    phase=PlanPhase.DISCOVERY
                )]

            discovery_required = plan_data.get(
                "discovery_required",
                self._infer_discovery_requirement(plan_data.get("goal_type"), plan_data.get("requires_tools", False))
            )

            plan = Plan(
                goal=plan_data.get("goal", user_input),
                goal_type=plan_data.get("goal_type", "task"),
                steps=steps,
                success_criteria=SuccessCriteria(
                    description=plan_data.get("success_criteria", "Goal achieved")
                ),
                estimated_complexity=tier,
                requires_tools=plan_data.get("requires_tools", False),
                reasoning=plan_data.get("reasoning", "LLM-generated plan"),
                discovery_required=discovery_required,
                assumptions=plan_data.get("assumptions", []) or []
            )
            return self._finalize_plan(plan, user_input)

        except Exception as e:
            # Executor can throw exceptions - Agent will handle them
            # Return fallback plan
            fallback = Plan(
                goal=user_input,
                goal_type="task",
                steps=[PlanStep(
                    step_num=1,
                    objective="Handle user request",
                    success_criteria=SuccessCriteria(description="Request processed"),
                    phase=PlanPhase.DISCOVERY
                )],
                success_criteria=SuccessCriteria(description="Request handled"),
                estimated_complexity=tier,
                requires_tools=False,
                reasoning=f"Fallback plan due to planning error: {str(e)}",
                assumptions=[f"Planning failed: {str(e)}"]
            )
            fallback.discovery_required = True
            return self._finalize_plan(fallback, user_input)

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

            result = json.loads(json_str.strip())
            return result
        except (json.JSONDecodeError, IndexError):
            # Return minimal plan structure
            return {
                "goal": user_input,
                "goal_type": "task",
                "requires_tools": False,
                "steps": [{"step_num": 1, "objective": "Process request"}],
                "success_criteria": "Request handled",
                "reasoning": "Could not parse plan"
            }
        except Exception:
            # Re-raise for Agent to handle
            raise

    def _build_phase_steps(
        self,
        steps_data: Optional[List[Dict[str, Any]]],
        phase: PlanPhase
    ) -> List[PlanStep]:
        """Convert structured plan data into PlanStep objects for a specific phase."""
        if not steps_data:
            return []

        built_steps: List[PlanStep] = []
        for idx, step_data in enumerate(steps_data):
            raw_step_num = step_data.get("step_num", idx + 1)
            try:
                step_num = int(raw_step_num)
            except (TypeError, ValueError):
                step_num = idx + 1

            success = self._build_success_criteria(
                step_data.get("success_criteria"),
                step_data.get("objective", "Complete the objective")
            )

            tool_args_hint = step_data.get("tool_args_hint")
            if tool_args_hint is not None and not isinstance(tool_args_hint, dict):
                tool_args_hint = None

            depends_on = self._normalize_dependencies(step_data.get("depends_on"))

            step = PlanStep(
                step_num=step_num,
                objective=step_data.get("objective", "Execute step"),
                tool_hint=step_data.get("tool_hint"),
                tool_args_hint=tool_args_hint,
                success_criteria=success,
                depends_on=depends_on,
                phase=phase
            )
            setattr(step, "_original_step_num", step_num)
            built_steps.append(step)

        return built_steps

    def _build_success_criteria(self, raw: Any, default_description: str) -> SuccessCriteria:
        """Create a SuccessCriteria object from planner JSON."""
        if isinstance(raw, dict):
            return SuccessCriteria(
                description=raw.get("description", default_description),
                required_outputs=raw.get("required_outputs", []),
                validation_hints=raw.get("validation_hints", []),
                automated_checks=raw.get("automated_checks")
            )
        if isinstance(raw, str):
            return SuccessCriteria(description=raw)
        if isinstance(raw, list):
            return SuccessCriteria(
                description=default_description,
                required_outputs=[str(item) for item in raw]
            )
        return SuccessCriteria(description=default_description)

    def _normalize_dependencies(self, depends_on: Any) -> List[int]:
        """Ensure depends_on is a list of ints."""
        if not depends_on:
            return []
        if not isinstance(depends_on, list):
            depends = [depends_on]
        else:
            depends = depends_on

        normalized: List[int] = []
        for dep in depends:
            if isinstance(dep, bool):
                continue
            if isinstance(dep, (int, float)):
                normalized.append(int(dep))
            elif isinstance(dep, str) and dep.strip().isdigit():
                normalized.append(int(dep.strip()))
        return normalized

    def _infer_discovery_requirement(
        self,
        goal_type: Optional[str],
        requires_tools: bool
    ) -> bool:
        """Determine if discovery should be mandatory."""
        if goal_type == "question" and not requires_tools:
            return False
        return True

    def _extract_file_mentions(self, text: str) -> List[str]:
        """
        Aggressively extract ALL file/module mentions from user input.

        Looks for:
        - @mentions: @file.py, @module.js
        - Direct filenames: harness.py, planner.py
        - Paths: src/agent.py, ./config.json
        - Common extensions: .py, .js, .ts, .go, .java, etc.
        """
        import re

        mentions = []

        # @mentions - highest priority
        mentions.extend(re.findall(r'@([\w/\-\.]+\.[\w]+)', text))

        # Direct file references with common extensions
        extensions = r'(?:py|js|ts|jsx|tsx|go|java|cpp|h|hpp|c|rs|rb|php|swift|kt|m|mm|sh|bash|json|yaml|yml|toml|xml|md|txt|csv|sql)'
        mentions.extend(re.findall(rf'\b([\w/\-\.]+\.{extensions})\b', text, re.IGNORECASE))

        # Handle typos: "harnessss.py" -> try "harness.py"
        cleaned_mentions = []
        for mention in mentions:
            # Remove duplicate consecutive characters (harnessss -> harness)
            cleaned = re.sub(r'(.)\1{2,}', r'\1', mention)
            cleaned_mentions.append(cleaned)
            if cleaned != mention:
                cleaned_mentions.append(mention)  # Keep original too

        return list(set(cleaned_mentions))

    def _extract_key_terms(self, text: str) -> List[str]:
        """Extract key technical terms that might be class/function/module names."""
        import re

        # Remove common question words and filler
        noise = r'\b(where|what|how|why|when|who|which|the|a|an|in|on|at|to|for|of|with|by|from|do|you|see|find|show|tell|me|my|your|our|their|opportunities|optimization|optimizations)\b'
        cleaned = re.sub(noise, ' ', text.lower())

        # Extract CamelCase and snake_case identifiers
        terms = re.findall(r'\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z_]+\b', text)

        # Filter to meaningful terms (length > 3, not just articles/conjunctions)
        meaningful = [t for t in terms if len(t) > 3 and t not in ('that', 'this', 'these', 'those', 'with', 'from')]

        return list(set(meaningful))[:5]  # Top 5 terms

    def _default_discovery_steps(self, user_input: str) -> List[PlanStep]:
        """
        AGGRESSIVE discovery - don't give up until files are found!

        Strategy:
        1. Extract ALL file mentions from user input
        2. Search filesystem for each specific file
        3. If files mentioned, read them and parse imports
        4. Follow dependency chain
        5. Fallback to keyword search only if NO files mentioned
        """
        steps = []
        step_num = 1

        # STEP 1: Extract file mentions
        file_mentions = self._extract_file_mentions(user_input)

        if file_mentions:
            # User explicitly mentioned files - FIND THEM!
            for file_pattern in file_mentions:
                steps.append(
                    PlanStep(
                        step_num=step_num,
                        objective=f"Discovery: Search for '{file_pattern}' in repository",
                        tool_hint="search_filesystem",
                        tool_args_hint={"pattern": file_pattern, "path": "."},
                        success_criteria=SuccessCriteria(
                            description=f"Located {file_pattern}",
                            required_outputs=[f"search_filesystem_output"]
                        ),
                        phase=PlanPhase.DISCOVERY,
                        max_tool_calls=3  # Try harder - grep multiple times if needed
                    )
                )
                step_num += 1

            # STEP 2: Read each found file
            for file_pattern in file_mentions:
                steps.append(
                    PlanStep(
                        step_num=step_num,
                        objective=f"Discovery: Read {file_pattern} contents",
                        tool_hint="file_read",
                        tool_args_hint={"path": file_pattern},
                        success_criteria=SuccessCriteria(
                            description=f"File {file_pattern} contents loaded",
                            required_outputs=[f"file_read_output"]
                        ),
                        depends_on=[step_num - len(file_mentions)],  # Depends on corresponding search
                        phase=PlanPhase.DISCOVERY,
                        max_tool_calls=2
                    )
                )
                step_num += 1

            # STEP 3: Parse imports from found files (for dependency analysis)
            if any('.py' in f for f in file_mentions):
                steps.append(
                    PlanStep(
                        step_num=step_num,
                        objective="Discovery: Extract imports and dependencies from Python files",
                        tool_hint="search_filesystem",
                        tool_args_hint={"pattern": "^import |^from ", "path": "."},
                        success_criteria=SuccessCriteria(
                            description="Dependencies identified",
                            required_outputs=["search_filesystem_output"]
                        ),
                        depends_on=list(range(len(file_mentions) + 1, step_num)),
                        phase=PlanPhase.DISCOVERY,
                        max_tool_calls=2
                    )
                )
                step_num += 1

        else:
            # No files mentioned - fall back to keyword search
            # Extract technical terms from query
            key_terms = self._extract_key_terms(user_input)

            # STEP 1: List repo structure
            steps.append(
                PlanStep(
                    step_num=step_num,
                    objective="Discovery: Inspect repository root structure",
                    tool_hint="list_files",
                    tool_args_hint={"path": "."},
                    success_criteria=SuccessCriteria(
                        description="Repo structure enumerated",
                        required_outputs=["list_files_output"]
                    ),
                    phase=PlanPhase.DISCOVERY,
                    max_tool_calls=2
                )
            )
            step_num += 1

            # STEP 2: Search for each key term
            for term in key_terms[:3]:  # Top 3 terms
                steps.append(
                    PlanStep(
                        step_num=step_num,
                        objective=f"Discovery: Search for '{term}' in codebase",
                        tool_hint="search_filesystem",
                        tool_args_hint={"pattern": term, "path": "."},
                        success_criteria=SuccessCriteria(
                            description=f"Files containing '{term}' found",
                            required_outputs=["search_filesystem_output"]
                        ),
                        depends_on=[step_num - 1],
                        phase=PlanPhase.DISCOVERY,
                        max_tool_calls=3
                    )
                )
                step_num += 1

        # Mark original step numbers for resequencing
        for step in steps:
            setattr(step, "_original_step_num", step.step_num)

        return steps

    def _resequence_steps(self, steps: List[PlanStep]) -> List[PlanStep]:
        """Sort steps (discovery first) and reassign sequential numbers."""
        if not steps:
            return steps

        sorted_steps = sorted(
            steps,
            key=lambda step: (
                0 if step.phase == PlanPhase.DISCOVERY else 1,
                getattr(step, "_original_step_num", step.step_num)
            )
        )
        mapping: Dict[int, int] = {}
        for idx, step in enumerate(sorted_steps, 1):
            original = getattr(step, "_original_step_num", step.step_num)
            mapping[original] = idx
            step.step_num = idx

        for step in sorted_steps:
            if not step.depends_on:
                continue
            new_deps = []
            for dep in step.depends_on:
                if isinstance(dep, bool):
                    continue
                dep_int = int(dep)
                new_deps.append(mapping.get(dep_int, dep_int))
            step.depends_on = new_deps

        return sorted_steps

    def _finalize_plan(self, plan: Plan, user_input: str) -> Plan:
        """Ensure discovery plan exists, phases ordered, and metadata populated."""
        plan.steps = self._resequence_steps(plan.steps)
        plan.discovery_plan = [s for s in plan.steps if s.phase == PlanPhase.DISCOVERY]
        plan.execution_plan = [s for s in plan.steps if s.phase == PlanPhase.EXECUTION]

        if plan.discovery_required and not plan.discovery_plan:
            injected = self._default_discovery_steps(user_input)
            plan.steps = injected + plan.steps
            plan.steps = self._resequence_steps(plan.steps)
            plan.discovery_plan = [s for s in plan.steps if s.phase == PlanPhase.DISCOVERY]
            plan.execution_plan = [s for s in plan.steps if s.phase == PlanPhase.EXECUTION]
            plan.assumptions.append("Auto-added discovery plan to inspect repository context")

        return plan


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
        # NO logger - Executor doesn't log, Agent does
        self._step_callbacks: List[Callable[[int, ToolCallRecord], None]] = []

    def add_step_callback(self, callback: Callable[[int, ToolCallRecord], None]):
        """Register callback invoked when a tool call completes within a step."""
        self._step_callbacks.append(callback)

    def _emit_step_callback(self, step_num: int, record: ToolCallRecord):
        """Emit tool progress callbacks safely."""
        for callback in self._step_callbacks:
            try:
                callback(step_num, record)
            except Exception:
                # Executor deliberately stays silent - Agent handles logging
                continue

    def execute(
        self,
        plan: Plan,
        messages: List[Message],
        tools: List[Any]
    ) -> ExecutionTrace:
        """
        Execute a plan and return trace of what happened.

        Does NOT mutate plan - Agent is responsible for updating plan state.
        Does NOT log - Agent handles all logging.
        """
        trace = ExecutionTrace(plan=plan)
        start_time = time.time()

        try:
            # OPTIMIZATION: Fast path for simple single-tool tasks
            # Reduces LLM calls from 3-5 down to 1 for common cases like search
            if (len(plan.steps) == 1 and
                plan.steps[0].tool_hint and
                not plan.steps[0].depends_on and
                plan.requires_tools):
                trace = self._execute_simple_tool_task(plan, messages, tools, trace, start_time)

            elif not plan.requires_tools:
                # Simple execution - just get LLM response
                response = self.llm.complete(messages, tools=None)
                trace.llm_calls += 1
                trace.final_response = response.content

                # Create a StepResult for the single reasoning step
                if plan.steps:
                    step_result = StepResult(
                        step_num=plan.steps[0].step_num,
                        status=PlanStatus.COMPLETED,
                        accumulated_data={"response": response.content},
                        final_response=response.content,
                        duration_ms=(time.time() - start_time) * 1000
                    )
                    trace.step_results.append(step_result)
            else:
                # Step-by-step execution
                trace = self._execute_plan_stepwise(plan, messages, tools, trace)

        except Exception as e:
            # Executor can throw exceptions - Agent will handle them
            trace.final_response = f"Execution error: {str(e)}"
            raise

        trace.total_duration_ms = (time.time() - start_time) * 1000
        return trace

    def _execute_simple_tool_task(
        self,
        plan: Plan,
        messages: List[Message],
        tools: List[Any],
        trace: ExecutionTrace,
        start_time: float
    ) -> ExecutionTrace:
        """
        Fast path for simple single-step, single-tool tasks.

        Examples: search queries, file reads, calculations
        Reduces LLM calls from 3-5 down to 1 by skipping stepwise execution.
        """
        step = plan.steps[0]

        # Add focused guidance for single-tool execution
        focused_guidance = f"""Execute this single-step task:

OBJECTIVE: {step.objective}

SUGGESTED ACTION: Call {step.tool_hint} to complete the task.

CRITICAL: Call the tool ONCE and return the result. Do not call multiple tools."""

        messages_focused = messages.copy()
        messages_focused.append(Message(MessageRole.SYSTEM, focused_guidance))

        # Single LLM call with tool
        response = self.llm.complete(messages_focused, tools=tools)
        trace.llm_calls += 1

        # Execute tool if called
        if response.has_tool_calls and response.tool_calls:
            tool_call = response.tool_calls[0]
            result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)
            trace.tool_calls += 1

            if result.is_success:
                trace.final_response = str(result.output)[:1000]  # Limit output size
            else:
                trace.tool_failures += 1
                trace.final_response = f"Tool failed: {result.error}"

            # Create step result
            step_result = StepResult(
                step_num=1,
                status=PlanStatus.COMPLETED if result.is_success else PlanStatus.FAILED,
                tool_calls_made=[ToolCallRecord(
                    tool_name=tool_call.name,
                    arguments=tool_call.arguments,
                    result=result,
                    duration_ms=0,
                    timestamp=time.time()
                )],
                accumulated_data={"result": result.output} if result.is_success else {},
                final_response=trace.final_response,
                duration_ms=(time.time() - start_time) * 1000,
                phase=step.phase
            )
            trace.step_results.append(step_result)
        else:
            # LLM didn't call tool - use its response
            trace.final_response = response.content
            step_result = StepResult(
                step_num=1,
                status=PlanStatus.COMPLETED,
                final_response=response.content,
                duration_ms=(time.time() - start_time) * 1000,
                phase=step.phase
            )
            trace.step_results.append(step_result)

        return trace

    def _execute_plan_stepwise(
        self,
        plan: Plan,
        messages: List[Message],
        tools: List[Any],
        trace: ExecutionTrace
    ) -> ExecutionTrace:
        """
        Execute plan step-by-step.

        Each step is a unit of work that may involve multiple tool calls.
        We execute steps sequentially, respecting dependencies.

        Updates plan step status after each step so dependencies work correctly.
        """

        remaining_discovery = {
            s.step_num for s in plan.steps if s.phase == PlanPhase.DISCOVERY
        }
        discovery_required = plan.discovery_required and bool(remaining_discovery)

        for step in plan.steps:
            if discovery_required and step.phase == PlanPhase.EXECUTION and remaining_discovery:
                raise RuntimeError("Cannot execute action steps before completing discovery.")

            # Check dependencies - throw exception if not met
            if not self._dependencies_met(step, plan.steps):
                raise RuntimeError(f"Step {step.step_num} dependencies not satisfied: {step.depends_on}")

            # Execute the step and get result
            step_result = self._execute_step(step, messages, tools, trace)

            # Update plan step status so dependencies work correctly for subsequent steps
            step.status = step_result.status
            step.error = step_result.error
            step.duration_ms = step_result.duration_ms
            step.context = step_result.context if hasattr(step_result, "context") else step.context

            # Append messages from this step to conversation (for next steps)
            messages.extend(step_result.llm_messages)

            # Store result in trace (Agent will use this to update plan state)
            trace.step_results.append(step_result)

            # Stop if critical step failed and no response yet
            if step_result.status == PlanStatus.FAILED and not trace.final_response:
                break

            if discovery_required and step.phase == PlanPhase.DISCOVERY:
                remaining_discovery.discard(step.step_num)
                if not remaining_discovery:
                    discovery_required = False

        # OPTIMIZATION: Reuse step results instead of making another LLM call
        if not trace.final_response:
            # Use last successful step's response
            if trace.step_results:
                last_step = trace.step_results[-1]
                if last_step.final_response:
                    trace.final_response = last_step.final_response
                elif last_step.accumulated_data:
                    # Synthesize from accumulated data
                    trace.final_response = f"Completed {len(trace.step_results)} steps"
                else:
                    trace.final_response = "Task completed"
            else:
                trace.final_response = "No steps executed"

        return trace

    def _execute_step(
        self,
        step: PlanStep,
        messages: List[Message],
        tools: List[Any],
        trace: ExecutionTrace
    ) -> StepResult:
        """
        Execute a single step (may involve multiple tool calls).

        Returns StepResult - does NOT mutate step.
        Does NOT log.
        Can throw exceptions for critical failures.

        A step is complete when:
        1. LLM stops requesting tools (has final answer), OR
        2. max_tool_calls reached for this step
        """

        start_time = time.time()
        context = StepContext()
        llm_messages_to_add = []  # Messages generated during this step

        # Add step guidance to help LLM focus
        # Pass context so guidance can show what data we already have
        step_guidance = self._create_step_guidance(step, context)
        messages_with_guidance = messages.copy()
        messages_with_guidance.append(Message(
            role=MessageRole.SYSTEM,
            content=step_guidance
        ))

        tool_calls_in_step = 0
        step_complete = False
        tool_hint_executed = False
        final_response_content = None
        error_message = None

        # Execute until step completes or hits limit
        while not step_complete and tool_calls_in_step < step.max_tool_calls:
            response = self.llm.complete(messages_with_guidance, tools=tools)
            trace.llm_calls += 1

            if not response.has_tool_calls:
                # LLM thinks step is done (no more tools needed)
                step_complete = True
                final_response_content = response.content
                trace.final_response = response.content
                break

            remaining_calls = step.max_tool_calls - tool_calls_in_step
            tool_calls_batch = response.tool_calls[:remaining_calls]

            # Fast-path: run cheap, read-only calls in parallel for speed
            if self._can_parallelize_batch(tool_calls_batch):
                (
                    batch_tool_hint_executed,
                    batch_last_success_output,
                    criteria_met,
                    criteria_output
                ) = self._execute_tool_calls_parallel(
                    tool_calls_batch,
                    response,
                    step,
                    context,
                    messages_with_guidance,
                    llm_messages_to_add,
                    trace
                )

                tool_calls_in_step += len(tool_calls_batch)
                tool_hint_executed = tool_hint_executed or batch_tool_hint_executed

                if criteria_met:
                    step_complete = True
                    final_response_content = criteria_output
                    trace.final_response = final_response_content
                    break

                if batch_tool_hint_executed:
                    step_complete = True
                    if batch_last_success_output is not None:
                        final_response_content = str(batch_last_success_output)[:500]
                    else:
                        final_response_content = f"Step {step.step_num} completed"
                    trace.final_response = final_response_content
                    break

                # Continue to next loop for more tool calls or reasoning
                continue

            # Process all tool calls in this LLM response
            for tool_call in tool_calls_batch:
                if tool_calls_in_step >= step.max_tool_calls:
                    break

                # Execute tool
                tool_start_time = time.time()
                result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)
                duration_ms = (time.time() - tool_start_time) * 1000

                # Record in context
                record = ToolCallRecord(
                    tool_name=tool_call.name,
                    arguments=tool_call.arguments,
                    result=result,
                    duration_ms=duration_ms,
                    timestamp=time.time()
                )
                context.tool_calls_made.append(record)
                context.add_tool_result(tool_call.name, result)
                self._emit_step_callback(step.step_num, record)

                tool_calls_in_step += 1
                trace.tool_calls += 1

                # NEW: Check if success criteria met after tool call
                if step.success_criteria and step.success_criteria.required_outputs:
                    if context.has_required_data(step.success_criteria.required_outputs):
                        step_complete = True
                        # Use tool result directly, don't make another LLM call
                        final_response_content = str(result.output) if result.is_success else "Step completed"
                        trace.final_response = final_response_content
                        break

                # Check if this was the suggested tool and it succeeded
                if step.tool_hint and tool_call.name == step.tool_hint and result.is_success:
                    tool_hint_executed = True

                # Track failures
                if not result.is_success:
                    trace.tool_failures += 1

                # Create messages for conversation history
                assistant_msg = Message(
                    role=MessageRole.ASSISTANT,
                    content=response.content or "",
                    tool_calls=[{
                        "id": tool_call.id,
                        "type": "function",
                        "function": {"name": tool_call.name, "arguments": json.dumps(tool_call.arguments)}
                    }]
                )
                tool_msg = Message(
                    role=MessageRole.TOOL,
                    content=str(result.output if result.is_success else f"Error: {result.error}")[:2000],
                    tool_call_id=tool_call.id,
                    name=tool_call.name
                )

                # Add to guidance messages for continued execution
                messages_with_guidance.append(assistant_msg)
                messages_with_guidance.append(tool_msg)

                # Track messages to be added to main conversation (Agent will do this)
                llm_messages_to_add.append(assistant_msg)
                llm_messages_to_add.append(tool_msg)

                # DON'T append to main messages - Agent controls conversation state

            # HEURISTIC: If the suggested tool was executed successfully, consider step complete
            # This prevents the LLM from looping on the same tool repeatedly
            if tool_hint_executed and tool_calls_in_step >= 1:
                step_complete = True
                # OPTIMIZATION: Use tool result directly instead of making another LLM call
                # This saves 1 LLM call per step (significant performance improvement)
                last_tool_result = context.tool_calls_made[-1].result
                if last_tool_result.is_success:
                    final_response_content = str(last_tool_result.output)[:500]  # Truncate long outputs
                else:
                    final_response_content = f"Step {step.step_num} completed"
                trace.final_response = final_response_content
                break

        # Calculate duration
        duration_ms = (time.time() - start_time) * 1000

        # Determine step status
        if step_complete:
            status = PlanStatus.COMPLETED
        elif tool_calls_in_step >= step.max_tool_calls:
            status = PlanStatus.PARTIAL
            error_message = f"Max tool calls ({step.max_tool_calls}) reached before step completion"
        else:
            status = PlanStatus.FAILED
            error_message = "Step did not complete"

        # Return StepResult - Agent will handle validation, logging, state updates
        return StepResult(
            step_num=step.step_num,
            status=status,
            tool_calls_made=context.tool_calls_made,
            llm_messages=llm_messages_to_add,
            accumulated_data=context.accumulated_data,
            final_response=final_response_content,
            error=error_message,
            duration_ms=duration_ms,
            phase=step.phase,
            context=context
        )

    def _can_parallelize_batch(self, tool_calls: List[ToolCall]) -> bool:
        """Return True if all tool calls are marked safe to run in parallel"""
        return (
            len(tool_calls) > 1 and
            all(self.tool_registry.is_parallel_safe(tc.name) for tc in tool_calls)
        )

    def _execute_tool_calls_parallel(
        self,
        tool_calls: List[ToolCall],
        response: LLMResponse,
        step: PlanStep,
        context: StepContext,
        messages_with_guidance: List[Message],
        llm_messages_to_add: List[Message],
        trace: ExecutionTrace
    ):
        """
        Execute a batch of read-only tool calls in parallel.

        Updates context, trace, and conversation scaffolding in original order.
        """
        last_success_output = None
        tool_hint_executed = False
        max_workers = min(len(tool_calls), 4)

        # Submit all calls
        futures = {}
        start_times = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            for idx, tool_call in enumerate(tool_calls):
                start_times[idx] = time.time()
                futures[executor.submit(self.tool_registry.execute, tool_call.name, **tool_call.arguments)] = (idx, tool_call)

            ordered_results: List[Optional[tuple]] = [None] * len(tool_calls)
            for future in as_completed(futures):
                idx, tool_call = futures[future]
                try:
                    result = future.result()
                except Exception as exc:  # Defensive: ensure failures are captured
                    result = ToolResult(
                        status=ToolStatus.ERROR,
                        output=None,
                        error=str(exc),
                        duration_ms=(time.time() - start_times[idx]) * 1000
                    )

                if result.duration_ms == 0:
                    result.duration_ms = (time.time() - start_times[idx]) * 1000

                ordered_results[idx] = (tool_call, result)

        # Apply results in original order for deterministic conversation state
        for tool_call, result in ordered_results:
            record = ToolCallRecord(
                tool_name=tool_call.name,
                arguments=tool_call.arguments,
                result=result,
                duration_ms=result.duration_ms,
                timestamp=time.time()
            )
            context.tool_calls_made.append(record)
            context.add_tool_result(tool_call.name, result)
            self._emit_step_callback(step.step_num, record)

            trace.tool_calls += 1
            if not result.is_success:
                trace.tool_failures += 1
            else:
                last_success_output = result.output
                if step.tool_hint and tool_call.name == step.tool_hint:
                    tool_hint_executed = True

            # Create messages mirroring sequential execution order
            assistant_msg = Message(
                role=MessageRole.ASSISTANT,
                content=response.content or "",
                tool_calls=[{
                    "id": tool_call.id,
                    "type": "function",
                    "function": {"name": tool_call.name, "arguments": json.dumps(tool_call.arguments)}
                }]
            )
            tool_msg = Message(
                role=MessageRole.TOOL,
                content=str(result.output if result.is_success else f"Error: {result.error}")[:2000],
                tool_call_id=tool_call.id,
                name=tool_call.name
            )

            messages_with_guidance.append(assistant_msg)
            messages_with_guidance.append(tool_msg)
            llm_messages_to_add.append(assistant_msg)
            llm_messages_to_add.append(tool_msg)

        # Success criteria check after all results applied
        criteria_met = False
        criteria_output = None
        if step.success_criteria and step.success_criteria.required_outputs:
            if context.has_required_data(step.success_criteria.required_outputs):
                criteria_met = True
                target_output = last_success_output
                if target_output is None and ordered_results:
                    target_output = ordered_results[-1][1].output
                criteria_output = str(target_output) if target_output is not None else "Step completed"

        return tool_hint_executed, last_success_output, criteria_met, criteria_output

    def _create_step_guidance(self, step: PlanStep, context: Optional[StepContext] = None) -> str:
        """Create system message to guide LLM for this specific step"""
        guidance = f"""You are currently executing Step {step.step_num} of a multi-step plan.

STEP OBJECTIVE: {step.objective}

SUCCESS CRITERIA: {step.success_criteria.description if step.success_criteria else "Complete the objective"}

"""

        # OPTIMIZATION: Show LLM what data we already have
        if context and context.accumulated_data:
            guidance += "DATA ALREADY COLLECTED:\n"
            for key, value in list(context.accumulated_data.items())[:3]:  # Max 3 to keep guidance concise
                value_str = str(value)[:100] if value else "None"
                guidance += f"  - {key}: {value_str}...\n"
            guidance += "\n"

        # OPTIMIZATION: Tell LLM what's still needed
        if step.success_criteria and step.success_criteria.required_outputs:
            missing = [req for req in step.success_criteria.required_outputs
                       if not context or req not in context.accumulated_data]
            if missing:
                guidance += f"STILL NEED: {', '.join(missing)}\n\n"
            else:
                guidance += "ALL REQUIRED DATA COLLECTED - provide final answer WITHOUT calling more tools\n\n"

        guidance += "CRITICAL: This is a SINGLE FOCUSED STEP. Once you have the required data, respond WITHOUT calling more tools.\n\n"

        if step.tool_hint:
            guidance += f"SUGGESTED ACTION: Call {step.tool_hint}"
            if step.tool_args_hint:
                guidance += f" with args: {json.dumps(step.tool_args_hint)}"
            guidance += f"\nAfter calling {step.tool_hint} successfully, provide your answer. Do NOT call additional tools.\n"
        else:
            guidance += "This step is reasoning/synthesis only - no tools needed. Provide your analysis.\n"

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
        """
        Check if step's dependencies are satisfied.

        Dependencies are met if the step is COMPLETED or PARTIAL.
        PARTIAL means some work was done and subsequent steps can proceed.
        Only PENDING and FAILED block dependent steps.
        """
        if not step.depends_on:
            return True

        for dep_num in step.depends_on:
            dep_step = next((s for s in all_steps if s.step_num == dep_num), None)
            if not dep_step:
                return False

            # Accept COMPLETED or PARTIAL - both mean some work was done
            # Only PENDING and FAILED should block dependent steps
            if dep_step.status not in (PlanStatus.COMPLETED, PlanStatus.PARTIAL):
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
        # NO logger - Reflector doesn't log, Agent does

    def reflect(
        self,
        plan: Plan,
        trace: ExecutionTrace,
        file_operations: Optional[List[Dict[str, Any]]] = None
    ) -> Reflection:
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

        # OPTIMIZATION: Fast path for simple tasks - skip expensive LLM reflection
        # Simple questions: no tools, just answered from knowledge
        if plan.goal_type == "question" and not plan.requires_tools:
            return Reflection(
                plan_goal=plan.goal,
                goal_achieved=True,
                confidence=0.9,
                evidence=["Direct answer provided"],
                gaps=[],
                suggestions=[],
                reward=1.0,
                plan_quality=1.0,
                execution_quality=1.0,
                response_quality=0.9
            )

        # Simple tool tasks: single tool used successfully (e.g., search, file read)
        if (plan.goal_type in ("search", "question") and
            trace.tool_calls > 0 and
            trace.tool_failures == 0 and
            trace.final_response and
            len(trace.final_response) > 20):
            return Reflection(
                plan_goal=plan.goal,
                goal_achieved=True,
                confidence=0.95,
                evidence=["Tool executed successfully with result"],
                gaps=[],
                suggestions=[],
                reward=1.0,
                plan_quality=1.0,
                execution_quality=1.0,
                response_quality=0.9
            )

        # Heuristic: if execution produced tangible artifacts/tests, trust that evidence
        heuristic_reflection = self._auto_reflect_from_trace(plan, trace, file_operations)
        if heuristic_reflection:
            return heuristic_reflection

        # For complex tasks, use LLM to evaluate
        return self._llm_reflect(plan, trace, file_operations=file_operations)

    def _llm_reflect(
        self,
        plan: Plan,
        trace: ExecutionTrace,
        file_operations: Optional[List[Dict[str, Any]]] = None
    ) -> Reflection:
        """Use LLM to evaluate complex task completion with RL labeling"""
        # Build structured input for the Reflector
        step_summaries = self._build_step_summaries(plan, trace)
        artifact_summary = self._summarize_artifacts_for_llm(file_operations)

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
                "all_steps_succeeded": trace.all_steps_succeeded,
                "steps": step_summaries
            },
            "final_response": trace.final_response[:1500] if trace.final_response else "(no response)"
        }
        if artifact_summary:
            reflector_input["artifacts"] = artifact_summary

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
        except Exception:
            # Fallback: use heuristics
            # Agent will handle exception logging
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

    def _auto_reflect_from_trace(
        self,
        plan: Plan,
        trace: ExecutionTrace,
        file_operations: Optional[List[Dict[str, Any]]]
    ) -> Optional[Reflection]:
        """
        Lightweight heuristics that mark success when evidence is obvious.
        """
        if not trace.final_response:
            return None

        all_steps_completed = bool(plan.steps) and all(
            step.status == PlanStatus.COMPLETED for step in plan.steps
        )
        if all_steps_completed:
            return self._build_success_reflection(
                plan,
                trace,
                file_operations,
                confidence=0.9,
                note="All planned steps completed"
            )

        test_note = self._detect_successful_tests(trace)
        file_writes = self._extract_file_writes(file_operations)
        if test_note and file_writes:
            return self._build_success_reflection(
                plan,
                trace,
                file_operations,
                confidence=0.8,
                note="Files created and tests reported success",
                test_note=test_note
            )

        return None

    def _build_success_reflection(
        self,
        plan: Plan,
        trace: ExecutionTrace,
        file_operations: Optional[List[Dict[str, Any]]],
        confidence: float,
        note: str,
        test_note: Optional[str] = None
    ) -> Reflection:
        """Construct a Reflection object that records clear success evidence."""
        evidence = [note]
        file_summary = self._summarize_file_ops_simple(file_operations)
        if file_summary:
            evidence.append(file_summary)
        if test_note:
            evidence.append(test_note)

        had_failures = trace.tool_failures > 0
        return Reflection(
            plan_goal=plan.goal,
            goal_achieved=True,
            confidence=confidence,
            evidence=evidence,
            gaps=[],
            suggestions=[],
            should_retry=False,
            had_tool_failures=had_failures,
            reward=1.0 if not had_failures else 0.85,
            plan_quality=1.0 if not had_failures else 0.9,
            execution_quality=0.95 if not had_failures else 0.8,
            response_quality=0.85 if trace.final_response else 0.6
        )

    def _extract_file_writes(
        self,
        file_operations: Optional[List[Dict[str, Any]]]
    ) -> List[str]:
        """Return list of paths that appear to have been written/appended."""
        if not file_operations:
            return []

        writes = []
        for op in file_operations:
            action = (op.get("action") or "").lower()
            if action in {"write", "append", "file_write", "create"}:
                path = op.get("path")
                if path:
                    writes.append(path)
        return writes

    def _summarize_file_ops_simple(
        self,
        file_operations: Optional[List[Dict[str, Any]]]
    ) -> Optional[str]:
        """Create a concise human-readable summary of file work."""
        writes = self._extract_file_writes(file_operations)
        if writes:
            display = ", ".join(writes[:3])
            if len(writes) > 3:
                display += ", ..."
            return f"Files written: {display}"
        return None

    def _detect_successful_tests(self, trace: ExecutionTrace) -> Optional[str]:
        """Look for obvious signs of passing tests in tool outputs."""
        success_phrases = [
            "all tests passed",
            "tests passed",
            "ok (",
            "ok\n",
            "successfully ran",
            "passed in"
        ]
        failure_phrases = ["fail", "traceback", "assert", "error"]

        for step_result in trace.step_results:
            for record in step_result.tool_calls_made:
                if record.tool_name not in {"python_execute", "bash_execute"}:
                    continue
                output = str(record.result.output or "")
                lower_output = output.lower()
                if any(phrase in lower_output for phrase in success_phrases):
                    if not any(failure in lower_output for failure in failure_phrases):
                        snippet = self._truncate_text(output, max_len=200)
                        return f"Test output from {record.tool_name}: {snippet}"
        return None

    def _build_step_summaries(
        self,
        plan: Plan,
        trace: ExecutionTrace
    ) -> List[Dict[str, Any]]:
        """Summarize per-step execution for inclusion in reflection prompt."""
        summaries: List[Dict[str, Any]] = []
        plan_map = {step.step_num: step for step in plan.steps}

        for step_result in trace.step_results[:8]:  # limit for prompt size
            plan_step = plan_map.get(step_result.step_num)
            summary: Dict[str, Any] = {
                "step_num": step_result.step_num,
                "status": step_result.status.value,
                "objective": plan_step.objective if plan_step else None,
                "error": step_result.error
            }
            if step_result.final_response:
                summary["final_response"] = self._truncate_text(step_result.final_response, max_len=300)

            tool_calls = []
            for record in step_result.tool_calls_made[:4]:
                tool_calls.append({
                    "tool": record.tool_name,
                    "status": record.result.status.value if hasattr(record.result.status, "value") else str(record.result.status),
                    "output": self._truncate_text(str(record.result.output or ""), max_len=150),
                    "error": record.result.error
                })
            if tool_calls:
                summary["tool_calls"] = tool_calls

            summaries.append(summary)

        return summaries

    def _summarize_artifacts_for_llm(
        self,
        file_operations: Optional[List[Dict[str, Any]]]
    ) -> Optional[List[Dict[str, Any]]]:
        """Convert file operation logs into concise artifact descriptors."""
        if not file_operations:
            return None

        artifacts = []
        for op in file_operations[:10]:
            artifacts.append({
                "path": op.get("path"),
                "action": op.get("action"),
                "tool": op.get("tool")
            })
        return artifacts

    @staticmethod
    def _truncate_text(value: str, max_len: int = 120) -> str:
        """Truncate long strings for prompts/evidence."""
        text = value.strip()
        if len(text) <= max_len:
            return text
        return text[:max_len - 3] + "..."

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
