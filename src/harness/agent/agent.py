"""
Agent - Main reasoning and tool execution agent.
Handles user requests with tool usage and LLM reasoning.

Architecture: Plan → Wizard → Synthesis
- Planner: Creates explicit execution plans with success criteria
- Wizard: Orchestrates steps and workers over a single context window
- Synthesizer: Produces the final response
"""

import time
import uuid
import os
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Callable
from enum import Enum

from util.config import AgentConfig, LLMConfig, DEFAULT_TIER_TOOL_LIMITS, DEFAULT_TIER_MAX_TOKENS
from util.llm_adapter import LLMAdapter, create_adapter
from .tool_registry import ToolRegistry
from util.logger import StructuredLogger
from .planner import Planner
from .agent_logger import AgentLogger
from .wizard import convert_plan_to_wizard_plan
from .wizard.context_window import SessionContext


class NullLogger:
    """
    A no-op logger that silently ignores all calls.
    Used when no logger is provided to avoid None checks everywhere.
    """

    def __init__(self):
        self._session_id = str(uuid.uuid4())[:8]
        self._request_id = None

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def request_id(self) -> Optional[str]:
        return self._request_id

    def new_request(self) -> str:
        self._request_id = f"{self._session_id}-null-{int(time.time() * 1000) % 100000}"
        return self._request_id

    def __getattr__(self, name):
        """Return a no-op function for any method call."""
        def noop(*args, **kwargs):
            pass
        return noop


@dataclass
class AgentResponse:
    """Response from the agent via Wizard orchestration."""
    content: str                          # The spoken/displayed response
    structured_action: Optional[str] = None  # Description of action taken
    speech_text: Optional[str] = None     # Direct TTS text (bypasses LLM summarization)
    total_duration_ms: float = 0
    tools_used: List[str] = field(default_factory=list)  # For backwards compatibility
    success: bool = True
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    goal_achieved: bool = True
    reflection: Optional[Any] = None  # WizardReflection from wizard result
    # Pause state for user clarification
    paused: bool = False
    user_prompt: Optional[Dict[str, Any]] = None  # {question, options, context}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "content": self.content,
            "structured_action": self.structured_action,
            "speech_text": self.speech_text,
            "total_duration_ms": self.total_duration_ms,
            "tools_used": self.tools_used,
            "success": self.success,
            "error": self.error,
            "metadata": self.metadata,
            "goal_achieved": self.goal_achieved,
            "paused": self.paused,
            "user_prompt": self.user_prompt,
        }


@dataclass
class TierRuntime:
    """Precomputed tier configuration and LLM state."""
    agent_config: AgentConfig
    llm_config: LLMConfig


class Agent:
    """
    Main reasoning and execution agent.
    Uses Wizard orchestration for plan execution.
    """

    def __init__(
        self,
        config: AgentConfig,
        tool_registry: ToolRegistry,
        llm_config: Optional[LLMConfig] = None,
        event_bus: Optional[Any] = None,
        logger: Optional[StructuredLogger] = None,
        agent_logger: Optional[AgentLogger] = None,
        graphd_client: Optional[Any] = None,
        # Deprecated parameters kept for backwards compatibility
        execution_logger: Optional[Any] = None,  # No longer used
    ):
        """
        Initialize Agent.

        Args:
            config: Agent configuration
            tool_registry: Registry of available tools
            llm_config: LLM configuration (optional, uses config.llm_config if not provided)
            event_bus: Optional EventBus for progress events
            logger: StructuredLogger for request/health logging (optional)
            agent_logger: AgentLogger for LLM request logging (optional)
            graphd_client: Optional GraphdClient for graph-based code intelligence
        """
        self.config = config
        self.tool_registry = tool_registry
        self._graphd_client = graphd_client
        self.logger = logger or NullLogger()
        self.event_bus = event_bus
        self._agent_logger = agent_logger

        # LLM setup
        self._llm_config = llm_config or config.llm_config
        self._llm: Optional[LLMAdapter] = None
        if self._llm_config:
            self._llm = create_adapter(self._llm_config, logger=self.logger)

        # Core components
        self._planner: Optional[Planner] = None
        self._wizard = None
        if self._llm:
            self._planner = Planner(self._llm, tool_registry, graphd_client=self._graphd_client)
            from .wizard import Wizard, WizardConfig
            self._wizard = Wizard(
                tool_registry=self.tool_registry,
                llm=self._llm,
                config=WizardConfig(),
                logger=self.logger,
            )

        # State
        self._stop_requested = False
        self._current_request_id: Optional[str] = None

        # Callbacks for progress reporting
        self._phase_callbacks: List[Callable[[str, Optional[str], int], None]] = []

    def _serialize_messages_for_planner(self, messages: List[Dict[str, Any]]) -> str:
        """Render persisted context messages into a readable planning transcript."""
        import json
        lines: List[str] = []
        for msg in messages:
            role = msg.get("role", "unknown").upper()
            content = msg.get("content")
            if content:
                lines.append(f"{role}: {content}")
            tool_calls = msg.get("tool_calls")
            if tool_calls:
                lines.append(f"{role} TOOL_CALLS: {json.dumps(tool_calls)}")
        return "\n".join(lines).strip()

    def _render_context_for_planner(
        self,
        session_state: Optional[SessionContext],
        extra_context: Optional[str],
    ) -> Optional[str]:
        """Build planning context string from session messages + extra context."""
        parts: List[str] = []
        if session_state and session_state.messages:
            serialized = self._serialize_messages_for_planner(session_state.messages)
            if serialized:
                parts.append(serialized)
        if extra_context:
                parts.append(f"Additional context:\n{extra_context}")
        return "\n\n".join(parts) if parts else None

    def _run_simple_tier(
        self,
        user_input: str,
        context: Optional[str],
        session_state: Optional[SessionContext],
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
    ) -> AgentResponse:
        """Single LLM call path for simple-tier requests."""
        start_time = time.time()
        instructions = (
            self.config.system_prompt
            or SIMPLE_TIER_PROMPT
            or "You are a fast assistant. Answer directly and briefly."
        )

        if context:
            content = f"{user_input}\n\nAdditional context:\n{context}"
        else:
            content = user_input

        if session_state is None:
            session_state = SessionContext()

        if session_state.messages:
            messages = list(session_state.messages)
            messages.append({"role": "user", "content": content})
            response = self._llm.respond(input=messages, instructions=instructions, tools=[])
        else:
            response = self._llm.respond(input=content, instructions=instructions, tools=[])

        final_content = response.content or ""

        session_state.add_message({"role": "user", "content": content})
        if final_content:
            session_state.add_message({"role": "assistant", "content": final_content})

        if on_stream_chunk:
            on_stream_chunk(final_content, 0, True)

        return AgentResponse(
            content=final_content,
            structured_action=f"Answer: {user_input}",
            total_duration_ms=(time.time() - start_time) * 1000,
            success=True,
            goal_achieved=True,
            metadata={"final_context_state": session_state.to_session_dict()},
        )


    def _notify_phase(self, message: str, tool_name: Optional[str] = None, step_number: int = 0):
        """Notify phase callbacks of progress."""
        for callback in self._phase_callbacks:
            try:
                callback(message, tool_name, step_number)
            except Exception as e:
                self.logger.error(f"Phase callback error: {e}", component="agent")

    def stop(self):
        """Request the agent to stop execution at next checkpoint."""
        self._stop_requested = True
        self.logger.info("Agent stop requested", component="agent")

    def run(
        self,
        user_input: str,
        context: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
        classification: Optional[Any] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
        session_context: Optional[Dict[str, Any]] = None,
    ) -> AgentResponse:
        """
        Run the agent using Wizard orchestration.

        Args:
            user_input: The user's request
            context: Optional additional context
            budget: Budget constraints from router
            classification: Full TaskClassification for logging
            on_stream_chunk: Optional callback for streaming response
            session_context: Optional context from graphd session for hydration

        Returns:
            AgentResponse with content and metadata
        """
        if not self._llm:
            return AgentResponse(
                content="Agent not properly configured. No LLM available.",
                success=False,
                error="No LLM configured"
            )

        # Setup request tracking
        if self.logger.request_id is None:
            req_id = self.logger.new_request()
        else:
            req_id = self.logger.request_id
        self._current_request_id = req_id
        self._notify_phase("Request received", step_number=0)

        # Hydrate session context if provided
        session_state: Optional[SessionContext] = None
        if session_context:
            try:
                session_state = SessionContext.from_session_dict(session_context)
                self.logger.info(
                    f"Hydrated SessionContext: {len(session_state.messages)} messages, "
                    f"{len(session_state.read_files)} files read",
                    component="agent",
                )
            except Exception as e:
                self.logger.warning(f"Failed to hydrate SessionContext: {e}", component="agent")
                session_state = None

        if self.config.tier == "simple":
            self._notify_phase("Simple tier: direct answer", step_number=0)
            return self._run_simple_tier(user_input, context, session_state, on_stream_chunk)

        planning_context = self._render_context_for_planner(session_state, context)

        # Create and execute plan via Wizard
        plan = self._planner.create_plan(
            user_input=user_input,
            context=planning_context,
            tier=self.config.tier,
            budget=budget
        )
        wizard_plan = convert_plan_to_wizard_plan(plan)

        result = self._wizard.orchestrate(
            plan=wizard_plan,
            user_input=user_input,
            request_context=context,
            budget=budget,
            on_stream_chunk=on_stream_chunk,
            session_context=session_state,
        )

        result_error = None
        if not result.success:
            result_error = result.to_dict().get("error")
            if not result_error:
                result_error = "Unable to complete request. Check logs for details."

        # Build response metadata
        result_dict = result.to_dict()
        response_metadata = result_dict.get("metadata", {})
        if result.final_context_state:
            response_metadata["final_context_state"] = result.final_context_state
        if result_error:
            response_metadata["error"] = result_error

        # Include wizard events for dashboard telemetry
        if result.events:
            response_metadata["wizard_events"] = [
                event.to_dict() for event in result.events
            ]
            self.logger.info(
                f"Agent collected {len(result.events)} wizard events for dashboard",
                component="agent",
            )

        if result.plan_state:
            response_metadata["plan_steps"] = [
                {
                    "step_num": step.step_num,
                    "objective": step.objective,
                    "tool_hint": step.tool_hint,
                    "status": step.status.value,
                    "phase": step.phase.value,
                    "depends_on": list(step.depends_on),
                    "required": step.required,
                }
                for step in sorted(result.plan_state.steps.values(), key=lambda s: s.step_num)
            ]

        content = result.final_response
        if result_error and (not content or not content.strip() or content.strip() == "Task processing complete."):
            content = result_error

        return AgentResponse(
            content=content,
            structured_action=result.plan_state.goal,
            total_duration_ms=result.duration_ms,
            success=result.success,
            error=result_error,
            goal_achieved=result.goal_achieved,
            reflection=result.to_reflection(),
            metadata=response_metadata,
            paused=result.paused,
            user_prompt=result.user_prompt,
        )

    def add_phase_callback(self, callback: Callable[[str, Optional[str], int], None]):
        """Add callback for phase progress updates."""
        self._phase_callbacks.append(callback)

    def remove_phase_callback(self, callback: Callable[[str, Optional[str], int], None]):
        """Remove a previously registered phase callback."""
        if callback in self._phase_callbacks:
            self._phase_callbacks.remove(callback)

    def resume_with_answer(
        self,
        answer: str,
        budget: Optional[Dict[str, int]] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
    ) -> AgentResponse:
        """
        Resume execution after user provides an answer to ask_user prompt.

        Args:
            answer: The user's response to the question
            budget: Optional budget constraints
            on_stream_chunk: Optional streaming callback

        Returns:
            AgentResponse with continued execution results
        """
        result = self._wizard.resume_with_answer(
            answer=answer,
            budget=budget,
            on_stream_chunk=on_stream_chunk,
        )

        response_metadata = result.to_dict().get("metadata", {})
        if result.final_context_state:
            response_metadata["final_context_state"] = result.final_context_state

        return AgentResponse(
            content=result.final_response,
            structured_action=result.plan_state.goal,
            total_duration_ms=result.duration_ms,
            success=result.success,
            goal_achieved=result.goal_achieved,
            reflection=result.to_reflection(),
            metadata=response_metadata,
            paused=result.paused,
            user_prompt=result.user_prompt,
        )

    @property
    def is_stop_requested(self) -> bool:
        """Check if stop has been requested."""
        return self._stop_requested


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
            "simple": "You are a fast assistant. Answer from your own knowledge unless the user explicitly asks for a lookup or the request is about fresh data (time/date/weather/stocks/news).\n\nPrinciples:\n- Be decisive and brief (under 40 words).\n- ZERO tools unless the user asks you to search OR it's clearly fresh-data.\n- No preambles; just give the answer.\n\nAvailable tools (use only if necessary):\n{tools}",
            "standard": "You are a capable assistant. Optimize for fast, accurate answers with minimal tool use.\n\nPrinciples:\n- First, answer directly if you can. Only reach for tools when data is missing, stale, or explicitly requested.\n- Keep responses concise and clear; avoid boilerplate.\n\nAvailable tools:\n{tools}",
            "advanced": "You are an expert personal CLI assistant for complex tasks. Optimize for correctness and clarity.\n\nPrinciples:\n- Quickly outline the plan. This could be multiple steps and also could require discovery if called from an existing system. You are highly capable of multi-turn robust plans and should be very detail oriented for complex tasks. Use tools only where they add real evidence or fresh data.\n- Prefer fewer, high-impact tool calls (max 10). Avoid trivial tool calls (e.g., time) unless requested.\n- Double-check critical facts; provide a crisp, helpful final answer.\n\nAvailable tools:\n{tools}"
        }

# Load tier prompts from config
_TIER_PROMPTS = _load_tier_prompts()

SIMPLE_TIER_PROMPT = _TIER_PROMPTS.get("simple", "")
STANDARD_TIER_PROMPT = _TIER_PROMPTS.get("standard", "")
ADVANCED_TIER_PROMPT = _TIER_PROMPTS.get("advanced", "")

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
        tier_configs: Dict[str, LLMConfig],
        event_bus: Optional[Any] = None,
        logger: Optional[StructuredLogger] = None,
        agent_logger: Optional[AgentLogger] = None,
        graphd_client: Optional[Any] = None,
        # Deprecated parameter kept for backwards compatibility
        execution_logger: Optional[Any] = None,  # No longer used
    ):
        """
        Initialize TieredAgent.

        Args:
            config: Agent configuration
            tool_registry: Registry of available tools
            tier_configs: LLM configs per tier
            event_bus: Optional EventBus for progress events
            logger: StructuredLogger for request/health logging (optional)
            agent_logger: AgentLogger for LLM request logging (optional)
            graphd_client: Optional GraphdClient for graph-based code intelligence
        """
        self.config = config
        self.tool_registry = tool_registry
        self.tier_configs = tier_configs
        self.event_bus = event_bus
        self._graphd_client = graphd_client
        self._agents: Dict[str, Agent] = {}
        self._tier_runtimes: Dict[str, TierRuntime] = {}
        self._current_tier = config.tier
        self.logger = logger or NullLogger()
        self._agent_logger = agent_logger
        self._prepare_tier_runtimes()
        self._last_tier_used = self._current_tier

    def _get_tier_prompt(self, tier: str) -> str:
        """Get the appropriate system prompt for the tier"""
        tools = [
            tool for tool in self.tool_registry.list_tools(enabled_only=True)
            if not tool.name.startswith("graphd_")
        ]
        tool_descriptions = "\n".join([f"- {t.name}: {t.description}" for t in tools])

        # Get prompt template from config
        prompt_template = _TIER_PROMPTS.get(tier, _TIER_PROMPTS.get("standard"))
        return prompt_template.format(tools=tool_descriptions)

    def _prepare_tier_runtimes(self):
        """Pre-compute tier runtimes so switching tiers is deterministic."""
        for tier in self._resolve_tier_names():
            self._tier_runtimes[tier] = self._build_tier_runtime(tier)

    def _resolve_tier_names(self) -> List[str]:
        """Determine which tiers should be available."""
        tiers = set(self.config.tier_tool_limits.keys())
        tiers.add(self.config.tier)
        for tier in self.tier_configs.keys():
            if tier in DEFAULT_TIER_TOOL_LIMITS or tier in DEFAULT_TIER_MAX_TOKENS:
                tiers.add(tier)
        return sorted(tiers)

    def _build_tier_runtime(self, tier: str) -> TierRuntime:
        """Create the AgentConfig/LLMConfig pair for a tier."""
        base_llm_config = (
            self.tier_configs.get(tier)
            or self.tier_configs.get("standard")
            or self.config.llm_config
        )
        if not base_llm_config:
            raise ValueError(f"No LLM config available for tier '{tier}'")

        tier_max_tokens = self.config.tier_max_tokens.get(tier)
        if tier_max_tokens is None:
            llm_base_max = getattr(self.config.llm_config, "max_tokens", None) if self.config.llm_config else None
            tier_max_tokens = llm_base_max or DEFAULT_TIER_MAX_TOKENS.get(tier, 500)

        llm_config = LLMConfig(
            provider=base_llm_config.provider,
            model=base_llm_config.model,
            api_key=base_llm_config.api_key,
            api_base=base_llm_config.api_base,
            max_tokens=tier_max_tokens,
            max_completion_tokens=tier_max_tokens,
            failover_models=getattr(base_llm_config, "failover_models", []),
            temperature=base_llm_config.temperature,
            top_p=base_llm_config.top_p,
            timeout=base_llm_config.timeout,
            max_retries=base_llm_config.max_retries,
            retry_delay=base_llm_config.retry_delay,
            retry_backoff_multiplier=base_llm_config.retry_backoff_multiplier,
            retry_backoff_max=base_llm_config.retry_backoff_max,
            retry_jitter=base_llm_config.retry_jitter,
            circuit_breaker_threshold=base_llm_config.circuit_breaker_threshold,
            circuit_breaker_cooldown=base_llm_config.circuit_breaker_cooldown,
            circuit_breaker_half_open_successes=base_llm_config.circuit_breaker_half_open_successes,
            streaming=base_llm_config.streaming
        )

        tool_limit = self.config.tier_tool_limits.get(tier, self.config.max_tool_calls)

        tier_config = AgentConfig(
            llm_config=llm_config,
            tier=tier,
            system_prompt=self._get_tier_prompt(tier),
            max_tool_calls=tool_limit,
            tool_timeout=self.config.tool_timeout,
            allow_code_execution=self.config.allow_code_execution,
            allow_internet=self.config.allow_internet,
            allow_bash=self.config.allow_bash,
            tier_tool_limits=self.config.tier_tool_limits,
            tier_max_tokens=self.config.tier_max_tokens
        )

        self.logger.system_init("agent", f"configured_{tier}", {
            "max_tokens": tier_max_tokens,
            "max_tools": tool_limit
        })

        return TierRuntime(agent_config=tier_config, llm_config=llm_config)

    def _get_agent(self, tier: str) -> Agent:
        """Get or create agent for tier with tier-specific config."""
        if tier not in self._tier_runtimes:
            self._tier_runtimes[tier] = self._build_tier_runtime(tier)

        if tier not in self._agents:
            runtime = self._tier_runtimes[tier]
            self._agents[tier] = Agent(
                runtime.agent_config,
                self.tool_registry,
                runtime.llm_config,
                self.event_bus,
                logger=self.logger,
                agent_logger=self._agent_logger,
                graphd_client=self._graphd_client
            )
        return self._agents[tier]

    def get_agent_for_tier(self, tier: str) -> Agent:
        """Public accessor for tier-specific Agent instances."""
        return self._get_agent(tier)

    def prewarm_all_tiers(self) -> List[str]:
        """Prewarm every tier's LLM adapter to keep connections warm."""
        warmed: List[str] = []
        warmed_keys = set()

        for tier in self._resolve_tier_names():
            agent = self._get_agent(tier)
            if not agent._llm:
                continue

            provider = agent._llm.provider
            model = agent._llm.config.model if agent._llm.config else "unknown"
            key = f"{provider}:{model}"
            prewarm_fn = getattr(agent._llm, "prewarm", None)
            if callable(prewarm_fn):
                try:
                    if key in warmed_keys or prewarm_fn():
                        warmed_keys.add(key)
                        warmed.append(tier)
                    else:
                        self.logger.warning(
                            f"Prewarm returned False for tier {tier}",
                            component="agent"
                        )
                except Exception as exc:
                    self.logger.error(
                        f"Prewarm failed for tier {tier}: {exc}",
                        component="agent"
                    )
            else:
                warmed.append(tier)

        return warmed

    def run(
        self,
        user_input: str,
        tier: str = None,
        context: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
        classification: Optional[Any] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
        session_context: Optional[Dict[str, Any]] = None,
    ) -> AgentResponse:
        """
        Run with specified tier and tier-appropriate behavior.

        Args:
            user_input: The user's request
            tier: Which tier to use (simple/standard/advanced)
            context: Optional additional context
            budget: Budget constraints from router (max_tool_calls, max_tokens, max_steps)
            classification: Full TaskClassification from router (for logging/debugging)
            on_stream_chunk: Optional callback for streaming final response synthesis.
                            Called with (chunk: str, chunk_index: int, is_final: bool)
            session_context: Optional context from graphd session for hydration.
                            Contains persisted messages, read_files, and cache state.
        """
        tier = tier or self._current_tier
        self._last_tier_used = tier

        # Use budget from classification if provided, otherwise fall back to config
        if budget:
            tool_limit = budget.get("max_tool_calls")
            max_steps = budget.get("max_steps")
        else:
            tool_limit = self.config.tier_tool_limits.get(tier)
            max_steps = None

        if tool_limit is None:
            tool_limit = self.config.max_tool_calls

        self.logger.debug(
            f"Running agent at tier '{tier}' (max {tool_limit} tools, max {max_steps} steps)",
            component="agent"
        )

        agent = self._get_agent(tier)

        # Pass budget, streaming callback, and session context to agent
        return agent.run(
            user_input, context,
            budget=budget,
            classification=classification,
            on_stream_chunk=on_stream_chunk,
            session_context=session_context,
        )

    def resume_with_answer(
        self,
        answer: str,
        budget: Optional[Dict[str, int]] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
    ) -> AgentResponse:
        """
        Delegate resume calls to the most recently used tier so ask_user follow-ups continue
        in the same context.
        """
        tier = self._last_tier_used or self._current_tier
        agent = self._get_agent(tier)
        return agent.resume_with_answer(
            answer=answer,
            budget=budget,
            on_stream_chunk=on_stream_chunk,
        )

    def set_tier(self, tier: str):
        """Set default tier"""
        self._current_tier = tier

    @property
    def current_tier(self) -> str:
        return self._current_tier
