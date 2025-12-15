"""
Unified Application Configuration.

Combines all configuration concerns into a single, well-structured config.
Separates service configuration from runtime configuration.
"""

import json
import os
import logging
from dataclasses import dataclass, field, asdict
from typing import Optional, Dict, Any
from enum import Enum


class RuntimeMode(Enum):
    """Application runtime mode"""
    SINGLE_PROCESS = "single"
    MULTI_PROCESS = "multi"


@dataclass
class LoggingConfig:
    """Logging configuration"""
    level: str = "INFO"
    log_dir: str = "logs"
    log_to_file: bool = True
    log_to_console: bool = True
    structured_format: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class AudioServiceConfig:
    """Audio service configuration"""
    sample_rate: int = 32000
    chunk_duration_ms: int = 30
    channels: int = 1
    vad_aggressiveness: int = 2
    speech_timeout_ms: int = 1000
    silence_timeout_ms: int = 500
    min_speech_duration_s: float = 0.3
    device_index: Optional[int] = None
    device_name: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class STTServiceConfig:
    """STT service configuration"""
    engine: str = "whisper"  # "whisper" or "google"
    model_size: str = "base.en"
    device: str = "auto"
    compute_type: str = "auto"
    beam_size: int = 1
    vad_filter: bool = True
    filter_hallucinations: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class LinterServiceConfig:
    """Text linter service configuration"""
    enabled: bool = True
    cache_size: int = 100
    min_words: int = 2

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class HarnessReferenceConfig:
    """Reference to harness configuration file"""
    config_path: str = "config/harness_config.json"
    router_enabled: bool = True
    service_rep_enabled: bool = True
    default_tier: str = "standard"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class RuntimeConfig:
    """Runtime-specific configuration"""
    mode: RuntimeMode = RuntimeMode.MULTI_PROCESS
    max_agent_pending: int = 1
    health_check_interval_s: float = 2.0
    agent_timeout_s: float = 30.0
    tts_timeout_s: float = 30.0
    enable_rl_worker: bool = False

    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        result['mode'] = self.mode.value
        return result


@dataclass
class AppConfig:
    """
    Unified application configuration.

    This is the single source of truth for all application configuration.
    Contains both service configuration and runtime configuration.
    """
    # Runtime mode
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)

    # Logging
    logging: LoggingConfig = field(default_factory=LoggingConfig)

    # Services
    audio: AudioServiceConfig = field(default_factory=AudioServiceConfig)
    stt: STTServiceConfig = field(default_factory=STTServiceConfig)
    linter: LinterServiceConfig = field(default_factory=LinterServiceConfig)

    # Harness (domain layer)
    harness: HarnessReferenceConfig = field(default_factory=HarnessReferenceConfig)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            'runtime': self.runtime.to_dict(),
            'logging': self.logging.to_dict(),
            'audio': self.audio.to_dict(),
            'stt': self.stt.to_dict(),
            'linter': self.linter.to_dict(),
            'harness': self.harness.to_dict()
        }

    def save(self, path: str):
        """Save configuration to JSON file"""
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, 'w') as f:
            json.dump(self.to_dict(), f, indent=2)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'AppConfig':
        """Load configuration from dictionary"""
        # Convert runtime mode string to enum
        runtime_data = data.get('runtime', {})
        if 'mode' in runtime_data:
            mode_str = runtime_data['mode']
            runtime_data['mode'] = RuntimeMode(mode_str)

        return cls(
            runtime=RuntimeConfig(**runtime_data) if runtime_data else RuntimeConfig(),
            logging=LoggingConfig(**data.get('logging', {})),
            audio=AudioServiceConfig(**data.get('audio', {})),
            stt=STTServiceConfig(**data.get('stt', {})),
            linter=LinterServiceConfig(**data.get('linter', {})),
            harness=HarnessReferenceConfig(**data.get('harness', {}))
        )

    @classmethod
    def load(cls, path: str) -> 'AppConfig':
        """Load configuration from JSON file"""
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            return cls.from_dict(data)
        except FileNotFoundError:
            logging.warning(f"Config file not found: {path}, using defaults")
            return cls()
        except json.JSONDecodeError as e:
            logging.error(f"Invalid JSON in config file: {e}, using defaults")
            return cls()


def load_app_config(path: Optional[str] = None) -> AppConfig:
    """
    Load application configuration.

    Args:
        path: Path to config file (defaults to config/app_config.json)

    Returns:
        AppConfig instance
    """
    if path is None:
        path = "config/app_config.json"

    if os.path.exists(path):
        return AppConfig.load(path)
    else:
        logging.info(f"Config file not found at {path}, creating default config")
        config = AppConfig()
        config.save(path)
        return config


def create_default_config(path: str = "config/app_config.json"):
    """Create a default configuration file"""
    config = AppConfig()
    config.save(path)
    print(f"Default configuration saved to: {path}")
    return config
