"""
Command-line interface for the MultiProcessVoiceApp.

This module powers both the local `run_app.py` script and the packaged
`voice-agent` console entry point defined in `pyproject.toml`.
"""

from __future__ import annotations

import argparse
import signal
import sys
import time
from multiprocessing import Process
from pathlib import Path
from typing import Optional

from app import MultiProcessVoiceApp
from app_config import AppConfig, RuntimeMode, load_app_config
from rl.worker import start_rl_worker as run_rl_worker
from util.config_discovery import find_config_file, init_user_config
from util.config_validator import ConfigValidator


def _build_parser() -> argparse.ArgumentParser:
    """Create the CLI argument parser."""
    return argparse.ArgumentParser(
        description="Voice-Activated AI Agent System (Refactored Architecture)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  voice-agent                                  # Run with default config
  voice-agent --config custom.json             # Run with custom config
  voice-agent --create-config                  # Create default config file
        """,
    )


def _get_version() -> str:
    """Get version from pyproject.toml."""
    try:
        from importlib.metadata import version
        return version("voice-agent-system")
    except Exception:
        return "0.1.0 (development)"


def _register_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--version",
        "-v",
        action="version",
        version=f"%(prog)s {_get_version()}",
        help="Show version and exit",
    )
    parser.add_argument(
        "--config",
        default=None,  # Will use discovery if not specified
        help="Path to application configuration file (default: XDG config search)",
    )
    parser.add_argument(
        "--config-dir",
        help="Custom config directory to search for configs",
    )
    parser.add_argument(
        "--create-config",
        action="store_true",
        help="[DEPRECATED] Use --init-config instead",
    )
    parser.add_argument(
        "--init-config",
        action="store_true",
        help="Initialize config in ~/.config/voice-agent/ and exit",
    )
    parser.add_argument(
        "--validate-config",
        action="store_true",
        help="Validate configuration and exit (no app startup)",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="List available audio input devices and exit",
    )
    parser.add_argument(
        "--health-check",
        action="store_true",
        help="Run health checks and exit (for Docker HEALTHCHECK)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--rl",
        action="store_true",
        help="Enable RL worker for log creation",
    )


def _print_banner(config: AppConfig) -> None:
    print("\n" + "=" * 60)
    print("Voice Agent System - Refactored Architecture")
    print("=" * 60)
    print(f"Runtime Mode: {config.runtime.mode.value}")
    print(f"STT Engine: {config.stt.engine} ({config.stt.model_size})")
    print(f"Harness Config: {config.harness.config_path}")
    print(f"Default Tier: {config.harness.default_tier}")
    print(f"RL Worker Enabled: {config.runtime.enable_rl_worker}")
    print("=" * 60)
    print()


def _start_rl_worker(app: MultiProcessVoiceApp) -> Optional[Process]:
    """Start the RL worker in its own process if enabled."""
    if not app.config.runtime.enable_rl_worker:
        return None

    rl_log_dir = Path(app.config.logging.log_dir or "logs")
    rl_log_dir.mkdir(parents=True, exist_ok=True)

    process = Process(
        target=run_rl_worker,
        args=(app.event_bus, str(rl_log_dir)),
        daemon=True,
        name="RLWorker",
    )
    process.start()
    print(f"RL worker started (PID: {process.pid})")
    return process


def _stop_rl_worker(process: Optional[Process]) -> None:
    """Terminate the RL worker if it is running."""
    if not process:
        return
    process.join(timeout=2.0)
    if process.is_alive():
        process.terminate()
        process.join(timeout=1.0)


def main(argv: Optional[list[str]] = None) -> int:
    """CLI entry point."""
    parser = _build_parser()
    _register_arguments(parser)
    args = parser.parse_args(argv)

    # Handle --init-config: Create user config directory
    if args.init_config:
        print("Initializing user configuration directory...")
        try:
            config_dir = init_user_config(args.config_dir)
            print(f"\n✓ Configuration initialized in: {config_dir}")
            print("\nNext steps:")
            print(f"  1. Edit {config_dir}/app_config.json")
            print(f"  2. Edit {config_dir}/harness_config.json")
            print(f"  3. Add API keys to {config_dir}/.env")
            print(f"  4. Run: voice-agent")
            return 0
        except Exception as e:
            print(f"\n✗ Error initializing config: {e}")
            return 1

    # Handle --list-devices: Show audio devices
    if args.list_devices:
        print("Available audio input devices:\n")
        try:
            import pyaudio
            pa = pyaudio.PyAudio()
            found_devices = False
            for i in range(pa.get_device_count()):
                info = pa.get_device_info_by_index(i)
                if info['maxInputChannels'] > 0:
                    found_devices = True
                    default = " (DEFAULT)" if i == pa.get_default_input_device_info()['index'] else ""
                    print(f"  [{i}] {info['name']}{default}")
                    print(f"      Channels: {info['maxInputChannels']}, "
                          f"Sample Rate: {int(info['defaultSampleRate'])} Hz")
            pa.terminate()

            if not found_devices:
                print("  No input devices found.")
                return 1

            print("\nTo use a specific device, set AUDIO_DEVICE_INDEX environment variable")
            print("or update audio.device_index in app_config.json")
            return 0
        except Exception as e:
            print(f"Error listing devices: {e}")
            return 1

    # Handle --health-check: Quick validation (for Docker HEALTHCHECK)
    if args.health_check:
        try:
            # Check 1: Audio devices
            import pyaudio
            pa = pyaudio.PyAudio()
            device_count = pa.get_device_count()
            pa.terminate()

            if device_count == 0:
                print("FAIL: No audio devices found")
                return 1

            # Check 2: Config file exists (if not using defaults)
            if args.config:
                config_path = Path(args.config)
                if not config_path.exists():
                    print(f"FAIL: Config file not found: {args.config}")
                    return 1

            print("PASS: Health check successful")
            return 0
        except Exception as e:
            print(f"FAIL: {e}")
            return 1

    # Handle deprecated --create-config
    if args.create_config:
        print("Warning: --create-config is deprecated. Use --init-config instead.")
        from app_config import create_default_config
        create_default_config(args.config or "config/app_config.json")
        return 0

    # Load configuration using discovery
    try:
        if args.config:
            # Explicit path provided
            config_path = Path(args.config)
            if not config_path.exists():
                print(f"Error: Config file not found: {args.config}")
                return 1
            config_path_str = str(config_path)
        else:
            # Use discovery
            config_path = find_config_file(
                explicit_path=args.config,
                config_dir=args.config_dir
            )
            config_path_str = str(config_path)
            print(f"Using configuration: {config_path_str}")
    except FileNotFoundError as e:
        print(f"\nError: {e}")
        return 1

    config = load_app_config(config_path_str)

    # Apply CLI overrides
    if args.debug:
        config.logging.level = "DEBUG"

    if args.rl:
        config.runtime.enable_rl_worker = True

    # Handle --validate-config: Validate and exit
    if args.validate_config:
        print(f"\nValidating configuration: {config_path_str}")
        validator = ConfigValidator(config)
        validator.validate_all()
        validator.print_report()
        return 0 if not validator.has_errors() else 1

    # Auto-validate before starting (fail fast on errors)
    validator = ConfigValidator(config)
    if not validator.validate_all():
        print(f"\nConfiguration validation failed for: {config_path_str}")
        validator.print_report()
        print("\nFix errors and try again, or run with --validate-config for details.")
        return 1

    # Force multi-process mode (current requirement)
    if config.runtime.mode != RuntimeMode.MULTI_PROCESS:
        print(f"Warning: Forcing multi-process mode (was {config.runtime.mode.value})")
        config.runtime.mode = RuntimeMode.MULTI_PROCESS

    app = MultiProcessVoiceApp(config)
    _print_banner(config)

    rl_worker_process = None

    def start_rl_worker_process():
        nonlocal rl_worker_process
        if config.runtime.enable_rl_worker:
            if rl_worker_process is None or not rl_worker_process.is_alive():
                rl_worker_process = _start_rl_worker(app)

    def stop_rl_worker_process():
        nonlocal rl_worker_process
        if rl_worker_process:
            _stop_rl_worker(rl_worker_process)
            rl_worker_process = None

    def signal_handler(signum, frame):
        del signum, frame
        print("\nShutting down gracefully...")
        app.stop()
        stop_rl_worker_process()
        sys.exit(0)

    for sig_name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, sig_name):
            signal.signal(getattr(signal, sig_name), signal_handler)

    if app.start():
        if config.runtime.enable_rl_worker:
            start_rl_worker_process()
        print("\nApp started successfully!")
        print("Speak to interact with the AI agent...")
        print("Press Ctrl+C to stop")

        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nReceived interrupt signal")
            app.stop()
            stop_rl_worker_process()
    else:
        print("\nFailed to start app!")
        stop_rl_worker_process()
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
