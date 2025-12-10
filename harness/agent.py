"""
Agent - Main reasoning and tool execution agent.
Handles user requests with tool usage and LLM reasoning.

Architecture: Plan → Execute → Reflect
- Planner: Creates explicit execution plans with success criteria
- Executor: Runs plans step-by-step with validation
- Reflector: Evaluates if goal was actually achieved
"""

import json
import time
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Generator, Callable
from enum import Enum

from .config import AgentConfig, LLMConfig, DEFAULT_TIER_TOOL_LIMITS, DEFAULT_TIER_MAX_TOKENS
from .llm_adapter import (
    LLMAdapter, create_adapter, Message, MessageRole,
    LLMResponse, ToolCall, ToolDefinition
)
from .tool_registry import ToolRegistry, ToolResult, ToolStatus
from .logger import get_logger
from .agent_execution_logger import get_execution_logger
from .planner import Planner, Executor, Reflector, Plan, ExecutionTrace, Reflection, PlanStatus


class AgentState(Enum):
    """Agent execution states"""
    IDLE = "idle"
    PLANNING = "planning"
    THINKING = "thinking"
    EXECUTING_TOOL = "executing_tool"
    REFLECTING = "reflecting"
    GENERATING_RESPONSE = "generating_response"
    COMPLETE = "complete"
    ERROR = "error"


@dataclass
class AgentStep:
    """A single step in agent execution"""
    step_number: int
    state: AgentState
    thought: Optional[str] = None
    tool_name: Optional[str] = None
    tool_input: Optional[Dict[str, Any]] = None
    tool_output: Optional[Any] = None
    response: Optional[str] = None
    duration_ms: float = 0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "step": self.step_number,
            "state": self.state.value,
            "thought": self.thought,
            "tool_name": self.tool_name,
            "tool_input": self.tool_input,
            "tool_output": str(self.tool_output)[:500] if self.tool_output else None,
            "response": self.response,
            "duration_ms": self.duration_ms,
            "error": self.error
        }


@dataclass
class AgentResponse:
    """Response from the agent"""
    content: str                          # The spoken/displayed response
    structured_action: Optional[str] = None  # Description of action taken (for ServiceRep)
    steps: List[AgentStep] = field(default_factory=list)
    total_duration_ms: float = 0
    tools_used: List[str] = field(default_factory=list)
    success: bool = True
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    # Plan/Execute/Reflect tracking
    plan: Optional[Plan] = None
    reflection: Optional[Reflection] = None
    goal_achieved: bool = True            # Did we actually achieve the user's goal?

    def to_dict(self) -> Dict[str, Any]:
        return {
            "content": self.content,
            "structured_action": self.structured_action,
            "steps": [s.to_dict() for s in self.steps],
            "total_duration_ms": self.total_duration_ms,
            "tools_used": self.tools_used,
            "success": self.success,
            "error": self.error,
            "metadata": self.metadata,
            "goal_achieved": self.goal_achieved,
            "plan": self.plan.to_dict() if self.plan else None
        }


class Agent:
    """
    Main reasoning and execution agent.
    Uses Plan → Execute → Reflect architecture for structured execution.
    """

    def __init__(
        self,
        config: AgentConfig,
        tool_registry: ToolRegistry,
        llm_config: Optional[LLMConfig] = None
    ):
        self.config = config
        self.tool_registry = tool_registry
        self.logger = get_logger()
        self.exec_logger = get_execution_logger()

        # Use provided LLM config or agent's config
        self._llm_config = llm_config or config.llm_config
        self._llm: Optional[LLMAdapter] = None
        if self._llm_config:
            self._llm = create_adapter(self._llm_config)

        # Plan/Execute/Reflect components
        self._planner: Optional[Planner] = None
        self._executor: Optional[Executor] = None
        self._reflector: Optional[Reflector] = None
        if self._llm:
            self._planner = Planner(self._llm, tool_registry)
            self._executor = Executor(self._llm, tool_registry, config.max_tool_calls)
            self._reflector = Reflector(self._llm)

        # Conversation history
        self._conversation: List[Message] = []
        self._max_conversation_length = 20

        # Execution state
        self._current_state = AgentState.IDLE
        self._step_count = 0
        self._steps: List[AgentStep] = []
        self._file_operations: List[Dict[str, Any]] = []

        # Callbacks
        self._step_callbacks: List[Callable[[AgentStep], None]] = []
        self._thought_callbacks: List[Callable[[str], None]] = []

    def _build_system_prompt(self) -> str:
        """Build system prompt - uses tier-specific prompt from config"""
        # The system prompt should already be tier-specific from TieredAgent
        # Just return it directly without adding extra verbose instructions
        return self.config.system_prompt

    def _needs_realtime_data(self, user_input: str) -> bool:
        """
        Detect if the query requires real-time data (weather, stocks, news, etc.)
        These queries MUST use tools - the model cannot answer from memory.
        """
        input_lower = user_input.lower()

        # Keywords that indicate real-time data is needed
        realtime_keywords = [
            "weather", "temperature", "forecast", "rain", "sunny", "cloudy",
            "stock", "price", "market", "trading", "shares",
            "news", "today", "current", "right now", "latest",
            "score", "game", "match", "playing",
            "traffic", "flight", "status",
            "bitcoin", "crypto", "btc", "eth",
            "exchange rate", "currency"
        ]

        return any(keyword in input_lower for keyword in realtime_keywords)

    def _needs_file_tools(self, user_input: str) -> bool:
        """
        Detect if the query clearly requires file system operations.
        """
        input_lower = user_input.lower()

        trigger_phrases = [
            "create file", "write file", "append file", "new file",
            "add file", "make file", "generate file", "remove file",
            "delete file", "edit file", "save file", "open file",
            "create folder", "create directory", "write script",
            "save script", "create test", "generate script"
        ]

        if any(phrase in input_lower for phrase in trigger_phrases):
            return True

        verbs = ["create", "write", "append", "add", "save", "edit", "update", "delete", "remove", "generate"]
        nouns = ["file", "folder", "directory", "script", "code", "config", "project"]

        if any(verb in input_lower for verb in verbs) and any(noun in input_lower for noun in nouns):
            return True

        return False

    def _get_tool_definitions(self) -> List[ToolDefinition]:
        """Get tool definitions for LLM"""
        return self.tool_registry.get_definitions(enabled_only=True)

    def _add_message(self, message: Message):
        """Add message to conversation history"""
        self._conversation.append(message)

        # Trim conversation if too long
        if len(self._conversation) > self._max_conversation_length:
            # Keep system message and recent messages
            system_msgs = [m for m in self._conversation if m.role == MessageRole.SYSTEM]
            other_msgs = [m for m in self._conversation if m.role != MessageRole.SYSTEM]
            self._conversation = system_msgs + other_msgs[-(self._max_conversation_length - len(system_msgs)):]

    def _record_step(self, step: AgentStep):
        """Record an execution step"""
        self._steps.append(step)
        for callback in self._step_callbacks:
            try:
                callback(step)
            except Exception as e:
                self.logger.error(f"Step callback error: {e}", component="agent")

    def _record_file_operation(self, path: str, tool_name: str, action: str):
        """Track file operations requested by tools"""
        if not path:
            return
        entry = {
            "path": path,
            "tool": tool_name,
            "action": action,
            "timestamp": time.time()
        }
        self._file_operations.append(entry)
        self.logger.file_operation(
            "agent_file",
            path,
            status="noted",
            detail=f"tool={tool_name} action={action}",
            component="agent"
        )

    def _emit_thought(self, thought: str):
        """Emit a thought to callbacks"""
        self.logger.agent_thinking(thought)
        for callback in self._thought_callbacks:
            try:
                callback(thought)
            except Exception as e:
                self.logger.error(f"Thought callback error: {e}", component="agent")

    def _extract_action_description(self, content: str) -> tuple:
        """
        Extract action description and remaining content.
        Returns (action_description, remaining_content)
        """
        if "ACTION:" in content:
            parts = content.split("---", 1)
            action_part = parts[0]
            remaining = parts[1] if len(parts) > 1 else ""

            # Extract action text
            action_lines = action_part.split("ACTION:", 1)
            if len(action_lines) > 1:
                action = action_lines[1].strip()
                return action, remaining.strip()

        return None, content

    def _execute_tool(self, tool_call: ToolCall) -> ToolResult:
        """Execute a single tool call"""
        self._current_state = AgentState.EXECUTING_TOOL
        start_time = time.time()

        step = AgentStep(
            step_number=self._step_count,
            state=AgentState.EXECUTING_TOOL,
            tool_name=tool_call.name,
            tool_input=tool_call.arguments
        )
        self._step_count += 1

        # Log tool call start
        self.logger.tool_call_start([{"name": tool_call.name, "params": tool_call.arguments}])

        # CRITICAL: Record step BEFORE execution so progress callbacks fire immediately
        # This allows ServiceRep to speak "Searching now..." before the actual search
        self._record_step(step)

        result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)

        # Update step with results after execution
        step.tool_output = result.output if result.is_success else result.error
        step.duration_ms = (time.time() - start_time) * 1000
        step.error = result.error if not result.is_success else None

        if result.is_success:
            self.logger.tool_call_end(tool_call.name, True, step.duration_ms, str(result.output)[:100])
        else:
            self.logger.tool_call_end(tool_call.name, False, step.duration_ms, result.error)

        metadata = result.metadata or {}
        paths = []
        if metadata.get("path"):
            paths.append(metadata["path"])
        if metadata.get("paths"):
            additional = metadata["paths"]
            if isinstance(additional, list):
                paths.extend(additional)
            else:
                paths.append(additional)
        action = metadata.get("action", tool_call.name)
        for path in paths:
            self._record_file_operation(path, tool_call.name, action)

        return result

    def _process_tool_calls(self, tool_calls: List[ToolCall]) -> tuple:
        """Process multiple tool calls and return (results, any_failed)"""
        results = []
        seen_calls = set()  # Track (name, args_hash) to prevent duplicates
        any_failed = False

        for tool_call in tool_calls:
            # De-duplicate: skip if we've already called this tool with same args
            args_key = (tool_call.name, json.dumps(tool_call.arguments, sort_keys=True))
            if args_key in seen_calls:
                self.logger.warning(
                    f"Skipping duplicate tool call: {tool_call.name}",
                    component="agent"
                )
                continue
            seen_calls.add(args_key)

            result = self._execute_tool(tool_call)
            if not result.is_success:
                any_failed = True
            results.append({
                "tool_call_id": tool_call.id,
                "name": tool_call.name,
                "result": result.output if result.is_success else f"Error: {result.error}",
                "success": result.is_success
            })
        return results, any_failed

    def run(self, user_input: str, context: Optional[str] = None) -> AgentResponse:
        """
        Run the agent using Plan → Execute → Reflect architecture.

        1. PLAN: Create explicit execution plan with success criteria
        2. EXECUTE: Run the plan step by step
        3. REFLECT: Evaluate if the goal was actually achieved

        Args:
            user_input: The user's request
            context: Optional additional context

        Returns:
            AgentResponse with content, plan, and reflection
        """
        if not self._llm:
            return AgentResponse(
                content="Agent not properly configured. No LLM available.",
                success=False,
                error="No LLM configured"
            )

        start_time = time.time()
        self._step_count = 0
        self._steps = []
        self._file_operations = []

        # Build messages
        system_prompt = self._build_system_prompt()
        messages = [Message(MessageRole.SYSTEM, system_prompt)]
        messages.extend(self._conversation)

        # Add context if provided
        full_input = user_input
        if context:
            full_input = f"{user_input}\n\nContext: {context}"
        messages.append(Message(MessageRole.USER, full_input))

        # Get tool definitions
        tool_definitions = self._get_tool_definitions()

        # ========== LOG FULL AGENT CONTEXT ==========
        req_id = self.logger.request_id or "no-req"
        exec_id = self.exec_logger.new_execution_id(req_id)

        self.exec_logger.log_agent_context(
            req_id=req_id,
            exec_id=exec_id,
            user_input=full_input,
            tier=self.config.tier,
            system_prompt=system_prompt,
            conversation_history=[
                {"role": m.role.value, "content": m.content[:500] if m.content else ""}
                for m in self._conversation
            ],
            tool_definitions=[
                {
                    "name": td.get("function", {}).get("name") if isinstance(td, dict) else getattr(td, "name", "unknown"),
                    "description": td.get("function", {}).get("description", "")[:200] if isinstance(td, dict) else getattr(td, "description", "")[:200]
                }
                for td in tool_definitions
            ],
            additional_context={"context_provided": context} if context else None
        )

        try:
            # ========== PHASE 1: PLANNING ==========
            self._current_state = AgentState.PLANNING
            self._emit_thought("Creating execution plan...")

            plan = self._planner.create_plan(
                user_input=user_input,
                context=context,
                tier=self.config.tier,
                exec_id=exec_id  # Pass exec_id for logging
            )

            self.logger.plan_created(
                f"Plan: {plan.goal_type} - {plan.goal[:60]}",
                tools=[s.tool_hint for s in plan.steps if s.tool_hint]
            )

            # ========== LOG PLANNING RESULT ==========
            self.exec_logger.log_planning_result(
                req_id=req_id,
                exec_id=exec_id,
                goal=plan.goal,
                goal_type=plan.goal_type,
                requires_tools=plan.requires_tools,
                steps=[
                    {
                        "step_num": s.step_num,
                        "objective": s.objective,
                        "tool_hint": s.tool_hint,
                        "tool_args_hint": s.tool_args_hint,
                        "success_criteria": s.success_criteria.description if s.success_criteria else None,
                        "depends_on": s.depends_on,
                        "status": s.status.value
                    }
                    for s in plan.steps
                ],
                success_criteria=plan.success_criteria.description,
                estimated_complexity=plan.estimated_complexity,
                reasoning=plan.reasoning,
                plan_status=plan.status.value
            )

            # Record planning step
            planning_step = AgentStep(
                step_number=self._step_count,
                state=AgentState.PLANNING,
                thought=f"Plan: {plan.goal} ({len(plan.steps)} steps)"
            )
            self._step_count += 1
            self._record_step(planning_step)

            # ========== PHASE 2: EXECUTION ==========
            self._current_state = AgentState.THINKING
            self._emit_thought(f"Executing plan: {plan.goal[:50]}...")

            trace = self._executor.execute(
                plan=plan,
                messages=messages,
                tools=tool_definitions if plan.requires_tools else [],
                req_id=req_id,
                exec_id=exec_id
            )

            final_content = trace.final_response or "I apologize, I couldn't generate a response."

            # Record tool steps in our step list
            for plan_step in trace.steps_executed:
                if plan_step.tool_hint:
                    agent_step = AgentStep(
                        step_number=self._step_count,
                        state=AgentState.EXECUTING_TOOL,
                        tool_name=plan_step.tool_hint,
                        tool_output=plan_step.result,
                        duration_ms=plan_step.duration_ms,
                        error=plan_step.error
                    )
                    self._step_count += 1
                    self._record_step(agent_step)

            # Update conversation history
            self._add_message(Message(MessageRole.USER, full_input))
            self._add_message(Message(MessageRole.ASSISTANT, final_content))

            # ========== PHASE 3: REFLECTION ==========
            self._current_state = AgentState.REFLECTING

            reflection = self._reflector.reflect(plan, trace)

            # Log reflection result
            status = "completed" if reflection.goal_achieved else "failed"
            if trace.had_failures and reflection.goal_achieved:
                status = "partial"

            self.logger.reflection(
                goal_achieved=reflection.goal_achieved,
                confidence=reflection.confidence,
                gaps=reflection.gaps
            )

            # ========== BUILD RESPONSE ==========
            self._current_state = AgentState.COMPLETE
            total_duration = (time.time() - start_time) * 1000

            # Determine success based on reflection
            actual_success = reflection.goal_achieved
            failure_reason = None if actual_success else "; ".join(reflection.gaps) if reflection.gaps else "Goal not achieved"

            return AgentResponse(
                content=final_content,
                structured_action=plan.goal,
                steps=self._steps,
                total_duration_ms=total_duration,
                tools_used=[s.tool_hint for s in trace.steps_executed if s.tool_hint],
                success=actual_success,
                error=failure_reason,
                plan=plan,
                reflection=reflection,
                goal_achieved=reflection.goal_achieved,
                metadata={
                    "model": self._llm_config.model if self._llm_config else None,
                    "tool_calls": trace.tool_calls,
                    "tool_failures": trace.tool_failures,
                    "llm_calls": trace.llm_calls,
                    "max_tool_calls": self.config.max_tool_calls,
                    "file_operations": list(self._file_operations),
                    "had_tool_failures": trace.had_failures,
                    "status": status,
                    "plan_type": plan.goal_type,
                    "reflection_confidence": reflection.confidence
                }
            )

        except Exception as e:
            self._current_state = AgentState.ERROR
            self.logger.error(f"Agent execution failed: {e}", component="agent")

            return AgentResponse(
                content=f"I encountered an error: {str(e)}",
                success=False,
                error=str(e),
                steps=self._steps,
                total_duration_ms=(time.time() - start_time) * 1000,
                goal_achieved=False
            )

    def run_streaming(
        self,
        user_input: str,
        context: Optional[str] = None
    ) -> Generator[str, None, AgentResponse]:
        """
        Run agent with streaming output.
        Yields content chunks as they arrive.
        """
        if not self._llm:
            yield "Agent not properly configured."
            return AgentResponse(
                content="Agent not properly configured.",
                success=False,
                error="No LLM configured"
            )

        start_time = time.time()
        self._current_state = AgentState.THINKING
        self._step_count = 0
        self._steps = []
        tools_used = []
        full_content = ""
        self._file_operations = []

        # Build messages
        messages = [Message(MessageRole.SYSTEM, self._build_system_prompt())]
        messages.extend(self._conversation)

        if context:
            user_input = f"{user_input}\n\nContext: {context}"

        messages.append(Message(MessageRole.USER, user_input))
        tool_definitions = self._get_tool_definitions()

        try:
            # Stream initial response
            response = None
            for chunk in self._llm.stream(messages, tools=tool_definitions):
                full_content += chunk
                yield chunk
                response = chunk  # Will be replaced with final response

            # Get the actual response object (returned from generator)
            # For now, do a non-streaming call if we need tool handling
            response = self._llm.complete(messages, tools=tool_definitions)

            # Handle tool calls (non-streaming for tool execution)
            iteration = 0
            while response.has_tool_calls and iteration < self.config.max_tool_calls:
                iteration += 1

                yield f"\n[Using tools: {', '.join(tc.name for tc in response.tool_calls)}]\n"

                tool_results = self._process_tool_calls(response.tool_calls)
                tools_used.extend([tr["name"] for tr in tool_results])

                messages.append(Message(
                    role=MessageRole.ASSISTANT,
                    content=response.content,
                    tool_calls=[{
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)}
                    } for tc in response.tool_calls]
                ))

                for tr in tool_results:
                    messages.append(Message(
                        role=MessageRole.TOOL,
                        content=str(tr["result"]),
                        tool_call_id=tr["tool_call_id"],
                        name=tr["name"]
                    ))

                # Stream next response
                for chunk in self._llm.stream(messages, tools=tool_definitions):
                    full_content += chunk
                    yield chunk

                response = self._llm.complete(messages, tools=tool_definitions)

            # Update conversation
            self._add_message(Message(MessageRole.USER, user_input))
            self._add_message(Message(MessageRole.ASSISTANT, full_content))

            self._current_state = AgentState.COMPLETE

            return AgentResponse(
                content=full_content,
                steps=self._steps,
                total_duration_ms=(time.time() - start_time) * 1000,
                tools_used=list(set(tools_used)),
                success=True,
                metadata={"file_operations": list(self._file_operations)}
            )

        except Exception as e:
            self._current_state = AgentState.ERROR
            yield f"\nError: {str(e)}"

            return AgentResponse(
                content=full_content + f"\nError: {str(e)}",
                success=False,
                error=str(e),
                total_duration_ms=(time.time() - start_time) * 1000
            )

    def reset_conversation(self):
        """Reset conversation history"""
        self._conversation = []

    def add_step_callback(self, callback: Callable[[AgentStep], None]):
        """Add callback for execution steps"""
        self._step_callbacks.append(callback)

    def add_thought_callback(self, callback: Callable[[str], None]):
        """Add callback for agent thoughts"""
        self._thought_callbacks.append(callback)

    @property
    def state(self) -> AgentState:
        """Get current agent state"""
        return self._current_state

    @property
    def conversation_history(self) -> List[Dict[str, str]]:
        """Get conversation history as list of dicts"""
        return [{"role": m.role.value, "content": m.content} for m in self._conversation]


# =============================================================================
# TIER-SPECIFIC SYSTEM PROMPTS - Loaded from config
# =============================================================================

def _load_tier_prompts():
    """Load tier-specific prompts from config file"""
    import json
    from pathlib import Path

    config_path = Path(__file__).parent.parent / "config" / "prompts_config.json"
    try:
        with open(config_path, 'r') as f:
            data = json.load(f)
            return data.get("agent_tier_prompts", {})
    except Exception:
        # Fallback to hardcoded defaults if config fails to load
        return {
            "simple": "You are a fast assistant. Answer from your own knowledge unless the user explicitly asks for a lookup or the request is about fresh data (time/date/weather/stocks/news).\n\nPrinciples:\n- Be decisive and brief (under 40 words).\n- ZERO tools unless the user asks you to search OR it's clearly fresh-data. If you must fetch, call fast_answer once, then answer.\n- No preambles; just give the answer.\n\nAvailable tools (use only if necessary):\n{tools}",
            "standard": "You are a capable assistant. Optimize for fast, accurate answers with minimal tool use.\n\nPrinciples:\n- First, answer directly if you can. Only reach for tools when data is missing, stale, or explicitly requested.\n- If you need to search, prefer fast_answer and keep tool calls to the minimum required (max 3, but aim for 1).\n- Keep responses concise and clear; avoid boilerplate.\n\nAvailable tools:\n{tools}",
            "advanced": "You are an expert personal CLI assistant for complex tasks. Optimize for correctness and clarity.\n\nPrinciples:\n- Quickly outline the plan. This could be multiple steps and also could require discovery if called from an existing system. You are highly capable of multi-turn robust plans and should be very detail oriented for complex tasks. Use tools only where they add real evidence or fresh data.\n- Prefer fewer, high-impact tool calls (max 10). Avoid trivial tool calls (e.g., time) unless requested.\n- Double-check critical facts; provide a crisp, helpful final answer.\n\nAvailable tools:\n{tools}"
        }

# Load tier prompts from config
_TIER_PROMPTS = _load_tier_prompts()

# Tool call limits and max tokens are driven by the JSON config defaults above
TIER_TOOL_LIMITS = DEFAULT_TIER_TOOL_LIMITS
TIER_MAX_TOKENS = DEFAULT_TIER_MAX_TOKENS


class TieredAgent:
    """
    Agent that operates with tier-specific behavior.
    Each tier has different prompts, tool limits, and response styles.
    """

    def __init__(
        self,
        config: AgentConfig,
        tool_registry: ToolRegistry,
        tier_configs: Dict[str, LLMConfig]
    ):
        self.config = config
        self.tool_registry = tool_registry
        self.tier_configs = tier_configs
        self._agents: Dict[str, Agent] = {}
        self._current_tier = config.tier
        self.logger = get_logger()

    def _get_tier_prompt(self, tier: str) -> str:
        """Get the appropriate system prompt for the tier"""
        tools = self.tool_registry.list_tools(enabled_only=True)
        tool_descriptions = "\n".join([f"- {t.name}: {t.description}" for t in tools])

        # Get prompt template from config
        prompt_template = _TIER_PROMPTS.get(tier, _TIER_PROMPTS.get("standard"))
        return prompt_template.format(tools=tool_descriptions)

    def _get_agent(self, tier: str) -> Agent:
        """Get or create agent for tier with tier-specific config"""
        if tier not in self._agents:
            base_llm_config = self.tier_configs.get(tier, self.tier_configs.get("standard"))

            # Clone LLM config with tier-specific max_tokens
            # CRITICAL: This prevents simple queries from generating 1000+ tokens
            from .config import LLMConfig
            tier_max_tokens = self.config.tier_max_tokens.get(tier)
            if tier_max_tokens is None:
                llm_base_max = None
                if self.config.llm_config and getattr(self.config.llm_config, "max_tokens", None):
                    llm_base_max = self.config.llm_config.max_tokens
                tier_max_tokens = llm_base_max or DEFAULT_TIER_MAX_TOKENS.get(tier, 500)
            llm_config = LLMConfig(
                provider=base_llm_config.provider,
                model=base_llm_config.model,
                api_key=base_llm_config.api_key,
                api_base=base_llm_config.api_base,
                max_tokens=tier_max_tokens,  # TIER-SPECIFIC LIMIT
                max_completion_tokens=tier_max_tokens,  # Some models need this
                temperature=base_llm_config.temperature,
                top_p=base_llm_config.top_p,
                timeout=base_llm_config.timeout,
                max_retries=base_llm_config.max_retries,
                retry_delay=base_llm_config.retry_delay,
                streaming=base_llm_config.streaming
            )

            # Create modified config with tier-specific tool limits
            tool_limit = self.config.tier_tool_limits.get(tier)
            if tool_limit is None:
                tool_limit = self.config.max_tool_calls

            tier_config = AgentConfig(
                llm_config=llm_config,
                tier=tier,
                system_prompt=self._get_tier_prompt(tier),
                max_tool_calls=tool_limit,
                tool_timeout=self.config.tool_timeout,
                allow_code_execution=self.config.allow_code_execution,
                allow_internet=self.config.allow_internet,
                allow_bash=self.config.allow_bash
            )

            self.logger.system_init("agent", f"created_{tier}", {
                "max_tokens": tier_max_tokens,
                "max_tools": tool_limit
            })

            self._agents[tier] = Agent(tier_config, self.tool_registry, llm_config)
        return self._agents[tier]

    def run(self, user_input: str, tier: str = None, context: Optional[str] = None) -> AgentResponse:
        """Run with specified tier and tier-appropriate behavior"""
        tier = tier or self._current_tier

        tool_limit = self.config.tier_tool_limits.get(tier)
        if tool_limit is None:
            tool_limit = self.config.max_tool_calls

        self.logger.debug(f"Running agent at tier '{tier}' (max {tool_limit} tools)", component="agent")

        agent = self._get_agent(tier)
        return agent.run(user_input, context)

    def set_tier(self, tier: str):
        """Set default tier"""
        self._current_tier = tier

    @property
    def current_tier(self) -> str:
        return self._current_tier
