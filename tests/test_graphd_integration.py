"""Test graphd integration with agent stack."""

import os
import sys
import tempfile

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from util.config import load_or_create_config
from util.runtime import create_runtime


def test_graphd_wiring():
    """Test that graphd_client flows through the entire stack."""
    print("\n=== Test: Graphd Client Wiring ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        # Load config
        config_path = "config/harness_config.json"
        config = load_or_create_config(config_path)

        # Ensure graphd is enabled
        assert config.graphd.enabled, "Graphd should be enabled in config"

        # Override db path and port to avoid conflicts
        config.graphd.db_path = os.path.join(tmpdir, "test.db")
        config.graphd.root_path = tmpdir
        config.graphd.port = 29444  # Use different port to avoid conflicts
        config.graphd.client_timeout_s = 5  # Increase timeout for slow starts

        # Create runtime
        runtime = create_runtime(
            config=config,
            log_dir=tmpdir
        )

        # Check that graphd was started
        assert runtime.graphd is not None, "Graphd manager should be initialized"

        # Check that tool_registry has graphd_client
        assert hasattr(runtime.tool_registry, '_graphd_client'), "ToolRegistry should have _graphd_client"
        assert runtime.tool_registry._graphd_client is not None, "ToolRegistry graphd_client should not be None"

        # Get an agent instance (standard tier)
        agent = runtime.agent.get_agent_for_tier("standard")

        # Check that agent has graphd_client
        assert hasattr(agent, '_graphd_client'), "Agent should have _graphd_client"
        assert agent._graphd_client is not None, "Agent graphd_client should not be None"

        # Check that executor has graphd_client
        assert hasattr(agent._executor, 'graphd_client'), "Executor should have graphd_client"
        assert agent._executor.graphd_client is not None, "Executor graphd_client should not be None"

        # Enable microloop and check it has graphd_client
        microloop_enabled = agent._executor.enable_microloop()
        assert microloop_enabled, "Microloop should be available"

        # Check that microloop has graphd_client
        assert hasattr(agent._executor._microloop, 'graphd_client'), "Microloop should have graphd_client"
        assert agent._executor._microloop.graphd_client is not None, "Microloop graphd_client should not be None"

        # Verify all graphd_clients are the same instance
        assert (runtime.tool_registry._graphd_client is
                agent._graphd_client is
                agent._executor.graphd_client is
                agent._executor._microloop.graphd_client), \
            "All graphd_client references should point to the same instance"

        # Test that graphd_client is functional
        health = agent._executor.graphd_client.health()
        assert health.get("status") == "ok", f"Graphd health check failed: {health}"

        print(f"  ✓ Graphd manager: {runtime.graphd}")
        print(f"  ✓ ToolRegistry has graphd_client: {runtime.tool_registry._graphd_client}")
        print(f"  ✓ Agent has graphd_client: {agent._graphd_client}")
        print(f"  ✓ Executor has graphd_client: {agent._executor.graphd_client}")
        print(f"  ✓ Microloop has graphd_client: {agent._executor._microloop.graphd_client}")
        print(f"  ✓ Health check: {health.get('status')}")
        print("✓ Graphd client wiring test passed")

        # Cleanup
        if runtime.graphd:
            runtime.graphd.stop()


if __name__ == "__main__":
    try:
        test_graphd_wiring()
        print("\n✅ All integration tests passed!")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
