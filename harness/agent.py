"""
Agent - Main reasoning and tool execution agent.
Handles user requests with tool usage and LLM reasoning.
"""

import json
import time
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Generator, Callable
from enum import Enum

from .config import AgentConfig, LLMConfig
from .llm_adapter import (
    LLMAdapter, create_adapter, Message, MessageRole,
    LLMResponse, ToolCall, ToolDefinition
)
from .tool_registry import ToolRegistry, ToolResult, ToolStatus
from .logger import get_logger


class AgentState(Enum):
    """Agent execution states"""
    IDLE = "idle"
    THINKING = "thinking"
    EXECUTING_TOOL = "executing_tool"
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

    def to_dict(self) -> Dict[str, Any]:
        return {
            "content": self.content,
            "structured_action": self.structured_action,
            "steps": [s.to_dict() for s in self.steps],
            "total_duration_ms": self.total_duration_ms,
            "tools_used": self.tools_used,
            "success": self.success,
            "error": self.error,
            "metadata": self.metadata
        }


class Agent:
    """
    Main reasoning and execution agent.
    Uses LLM for decision-making and tools for actions.
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

        # Use provided LLM config or agent's config
        self._llm_config = llm_config or config.llm_config
        self._llm: Optional[LLMAdapter] = None
        if self._llm_config:
            self._llm = create_adapter(self._llm_config)

        # Conversation history
        self._conversation: List[Message] = []
        self._max_conversation_length = 20

        # Execution state
        self._current_state = AgentState.IDLE
        self._step_count = 0
        self._steps: List[AgentStep] = []

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

        # CRITICAL: Record step BEFORE execution so progress callbacks fire immediately
        # This allows ServiceRep to speak "Searching now..." before the actual search
        self._record_step(step)

        result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)

        # Update step with results after execution
        step.tool_output = result.output if result.is_success else result.error
        step.duration_ms = (time.time() - start_time) * 1000
        step.error = result.error if not result.is_success else None

        if result.is_success:
            self.logger.tool_result(tool_call.name, result.output, step.duration_ms)
        else:
            self.logger.tool_error(tool_call.name, Exception(result.error or "Unknown"))

        return result

    def _process_tool_calls(self, tool_calls: List[ToolCall]) -> List[Dict[str, Any]]:
        """Process multiple tool calls and return results (with de-duplication)"""
        results = []
        seen_calls = set()  # Track (name, args_hash) to prevent duplicates

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
            results.append({
                "tool_call_id": tool_call.id,
                "name": tool_call.name,
                "result": result.output if result.is_success else f"Error: {result.error}",
                "success": result.is_success
            })
        return results

    def run(self, user_input: str, context: Optional[str] = None) -> AgentResponse:
        """
        Run the agent on user input with tier-appropriate tool limits.

        Args:
            user_input: The user's request
            context: Optional additional context

        Returns:
            AgentResponse with content and execution details
        """
        if not self._llm:
            return AgentResponse(
                content="Agent not properly configured. No LLM available.",
                success=False,
                error="No LLM configured"
            )

        start_time = time.time()
        self._current_state = AgentState.THINKING
        self._step_count = 0
        self._steps = []
        tools_used = []
        total_tool_calls = 0
        max_tool_calls = self.config.max_tool_calls
        input_lower = user_input.lower()
        wants_search = any(
            phrase in input_lower
            for phrase in ["search", "look up", "lookup", "google", "find", "check online", "look online"]
        )

        # Build messages
        messages = [Message(MessageRole.SYSTEM, self._build_system_prompt())]
        messages.extend(self._conversation)

        # Add context if provided
        if context:
            user_input = f"{user_input}\n\nContext: {context}"

        messages.append(Message(MessageRole.USER, user_input))

        # Decide whether tools are allowed for this request
        needs_realtime = self._needs_realtime_data(user_input)
        # Only allow tools when we truly need external/fresh data or the user asked to search
        allow_tools = max_tool_calls > 0 and (needs_realtime or wants_search)
        if not allow_tools:
            max_tool_calls = 0
        tool_definitions = self._get_tool_definitions() if allow_tools else []

        try:
            # Initial LLM call
            self._emit_thought("Processing request...")

            # CRITICAL: If this looks like a query that NEEDS real-time data, force tool usage
            tool_choice = None
            if needs_realtime and tool_definitions:
                # Force the model to use fast_answer for real-time queries
                fast_answer = next((t for t in tool_definitions if t.name == "fast_answer"), None)
                if fast_answer:
                    tool_choice = {"type": "function", "function": {"name": "fast_answer"}}
                    self.logger.info(f"Forcing fast_answer tool for real-time query", component="agent")

            response = self._llm.complete(
                messages,
                tools=tool_definitions if max_tool_calls > 0 else None,
                tool_choice=tool_choice
            )

            # Record thinking step
            thinking_step = AgentStep(
                step_number=self._step_count,
                state=AgentState.THINKING,
                thought=response.content[:200] if response.content else "Thinking..."
            )
            self._step_count += 1
            self._record_step(thinking_step)

            # If tools are disallowed, force the model to answer without them
            if response.has_tool_calls and max_tool_calls == 0:
                response = self._llm.complete(messages, tools=None)

            # Process tool calls with STRICT limit enforcement
            while response.has_tool_calls and max_tool_calls > 0 and total_tool_calls < max_tool_calls:
                # CRITICAL: Limit number of parallel tool calls per iteration
                tool_calls_this_round = response.tool_calls[:max(1, max_tool_calls - total_tool_calls)]

                self._emit_thought(f"Using tool: {tool_calls_this_round[0].name}")

                # Execute tools (limited)
                tool_results = self._process_tool_calls(tool_calls_this_round)
                tools_used.extend([tr["name"] for tr in tool_results])
                total_tool_calls += len(tool_results)

                # Add assistant message with tool calls
                messages.append(Message(
                    role=MessageRole.ASSISTANT,
                    content=response.content or "",
                    tool_calls=[{
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)}
                    } for tc in tool_calls_this_round]
                ))

                # Add tool results
                for tr in tool_results:
                    messages.append(Message(
                        role=MessageRole.TOOL,
                        content=str(tr["result"])[:2000],  # Limit result size
                        tool_call_id=tr["tool_call_id"],
                        name=tr["name"]
                    ))

                # Check if we've hit the limit - if so, force final answer
                if total_tool_calls >= max_tool_calls:
                    self._emit_thought(f"Tool limit reached ({max_tool_calls}), generating final answer")
                    # Don't pass tools to force a text-only response
                    response = self._llm.complete(messages, tools=None)
                    break

                # Get next response (may include more tool calls)
                self._current_state = AgentState.GENERATING_RESPONSE
                response = self._llm.complete(messages, tools=tool_definitions)

            # Final response
            self._current_state = AgentState.COMPLETE
            final_content = response.content or "I apologize, I couldn't generate a response."

            # Update conversation history
            self._add_message(Message(MessageRole.USER, user_input))
            self._add_message(Message(MessageRole.ASSISTANT, final_content))

            total_duration = (time.time() - start_time) * 1000

            self.logger.agent_decision(
                f"Completed with {total_tool_calls} tool calls (limit: {max_tool_calls})",
                tools=tools_used
            )

            return AgentResponse(
                content=final_content,
                structured_action=None,  # Removed ACTION: requirement
                steps=self._steps,
                total_duration_ms=total_duration,
                tools_used=list(set(tools_used)),
                success=True,
                metadata={
                    "model": self._llm_config.model if self._llm_config else None,
                    "tool_calls": total_tool_calls,
                    "max_tool_calls": max_tool_calls
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
                total_duration_ms=(time.time() - start_time) * 1000
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
                success=True
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
# TIER-SPECIFIC SYSTEM PROMPTS - Critical for appropriate response complexity
# =============================================================================

SIMPLE_TIER_PROMPT = """You are a fast assistant. Answer from your own knowledge unless the user explicitly asks for a lookup or the request is about fresh data (time/date/weather/stocks/news).

Principles:
- Be decisive and brief (under 40 words).
- ZERO tools unless the user asks you to search OR it’s clearly fresh-data. If you must fetch, call fast_answer once, then answer.
- No preambles; just give the answer.

Available tools (use only if necessary):
{tools}"""

STANDARD_TIER_PROMPT = """You are a capable assistant. Optimize for fast, accurate answers with minimal tool use.

Principles:
- First, answer directly if you can. Only reach for tools when data is missing, stale, or explicitly requested.
- If you need to search, prefer fast_answer and keep tool calls to the minimum required (max 3, but aim for 1).
- Keep responses concise and clear; avoid boilerplate.

Available tools:
{tools}"""

ADVANCED_TIER_PROMPT = """You are an expert assistant for complex tasks. Optimize for correctness and clarity.

Principles:
- Quickly outline the plan in your head, then execute. Use tools only where they add real evidence or fresh data.
- Prefer fewer, high-impact tool calls (max 10). Avoid trivial tool calls (e.g., time) unless requested.
- Double-check critical facts; provide a crisp, helpful final answer.

Available tools:
{tools}"""

# Tool call limits by tier
TIER_TOOL_LIMITS = {
    "simple": 1,      # ONE tool call max - answer quickly
    "standard": 3,    # Reasonable for most tasks
    "advanced": 10    # Complex research/multi-step
}

# Max tokens by tier - keep latency low
TIER_MAX_TOKENS = {
    "simple": 1500,
    "standard": 4000,
    "advanced": 8000
}


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

        if tier == "simple":
            return SIMPLE_TIER_PROMPT.format(tools=tool_descriptions)
        elif tier == "advanced":
            return ADVANCED_TIER_PROMPT.format(tools=tool_descriptions)
        else:
            return STANDARD_TIER_PROMPT.format(tools=tool_descriptions)

    def _get_agent(self, tier: str) -> Agent:
        """Get or create agent for tier with tier-specific config"""
        if tier not in self._agents:
            base_llm_config = self.tier_configs.get(tier, self.tier_configs.get("standard"))

            # Clone LLM config with tier-specific max_tokens
            # CRITICAL: This prevents simple queries from generating 1000+ tokens
            from .config import LLMConfig
            tier_max_tokens = TIER_MAX_TOKENS.get(tier, 500)
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
            tier_config = AgentConfig(
                llm_config=llm_config,
                tier=tier,
                system_prompt=self._get_tier_prompt(tier),
                max_tool_calls=TIER_TOOL_LIMITS.get(tier, 3),
                tool_timeout=self.config.tool_timeout,
                allow_code_execution=self.config.allow_code_execution,
                allow_internet=self.config.allow_internet,
                allow_bash=self.config.allow_bash
            )

            self.logger.info(
                f"Creating {tier} tier agent (max_tokens={tier_max_tokens}, max_tools={TIER_TOOL_LIMITS.get(tier, 3)})",
                component="agent"
            )

            self._agents[tier] = Agent(tier_config, self.tool_registry, llm_config)
        return self._agents[tier]

    def run(self, user_input: str, tier: str = None, context: Optional[str] = None) -> AgentResponse:
        """Run with specified tier and tier-appropriate behavior"""
        tier = tier or self._current_tier

        self.logger.info(
            f"Running agent at tier '{tier}' (max {TIER_TOOL_LIMITS.get(tier, 3)} tool calls)",
            component="agent"
        )

        agent = self._get_agent(tier)
        return agent.run(user_input, context)

    def set_tier(self, tier: str):
        """Set default tier"""
        self._current_tier = tier

    @property
    def current_tier(self) -> str:
        return self._current_tier
