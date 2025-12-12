#!/usr/bin/env python3
"""
Multi-Process Voice Agent Entry Point

Architecture:
- Main Process: Audio capture + STT
- Agent Process: LLM reasoning and tool execution
- TTS Process: Speech synthesis
- No GIL contention, true parallelism
- Best performance for production

Usage:
    python run_multi.py                     # Use default config
    python run_multi.py --config path.json  # Use custom config
    python run_multi.py --create-config     # Create default config file
"""

import sys
import signal
import argparse
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from app_config import AppConfig, create_default_config
from app import MultiProcessVoiceApp


def main():
    """Main entry point for multi-process voice agent"""
    parser = argparse.ArgumentParser(
        description="Voice-Activated AI Agent System (Multi-Process)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_multi.py                         # Start with default config
  python run_multi.py --config my_config.json # Start with custom config
  python run_multi.py --create-config         # Create default config and exit
  python run_multi.py --list-devices          # List audio devices and exit

Architecture:
  Multi-process with true parallelism:
  - Main Process: Audio capture, VAD, Whisper STT
  - Agent Process: LLM reasoning, tool execution (no GIL)
  - TTS Process: Speech synthesis (no GIL)

  Communication via IPC EventBus (multiprocessing.Queue)
  Best performance, recommended for production
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
        "--list-devices",
        action="store_true",
        help="List available audio devices and exit"
    )

    args = parser.parse_args()

    # Create default config if requested
    if args.create_config:
        config = create_default_config(args.config)
        # Set to multi-process mode
        from app_config import RuntimeMode
        config.runtime.mode = RuntimeMode.MULTI_PROCESS
        config.save(args.config)
        print(f"Default multi-process configuration saved to: {args.config}")
        return

    # List devices if requested
    if args.list_devices:
        from audio_pipeline import AudioDeviceManager, AudioConfig
        from app_config import load_app_config

        app_config = load_app_config(args.config)
        audio_config = AudioConfig(app_config.audio.to_dict())
        device_manager = AudioDeviceManager(audio_config)
        devices = device_manager.list_devices()

        print("\nAvailable Audio Devices:")
        print("-" * 60)
        for device in devices:
            vad_rates = ', '.join(map(str, device['supported_vad_rates'])) or 'None'
            print(f"  [{device['index']}] {device['name']}")
            print(f"      Channels: {device['channels']}, Input: {device['is_input']}")
            print(f"      VAD Rates: {vad_rates}")
            print()
        return

    # Load configuration
    config = AppConfig.load(args.config)

    # Override runtime mode to multi-process
    from app_config import RuntimeMode
    config.runtime.mode = RuntimeMode.MULTI_PROCESS

    # Create application
    print("=" * 60)
    print("Voice Agent System - Multi-Process Architecture")
    print("=" * 60)
    print("  Main Process: Audio capture, Whisper STT")
    print("  Agent Process: LLM reasoning, tool execution")
    print("  TTS Process: Speech synthesis")
    print("  Communication: IPC via multiprocessing.Queue")
    print("  Best for: Production, maximum performance")
    print("=" * 60)
    print()

    app = MultiProcessVoiceApp(config)

    # Handle signals
    def signal_handler(signum, frame):
        print("\nShutting down...")
        app.stop()
        sys.exit(0)

    for sig_name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"):
        if hasattr(signal, sig_name):
            signal.signal(getattr(signal, sig_name), signal_handler)

    # Run application
    app.run_blocking()


if __name__ == "__main__":
    main()
