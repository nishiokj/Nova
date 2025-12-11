"""
Harness runtime context - builds and wires core components without starting the service layer.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Optional, Any

from .config import HarnessConfig, RuntimeConfig, load_or_create_config
from .logger import StructuredLogger, set_logger, get_logger
from .tool_registry import ToolRegistry
from .router import Router, TaskTier
from .service_rep import StreamingServiceRep
from .agent import TieredAgent


@dataclass
class HarnessRuntime:
    """Container for all core harness components."""
    config: HarnessConfig
    runtime_config: RuntimeConfig
    logger: StructuredLogger
    tool_registry: ToolRegistry
    router: Router
    agent: TieredAgent
    profiler: Optional[Any] = None

    def create_service_rep(self, speech_block_event, cancel_event=None) -> StreamingServiceRep:
        """
        Build a ServiceRep instance bound to the provided synchronization primitives.
        """
        service_rep = StreamingServiceRep(
            self.config.service_rep,
            speech_block_event=speech_block_event,
            cancel_event=cancel_event
        )
        service_rep.initialize()

        if self.config.service_rep.enabled and service_rep.tts._engine_type == "none":
            msg = (
                "\n" + "=" * 70 + "\n"
                "🚨 FATAL: TTS IS ENABLED BUT NO ENGINE AVAILABLE!\n"
                "   ServiceRep.enabled=True but no TTS engine loaded.\n"
                "   Audio output will NOT work!\n\n"
                "   Fix options:\n"
                "   1. pip install pyttsx3\n"
                "   2. Ensure voice.py VoiceStreamer is importable\n"
                "   3. Run with --no-tts to disable TTS\n"
                + "=" * 70 + "\n"
            )
            print(msg, file=sys.stderr)
            self.logger.error(msg, component="harness")

        return service_rep

    def configure_router_tiers(self):
        """Attach tier-specific LLM configs to the router."""
        for tier in TaskTier:
            tier_llm = self.config.llm_configs.get(tier.value)
            if tier_llm:
                self.router.set_tier_config(tier, tier_llm)

    def prewarm_default_tier(self):
        """Prewarm the default agent tier if supported by the adapter."""
        try:
            default_tier = self.config.agent.tier
            agent = self.agent._get_agent(default_tier)
            if agent._llm and hasattr(agent._llm, "prewarm"):
                agent._llm.prewarm()
            self.logger.system_init("llm", "prewarmed", {"tier": default_tier})
        except Exception as exc:
            self.logger.error(f"Failed to pre-warm LLM: {exc}", component="harness")


def _build_logger(config: HarnessConfig) -> StructuredLogger:
    """Initialize structured logging for the harness runtime."""
    log_config = config.logging
    logger = StructuredLogger(
        name="harness",
        log_dir=log_config.log_dir,
        log_level=log_config.log_level,
        log_to_file=log_config.log_to_file,
        log_to_console=log_config.log_to_console,
        structured_format=log_config.structured_format
    )
    set_logger(logger)
    return logger


def create_runtime(
    config: Optional[HarnessConfig] = None,
    config_path: Optional[str] = None,
    profiler: Optional[Any] = None
) -> HarnessRuntime:
    """
    Build a HarnessRuntime from the provided config or config_path.
    """
    if config:
        resolved_config = config
    elif config_path:
        resolved_config = load_or_create_config(config_path)
    else:
        resolved_config = load_or_create_config()

    runtime_config = RuntimeConfig(resolved_config)
    logger = _build_logger(resolved_config)

    tool_registry = ToolRegistry(resolved_config.tools)
    router = Router(resolved_config.router)
    agent = TieredAgent(
        config=resolved_config.agent,
        tool_registry=tool_registry,
        tier_configs=resolved_config.llm_configs
    )

    runtime = HarnessRuntime(
        config=resolved_config,
        runtime_config=runtime_config,
        logger=logger,
        tool_registry=tool_registry,
        router=router,
        agent=agent,
        profiler=profiler
    )
    runtime.configure_router_tiers()
    runtime.prewarm_default_tier()
    get_logger().system_init("runtime", "ready")
    return runtime
