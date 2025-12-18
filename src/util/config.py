"""
Configuration management for the agentic harness.
Supports runtime mutation via APIs and environment variables.
"""

from __future__ import annotations

import os
import json
import threading
from dataclasses import dataclass, field, asdict
from typing import Dict, Any, Optional, List, Callable
from pathlib import Path
import copy

DEFAULT_TIER_TOOL_LIMITS = {
    "simple": 1,
    "standard": 15,
    "advanced": 30
}

DEFAULT_TIER_MAX_TOKENS = {
    "simple": 4096,
    "standard": 16000,
    "advanced": 32000
}


@dataclass
class LLMConfig:
    """Configuration for an LLM backend"""
    provider: str = "openai"  # openai, anthropic, custom
    model: str = "gpt-4o-mini"
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 4096
    max_completion_tokens: Optional[int] = None  # For models that require max_completion_tokens
    top_p: float = 0.9
    timeout: int = 60
    max_retries: int = 2
    retry_delay: float = 1.0
    retry_backoff_multiplier: float = 2.0
    retry_backoff_max: float = 30.0
    retry_jitter: float = 0.1
    circuit_breaker_threshold: int = 2
    circuit_breaker_cooldown: float = 30.0
    circuit_breaker_half_open_successes: int = 1
    streaming: bool = True
    # Optional failover models to try if this model repeatedly fails
    # Each entry can be a dict (from JSON) or an LLMConfig instance.
    failover_models: List["LLMConfig"] = field(default_factory=list)

    def __post_init__(self):
        # Load API key from environment if not provided
        if not self.api_key:
            env_key_map = {
                "openai": "OPENAI_API_KEY",
                "anthropic": "ANTHROPIC_API_KEY",
                "custom": "CUSTOM_API_KEY"
            }
            env_var = env_key_map.get(self.provider, f"{self.provider.upper()}_API_KEY")
            self.api_key = os.environ.get(env_var)

        # Normalize failover model configs to LLMConfig instances
        if self.failover_models:
            normalized: List[LLMConfig] = []
            for entry in self.failover_models:
                if isinstance(entry, LLMConfig):
                    normalized.append(entry)
                elif isinstance(entry, dict):
                    normalized.append(LLMConfig(**entry))
                else:
                    # Ignore unsupported types silently to be robust against bad config
                    continue
            self.failover_models = normalized


@dataclass
class RouterConfig:
    """Configuration for the Router component"""
    enabled: bool = True
    llm_config: Optional[LLMConfig] = None
    difficulty_tiers: List[str] = field(default_factory=lambda: ["simple", "standard", "advanced"])
    default_tier: str = "standard"
    # classification_prompt moved to config/prompts_config.json


@dataclass
class ServiceRepConfig:
    """Configuration for the ServiceRep (TTS communication)"""
    enabled: bool = True
    llm_config: Optional[LLMConfig] = None
    max_worker_threads: int = 1
    voice_engine: str = "pyttsx3"
    voice_rate: int = 180
    voice_volume: float = 0.8
    # acknowledgment_prompt moved to config/prompts_config.json
    # canned_responses moved to config/service_rep_config.json


@dataclass
class AgentConfig:
    """Configuration for the Agent component"""
    llm_config: Optional[LLMConfig] = None
    tier: str = "standard"
    # system_prompt moved to config/prompts_config.json (tier-specific prompts)
    system_prompt: str = ""  # Will be populated from tier-specific prompts

    max_tool_calls: int = 20
    tool_timeout: int = 30
    allow_code_execution: bool = True
    allow_internet: bool = True
    allow_bash: bool = True
    tier_tool_limits: Dict[str, int] = field(default_factory=lambda: DEFAULT_TIER_TOOL_LIMITS.copy())
    tier_max_tokens: Dict[str, int] = field(default_factory=lambda: DEFAULT_TIER_MAX_TOKENS.copy())


@dataclass
class ToolConfig:
    """Configuration for the Tool Registry"""
    enabled_tools: List[str] = field(default_factory=lambda: [
        "web_fetch", "bash_execute", "python_execute",
        "file_read", "file_write", "search_filesystem", "calculator", "get_current_time"
    ])
    sandbox_bash: bool = True
    sandbox_python: bool = True
    max_output_length: int = 10000
    bash_timeout: int = 30
    python_timeout: int = 60
    max_retries: int = 0
    retry_delay: float = 0.5
    retry_backoff_multiplier: float = 2.0
    retry_backoff_max: float = 5.0
    retry_jitter: float = 0.1
    circuit_breaker_threshold: int = 5
    circuit_breaker_cooldown: float = 15.0
    circuit_breaker_half_open_successes: int = 1


@dataclass
class LoggingConfig:
    """Configuration for structured logging"""
    log_dir: str = "logs"
    log_level: str = "INFO"
    log_to_file: bool = True
    log_to_console: bool = True
    structured_format: bool = True
    max_log_size: int = 10 * 1024 * 1024  # 10MB
    backup_count: int = 5


@dataclass
class HarnessConfig:
    """Main configuration for the entire harness"""
    router: RouterConfig = field(default_factory=RouterConfig)
    service_rep: ServiceRepConfig = field(default_factory=ServiceRepConfig)
    agent: AgentConfig = field(default_factory=AgentConfig)
    tools: ToolConfig = field(default_factory=ToolConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)

    # Default LLM configs for each tier
    llm_configs: Dict[str, LLMConfig] = field(default_factory=dict)

    def __post_init__(self):
        # Set up default LLM configs if not provided
        if not self.llm_configs:
            self.llm_configs = {
                "router": LLMConfig(provider="openai", model="gpt-4o-mini", max_tokens=100),
                "service_rep": LLMConfig(provider="openai", model="gpt-4o-mini", max_tokens=200),
                "simple": LLMConfig(provider="openai", model="gpt-4o-mini"),
                "standard": LLMConfig(provider="openai", model="gpt-4o"),
                "advanced": LLMConfig(provider="anthropic", model="claude-sonnet-4-20250514"),
            }

        # Apply LLM configs to components if not set
        if self.router.llm_config is None:
            self.router.llm_config = self.llm_configs.get("router")
        if self.service_rep.llm_config is None:
            self.service_rep.llm_config = self.llm_configs.get("service_rep")
        if self.agent.llm_config is None:
            self.agent.llm_config = self.llm_configs.get(self.agent.tier, self.llm_configs.get("standard"))

    @classmethod
    def from_file(cls, path: str) -> "HarnessConfig":
        """Load configuration from JSON file"""
        with open(path, 'r') as f:
            data = json.load(f)
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "HarnessConfig":
        """Create config from dictionary"""
        # Parse nested configs
        router_data = data.get("router", {})
        if "llm_config" in router_data and isinstance(router_data["llm_config"], dict):
            router_data["llm_config"] = LLMConfig(**router_data["llm_config"])

        service_rep_data = data.get("service_rep", {})
        if "llm_config" in service_rep_data and isinstance(service_rep_data["llm_config"], dict):
            service_rep_data["llm_config"] = LLMConfig(**service_rep_data["llm_config"])

        agent_data = data.get("agent", {})
        if "llm_config" in agent_data and isinstance(agent_data["llm_config"], dict):
            agent_data["llm_config"] = LLMConfig(**agent_data["llm_config"])

        llm_configs = {}
        for key, llm_data in data.get("llm_configs", {}).items():
            if isinstance(llm_data, dict):
                llm_configs[key] = LLMConfig(**llm_data)

        return cls(
            router=RouterConfig(**router_data) if router_data else RouterConfig(),
            service_rep=ServiceRepConfig(**service_rep_data) if service_rep_data else ServiceRepConfig(),
            agent=AgentConfig(**agent_data) if agent_data else AgentConfig(),
            tools=ToolConfig(**data.get("tools", {})) if data.get("tools") else ToolConfig(),
            logging=LoggingConfig(**data.get("logging", {})) if data.get("logging") else LoggingConfig(),
            llm_configs=llm_configs
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert config to dictionary"""
        def convert(obj):
            if hasattr(obj, '__dataclass_fields__'):
                return {k: convert(v) for k, v in asdict(obj).items()}
            elif isinstance(obj, dict):
                return {k: convert(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [convert(v) for v in obj]
            return obj
        return convert(self)

    def save(self, path: str):
        """Save configuration to JSON file"""
        with open(path, 'w') as f:
            json.dump(self.to_dict(), f, indent=2)


class RuntimeConfig:
    """
    Thread-safe runtime configuration manager.
    Allows dynamic updates to configuration during execution.
    """

    def __init__(self, base_config: HarnessConfig):
        self._config = base_config
        self._lock = threading.RLock()
        self._change_callbacks: List[Callable[[str, Any, Any], None]] = []
        self._version = 0

    @property
    def config(self) -> HarnessConfig:
        """Get current configuration (read-only snapshot)"""
        with self._lock:
            return copy.deepcopy(self._config)

    @property
    def version(self) -> int:
        """Get configuration version number"""
        with self._lock:
            return self._version

    def get(self, path: str, default: Any = None) -> Any:
        """
        Get a configuration value by dot-notation path.
        Example: config.get("router.enabled")
        """
        with self._lock:
            obj = self._config
            for part in path.split('.'):
                if hasattr(obj, part):
                    obj = getattr(obj, part)
                elif isinstance(obj, dict) and part in obj:
                    obj = obj[part]
                else:
                    return default
            return obj

    def set(self, path: str, value: Any) -> bool:
        """
        Set a configuration value by dot-notation path.
        Returns True if successful, False otherwise.
        """
        with self._lock:
            parts = path.split('.')
            obj = self._config

            # Navigate to parent
            for part in parts[:-1]:
                if hasattr(obj, part):
                    obj = getattr(obj, part)
                elif isinstance(obj, dict) and part in obj:
                    obj = obj[part]
                else:
                    return False

            # Set the value
            final_key = parts[-1]
            old_value = getattr(obj, final_key, None) if hasattr(obj, final_key) else obj.get(final_key)

            if hasattr(obj, final_key):
                setattr(obj, final_key, value)
            elif isinstance(obj, dict):
                obj[final_key] = value
            else:
                return False

            self._version += 1

            # Notify callbacks
            for callback in self._change_callbacks:
                try:
                    callback(path, old_value, value)
                except Exception:
                    pass

            return True

    def update(self, updates: Dict[str, Any]) -> List[str]:
        """
        Update multiple configuration values.
        Returns list of paths that were successfully updated.
        """
        successful = []
        for path, value in updates.items():
            if self.set(path, value):
                successful.append(path)
        return successful

    def on_change(self, callback: Callable[[str, Any, Any], None]):
        """Register a callback for configuration changes"""
        with self._lock:
            self._change_callbacks.append(callback)

    def remove_callback(self, callback: Callable[[str, Any, Any], None]):
        """Remove a change callback"""
        with self._lock:
            if callback in self._change_callbacks:
                self._change_callbacks.remove(callback)

    def reload_from_file(self, path: str) -> bool:
        """Reload configuration from file"""
        try:
            new_config = HarnessConfig.from_file(path)
            with self._lock:
                self._config = new_config
                self._version += 1
            return True
        except Exception:
            return False

    def export(self) -> Dict[str, Any]:
        """Export current configuration as dictionary"""
        with self._lock:
            return self._config.to_dict()


def create_default_config() -> HarnessConfig:
    """Create a default configuration with sensible defaults"""
    return HarnessConfig()


def load_or_create_config(path: str = "config/harness_config.json") -> HarnessConfig:
    """Load config from file or create default"""
    config_path = Path(path)
    if config_path.exists():
        return HarnessConfig.from_file(path)
    else:
        config = create_default_config()
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config.save(path)
        return config
