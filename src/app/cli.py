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


def _register_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--config",
        default="config/app_config.json",
        help="Path to application configuration file",
    )
    parser.add_argument(
        "--create-config",
        action="store_true",
        help="Create default configuration file and exit",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--rl",
        action="store_true",
        help="Worker for RL log creation",
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

    if args.create_config:
        from app_config import create_default_config

        create_default_config(args.config)
        return 0

    print(f"Loading configuration from: {args.config}")
    config = load_app_config(args.config)

    if args.debug:
        config.logging.level = "DEBUG"

    if args.rl:
        config.runtime.enable_rl_worker = True

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
