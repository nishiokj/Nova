#!/usr/bin/env python3
"""
Memory profiling script for rex.

Usage:
    python scripts/profile_memory.py [component]

Components:
    agent - Profile agent execution
    tool_registry - Profile tool registry operations
    logger - Profile logger operations
    all - Profile all components (default)
"""

import sys
import tracemalloc
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


def profile_tool_registry():
    """Profile tool registry memory usage."""
    tracemalloc.start()

    from harness.agent.tool_registry import ToolRegistry

    registry = ToolRegistry()

    # Register many tools
    for i in range(100):

        def tool_func(**kwargs):
            return {"i": i}

        registry.register_function(
            name=f"tool_{i}",
            func=tool_func,
            description=f"Tool {i} for testing",
            parameters={"type": "object", "properties": {}},
        )

    # Take snapshot
    snapshot = tracemalloc.take_snapshot()
    top_stats = snapshot.statistics("lineno")

    print("\n=== Tool Registry Memory Profile ===")
    print("Top 10 memory allocations:")
    for stat in top_stats[:10]:
        print(f"  {stat}")

    current, peak = tracemalloc.get_traced_memory()
    print(f"\nCurrent: {current / 1024 / 1024:.2f} MB")
    print(f"Peak: {peak / 1024 / 1024:.2f} MB")

    tracemalloc.stop()


def profile_logger():
    """Profile logger memory usage."""
    import tempfile

    tracemalloc.start()

    from util.logger import StructuredLogger

    with tempfile.TemporaryDirectory() as tmpdir:
        logger = StructuredLogger(log_dir=tmpdir)

        # Generate many log entries
        for i in range(1000):
            logger.info(f"Test message {i}")

        snapshot = tracemalloc.take_snapshot()
        top_stats = snapshot.statistics("lineno")

        print("\n=== Logger Memory Profile ===")
        print("Top 10 memory allocations:")
        for stat in top_stats[:10]:
            print(f"  {stat}")

        current, peak = tracemalloc.get_traced_memory()
        print(f"\nCurrent: {current / 1024 / 1024:.2f} MB")
        print(f"Peak: {peak / 1024 / 1024:.2f} MB")

    tracemalloc.stop()


def profile_resilience():
    """Profile resilience module memory usage."""
    tracemalloc.start()

    from util.resilience import CircuitBreakerState, ResilienceConfig

    # Create many states
    states = {}
    for i in range(1000):
        states[f"target_{i}"] = CircuitBreakerState()

    # Take snapshot
    snapshot = tracemalloc.take_snapshot()
    top_stats = snapshot.statistics("lineno")

    print("\n=== Resilience Memory Profile ===")
    print("Top 10 memory allocations:")
    for stat in top_stats[:10]:
        print(f"  {stat}")

    current, peak = tracemalloc.get_traced_memory()
    print(f"\nCurrent: {current / 1024 / 1024:.2f} MB")
    print(f"Peak: {peak / 1024 / 1024:.2f} MB")

    tracemalloc.stop()


def main():
    component = sys.argv[1] if len(sys.argv) > 1 else "all"

    if component in ("tool_registry", "all"):
        profile_tool_registry()

    if component in ("logger", "all"):
        profile_logger()

    if component in ("resilience", "all"):
        profile_resilience()

    if component not in ("tool_registry", "logger", "resilience", "all"):
        print(f"Unknown component: {component}")
        print("Available: tool_registry, logger, resilience, all")
        sys.exit(1)


if __name__ == "__main__":
    main()
