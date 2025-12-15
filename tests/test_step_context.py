"""
Test Per-Step Context for RL Training

Validates that each step has complete context (state) embedded for RL training.
"""

import json
from pathlib import Path
from util.manifest_store import ManifestStore
from rl.reconstructor import EpisodeReconstructor


def test_step_context_embedding():
    """Test that steps have embedded context (state)"""
    print("Testing per-step context embedding...")

    # Setup
    store = ManifestStore(base_dir="logs/test/manifests")
    store.store_system_prompt(
        tier="advanced",
        version="v1",
        prompt="You are an expert assistant.",
        prompt_id="test_prompt_v1"
    )
    store.store_tool_manifest(
        tools=[
            {"name": "file_write", "description": "Write to file"},
            {"name": "bash_execute", "description": "Execute bash"}
        ],
        version="v1",
        manifest_id="test_tools_v1"
    )

    # Create mock logs with execution_context
    exec_id = "test-step-ctx-0001"
    req_id = "test-step-ctx-req"

    exec_log_path = Path("logs/test/agent_execution_step_ctx.jsonl")
    exec_log_path.parent.mkdir(parents=True, exist_ok=True)

    logs = [
        # Agent context
        {
            "ts": "2025-12-10T20:00:00.000Z",
            "svc": "agent_context",
            "req_id": req_id,
            "exec_id": exec_id,
            "context": {
                "tier": "advanced",
                "system_prompt_id": "test_prompt_v1",
                "tool_manifest_id": "test_tools_v1",
                "conversation_history": [],
                "tool_count": 2
            },
            "request": {
                "user_input": "Create test.txt with hello world"
            }
        },
        # Planning
        {
            "ts": "2025-12-10T20:00:01.000Z",
            "svc": "planning",
            "req_id": req_id,
            "exec_id": exec_id,
            "plan": {
                "goal": "Create test.txt file with content",
                "goal_type": "task",
                "estimated_complexity": "simple",
                "success_criteria": "File exists with correct content",
                "requires_tools": True,
                "steps": [
                    {
                        "step_num": 1,
                        "objective": "Write file with content",
                        "tool_hint": "file_write",
                        "status": "pending"
                    }
                ]
            }
        },
        # Execution context for step 1 (STATE the model saw!)
        {
            "ts": "2025-12-10T20:00:02.000Z",
            "svc": "execution_context",
            "req_id": req_id,
            "exec_id": exec_id,
            "step_id": "step-1",
            "context": {
                "step_num": 1,
                "step_objective": "Write file with content",
                "tool_hint": "file_write",
                "messages": [
                    {"role": "system", "content": "You are an expert assistant."},
                    {"role": "user", "content": "Create test.txt with hello world"}
                ],
                "available_tools": ["file_write", "bash_execute"],
                "system_prompt_id": "test_prompt_v1",
                "tool_manifest_id": "test_tools_v1"
            }
        },
        # Execution step 1 (ACTION the model took!)
        {
            "ts": "2025-12-10T20:00:03.000Z",
            "svc": "execution_step",
            "req_id": req_id,
            "exec_id": exec_id,
            "step_id": "step-1",
            "step_num": 1,
            "status": "completed",
            "action": {
                "type": "tool_call",
                "tool_name": "file_write",
                "tool_args": {"path": "test.txt", "content": "hello world"}
            },
            "result": {
                "duration_ms": 50,
                "tool_success": True,
                "tool_output": "File written successfully"
            }
        },
        # Episode summary
        {
            "ts": "2025-12-10T20:00:04.000Z",
            "svc": "episode_summary",
            "req_id": req_id,
            "exec_id": exec_id,
            "stats": {
                "total_duration_ms": 200,
                "tool_calls": 1,
                "tool_failures": 0
            },
            "labels": {
                "goal_achieved": True,
                "reflection_confidence": 0.95,
                "gaps": [],
                "evidence": ["File created successfully"]
            }
        }
    ]

    with open(exec_log_path, 'w') as f:
        for log in logs:
            f.write(json.dumps(log) + "\n")

    print(f"✓ Created execution logs with step context")

    # Create RL log
    rl_log_path = Path("logs/test/rl_training_step_ctx.jsonl")

    rl_log = {
        "req_id": req_id,
        "exec_id": exec_id,
        "plan_id": f"{exec_id}-plan",
        "episode": {
            "goal_achieved": True,
            "episode_reward": 0.95,
            "quality_notes": "Excellent execution"
        },
        "steps": [
            {
                "step_id": "step-1",
                "step_num": 1,
                "reward": 0.95,
                "done": True,
                "classification": "excellent",
                "explanation": "Perfect execution"
            }
        ],
        "timestamp": "2025-12-10T20:00:04.000Z"
    }

    with open(rl_log_path, 'w') as f:
        f.write(json.dumps(rl_log) + "\n")

    print(f"✓ Created RL training log")

    # Reconstruct with step contexts
    from harness import manifest_store as ms
    ms._global_manifest_store = store

    reconstructor = EpisodeReconstructor(
        execution_log_path=str(exec_log_path),
        rl_log_path=str(rl_log_path)
    )

    episode = reconstructor.reconstruct(exec_id)

    assert episode is not None, "Reconstruction failed"
    print(f"✓ Reconstructed episode")

    # CRITICAL: Validate step has embedded context
    assert len(episode.steps_executed) == 1, "Should have 1 step"

    step = episode.steps_executed[0]

    # Check that step_context exists
    assert "step_context" in step, "❌ step_context missing!"
    print(f"✓ step_context exists in step")

    step_context = step["step_context"]

    # Validate step_context has all required fields
    assert "step_objective" in step_context, "❌ step_objective missing!"
    assert "messages" in step_context, "❌ messages missing!"
    assert "available_tools" in step_context, "❌ available_tools missing!"
    assert "tool_hint" in step_context, "❌ tool_hint missing!"

    print(f"✓ step_context has all required fields")

    # Validate step_context content
    assert step_context["step_objective"] == "Write file with content"
    assert len(step_context["messages"]) == 2
    assert step_context["messages"][0]["role"] == "system"
    assert step_context["messages"][1]["role"] == "user"
    assert step_context["available_tools"] == ["file_write", "bash_execute"]
    assert step_context["tool_hint"] == "file_write"

    print(f"✓ step_context content is correct")

    # Validate step also has action and result
    assert "action" in step, "❌ action missing!"
    assert "result" in step, "❌ result missing!"

    action = step["action"]
    assert action["type"] == "tool_call"
    assert action["tool_name"] == "file_write"
    assert action["tool_args"]["path"] == "test.txt"

    print(f"✓ action is correct")

    result = step["result"]
    assert result["tool_success"] == True
    assert "tool_output" in result

    print(f"✓ result is correct")

    print("\n=== Complete Step Structure ===")
    print(json.dumps({
        "step_num": step.get("step_num"),
        "step_context": step_context,
        "action": action,
        "result": {k: v for k, v in result.items() if k != "tool_output"}  # Abbreviated
    }, indent=2))

    print("\n✓ Step has complete RL tuple: (state, action, result)!\n")


def test_training_sample_format():
    """Test that training samples have proper transition format"""
    print("Testing training sample format...")

    # Use episode from previous test
    store = ManifestStore(base_dir="logs/test/manifests")

    from harness import manifest_store as ms
    ms._global_manifest_store = store

    reconstructor = EpisodeReconstructor(
        execution_log_path="logs/test/agent_execution_step_ctx.jsonl",
        rl_log_path="logs/test/rl_training_step_ctx.jsonl"
    )

    episode = reconstructor.reconstruct("test-step-ctx-0001")
    assert episode is not None

    # Convert to training sample
    training_sample = episode.to_training_sample()

    print("Training sample keys:", training_sample.keys())

    # Validate structure
    assert "transitions" in training_sample, "❌ transitions missing!"
    assert "episode_reward" in training_sample
    assert "goal_achieved" in training_sample

    print(f"✓ Training sample has correct top-level structure")

    # Validate transitions
    transitions = training_sample["transitions"]
    assert len(transitions) == 1, f"Expected 1 transition, got {len(transitions)}"

    transition = transitions[0]

    # Each transition should have: state, action, reward, next_state, done
    required_keys = ["state", "action", "reward", "next_state", "done"]
    for key in required_keys:
        assert key in transition, f"❌ {key} missing from transition!"

    print(f"✓ Transition has all required keys: {required_keys}")

    # Validate state (this is what model saw)
    state = transition["state"]
    assert "step_objective" in state
    assert "messages" in state
    assert "available_tools" in state

    print(f"✓ State has: objective, messages, available_tools")

    # Validate action
    action = transition["action"]
    assert "tool_name" in action
    assert action["tool_name"] == "file_write"

    print(f"✓ Action has tool_name: {action['tool_name']}")

    # Validate reward
    assert transition["reward"] == 0.95
    assert transition["done"] == True  # Terminal step

    print(f"✓ Reward: {transition['reward']}, Done: {transition['done']}")

    print("\n=== RL Transition Format ===")
    print(json.dumps({
        "state": {
            "step_objective": state["step_objective"],
            "messages": f"[{len(state['messages'])} messages]",
            "available_tools": state["available_tools"]
        },
        "action": {
            "tool_name": action["tool_name"],
            "tool_args": "..."
        },
        "reward": transition["reward"],
        "next_state": transition["next_state"],
        "done": transition["done"]
    }, indent=2))

    print("\n✓ Training sample has perfect RL transition format!\n")


if __name__ == "__main__":
    print("=" * 60)
    print("Per-Step Context Tests")
    print("=" * 60 + "\n")

    try:
        test_step_context_embedding()
        test_training_sample_format()

        print("=" * 60)
        print("✅ ALL STEP CONTEXT TESTS PASSED!")
        print("=" * 60)
        print()
        print("Summary:")
        print("✓ Each step has embedded step_context (STATE)")
        print("✓ step_context includes: objective, messages, tools")
        print("✓ Training samples have (state, action, reward, next_state) format")
        print("✓ Perfect for RL training (policy gradient, Q-learning, etc.)")
        print()

    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        import traceback
        traceback.print_exc()
        raise
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        raise
