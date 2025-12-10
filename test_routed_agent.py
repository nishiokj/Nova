"""
Test script to verify routed agent configuration works.
"""

import sys
from evals.agent_loader import create_agent_from_config

def test_routed_agent():
    """Test that routed agent can be created and used."""
    print("=" * 70)
    print("Testing Routed Agent Configuration")
    print("=" * 70)
    print()

    # Create routed agent factory
    print("[1/3] Creating routed agent factory...")
    try:
        factory = create_agent_from_config("routed_agent")
        print(f"✓ Factory created successfully")
        print(f"  Config: {factory.config}")
        print()
    except Exception as e:
        print(f"✗ Failed to create factory: {e}")
        return False

    # Create agent instance
    print("[2/3] Creating agent instance...")
    try:
        agent = factory()
        print(f"✓ Agent instance created successfully")
        print(f"  Type: {type(agent).__name__}")
        print()
    except Exception as e:
        print(f"✗ Failed to create agent instance: {e}")
        import traceback
        traceback.print_exc()
        return False

    # Test agent execution (without making actual API calls)
    print("[3/3] Testing agent interface...")
    try:
        # Verify agent has expected methods
        if not hasattr(agent, 'run'):
            print(f"✗ Agent missing 'run' method")
            return False
        if not hasattr(agent, 'stream'):
            print(f"✗ Agent missing 'stream' method")
            return False

        print(f"✓ Agent has required methods (run, stream)")
        print()

        # Note: We won't actually call run() to avoid API costs
        print("Note: Skipping actual execution to avoid API costs")
        print()
    except Exception as e:
        print(f"✗ Failed interface test: {e}")
        return False

    print("=" * 70)
    print("✓ ALL TESTS PASSED")
    print("=" * 70)
    print()
    print("The routed agent is ready to use. Example:")
    print("  python scripts/run_eval.py --agent-config routed_agent --quick")
    print()

    return True


if __name__ == "__main__":
    success = test_routed_agent()
    sys.exit(0 if success else 1)
