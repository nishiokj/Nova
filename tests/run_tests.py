#!/usr/bin/env python3
"""
Test runner script for the Agent Harness test suite.

Usage:
    python run_tests.py                 # Run all tests
    python run_tests.py --quick         # Run quick tests only (no slow tests)
    python run_tests.py --coverage      # Run with coverage report
    python run_tests.py --verbose       # Run with verbose output
    python run_tests.py --module tool   # Run only tool_registry tests
    python run_tests.py --failed        # Run only previously failed tests
    python run_tests.py --watch         # Watch mode (rerun on file changes)

Test modules:
    - test_tool_registry: Tool execution tests (calculator, file ops, bash, python)
    - test_router: Request classification tests
    - test_agent: Agent execution and tiering tests
    - test_event_bus: Message passing and queue tests
    - test_harness_integration: Full pipeline integration tests
"""

import argparse
import os
import sys
import subprocess
import time
from pathlib import Path

# Ensure we're in the right directory
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent


def run_pytest(args: list, verbose: bool = False) -> int:
    """Run pytest with given arguments"""
    cmd = [sys.executable, "-m", "pytest"]
    cmd.extend(args)

    if verbose:
        print(f"Running: {' '.join(cmd)}")
        print("-" * 60)

    try:
        result = subprocess.run(cmd, cwd=PROJECT_ROOT)
        return result.returncode
    except KeyboardInterrupt:
        print("\nTests interrupted by user")
        return 1


def run_all_tests(verbose: bool = False, coverage: bool = False) -> int:
    """Run all tests"""
    args = [str(SCRIPT_DIR), "-v"]

    if coverage:
        args = ["--cov=harness", "--cov-report=html", "--cov-report=term-missing"] + args

    return run_pytest(args, verbose)


def run_quick_tests(verbose: bool = False) -> int:
    """Run quick tests only (skip slow tests)"""
    args = [
        str(SCRIPT_DIR),
        "-v",
        "-m", "not slow",
        "--tb=short"
    ]
    return run_pytest(args, verbose)


def run_module_tests(module: str, verbose: bool = False) -> int:
    """Run tests for a specific module"""
    module_map = {
        "tool": "test_tool_registry.py",
        "tools": "test_tool_registry.py",
        "tool_registry": "test_tool_registry.py",
        "router": "test_router.py",
        "agent": "test_agent.py",
        "event": "test_event_bus.py",
        "eventbus": "test_event_bus.py",
        "event_bus": "test_event_bus.py",
        "harness": "test_harness_integration.py",
        "integration": "test_harness_integration.py",
    }

    if module.lower() not in module_map:
        print(f"Unknown module: {module}")
        print(f"Available modules: {', '.join(module_map.keys())}")
        return 1

    test_file = SCRIPT_DIR / module_map[module.lower()]
    args = [str(test_file), "-v"]

    return run_pytest(args, verbose)


def run_failed_tests(verbose: bool = False) -> int:
    """Run only previously failed tests"""
    args = [str(SCRIPT_DIR), "-v", "--lf"]
    return run_pytest(args, verbose)


def run_watch_mode(verbose: bool = False) -> int:
    """Run tests in watch mode (rerun on file changes)"""
    try:
        import pytest_watch
    except ImportError:
        print("pytest-watch not installed. Install with: pip install pytest-watch")
        print("Falling back to manual watch mode...")

        # Manual watch mode
        last_run = 0
        watched_dirs = [SCRIPT_DIR, PROJECT_ROOT / "harness"]

        print("Watching for changes... (Ctrl+C to stop)")

        try:
            while True:
                # Check for file changes
                latest_change = 0
                for watch_dir in watched_dirs:
                    for f in watch_dir.rglob("*.py"):
                        mtime = f.stat().st_mtime
                        if mtime > latest_change:
                            latest_change = mtime

                if latest_change > last_run:
                    print("\n" + "=" * 60)
                    print("Changes detected, running tests...")
                    print("=" * 60)
                    run_all_tests(verbose)
                    last_run = time.time()

                time.sleep(1)
        except KeyboardInterrupt:
            print("\nWatch mode stopped")
            return 0

    # Use pytest-watch if available
    args = ["ptw", str(SCRIPT_DIR), "--", "-v"]
    return subprocess.run(args, cwd=PROJECT_ROOT).returncode


def run_specific_test(test_spec: str, verbose: bool = False) -> int:
    """Run a specific test by name"""
    args = [str(SCRIPT_DIR), "-v", "-k", test_spec]
    return run_pytest(args, verbose)


def print_test_summary():
    """Print summary of available tests"""
    print("\n" + "=" * 60)
    print("AGENT HARNESS TEST SUITE")
    print("=" * 60)
    print("""
Test Modules:
  - test_tool_registry.py  : Tests for all built-in tools
                             (calculator, file ops, bash, python, web)
  - test_router.py         : Request classification tests
  - test_agent.py          : Agent execution and tiering tests
  - test_event_bus.py      : Message passing tests
  - test_harness_integration.py : Full pipeline tests

Quick Start:
  python run_tests.py              # Run all tests
  python run_tests.py --quick      # Quick subset only
  python run_tests.py -m tool      # Just tool tests
  python run_tests.py -k calc      # Tests matching 'calc'

Options:
  --verbose, -v    Verbose pytest output
  --coverage       Generate coverage report
  --quick          Skip slow tests
  --module, -m     Run specific module
  --failed, -f     Rerun failed tests
  --watch, -w      Watch mode (auto-rerun)
  --test, -t       Run specific test by name
  --summary        Show this summary
""")


def main():
    parser = argparse.ArgumentParser(
        description="Run Agent Harness test suite",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose output"
    )
    parser.add_argument(
        "--coverage",
        action="store_true",
        help="Generate coverage report"
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Run quick tests only"
    )
    parser.add_argument(
        "--module", "-m",
        type=str,
        help="Run specific module (tool, router, agent, event, harness)"
    )
    parser.add_argument(
        "--failed", "-f",
        action="store_true",
        help="Run only previously failed tests"
    )
    parser.add_argument(
        "--watch", "-w",
        action="store_true",
        help="Watch mode"
    )
    parser.add_argument(
        "--test", "-t",
        type=str,
        help="Run specific test by name"
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Show test summary"
    )
    parser.add_argument(
        "--parallel", "-p",
        action="store_true",
        help="Run tests in parallel (requires pytest-xdist)"
    )

    args = parser.parse_args()

    if args.summary:
        print_test_summary()
        return 0

    # Change to project root
    os.chdir(PROJECT_ROOT)

    # Determine which tests to run
    if args.watch:
        return run_watch_mode(args.verbose)
    elif args.module:
        return run_module_tests(args.module, args.verbose)
    elif args.failed:
        return run_failed_tests(args.verbose)
    elif args.test:
        return run_specific_test(args.test, args.verbose)
    elif args.quick:
        return run_quick_tests(args.verbose)
    else:
        return run_all_tests(args.verbose, args.coverage)


if __name__ == "__main__":
    sys.exit(main())
