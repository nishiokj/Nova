"""
Configuration validation module for Voice Agent System.

Validates configuration before startup with helpful error messages.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Optional

from app_config import AppConfig


class Severity(str, Enum):
    """Validation issue severity levels."""
    ERROR = "error"      # Must be fixed before running
    WARNING = "warning"  # Should be addressed but not blocking
    INFO = "info"        # Informational notices


@dataclass
class ValidationIssue:
    """Represents a single validation issue."""
    severity: Severity
    field: str
    message: str

    def __str__(self) -> str:
        symbol = {
            Severity.ERROR: "✗",
            Severity.WARNING: "⚠",
            Severity.INFO: "ℹ",
        }
        color = {
            Severity.ERROR: "\033[0;31m",      # Red
            Severity.WARNING: "\033[1;33m",    # Yellow
            Severity.INFO: "\033[0;36m",       # Cyan
        }
        reset = "\033[0m"

        sev_str = self.severity.value.upper()
        return f"{symbol[self.severity]} {color[self.severity]}{sev_str}{reset} [{self.field}]: {self.message}"


class ConfigValidator:
    """Validates AppConfig before application startup."""

    def __init__(self, config: AppConfig):
        self.config = config
        self.issues: list[ValidationIssue] = []

    def add_error(self, field: str, message: str) -> None:
        """Add an error-level validation issue."""
        self.issues.append(ValidationIssue(Severity.ERROR, field, message))

    def add_warning(self, field: str, message: str) -> None:
        """Add a warning-level validation issue."""
        self.issues.append(ValidationIssue(Severity.WARNING, field, message))

    def add_info(self, field: str, message: str) -> None:
        """Add an info-level validation issue."""
        self.issues.append(ValidationIssue(Severity.INFO, field, message))

    def has_errors(self) -> bool:
        """Check if any errors were found."""
        return any(issue.severity == Severity.ERROR for issue in self.issues)

    def validate_all(self) -> bool:
        """
        Run all validation checks.

        Returns:
            True if validation passed (no errors), False otherwise
        """
        self.issues.clear()

        # Run all validation methods
        self._validate_audio()
        self._validate_stt()
        self._validate_harness()
        self._validate_api_keys()
        self._validate_logging()
        self._validate_runtime()

        return not self.has_errors()

    def _validate_audio(self) -> None:
        """Validate audio configuration."""
        audio = self.config.audio

        # Headless mode: allow running without audio devices (e.g., Docker on macOS/CI).
        if getattr(self.config.runtime, "headless", False):
            self.add_info(
                "runtime.headless",
                "Headless mode enabled: skipping audio device validation."
            )
            return

        # Sample rate validation
        valid_sample_rates = [8000, 16000, 32000, 48000]
        if audio.sample_rate not in valid_sample_rates:
            self.add_warning(
                "audio.sample_rate",
                f"Unusual sample rate: {audio.sample_rate}. "
                f"Recommended: {', '.join(map(str, valid_sample_rates))} Hz"
            )

        # VAD aggressiveness
        if not 0 <= audio.vad_aggressiveness <= 3:
            self.add_error(
                "audio.vad_aggressiveness",
                f"Invalid VAD aggressiveness: {audio.vad_aggressiveness}. Must be 0-3."
            )

        # Device index
        if audio.device_index is not None and audio.device_index < 0:
            self.add_error(
                "audio.device_index",
                f"Invalid device index: {audio.device_index}. Must be >= 0 or None."
            )

        # Try to validate actual audio device availability
        try:
            import pyaudio
            pa = pyaudio.PyAudio()
            device_count = pa.get_device_count()

            if device_count == 0:
                self.add_error(
                    "audio",
                    "No audio devices found.\n\n"
                    "      To fix this:\n"
                    "      1. Connect a microphone or audio input device\n"
                    "      2. Ensure audio permissions are granted (System Settings > Privacy & Security > Microphone)\n"
                    "      3. If running in Docker, use --headless mode: voice-agent --headless\n"
                    "      4. If testing without audio: voice-agent --headless"
                )
            else:
                if audio.device_index is not None and audio.device_index >= device_count:
                    self.add_error(
                        "audio.device_index",
                        f"Device index {audio.device_index} not found (only {device_count} device(s) available).\n\n"
                        f"      To fix this:\n"
                        f"      1. Run: voice-agent --list-devices\n"
                        f"      2. Choose a valid device index (0-{device_count-1})\n"
                        f"      3. Update audio.device_index in your config file\n"
                        f"      4. Or set AUDIO_DEVICE_INDEX environment variable"
                    )
                else:
                    self.add_info(
                        "audio",
                        f"Found {device_count} audio device(s). "
                        f"Using device {audio.device_index if audio.device_index is not None else 'default'}."
                    )

            pa.terminate()
        except ImportError:
            self.add_error(
                "audio",
                "PyAudio not installed or not accessible.\n\n"
                "      To fix this:\n"
                "      1. Install PyAudio: pip install pyaudio\n"
                "      2. On macOS: brew install portaudio && pip install pyaudio\n"
                "      3. On Linux: sudo apt-get install portaudio19-dev python3-pyaudio\n"
                "      4. Or run in headless mode: voice-agent --headless"
            )
        except Exception as e:
            self.add_warning(
                "audio",
                f"Could not validate audio devices: {e}\n"
                "      If this persists, try: voice-agent --headless"
            )

    def _validate_stt(self) -> None:
        """Validate STT configuration."""
        stt = self.config.stt

        # Engine validation
        valid_engines = ["whisper", "google"]
        if stt.engine not in valid_engines:
            self.add_error(
                "stt.engine",
                f"Unknown STT engine: {stt.engine}. Valid: {', '.join(valid_engines)}"
            )

        # Model size validation (Whisper)
        if stt.engine == "whisper":
            valid_models = [
                "tiny", "tiny.en",
                "base", "base.en",
                "small", "small.en",
                "medium", "medium.en",
                "large-v1", "large-v2", "large-v3"
            ]
            if stt.model_size not in valid_models:
                self.add_error(
                    "stt.model_size",
                    f"Unknown Whisper model: {stt.model_size}. "
                    f"Valid: {', '.join(valid_models[:8])}..."
                )

        # Device validation
        if stt.device == "cuda":
            try:
                import torch
                if not torch.cuda.is_available():
                    self.add_error(
                        "stt.device",
                        "CUDA requested but not available. "
                        "Set device='cpu' or 'auto', or install CUDA toolkit."
                    )
                else:
                    cuda_version = torch.version.cuda
                    self.add_info(
                        "stt.device",
                        f"CUDA available (version {cuda_version}). GPU acceleration enabled."
                    )
            except ImportError:
                self.add_error(
                    "stt.device",
                    "CUDA requested but PyTorch not installed or doesn't support CUDA."
                )
        elif stt.device == "mps":
            try:
                import torch
                if not torch.backends.mps.is_available():
                    self.add_warning(
                        "stt.device",
                        "MPS (Apple Metal) requested but not available. Falling back to CPU."
                    )
            except (ImportError, AttributeError):
                self.add_warning(
                    "stt.device",
                    "MPS requested but PyTorch MPS backend not available."
                )

    def _validate_harness(self) -> None:
        """Validate harness configuration."""
        harness = self.config.harness

        # Config file exists
        config_path = Path(harness.config_path)
        if not config_path.exists():
            self.add_error(
                "harness.config_path",
                f"Harness config file not found: {harness.config_path}"
            )
        else:
            # Try to parse as JSON
            try:
                import json
                with open(config_path, 'r') as f:
                    json.load(f)
                self.add_info(
                    "harness.config_path",
                    f"Harness config loaded: {harness.config_path}"
                )
            except json.JSONDecodeError as e:
                self.add_error(
                    "harness.config_path",
                    f"Invalid JSON in harness config: {e}"
                )
            except Exception as e:
                self.add_warning(
                    "harness.config_path",
                    f"Could not read harness config: {e}"
                )

        # Default tier
        valid_tiers = ["simple", "standard", "advanced"]
        if harness.default_tier not in valid_tiers:
            self.add_warning(
                "harness.default_tier",
                f"Unknown default tier: {harness.default_tier}. "
                f"Valid: {', '.join(valid_tiers)}"
            )

    def _validate_api_keys(self) -> None:
        """Validate API key configuration."""
        providers = {
            "OPENAI_API_KEY": os.getenv("OPENAI_API_KEY"),
            "ANTHROPIC_API_KEY": os.getenv("ANTHROPIC_API_KEY"),
            "GOOGLE_API_KEY": os.getenv("GOOGLE_API_KEY"),
        }

        configured = [name for name, value in providers.items() if value]

        if not configured:
            from util.config_discovery import get_user_config_dir
            env_path = get_user_config_dir() / ".env"

            self.add_error(
                "environment.api_keys",
                "No API keys found in environment.\n"
                "      At least one LLM provider API key is required.\n\n"
                "      To fix this:\n"
                f"      1. Edit {env_path}\n"
                "      2. Add your API key (e.g., OPENAI_API_KEY=sk-...)\n"
                "      3. Restart voice-agent\n\n"
                "      Alternatively, set environment variables before running:\n"
                "        export OPENAI_API_KEY=sk-...\n"
                "        voice-agent"
            )
        else:
            self.add_info(
                "environment.api_keys",
                f"API keys configured: {', '.join(configured)}"
            )

    def _validate_logging(self) -> None:
        """Validate logging configuration."""
        logging = self.config.logging

        # Log level
        valid_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        if logging.level not in valid_levels:
            self.add_warning(
                "logging.level",
                f"Unknown log level: {logging.level}. Valid: {', '.join(valid_levels)}"
            )

        # Log directory
        if logging.log_dir:
            log_path = Path(logging.log_dir)
            if not log_path.exists():
                try:
                    log_path.mkdir(parents=True, exist_ok=True)
                    self.add_info(
                        "logging.log_dir",
                        f"Created log directory: {logging.log_dir}"
                    )
                except Exception as e:
                    self.add_error(
                        "logging.log_dir",
                        f"Cannot create log directory {logging.log_dir}: {e}"
                    )
            elif not os.access(log_path, os.W_OK):
                self.add_error(
                    "logging.log_dir",
                    f"Log directory not writable: {logging.log_dir}"
                )

    def _validate_runtime(self) -> None:
        """Validate runtime configuration."""
        runtime = self.config.runtime

        # Mode
        from app_config import RuntimeMode
        if runtime.mode not in [RuntimeMode.SINGLE_PROCESS, RuntimeMode.MULTI_PROCESS]:
            self.add_error(
                "runtime.mode",
                f"Invalid runtime mode: {runtime.mode}"
            )

        # RL worker
        if runtime.enable_rl_worker:
            self.add_info(
                "runtime.enable_rl_worker",
                "RL worker enabled. Episode data will be logged for training."
            )

    def print_report(self) -> None:
        """Print validation report to console."""
        if not self.issues:
            print("\n✓ Configuration validation passed (no issues found)\n")
            return

        # Group by severity
        errors = [i for i in self.issues if i.severity == Severity.ERROR]
        warnings = [i for i in self.issues if i.severity == Severity.WARNING]
        infos = [i for i in self.issues if i.severity == Severity.INFO]

        print("\n" + "=" * 70)
        print("Configuration Validation Report")
        print("=" * 70)

        if errors:
            print(f"\nFound {len(errors)} error(s):")
            for issue in errors:
                print(f"  {issue}")

        if warnings:
            print(f"\nFound {len(warnings)} warning(s):")
            for issue in warnings:
                print(f"  {issue}")

        if infos:
            print(f"\nInfo ({len(infos)}):")
            for issue in infos:
                print(f"  {issue}")

        print("\n" + "=" * 70)

        if errors:
            print("\n✗ Validation FAILED. Fix errors above before running.\n")
        elif warnings:
            print("\n⚠ Validation passed with warnings. Review warnings above.\n")
        else:
            print("\n✓ Validation PASSED.\n")
