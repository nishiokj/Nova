"""
Planner/Executor/Reflector architecture for structured agent execution.

This module is a compatibility facade that re-exports the plan models,
planner prompts, and the Planner/Executor/Reflector components.
"""

import json
from typing import Any, Dict, List, Optional

from util.llm_adapter import LLMAdapter
from util.perf_trace import get_tracer

from .executor import Executor
from .plan_models import (
    ExecutionTrace,
    Plan,
    PlanPhase,
    PlanStatus,
    PlanStep,
    Reflection,
    StepContext,
    StepResult,
    SuccessCriteria,
    ToolCallRecord,
    ValidationResult,
)
from .prompts import PLANNING_PROMPT, REFLECTION_PROMPT, format_prompt
from .reflector import Reflector
from .tool_registry import ToolRegistry


class Planner:
    """
    Creates explicit execution plans before running.

    The key insight: know what success looks like BEFORE you start.
    """

    def __init__(self, llm: LLMAdapter, tool_registry: ToolRegistry, enable_scouting: bool = True):
        self.llm = llm
        self.tool_registry = tool_registry
        self._tracer = get_tracer()
        # NO logger - Planner doesn't log, Agent does

        # Store last LLM call details for logging by Agent
        self.last_call_instructions: str = ""
        self.last_call_input: str = ""
        self.last_call_response: str = ""
        self.last_call_duration_ms: float = 0.0

        # Context scouting for grounded planning
        self._enable_scouting = enable_scouting
        self._scout = None
        self._last_scout_snapshot = None
        if enable_scouting:
            try:
                from .context_scout import ContextScout
                self._scout = ContextScout(tool_registry)
            except ImportError:
                self._enable_scouting = False

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

        NEW: If context scouting is enabled, gathers minimal context
        before planning to ground the plan in reality.

        IMPORTANT: If budget constraints are provided, the plan MUST fit within them.
        If the task cannot be completed within budget, we fail fast with a clear error.

        Args:
            user_input: The user's request
            context: Optional additional context
            tier: Execution tier (simple/standard/advanced)
            exec_id: Execution ID for logging
            budget: Budget constraints from router (max_tool_calls, max_tokens, max_steps)
        """
        # PRE-PLANNING: Scout context if enabled and needed
        if self._enable_scouting and self._scout:
            from .context_scout import should_scout
            if should_scout(user_input):
                with self._tracer.span("context_scout"):
                    self._last_scout_snapshot = self._scout.scout(user_input)
                    if self._last_scout_snapshot.has_useful_context:
                        scout_context = self._last_scout_snapshot.to_context_string()
                        context = f"{context}\n\n{scout_context}" if context else scout_context

        # Fast path: detect simple patterns that don't need LLM planning
        with self._tracer.span("try_simple_plan"):
            simple_plan = self._try_simple_plan(user_input)
        if simple_plan:
            self._tracer.add_metadata("plan_path", "simple")
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
        self._tracer.add_metadata("plan_path", "llm")
        with self._tracer.span("create_llm_plan"):
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

        IMPROVED: Now handles code location questions like:
        - "where does my TUI receive responses"
        - "where is X handled"
        - "find where Y is called"
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
        creation_keywords = [
            "create file", "write file", "create folder", "make folder", "mkdir",
            "create directory", "set up", "initialize", "instantiate"
        ]
        command_verbs_with_object = [
            "build a ", "build the ", "build me ", "build new ", "build this ",
            "generate a ", "generate the ", "generate me ", "generate new ",
            "implement a ", "implement the ", "implement new ", "implement this "
        ]
        is_question_about_code = any(input_lower.startswith(q) for q in [
            "how does", "how do", "what does", "explain how", "describe how"
        ])
        is_creation_task = (
            any(kw in input_lower for kw in creation_keywords) or
            (any(kw in input_lower for kw in command_verbs_with_object) and not is_question_about_code)
        )
        needs_files = any(kw in input_lower for kw in [
            "read file", "open file", "save", "delete file", "edit file", "modify"
        ])

        # NEW: Code location questions - "where is X handled", "where does Y receive Z"
        code_location_patterns = [
            "where is", "where does", "where do", "where are",
            "find where", "locate where", "show where",
            "which file", "what file", "in which"
        ]
        is_code_location_question = any(pattern in input_lower for pattern in code_location_patterns)

        # Check for code-related terms that indicate searching codebase
        code_terms = [
            "response", "request", "handler", "function", "class", "method",
            "receive", "send", "call", "handle", "process", "tui", "agent",
            "event", "message", "data", "file", "module", "import"
        ]
        mentions_code = any(term in input_lower for term in code_terms)

        # NEW: Handle code location questions with minimal steps
        if is_code_location_question and mentions_code and not is_creation_task:
            # Extract meaningful search terms
            key_terms = self._extract_key_terms(user_input)

            # Determine search pattern - look for the most specific term
            if key_terms:
                search_term = key_terms[0]
            else:
                # Fall back to extracting noun phrases
                import re
                # Look for patterns like "receive responses" → "response"
                # or "TUI application" → "tui"
                words = re.findall(r'\b[a-z]+\b', input_lower)
                code_related = [w for w in words if w in code_terms]
                search_term = code_related[0] if code_related else "handler"

            plan = Plan(
                goal=f"Find code location: {user_input}",
                goal_type="search",
                steps=[
                    PlanStep(
                        step_num=1,
                        objective=f"Search codebase for '{search_term}' handlers/functions",
                        tool_hint="search_filesystem",
                        tool_args_hint={"pattern": search_term, "path": "."},
                        phase=PlanPhase.DISCOVERY,
                        success_criteria=SuccessCriteria(
                            description=f"Found files containing '{search_term}'",
                            required_outputs=["search_filesystem_output"]
                        ),
                        max_tool_calls=2
                    ),
                    PlanStep(
                        step_num=2,
                        objective="Identify the specific location and provide answer",
                        tool_hint=None,
                        phase=PlanPhase.EXECUTION,
                        depends_on=[1],
                        success_criteria=SuccessCriteria(
                            description="File and function identified with explanation"
                        )
                    )
                ],
                success_criteria=SuccessCriteria(
                    description="Specific file/function location identified with context"
                ),
                estimated_complexity="standard",
                requires_tools=True,
                reasoning="Code location question - search for relevant terms, then explain",
                discovery_required=True,
                assumptions=["User wants to find code in the current project"]
            )
            return self._finalize_plan(plan, user_input)

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

        # Code explanation questions: "how does X work?", "explain Y", etc.
        code_question_patterns = ["how does", "how do", "explain", "what does", "describe"]
        has_file_path = any(ext in input_lower for ext in [".py", ".js", ".ts", ".go", ".java", ".cpp", ".h", ".rs"])
        is_code_question = any(input_lower.startswith(pattern) for pattern in code_question_patterns) and has_file_path

        if is_code_question and not is_creation_task:
            # USE SCOUT DISCOVERIES if available - scout already read the files!
            mentioned_files = []

            if self._last_scout_snapshot and self._last_scout_snapshot.files:
                # Scout already verified and read these files
                for path, file_ctx in self._last_scout_snapshot.files.items():
                    if file_ctx.exists:
                        mentioned_files.append(path)

            if not mentioned_files:
                # Fallback: extract paths ourselves (scout might not have run)
                import re
                # Pattern 1: @mentions like @tui/render_engine.py
                at_mentions = re.findall(r'@([\w/\-\.]+\.[\w]+)', user_input)
                mentioned_files.extend(at_mentions)
                # Pattern 2: Explicit paths like ./file.py or /path/to/file.py
                path_mentions = re.findall(r'\.?/([\w/\-\.]+\.[\w]+)', user_input)
                mentioned_files.extend(path_mentions)
                # Deduplicate
                mentioned_files = list(dict.fromkeys(mentioned_files))

            # If scout has full content for PRIMARY files, skip the read step entirely
            has_full_content = False
            if self._last_scout_snapshot:
                primary_files = self._last_scout_snapshot.primary_files
                if primary_files and any(f.content for f in primary_files):
                    has_full_content = True

            plan = Plan(
                goal=f"Explain: {user_input}",
                goal_type="question",
                steps=[
                    PlanStep(
                        step_num=1,
                        objective=f"Read and explain the code",
                        # Skip tool hint if scout already has full content
                        tool_hint="file_read" if mentioned_files and not has_full_content else None,
                        tool_args_hint={"path": mentioned_files[0]} if mentioned_files and not has_full_content else None,
                        phase=PlanPhase.EXECUTION,
                        success_criteria=SuccessCriteria(
                            description="Provide clear explanation of how the code works"
                        )
                    )
                ],
                success_criteria=SuccessCriteria(
                    description="Code behavior explained clearly"
                ),
                estimated_complexity="simple",
                requires_tools=bool(mentioned_files) and not has_full_content,
                reasoning="Code explanation question - read file and explain",
                discovery_required=False,
                assumptions=["User wants to understand existing code, not modify it"]
            )
            return self._finalize_plan(plan, user_input)

        # Search/lookup requests (but NOT creation tasks)
        if (needs_search or needs_realtime) and not is_creation_task and not needs_files:
            plan = Plan(
                goal=f"Answer (no auto-search): {user_input}",
                goal_type="question",
                steps=[
                    PlanStep(
                        step_num=1,
                        objective="Provide the best answer using existing knowledge; if fresh data is required, explain the limitation briefly.",
                        tool_hint=None,
                        phase=PlanPhase.EXECUTION,
                        success_criteria=SuccessCriteria(
                            description="Clear, concise answer or explicit note when external data is required"
                        )
                    )
                ],
                success_criteria=SuccessCriteria(
                    description="User gets a direct answer or a clear note about data freshness/limits"
                ),
                estimated_complexity="standard",
                requires_tools=False,
                reasoning="Request mentions search/lookup, but we avoid defaulting to web tools; rely on knowledge and communicate limits.",
                assumptions=["No automatic web search; respond from knowledge and flag if fresh data is needed"]
            )
            return self._finalize_plan(plan, user_input)

        # Not a simple pattern - need LLM planning
        return None

    def _create_llm_plan(
        self,
        user_input: str,
        context: Optional[str],
        tier: str
    ) -> Plan:
        """Use LLM to create a plan for complex requests with explicit discovery/execution phases"""
        with self._tracer.span("build_planning_prompt"):
            tools = self.tool_registry.list_tools(enabled_only=True)
            tool_descriptions = "\n".join([f"- {t.name}: {t.description}" for t in tools])

            context_str = f"\nContext: {context}" if context else ""

            # Build system instructions (planning rules + available tools)
            # NOTE: PLANNING_PROMPT contains JSON examples with braces that break str.format(),
            # so we use manual string replacement instead of format_prompt().
            prompt_template = PLANNING_PROMPT or ""
            system_instructions = prompt_template
            if system_instructions:
                # Replace placeholders manually (format() fails due to JSON braces in template)
                system_instructions = system_instructions.replace("{tools}", tool_descriptions)
                system_instructions = system_instructions.replace("{user_input}", user_input)
                system_instructions = system_instructions.replace("{context}", context_str)
            else:
                system_instructions = (
                    "You are a planning assistant. Output valid JSON only.\n\n"
                    f"Available tools:\n{tool_descriptions}"
                )

            # Build user input (the actual request)
            user_input_str = user_input
            if context and "{context}" not in prompt_template:
                user_input_str = f"{user_input}\n\nContext: {context}"

            self._tracer.add_metadata("instructions_len", len(system_instructions))
            self._tracer.add_metadata("input_len", len(user_input_str))

        try:
            with self._tracer.span("llm_respond_planning"):
                response_kwargs: Dict[str, Any] = {}
                provider = getattr(self.llm, "provider", "").lower()
                if provider in ("openai", "custom"):
                    tool_args_kv_schema = {
                        "type": "object",
                        "properties": {
                            "key": {"type": "string"},
                            "value": {"type": ["string", "number", "boolean", "null"]}
                        },
                        "required": ["key", "value"],
                        "additionalProperties": False
                    }
                    success_criteria_schema = {
                        "type": "object",
                        "properties": {
                            "description": {"type": "string"},
                            "required_outputs": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["description", "required_outputs"],
                        "additionalProperties": False
                    }
                    # Step schema - OpenAI requires ALL properties in required array
                    # tool_args_hint is a JSON string to avoid nested object schema issues
                    step_schema = {
                        "type": "object",
                        "properties": {
                            "step_num": {"type": "integer"},
                            "objective": {"type": "string"},
                            "tool_hint": {"type": ["string", "null"]},
                            "tool_args_hint": {"type": ["string", "null"]},  # JSON string, parsed later
                            "depends_on": {"type": "array", "items": {"type": "integer"}}
                        },
                        "required": [
                            "step_num",
                            "objective",
                            "tool_hint",
                            "tool_args_hint",
                            "depends_on"
                        ],
                        "additionalProperties": False
                    }
                    # Plan schema - OpenAI requires additionalProperties: false
                    plan_schema = {
                        "type": "object",
                        "properties": {
                            "user_intent": {"type": "string"},
                            "goal": {"type": "string"},
                            "goal_type": {"type": "string"},
                            "requires_tools": {"type": "boolean"},
                            "discovery_plan": {"type": "array", "items": step_schema},
                            "execution_plan": {"type": "array", "items": step_schema},
                            "success_criteria": {"type": "string"},
                            "reasoning": {"type": "string"}
                        },
                        "required": [
                            "user_intent",
                            "goal",
                            "goal_type",
                            "requires_tools",
                            "discovery_plan",
                            "execution_plan",
                            "success_criteria",
                            "reasoning"
                        ],
                        "additionalProperties": False
                    }
                    response_kwargs["text"] = {
                        "format": {
                            "type": "json_schema",
                            "name": "plan",
                            "strict": True,
                            "schema": plan_schema
                        }
                    }

                # Store call details for logging by Agent
                self.last_call_instructions = system_instructions
                self.last_call_input = user_input_str

                import time as _time
                _call_start = _time.time()
                response = self.llm.respond(
                    input=user_input_str,  # User's request (user role)
                    instructions=system_instructions,  # Planning rules + tools (system role)
                    **response_kwargs
                )
                self.last_call_duration_ms = (_time.time() - _call_start) * 1000
                self.last_call_response = response.content or ""

            self._tracer.add_metadata("response_len", len(response.content) if response.content else 0)

            with self._tracer.span("parse_plan_response"):
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

            # CRITICAL FIX: Infer requires_tools from actual step contents
            # LLM often gets this wrong (says false when steps clearly need tools)
            llm_requires_tools = plan_data.get("requires_tools", False)
            inferred_requires_tools = any(
                s.tool_hint for s in steps if hasattr(s, 'tool_hint')
            )
            # Trust the steps, not the LLM's top-level declaration
            actual_requires_tools = llm_requires_tools or inferred_requires_tools

            plan = Plan(
                goal=plan_data.get("goal", user_input),
                goal_type=plan_data.get("goal_type", "task"),
                steps=steps,
                success_criteria=SuccessCriteria(
                    description=plan_data.get("success_criteria", "Goal achieved")
                ),
                estimated_complexity=tier,
                requires_tools=actual_requires_tools,
                reasoning=plan_data.get("reasoning", "LLM-generated plan"),
                discovery_required=discovery_required,
                assumptions=plan_data.get("assumptions", []) or [],
                # NEW: Explicit uncertainty tracking
                user_intent=plan_data.get("user_intent", ""),
                uncertainties=plan_data.get("uncertainties", []) or [],
                uncertainty_threshold=plan_data.get("uncertainty_threshold", 0.2),
                current_uncertainty=1.0 if plan_data.get("uncertainties") else 0.0,
                # NEW: Pre/postconditions
                preconditions=plan_data.get("preconditions", []) or [],
                postconditions=plan_data.get("postconditions", []) or []
            )
            return self._finalize_plan(plan, user_input)

        except Exception as e:
            # Executor can throw exceptions - Agent will handle them
            # Return fallback plan that's smarter about tool requirements

            # CRITICAL: Detect if this is a creation/execution task
            # If so, we MUST set requires_tools=True even in fallback
            input_lower = user_input.lower()
            is_creation_task = any(kw in input_lower for kw in [
                "create", "make", "build", "scaffold", "generate", "write",
                "install", "setup", "initialize", "init", "new folder", "new file"
            ])

            fallback = Plan(
                goal=user_input,
                goal_type="creation" if is_creation_task else "task",
                steps=[PlanStep(
                    step_num=1,
                    objective="Execute user request directly",
                    tool_hint="bash_execute" if is_creation_task else None,
                    success_criteria=SuccessCriteria(description="Request processed"),
                    phase=PlanPhase.EXECUTION
                )],
                success_criteria=SuccessCriteria(description="Request handled"),
                estimated_complexity=tier,
                requires_tools=is_creation_task,  # Infer from request keywords
                reasoning=f"Fallback plan due to planning error: {str(e)}",
                assumptions=[f"Planning failed: {str(e)}"]
            )
            fallback.discovery_required = False  # Skip discovery in fallback
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

            # Clean up common JSON issues
            json_str = json_str.strip()

            # Try to parse
            result = json.loads(json_str)

            # Validate required fields
            if not isinstance(result, dict):
                raise ValueError("Plan response must be a JSON object")

            # Ensure we have at minimum the basic structure
            if "goal" not in result:
                result["goal"] = user_input
            if "goal_type" not in result:
                result["goal_type"] = "task"
            if "requires_tools" not in result:
                result["requires_tools"] = False

            return result

        except (json.JSONDecodeError, IndexError, ValueError) as e:
            # Log parsing error for debugging (will be handled by Agent's logger)
            import sys
            print(f"[PLANNER DEBUG] Failed to parse plan JSON: {e}", file=sys.stderr)
            print(f"[PLANNER DEBUG] Raw LLM response (first 500 chars): {content[:500]}", file=sys.stderr)

            # Return minimal plan structure
            return {
                "goal": user_input,
                "goal_type": "task",
                "requires_tools": False,
                "steps": [{"step_num": 1, "objective": "Process request"}],
                "success_criteria": "Request handled",
                "reasoning": f"Plan parsing failed: {str(e)[:100]}"
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
            if isinstance(tool_args_hint, str):
                try:
                    parsed = json.loads(tool_args_hint)
                except json.JSONDecodeError:
                    parsed = None
                tool_args_hint = parsed
            if isinstance(tool_args_hint, list):
                kv_pairs = {}
                for item in tool_args_hint:
                    if not isinstance(item, dict):
                        continue
                    key = item.get("key")
                    if isinstance(key, str):
                        kv_pairs[key] = item.get("value")
                tool_args_hint = kv_pairs or None
            if tool_args_hint is not None and not isinstance(tool_args_hint, dict):
                tool_args_hint = None

            depends_on = self._normalize_dependencies(step_data.get("depends_on"), step_num)

            step = PlanStep(
                step_num=step_num,
                objective=step_data.get("objective", "Execute step"),
                tool_hint=step_data.get("tool_hint"),
                tool_args_hint=tool_args_hint,
                success_criteria=success,
                depends_on=depends_on,
                phase=phase,
                # NEW: Uncertainty reduction (for discovery steps)
                uncertainties_targeted=step_data.get("uncertainties_targeted", []) or [],
                expected_uncertainty_reduction=step_data.get("expected_uncertainty_reduction", 0.0),
                # NEW: Pre/postconditions (for execution steps)
                preconditions=step_data.get("preconditions", []) or [],
                postconditions=step_data.get("postconditions", []) or [],
                verification_method=step_data.get("verification_method")
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

    def _normalize_dependencies(self, depends_on: Any, step_num: Optional[int] = None) -> List[int]:
        """Ensure depends_on is a list of ints, filtering out invalid dependencies.

        Args:
            depends_on: Raw dependency data from plan
            step_num: Current step number to filter out self-references
        """
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
            dep_int: Optional[int] = None
            if isinstance(dep, (int, float)):
                dep_int = int(dep)
            elif isinstance(dep, str) and dep.strip().isdigit():
                dep_int = int(dep.strip())

            # Filter out self-references (step cannot depend on itself)
            if dep_int is not None and dep_int != step_num:
                normalized.append(dep_int)
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
        """
        Extract MEANINGFUL technical terms that might be class/function/module names.

        CRITICAL: This method was causing bad plans by extracting random words like
        "even", "question", "meant" from user messages. Now it's more selective.
        """
        import re

        # Comprehensive list of stop words - words that should NEVER be searched for
        stop_words = {
            # Common words
            'where', 'what', 'how', 'why', 'when', 'who', 'which', 'the', 'a', 'an',
            'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'do', 'does',
            'you', 'see', 'find', 'show', 'tell', 'me', 'my', 'your', 'our', 'their',
            'that', 'this', 'these', 'those', 'will', 'would', 'could', 'should',
            'have', 'has', 'had', 'been', 'being', 'was', 'were', 'are', 'is', 'am',
            'can', 'may', 'might', 'must', 'shall', 'need', 'want', 'like', 'just',
            'also', 'very', 'much', 'many', 'some', 'any', 'all', 'most', 'other',
            'such', 'only', 'same', 'than', 'then', 'now', 'here', 'there', 'well',
            # Words commonly appearing in frustrated user messages
            'even', 'obviously', 'clearly', 'fucking', 'damn', 'hell', 'shit',
            'lazy', 'stupid', 'wrong', 'right', 'stop', 'please', 'just', 'already',
            'meant', 'mean', 'infer', 'inferred', 'premise', 'question', 'answer',
            # Generic action words
            'look', 'check', 'get', 'set', 'put', 'take', 'make', 'give', 'keep',
            'let', 'begin', 'seem', 'help', 'turn', 'start', 'show', 'hear', 'play',
            'run', 'move', 'live', 'believe', 'hold', 'bring', 'happen', 'write',
            'provide', 'sit', 'stand', 'lose', 'pay', 'meet', 'include', 'continue',
            # Generic nouns
            'thing', 'things', 'stuff', 'way', 'ways', 'time', 'times', 'place',
            'point', 'part', 'parts', 'case', 'cases', 'fact', 'facts', 'idea',
            'information', 'issue', 'issues', 'problem', 'problems', 'question',
            'questions', 'answer', 'answers', 'reason', 'result', 'results',
        }

        terms = []

        # 1. Extract CamelCase identifiers (class names like AgentResponse, SimpleTUI)
        camel_case = re.findall(r'\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b', text)
        terms.extend(camel_case)

        # 2. Extract snake_case identifiers (function names like handle_response, _get_input)
        snake_case = re.findall(r'\b_?[a-z]+(?:_[a-z]+)+\b', text)
        terms.extend(snake_case)

        # 3. Extract likely module/file names (words ending in common patterns)
        # e.g., "planner", "handler", "manager", "worker", "service"
        tech_suffixes = re.findall(r'\b\w+(?:er|or|handler|manager|worker|service|client|server|agent|builder|factory|registry|adapter|provider|processor|executor|planner|reflector)\b', text.lower())
        terms.extend(tech_suffixes)

        # 4. Extract quoted strings (user explicitly marking terms)
        quoted = re.findall(r"['\"]([^'\"]+)['\"]", text)
        terms.extend(quoted)

        # Filter: remove stop words, short words, and duplicates
        filtered = []
        seen = set()
        for term in terms:
            term_lower = term.lower()
            # Skip if: stop word, too short, already seen, or contains digits only
            if (term_lower in stop_words or
                len(term) < 4 or
                term_lower in seen or
                term.isdigit()):
                continue
            seen.add(term_lower)
            filtered.append(term)

        return filtered[:5]  # Top 5 meaningful terms

    def _default_discovery_steps(self, user_input: str) -> List[PlanStep]:
        """
        MINIMAL, SMART discovery - quality over quantity.

        PHILOSOPHY:
        - Fewer steps are better (each step costs time and tokens)
        - Only add steps that directly help answer the user's question
        - Never search for random words from the user's message

        Strategy:
        1. If files explicitly mentioned → search for them directly
        2. If asking about code concepts → search for technical terms only
        3. Maximum 3-4 discovery steps
        """
        steps = []
        step_num = 1

        # Extract file mentions (e.g., "planner.py", "@agent.py")
        file_mentions = self._extract_file_mentions(user_input)
        # Extract meaningful technical terms (CamelCase, snake_case, etc.)
        key_terms = self._extract_key_terms(user_input)

        if file_mentions:
            # User explicitly mentioned files - search and read them
            # Combine search and read into fewer steps
            for file_pattern in file_mentions[:2]:  # Max 2 files
                steps.append(
                    PlanStep(
                        step_num=step_num,
                        objective=f"Find and read '{file_pattern}'",
                        tool_hint="search_filesystem",
                        tool_args_hint={"pattern": file_pattern, "path": "."},
                        success_criteria=SuccessCriteria(
                            description=f"Located {file_pattern}",
                            required_outputs=["search_filesystem_output"]
                        ),
                        phase=PlanPhase.DISCOVERY,
                        max_tool_calls=2
                    )
                )
                step_num += 1

        elif key_terms:
            # User is asking about code concepts - search for technical terms
            # Only search for the most meaningful term
            primary_term = key_terms[0]
            steps.append(
                PlanStep(
                    step_num=step_num,
                    objective=f"Search codebase for '{primary_term}'",
                    tool_hint="search_filesystem",
                    tool_args_hint={"pattern": primary_term, "path": "."},
                    success_criteria=SuccessCriteria(
                        description=f"Found files related to '{primary_term}'",
                        required_outputs=["search_filesystem_output"]
                    ),
                    phase=PlanPhase.DISCOVERY,
                    max_tool_calls=2
                )
            )
            step_num += 1

        else:
            # No specific terms found - do minimal exploration
            # Just list the structure, don't do random searches
            steps.append(
                PlanStep(
                    step_num=step_num,
                    objective="List repository structure",
                    tool_hint="list_files",
                    tool_args_hint={"path": "."},
                    success_criteria=SuccessCriteria(
                        description="Repository structure enumerated",
                        required_outputs=["list_files_output"]
                    ),
                    phase=PlanPhase.DISCOVERY,
                    max_tool_calls=1
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


__all__ = [
    "Planner",
    "Executor",
    "Reflector",
    "Plan",
    "PlanStep",
    "SuccessCriteria",
    "StepContext",
    "PlanStatus",
    "PlanPhase",
    "ToolCallRecord",
    "ValidationResult",
    "StepResult",
    "ExecutionTrace",
    "Reflection",
    "PLANNING_PROMPT",
    "REFLECTION_PROMPT",
]
