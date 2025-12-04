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
        """Build system prompt with tool information"""
        tools = self.tool_registry.list_tools(enabled_only=True)
        tool_descriptions = []
        for tool in tools:
            desc = f"- {tool.name}: {tool.description}"
            tool_descriptions.append(desc)

        tools_section = "\n".join(tool_descriptions) if tool_descriptions else "No tools available."

        return f"""{self.config.system_prompt}

Available tools:
{tools_section}

When responding:
1. First, briefly explain what you're going to do (this will be spoken to the user)
2. Then use tools if needed
3. Provide a clear, helpful response

Format your initial response as:
ACTION: <brief description of what you will do>
---
<your reasoning and tool usage>"""

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

        self.logger.tool_call(tool_call.name, tool_call.arguments)

        step = AgentStep(
            step_number=self._step_count,
            state=AgentState.EXECUTING_TOOL,
            tool_name=tool_call.name,
            tool_input=tool_call.arguments
        )
        self._step_count += 1

        result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)

        step.tool_output = result.output if result.is_success else result.error
        step.duration_ms = (time.time() - start_time) * 1000
        step.error = result.error if not result.is_success else None

        self._record_step(step)

        if result.is_success:
            self.logger.tool_result(tool_call.name, result.output, step.duration_ms)
        else:
            self.logger.tool_error(tool_call.name, Exception(result.error or "Unknown"))

        return result

    def _process_tool_calls(self, tool_calls: List[ToolCall]) -> List[Dict[str, Any]]:
        """Process multiple tool calls and return results"""
        results = []
        for tool_call in tool_calls:
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
        Run the agent on user input.

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

        # Build messages
        messages = [Message(MessageRole.SYSTEM, self._build_system_prompt())]
        messages.extend(self._conversation)

        # Add context if provided
        if context:
            user_input = f"{user_input}\n\nContext: {context}"

        messages.append(Message(MessageRole.USER, user_input))

        # Get tool definitions
        tool_definitions = self._get_tool_definitions()

        try:
            # Initial LLM call
            self._emit_thought("Processing user request...")

            response = self._llm.complete(messages, tools=tool_definitions)

            # Extract action description for ServiceRep
            action_description, _ = self._extract_action_description(response.content)

            # Record thinking step
            thinking_step = AgentStep(
                step_number=self._step_count,
                state=AgentState.THINKING,
                thought=response.content[:500]
            )
            self._step_count += 1
            self._record_step(thinking_step)

            # Process tool calls if any
            iteration = 0
            max_iterations = self.config.max_tool_calls

            while response.has_tool_calls and iteration < max_iterations:
                iteration += 1
                self._emit_thought(f"Using tools: {[tc.name for tc in response.tool_calls]}")

                # Execute tools
                tool_results = self._process_tool_calls(response.tool_calls)
                tools_used.extend([tr["name"] for tr in tool_results])

                # Add assistant message with tool calls
                messages.append(Message(
                    role=MessageRole.ASSISTANT,
                    content=response.content,
                    tool_calls=[{
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)}
                    } for tc in response.tool_calls]
                ))

                # Add tool results
                for tr in tool_results:
                    messages.append(Message(
                        role=MessageRole.TOOL,
                        content=str(tr["result"]),
                        tool_call_id=tr["tool_call_id"],
                        name=tr["name"]
                    ))

                # Get next response
                self._current_state = AgentState.GENERATING_RESPONSE
                response = self._llm.complete(messages, tools=tool_definitions)

                # Update action description if found
                new_action, _ = self._extract_action_description(response.content)
                if new_action:
                    action_description = new_action

            # Final response
            self._current_state = AgentState.COMPLETE

            # Clean up response content
            final_content = response.content
            if "---" in final_content:
                parts = final_content.split("---")
                final_content = parts[-1].strip() if len(parts) > 1 else parts[0]

            # Remove ACTION prefix if present
            if final_content.startswith("ACTION:"):
                lines = final_content.split("\n")
                final_content = "\n".join(lines[1:]).strip()

            # Update conversation history
            self._add_message(Message(MessageRole.USER, user_input))
            self._add_message(Message(MessageRole.ASSISTANT, response.content))

            total_duration = (time.time() - start_time) * 1000

            self.logger.agent_decision(
                f"Completed with {len(tools_used)} tool calls",
                tools=tools_used
            )

            return AgentResponse(
                content=final_content,
                structured_action=action_description,
                steps=self._steps,
                total_duration_ms=total_duration,
                tools_used=list(set(tools_used)),
                success=True,
                metadata={
                    "model": self._llm_config.model if self._llm_config else None,
                    "iterations": iteration
                }
            )

        except Exception as e:
            self._current_state = AgentState.ERROR
            self.logger.error(f"Agent execution failed: {e}", component="agent")

            return AgentResponse(
                content=f"I encountered an error processing your request: {str(e)}",
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


class TieredAgent:
    """
    Agent that can operate at different tiers with different LLM configs.
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

    def _get_agent(self, tier: str) -> Agent:
        """Get or create agent for tier"""
        if tier not in self._agents:
            llm_config = self.tier_configs.get(tier, self.tier_configs.get("standard"))
            self._agents[tier] = Agent(self.config, self.tool_registry, llm_config)
        return self._agents[tier]

    def run(self, user_input: str, tier: str = None, context: Optional[str] = None) -> AgentResponse:
        """Run with specified tier"""
        tier = tier or self._current_tier
        agent = self._get_agent(tier)
        return agent.run(user_input, context)

    def set_tier(self, tier: str):
        """Set default tier"""
        self._current_tier = tier

    @property
    def current_tier(self) -> str:
        return self._current_tier
