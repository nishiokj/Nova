#!/usr/bin/env python3
"""
Entry point for the refactored MultiProcessVoiceApp.

This script runs the new architecture using:
- src/app/multi_process_app.py (MultiProcessVoiceApp)
- src/app_config.py (AppConfig)
- Refactored communication layer with EventBus
- New services layer (audio, stt, linter)
- New harness workers with ProcessWorker interface
"""

import sys
import os
import signal
import argparse
from pathlib import Path

# Add src to path
ROOT_DIR = Path(__file__).resolve().parent
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from app_config import AppConfig, load_app_config, RuntimeMode
from app import MultiProcessVoiceApp


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Voice-Activated AI Agent System (Refactored Architecture)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_app.py                           # Run with default config
  python run_app.py --config custom.json     # Run with custom config
  python run_app.py --create-config          # Create default config file
        """
    )

    parser.add_argument(
        "--config",
        default="config/app_config.json",
        help="Path to application configuration file"
    )
    parser.add_argument(
        "--create-config",
        action="store_true",
        help="Create default configuration file and exit"
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging"
    )

    args = parser.parse_args()

    # Create default config if requested
    if args.create_config:
        from app_config import create_default_config
        create_default_config(args.config)
        return

    # Load configuration
    print(f"Loading configuration from: {args.config}")
    config = load_app_config(args.config)

    # Override debug level if specified
    if args.debug:
        config.logging.level = "DEBUG"

    # Ensure we're in multi-process mode
    if config.runtime.mode != RuntimeMode.MULTI_PROCESS:
        print(f"Warning: Forcing multi-process mode (was {config.runtime.mode.value})")
        config.runtime.mode = RuntimeMode.MULTI_PROCESS

    # Create and start the app
    print("\n" + "="*60)
    print("Voice Agent System - Refactored Architecture")
    print("="*60)
    print(f"Runtime Mode: {config.runtime.mode.value}")
    print(f"STT Engine: {config.stt.engine} ({config.stt.model_size})")
    print(f"Harness Config: {config.harness.config_path}")
    print(f"Default Tier: {config.harness.default_tier}")
    print("="*60)
    print()

    # Create app
    app = MultiProcessVoiceApp(config)

    # Signal handlers
    def signal_handler(signum, frame):
        print("\nShutting down gracefully...")
        app.stop()
        sys.exit(0)

    # Register signal handlers
    for sig_name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, sig_name):
            signal.signal(getattr(signal, sig_name), signal_handler)

    # Start the app
    if app.start():
        print("\nApp started successfully!")
        print("Speak to interact with the AI agent...")
        print("Press Ctrl+C to stop")

        # Block until stopped
        try:
            import time
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nReceived interrupt signal")
            app.stop()
    else:
        print("\nFailed to start app!")
        sys.exit(1)


if __name__ == "__main__":
    main()
