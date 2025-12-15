#!/usr/bin/env python3
"""
Verify RL Worker Integration

This script checks that all the RL worker components are properly integrated.
Run this to verify the setup before starting the full system.
"""

import sys
import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))


def check_imports():
    """Verify all required modules can be imported"""
    print("=" * 60)
    print("Checking Imports...")
    print("=" * 60)

    checks = [
        ("EventBus", "from communication.event_bus import EventBus"),
        ("RL Worker", "from rl.worker import start_rl_worker"),
        ("RewardShaper", "from rl.reward_shaper import RewardShaper"),
        ("EpisodeReconstructor", "from rl.reconstructor import EpisodeReconstructor"),
        ("TieredAgent", "from harness.agent import TieredAgent"),
    ]

    all_passed = True
    for name, import_stmt in checks:
        try:
            exec(import_stmt)
            print(f"✓ {name}")
        except Exception as e:
            print(f"✗ {name}: {e}")
            all_passed = False

    print()
    return all_passed


def check_event_bus_integration():
    """Check that EventBus has RL methods"""
    print("=" * 60)
    print("Checking EventBus Integration...")
    print("=" * 60)

    from communication.event_bus import EventBus, MessageType

    # Check MessageType has EPISODE_COMPLETE
    if hasattr(MessageType, 'EPISODE_COMPLETE'):
        print("✓ MessageType.EPISODE_COMPLETE exists")
    else:
        print("✗ MessageType.EPISODE_COMPLETE missing")
        return False

    # Create EventBus instance
    event_bus = EventBus()

    # Check methods exist
    checks = [
        ("emit_episode_complete", "Method to emit episode events"),
        ("get_episode_event", "Method to consume episode events"),
        ("is_shutdown", "Shutdown check method"),
        ("shutdown", "Shutdown method"),
    ]

    all_passed = True
    for method_name, description in checks:
        if hasattr(event_bus, method_name):
            print(f"✓ EventBus.{method_name}() - {description}")
        else:
            print(f"✗ EventBus.{method_name}() missing - {description}")
            all_passed = False

    print()
    return all_passed


def check_agent_integration():
    """Check that TieredAgent accepts event_bus parameter"""
    print("=" * 60)
    print("Checking Agent Integration...")
    print("=" * 60)

    from harness.agent import TieredAgent
    from util.config import AgentConfig
    from harness.agent.tool_registry import ToolRegistry
    from communication.event_bus import EventBus
    import inspect

    # Check TieredAgent.__init__ signature
    sig = inspect.signature(TieredAgent.__init__)
    params = list(sig.parameters.keys())

    if 'event_bus' in params:
        print("✓ TieredAgent accepts event_bus parameter")
    else:
        print("✗ TieredAgent missing event_bus parameter")
        print(f"  Parameters: {params}")
        return False

    # Try to create instance with event_bus
    try:
        event_bus = EventBus()
        tool_registry = ToolRegistry()
        config = AgentConfig(
            tier="standard",
            system_prompt="Test",
            max_tool_calls=5
        )

        agent = TieredAgent(
            config=config,
            tool_registry=tool_registry,
            tier_configs={},
            event_bus=event_bus
        )
        print("✓ TieredAgent can be instantiated with event_bus")

        # Check that agent stored event_bus
        if hasattr(agent, 'event_bus') and agent.event_bus is event_bus:
            print("✓ TieredAgent stores event_bus reference")
        else:
            print("✗ TieredAgent doesn't store event_bus reference")
            return False

    except Exception as e:
        print(f"✗ Failed to create TieredAgent with event_bus: {e}")
        return False

    print()
    return True


def check_rl_worker():
    """Check RL worker can be imported and has correct signature"""
    print("=" * 60)
    print("Checking RL Worker...")
    print("=" * 60)

    from rl.worker import start_rl_worker
    import inspect

    # Check signature
    sig = inspect.signature(start_rl_worker)
    params = list(sig.parameters.keys())

    if 'event_bus' in params:
        print("✓ start_rl_worker accepts event_bus parameter")
    else:
        print("✗ start_rl_worker missing event_bus parameter")
        return False

    if 'log_dir' in params:
        print("✓ start_rl_worker accepts log_dir parameter")
    else:
        print("⚠ start_rl_worker missing log_dir parameter (may use default)")

    print()
    return True


def check_main_integration():
    """Check that main.py has --rl-worker flag"""
    print("=" * 60)
    print("Checking main.py Integration...")
    print("=" * 60)

    main_path = Path(__file__).parent.parent / "main.py"

    if not main_path.exists():
        print("✗ main.py not found")
        return False

    with open(main_path) as f:
        content = f.read()

    checks = [
        ("--rl-worker flag", '"--rl-worker"'),
        ("rl_worker_enabled parameter", 'rl_worker_enabled'),
        ("RL worker startup", 'start_rl_worker'),
        ("RL worker process attribute", 'rl_worker_process'),
    ]

    all_passed = True
    for name, pattern in checks:
        if pattern in content:
            print(f"✓ {name} found in main.py")
        else:
            print(f"✗ {name} NOT found in main.py")
            all_passed = False

    print()
    return all_passed


def check_log_directories():
    """Check that log directories exist or can be created"""
    print("=" * 60)
    print("Checking Log Directories...")
    print("=" * 60)

    logs_dir = Path("logs")
    manifests_dir = logs_dir / "manifests"
    reconstructed_dir = logs_dir / "reconstructed"

    # Create if don't exist
    logs_dir.mkdir(exist_ok=True)
    manifests_dir.mkdir(exist_ok=True)
    (manifests_dir / "system_prompts").mkdir(exist_ok=True)
    (manifests_dir / "tool_manifests").mkdir(exist_ok=True)
    reconstructed_dir.mkdir(exist_ok=True)

    if logs_dir.exists():
        print(f"✓ logs/ directory exists")
    else:
        print(f"✗ logs/ directory doesn't exist")
        return False

    if manifests_dir.exists():
        print(f"✓ logs/manifests/ directory exists")
    else:
        print(f"⚠ logs/manifests/ directory doesn't exist (will be created)")

    if reconstructed_dir.exists():
        print(f"✓ logs/reconstructed/ directory exists")
    else:
        print(f"⚠ logs/reconstructed/ directory doesn't exist (will be created)")

    # Check write permissions
    test_file = logs_dir / ".write_test"
    try:
        test_file.write_text("test")
        test_file.unlink()
        print(f"✓ logs/ directory is writable")
    except Exception as e:
        print(f"✗ logs/ directory is not writable: {e}")
        return False

    print()
    return True


def check_reconstruction_system():
    """Check that reconstruction system is available"""
    print("=" * 60)
    print("Checking Reconstruction System...")
    print("=" * 60)

    try:
        from rl.reconstructor import EpisodeReconstructor, FullEpisode
        from util.manifest_store import ManifestStore

        print("✓ EpisodeReconstructor imported")
        print("✓ FullEpisode imported")
        print("✓ ManifestStore imported")

        # Try to create instances
        reconstructor = EpisodeReconstructor()
        print("✓ EpisodeReconstructor can be instantiated")

        store = ManifestStore()
        print("✓ ManifestStore can be instantiated")

    except Exception as e:
        print(f"✗ Reconstruction system error: {e}")
        return False

    print()
    return True


def main():
    """Run all verification checks"""
    print("\n" + "=" * 60)
    print("RL WORKER INTEGRATION VERIFICATION")
    print("=" * 60 + "\n")

    checks = [
        ("Imports", check_imports),
        ("EventBus Integration", check_event_bus_integration),
        ("Agent Integration", check_agent_integration),
        ("RL Worker", check_rl_worker),
        ("main.py Integration", check_main_integration),
        ("Log Directories", check_log_directories),
        ("Reconstruction System", check_reconstruction_system),
    ]

    results = {}
    for name, check_func in checks:
        try:
            results[name] = check_func()
        except Exception as e:
            print(f"✗ {name} check failed with exception: {e}")
            import traceback
            traceback.print_exc()
            results[name] = False
            print()

    # Summary
    print("=" * 60)
    print("VERIFICATION SUMMARY")
    print("=" * 60)

    for name, passed in results.items():
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{status:8} {name}")

    all_passed = all(results.values())

    print()
    if all_passed:
        print("🎉 ALL CHECKS PASSED!")
        print()
        print("You can now start the system with:")
        print("  python main.py --v2 --rl-worker")
        print()
        print("Monitor RL logs with:")
        print("  tail -f logs/rl_training.jsonl")
        return 0
    else:
        print("⚠️  SOME CHECKS FAILED")
        print()
        print("Please fix the issues above before running the RL worker.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
