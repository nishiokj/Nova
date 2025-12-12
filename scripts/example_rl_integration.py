#!/usr/bin/env python3
"""
Example: Integrating RL Logging into Existing Agent System

This example shows how to add RL logging to your existing agent setup
without modifying the core agent workflow.
"""

import sys
import time
from pathlib import Path
from multiprocessing import Process

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from communication.event_bus import EventBus
from harness.agent import TieredAgent, AgentConfig
from harness.tool_registry import ToolRegistry
from harness.config import LLMConfig
from rl.worker import start_rl_worker


def setup_with_rl_logging():
    """
    Setup agent system with RL logging enabled.

    This example shows the minimal changes needed to add RL logging
    to an existing agent system.
    """
    print("=" * 60)
    print("RL Logging Integration Example")
    print("=" * 60 + "\n")

    # 1. Create EventBus (NEW)
    print("1. Creating EventBus for RL logging...")
    event_bus = EventBus()

    # 2. Setup existing components (no changes needed)
    print("2. Setting up agent components...")
    tool_registry = ToolRegistry()

    # Register some basic tools (example)
    # In real system, this would be your existing tool registration
    from harness.tools.bash_executor import BashExecutor
    from harness.tools.file_operations import FileReader, FileWriter

    bash_tool = BashExecutor()
    tool_registry.register_tool(bash_tool)

    file_reader = FileReader()
    tool_registry.register_tool(file_reader)

    file_writer = FileWriter()
    tool_registry.register_tool(file_writer)

    # 3. Create LLM configs (no changes needed)
    print("3. Creating LLM configs...")
    llm_config = LLMConfig(
        provider="openai",
        model="gpt-4",
        api_key="your-api-key-here"
    )

    tier_configs = {
        "simple": llm_config,
        "standard": llm_config,
        "advanced": llm_config
    }

    # 4. Create agent config (no changes needed)
    agent_config = AgentConfig(
        llm_config=llm_config,
        tier="advanced",
        system_prompt="You are a helpful assistant.",
        max_tool_calls=10
    )

    # 5. Create TieredAgent with EventBus (ONLY CHANGE)
    print("4. Creating TieredAgent with RL logging...")
    agent = TieredAgent(
        config=agent_config,
        tool_registry=tool_registry,
        tier_configs=tier_configs,
        event_bus=event_bus  # <-- Add this parameter
    )

    # 6. Start RL worker process (NEW)
    print("5. Starting RL worker process...")
    rl_worker = Process(
        target=start_rl_worker,
        args=(event_bus, "logs"),
        daemon=True,
        name="RLWorker"
    )
    rl_worker.start()
    print(f"   RL worker started (PID: {rl_worker.pid})")

    print("\n" + "=" * 60)
    print("✅ RL Logging Setup Complete!")
    print("=" * 60 + "\n")

    return agent, event_bus, rl_worker


def run_example_tasks(agent):
    """
    Run some example tasks to generate RL logs.

    Agent usage is EXACTLY THE SAME as before - RL logging
    happens automatically in the background.
    """
    print("Running example tasks...")
    print("-" * 60 + "\n")

    tasks = [
        ("Create a test file", "advanced"),
        ("List files in current directory", "standard"),
        ("What is 2+2?", "simple")
    ]

    for i, (task, tier) in enumerate(tasks, 1):
        print(f"Task {i}/{len(tasks)}: {task} (tier: {tier})")
        print("   Running...")

        try:
            response = agent.run(task, tier=tier)

            print(f"   ✓ Success: {response.success}")
            print(f"   ✓ Goal achieved: {response.goal_achieved}")
            print(f"   ✓ Duration: {response.total_duration_ms:.0f}ms")
            print(f"   ✓ Tools used: {response.tools_used}")

            # RL logging happens automatically here!
            # Episode will be logged to logs/rl_training.jsonl

        except Exception as e:
            print(f"   ✗ Error: {e}")

        print()

    print("-" * 60)
    print("✅ All tasks completed!")
    print("-" * 60 + "\n")


def check_rl_logs():
    """
    Check that RL logs were written correctly.
    """
    print("Checking RL logs...")
    print("-" * 60 + "\n")

    rl_log_path = Path("logs/rl_training.jsonl")

    # Give worker a moment to process
    time.sleep(1)

    if not rl_log_path.exists():
        print("⚠️  RL log file not found yet (worker may still be processing)")
        return

    # Count episodes
    with open(rl_log_path) as f:
        lines = f.readlines()
        episode_count = len(lines)

    print(f"✓ RL log file: {rl_log_path}")
    print(f"✓ Episodes logged: {episode_count}")

    if episode_count > 0:
        print(f"\n📊 Sample RL log entry:\n")

        import json
        sample = json.loads(lines[-1])

        print(f"   req_id: {sample['req_id']}")
        print(f"   exec_id: {sample['exec_id']}")
        print(f"   goal_achieved: {sample['episode']['goal_achieved']}")
        print(f"   episode_reward: {sample['episode']['episode_reward']:.3f}")
        print(f"   steps: {len(sample['steps'])}")

        for step in sample['steps']:
            print(f"      - Step {step['step_num']}: "
                  f"reward={step['reward']:.3f}, "
                  f"classification={step['classification']}")

    print("\n" + "-" * 60)
    print("✅ RL logging verified!")
    print("-" * 60 + "\n")


def main():
    """
    Main integration example.

    Shows complete workflow:
    1. Setup with RL logging
    2. Run normal agent tasks
    3. Verify RL logs were created
    """
    print("\n" + "=" * 60)
    print("EXAMPLE: Integrating RL Logging")
    print("=" * 60 + "\n")

    print("This example demonstrates how to add RL logging to your")
    print("existing agent system with minimal code changes.\n")

    # Setup
    agent, event_bus, rl_worker = setup_with_rl_logging()

    # Run tasks (agent usage unchanged!)
    # run_example_tasks(agent)

    # Check logs
    # check_rl_logs()

    print("=" * 60)
    print("Key Takeaways:")
    print("=" * 60)
    print()
    print("1. ✅ Only 2 changes needed:")
    print("   - Pass event_bus to TieredAgent")
    print("   - Start RL worker process")
    print()
    print("2. ✅ Agent usage unchanged:")
    print("   - agent.run() works exactly the same")
    print("   - No performance impact")
    print()
    print("3. ✅ RL logs created automatically:")
    print("   - logs/rl_training.jsonl")
    print("   - Per-step rewards")
    print("   - Quality classifications")
    print()
    print("4. ✅ Zero coupling:")
    print("   - RL logging never influences agent")
    print("   - Background process handles everything")
    print()
    print("=" * 60 + "\n")

    # Cleanup
    if rl_worker.is_alive():
        print("Shutting down RL worker...")
        event_bus.shutdown()
        rl_worker.join(timeout=2)
        print("✓ RL worker stopped\n")


if __name__ == "__main__":
    # Note: This is a demonstration script
    # To actually run with real LLM calls, you need:
    # 1. Valid API keys in config
    # 2. Proper tool implementations
    # 3. Environment setup

    # For now, just show the structure
    print("\n" + "=" * 60)
    print("RL Logging Integration Example")
    print("=" * 60)
    print()
    print("To use RL logging in your agent system:")
    print()
    print("1. Create EventBus:")
    print("   event_bus = EventBus()")
    print()
    print("2. Pass to TieredAgent:")
    print("   agent = TieredAgent(..., event_bus=event_bus)")
    print()
    print("3. Start RL worker:")
    print("   rl_worker = Process(target=start_rl_worker, args=(event_bus,))")
    print("   rl_worker.start()")
    print()
    print("4. Use agent normally:")
    print("   response = agent.run('your task')")
    print()
    print("That's it! RL logs will be written to logs/rl_training.jsonl")
    print()
    print("=" * 60 + "\n")
