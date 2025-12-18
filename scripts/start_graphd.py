#!/usr/bin/env python3
"""Start graphd daemon standalone for testing."""

import sys
import os
import time

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from util.config import load_or_create_config
from harness.graphd import GraphdManager
from util.logger import StructuredLogger


def main():
    # Load config
    config = load_or_create_config("config/harness_config.json")

    if not config.graphd.enabled:
        print("Graphd is not enabled in config!")
        return 1

    # Create logger
    logger = StructuredLogger(
        log_dir=config.logging.log_dir,
        name="graphd-standalone",
        log_level="INFO",
        log_to_console=True
    )

    # Create and start graphd
    print(f"Starting graphd on {config.graphd.host}:{config.graphd.port}...")
    print(f"  Root: {config.graphd.root_path or os.getcwd()}")
    print(f"  DB: {config.graphd.db_path}")

    manager = GraphdManager(config.graphd, logger=logger)

    if not manager.start():
        print("✗ Failed to start graphd!")
        return 1

    print("✓ Graphd started successfully!")
    print(f"\nGraphd is running. Press Ctrl+C to stop.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n\nStopping graphd...")
        manager.stop()
        print("✓ Graphd stopped")
        return 0


if __name__ == "__main__":
    sys.exit(main())
