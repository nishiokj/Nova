"""
Harness runtime context - builds and wires core components without starting the service layer.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Optional, Any

from .config import HarnessConfig, RuntimeConfig, load_or_create_config
from .logger import StructuredLogger
from harness.agent.tool_registry import ToolRegistry
from skills.store import SkillStore
from skills.registry import SkillRegistry
from skills.router import SkillRouter
from skills.runner import SkillRunner
from hooks.store import HookStore
from hooks.manager import HookManager
from services.router import Router, TaskTier
#from .service_rep import StreamingServiceRep
from harness.agent.agent import TieredAgent
from harness.agent.agent_logger import AgentLogger
from .agent_execution_logger import AgentExecutionLogger


@dataclass
class HarnessRuntime:
    """Container for all core harness components."""
    config: HarnessConfig
    runtime_config: RuntimeConfig
    logger: StructuredLogger
    execution_logger: AgentExecutionLogger
    agent_logger: AgentLogger
    tool_registry: ToolRegistry
    skill_store: SkillStore
    skill_registry: SkillRegistry
    skill_router: SkillRouter
    skill_runner: SkillRunner
    hook_store: HookStore
    hook_manager: HookManager
    router: Router
    agent: TieredAgent
    profiler: Optional[Any] = None
    graphd: Optional[Any] = None

    # def create_service_rep(self, speech_block_event, cancel_event=None) -> StreamingServiceRep:
    #     """
    #     Build a ServiceRep instance bound to the provided synchronization primitives.
    #     """
    #     service_rep = StreamingServiceRep(
    #         self.config.service_rep,
    #         speech_block_event=speech_block_event,
    #         cancel_event=cancel_event,
    #         logger=self.logger
    #     )
    #     service_rep.initialize()

    #     if self.config.service_rep.enabled and service_rep.tts._engine_type == "none":
    #         msg = (
    #             "\n" + "=" * 70 + "\n"
    #             "🚨 FATAL: TTS IS ENABLED BUT NO ENGINE AVAILABLE!\n"
    #             "   ServiceRep.enabled=True but no TTS engine loaded.\n"
    #             "   Audio output will NOT work!\n\n"
    #             "   Fix options:\n"
    #             "   1. pip install pyttsx3\n"
    #             "   2. Ensure voice.py VoiceStreamer is importable\n"
    #             "   3. Run with --no-tts to disable TTS\n"
    #             + "=" * 70 + "\n"
    #         )
    #         print(msg, file=sys.stderr)
    #         self.logger.error(msg, component="harness")

    #     return service_rep

    def configure_router_tiers(self):
        """Attach tier-specific LLM configs to the router."""
        for tier in TaskTier:
            tier_llm = self.config.llm_configs.get(tier.value)
            if tier_llm:
                self.router.set_tier_config(tier, tier_llm)

    def prewarm_all_tiers(self):
        """Prewarm every configured agent tier to keep HTTP pools hot."""
        try:
            warmed_tiers = self.agent.prewarm_all_tiers()
            self.logger.system_init("llm", "prewarmed", {"tiers": warmed_tiers})
        except Exception as exc:
            self.logger.error(f"Failed to pre-warm LLM tiers: {exc}", component="harness")

    # Backwards-compatible alias
    def prewarm_default_tier(self):
        """Legacy entrypoint retained for compatibility."""
        return self.prewarm_all_tiers()


def _build_logger(config: HarnessConfig, log_dir: Optional[str] = None) -> StructuredLogger:
    """Initialize structured logging for the harness runtime.

    Args:
        config: Harness configuration
        log_dir: Optional override for log directory. If not provided, uses config.logging.log_dir
    """
    log_config = config.logging
    resolved_log_dir = log_dir or log_config.log_dir

    if not resolved_log_dir:
        raise ValueError("log_dir is required - either pass it explicitly or set it in config")

    logger = StructuredLogger(
        log_dir=resolved_log_dir,
        name="harness",
        log_level=log_config.log_level,
        log_to_file=log_config.log_to_file,
        log_to_console=log_config.log_to_console,
        structured_format=log_config.structured_format
    )
    return logger


def create_runtime(
    config: Optional[HarnessConfig] = None,
    config_path: Optional[str] = None,
    profiler: Optional[Any] = None,
    logger: Optional[StructuredLogger] = None,
    execution_logger: Optional[AgentExecutionLogger] = None,
    log_dir: Optional[str] = None
) -> HarnessRuntime:
    """
    Build a HarnessRuntime from the provided config or config_path.

    Args:
        config: Harness configuration object
        config_path: Path to configuration file
        profiler: Optional profiler for runtime metrics
        logger: Optional pre-configured StructuredLogger (if not provided, one will be created)
        execution_logger: Optional pre-configured AgentExecutionLogger
        log_dir: Optional log directory override. Takes precedence over config.logging.log_dir

    Returns:
        Configured HarnessRuntime instance
    """
    if config:
        resolved_config = config
    elif config_path:
        resolved_config = load_or_create_config(config_path)
    else:
        resolved_config = load_or_create_config()

    # Resolve log_dir: explicit param > config > error
    resolved_log_dir = log_dir or resolved_config.logging.log_dir
    if not resolved_log_dir:
        raise ValueError("log_dir is required - pass it explicitly or set it in config")

    runtime_config = RuntimeConfig(resolved_config)
    runtime_logger = logger or _build_logger(resolved_config, log_dir=resolved_log_dir)
    exec_logger = execution_logger or AgentExecutionLogger(log_dir=resolved_log_dir)
    agent_log = AgentLogger(log_dir=resolved_log_dir, logger=runtime_logger)

    graphd_manager = None
    graphd_client = None
    if resolved_config.graphd and resolved_config.graphd.enabled:
        try:
            from harness.graphd import GraphdClient, GraphdManager
            graphd_manager = GraphdManager(resolved_config.graphd, logger=runtime_logger)
            if graphd_manager.start():
                graphd_client = GraphdClient(
                    host=resolved_config.graphd.host,
                    port=resolved_config.graphd.port,
                    timeout_s=resolved_config.graphd.client_timeout_s,
                    enabled=True
                )
            else:
                graphd_manager = None
        except Exception as exc:
            runtime_logger.error(f"Graphd init failed: {exc}", component="runtime", error=exc)
            graphd_manager = None

    hook_store = HookStore(resolved_config.hooks.hooks_dir, logger=runtime_logger)
    hook_manager = HookManager(hook_store, resolved_config.hooks, logger=runtime_logger)

    tool_registry = ToolRegistry(
        resolved_config.tools,
        logger=runtime_logger,
        nano_banana_config=resolved_config.nano_banana,
        graphd_client=graphd_client,
        graphd_tools_enabled=bool(resolved_config.graphd and resolved_config.graphd.enable_tools),
        hook_manager=hook_manager,
    )

    skill_store = SkillStore(resolved_config.skills.skills_dir, logger=runtime_logger)
    skill_registry = SkillRegistry(skill_store, logger=runtime_logger)
    skill_router = SkillRouter(
        skill_registry,
        resolved_config.skills,
        logger=runtime_logger,
        semantic_llm_config=resolved_config.skills.semantic_llm_config,
    )
    skill_runner = SkillRunner(tool_registry, logger=runtime_logger)
    router = Router(resolved_config.router, logger=runtime_logger)
    agent = TieredAgent(
        config=resolved_config.agent,
        tool_registry=tool_registry,
        tier_configs=resolved_config.llm_configs,
        logger=runtime_logger,
        execution_logger=exec_logger,
        agent_logger=agent_log,
        graphd_client=graphd_client
    )

    runtime = HarnessRuntime(
        config=resolved_config,
        runtime_config=runtime_config,
        logger=runtime_logger,
        execution_logger=exec_logger,
        agent_logger=agent_log,
        tool_registry=tool_registry,
        skill_store=skill_store,
        skill_registry=skill_registry,
        skill_router=skill_router,
        skill_runner=skill_runner,
        hook_store=hook_store,
        hook_manager=hook_manager,
        router=router,
        agent=agent,
        profiler=profiler,
        graphd=graphd_manager
    )
    runtime.configure_router_tiers()
    runtime.prewarm_all_tiers()
    runtime.logger.system_init("runtime", "ready")
    return runtime
