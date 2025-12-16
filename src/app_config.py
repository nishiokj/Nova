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
class TTSServiceConfig:
    """TTS service configuration"""
    engine: str = "auto"  # "auto", "macos_say", or "pyttsx3"
    voice: Optional[str] = None  # Voice name (e.g., "Samantha", "Alex", "Karen")
    rate: int = 180  # Speech rate (words per minute)
    volume: float = 0.8  # Volume level (0.0 to 1.0)

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
    # Headless mode: run without microphone/audio hardware requirements.
    # Intended for Docker/macOS/CI where audio passthrough is unavailable.
    headless: bool = False
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
    tts: TTSServiceConfig = field(default_factory=TTSServiceConfig)
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
            tts=TTSServiceConfig(**data.get('tts', {})),
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
            raise FileNotFoundError(
                f"Configuration file not found: {path}\n\n"
                "To fix this:\n"
                "  1. Run: voice-agent --init-config\n"
                "  2. Or specify a valid config: voice-agent --config /path/to/config.json"
            )
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in configuration file: {path}\n\n"
                f"Error details: {e}\n\n"
                "To fix this:\n"
                "  1. Check the JSON syntax in your config file\n"
                "  2. Ensure all brackets, braces, and quotes are properly matched\n"
                "  3. Remove any trailing commas\n"
                "  4. Or restore from template: voice-agent --init-config"
            )
        except Exception as e:
            raise RuntimeError(
                f"Unexpected error loading configuration from {path}: {e}\n\n"
                "To fix this:\n"
                "  1. Verify the file is readable and not corrupted\n"
                "  2. Check file permissions\n"
                "  3. Or restore from template: voice-agent --init-config"
            )


def load_app_config(path: Optional[str] = None) -> AppConfig:
    """
    Load application configuration with environment variable overrides.

    Environment variables take precedence over config file values,
    enabling Docker-friendly configuration management.

    Supported environment variables:
    - LOG_LEVEL: Logging level (DEBUG, INFO, WARNING, ERROR)
    - LOG_DIR: Log directory path
    - STT_MODEL: Whisper model size (tiny.en, base.en, small.en, etc.)
    - STT_DEVICE: STT device (auto, cpu, cuda, mps)
    - STT_COMPUTE_TYPE: Compute type (auto, int8, float16, float32)
    - TTS_VOICE: TTS voice name (e.g., Samantha, Alex, Karen for macOS)
    - TTS_RATE: TTS speech rate in words per minute (default: 200)
    - TTS_VOLUME: TTS volume level 0.0-1.0 (default: 0.9)
    - AUDIO_DEVICE_INDEX: Audio input device index
    - AUDIO_SAMPLE_RATE: Audio sample rate in Hz
    - HARNESS_CONFIG_PATH: Path to harness configuration file
    - VOICE_AGENT_HEADLESS: Enable headless mode (true/1)

    Args:
        path: Path to config file (defaults to config/app_config.json)

    Returns:
        AppConfig instance with environment variable overrides applied
    """
    if path is None:
        path = "config/app_config.json"

    if os.path.exists(path):
        config = AppConfig.load(path)
    else:
        logging.info(f"Config file not found at {path}, using defaults")
        config = AppConfig()

    # Apply environment variable overrides
    # Logging
    if os.getenv("LOG_LEVEL"):
        config.logging.level = os.getenv("LOG_LEVEL")
    if os.getenv("LOG_DIR"):
        config.logging.log_dir = os.getenv("LOG_DIR")

    # STT
    if os.getenv("STT_MODEL"):
        config.stt.model_size = os.getenv("STT_MODEL")
    if os.getenv("STT_DEVICE"):
        config.stt.device = os.getenv("STT_DEVICE")
    if os.getenv("STT_COMPUTE_TYPE"):
        config.stt.compute_type = os.getenv("STT_COMPUTE_TYPE")

    # TTS
    if os.getenv("TTS_VOICE"):
        config.tts.voice = os.getenv("TTS_VOICE")
    if os.getenv("TTS_RATE"):
        try:
            config.tts.rate = int(os.getenv("TTS_RATE"))
        except ValueError:
            logging.warning(f"Invalid TTS_RATE: {os.getenv('TTS_RATE')}")
    if os.getenv("TTS_VOLUME"):
        try:
            config.tts.volume = float(os.getenv("TTS_VOLUME"))
        except ValueError:
            logging.warning(f"Invalid TTS_VOLUME: {os.getenv('TTS_VOLUME')}")

    # Audio
    if os.getenv("AUDIO_DEVICE_INDEX"):
        try:
            config.audio.device_index = int(os.getenv("AUDIO_DEVICE_INDEX"))
        except ValueError:
            logging.warning(f"Invalid AUDIO_DEVICE_INDEX: {os.getenv('AUDIO_DEVICE_INDEX')}")
    if os.getenv("AUDIO_SAMPLE_RATE"):
        try:
            config.audio.sample_rate = int(
                os.getenv("AUDIO_SAMPLE_RATE"))
        except ValueError:
            logging.warning(f"Invalid AUDIO_SAMPLE_RATE: {os.getenv('AUDIO_SAMPLE_RATE')}")

    # Harness
    if os.getenv("HARNESS_CONFIG_PATH"):
        config.harness.config_path = os.getenv("HARNESS_CONFIG_PATH")

    # Runtime
    if os.getenv("VOICE_AGENT_HEADLESS"):
        config.runtime.headless = os.getenv("VOICE_AGENT_HEADLESS", "").strip().lower() in {"1", "true", "yes", "y", "on"}

    return config


def create_default_config(path: str = "config/app_config.json"):
    """Create a default configuration file"""
    config = AppConfig()
    config.save(path)
    print(f"Default configuration saved to: {path}")
    return config
