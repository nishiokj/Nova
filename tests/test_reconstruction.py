"""
Test Episode Reconstruction

Validates that we can fully reconstruct episodes from logs + manifests.
"""

import json
from pathlib import Path
from harness.manifest_store import ManifestStore, get_manifest_store, ensure_default_manifests
from harness.rl_reconstructor import EpisodeReconstructor, generate_training_dataset


def test_manifest_storage():
    """Test that manifests can be stored and retrieved"""
    print("Testing manifest storage...")

    store = ManifestStore(base_dir="logs/test/manifests")

    # Store system prompt
    prompt_id = store.store_system_prompt(
        tier="advanced",
        version="v1",
        prompt="You are an expert assistant.",
        prompt_id="test_prompt_v1"
    )

    assert prompt_id == "test_prompt_v1"
    print(f"✓ Stored system prompt: {prompt_id}")

    # Retrieve system prompt
    manifest = store.get_system_prompt("test_prompt_v1")
    assert manifest is not None
    assert manifest.prompt == "You are an expert assistant."
    print(f"✓ Retrieved system prompt: {manifest.id}")

    # Store tool manifest
    tools = [
        {"name": "tool1", "description": "Tool 1"},
        {"name": "tool2", "description": "Tool 2"}
    ]

    tool_id = store.store_tool_manifest(
        tools=tools,
        version="v1",
        manifest_id="test_tools_v1"
    )

    assert tool_id == "test_tools_v1"
    print(f"✓ Stored tool manifest: {tool_id}")

    # Retrieve tool manifest
    tool_manifest = store.get_tool_manifest("test_tools_v1")
    assert tool_manifest is not None
    assert len(tool_manifest.tools) == 2
    print(f"✓ Retrieved tool manifest: {tool_manifest.id} ({tool_manifest.tool_count} tools)")

    print("✓ Manifest storage test passed!\n")


def test_episode_reconstruction():
    """Test full episode reconstruction"""
    print("Testing episode reconstruction...")

    # Ensure manifests exist first
    store = ManifestStore(base_dir="logs/test/manifests")
    store.store_system_prompt(
        tier="advanced",
        version="v1",
        prompt="You are an expert assistant.",
        prompt_id="test_prompt_v1"
    )
    store.store_tool_manifest(
        tools=[
            {"name": "tool1", "description": "Tool 1"},
            {"name": "tool2", "description": "Tool 2"}
        ],
        version="v1",
        manifest_id="test_tools_v1"
    )

    # Create mock execution log
    exec_id = "test-exec-0001"
    req_id = "test-req-001"

    exec_log_path = Path("logs/test/agent_execution.jsonl")
    exec_log_path.parent.mkdir(parents=True, exist_ok=True)

    # Write mock execution logs
    logs = [
        {
            "ts": "2025-12-10T20:00:00.000Z",
            "lvl": "INFO",
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
                "user_input": "Create test.txt"
            }
        },
        {
            "ts": "2025-12-10T20:00:01.000Z",
            "lvl": "INFO",
            "svc": "planning",
            "req_id": req_id,
            "exec_id": exec_id,
            "plan": {
                "goal": "Create test.txt file",
                "goal_type": "task",
                "estimated_complexity": "simple",
                "success_criteria": "File exists",
                "requires_tools": True,
                "steps": [
                    {
                        "step_num": 1,
                        "objective": "Create file",
                        "tool_hint": "file_write",
                        "status": "pending"
                    }
                ]
            }
        },
        {
            "ts": "2025-12-10T20:00:02.000Z",
            "lvl": "INFO",
            "svc": "execution_step",
            "req_id": req_id,
            "exec_id": exec_id,
            "step_id": "step-1",
            "step_num": 1,
            "status": "completed",
            "action": {"type": "tool_call", "tool_name": "file_write"},
            "result": {"duration_ms": 50, "tool_success": True}
        },
        {
            "ts": "2025-12-10T20:00:03.000Z",
            "lvl": "INFO",
            "svc": "episode_summary",
            "req_id": req_id,
            "exec_id": exec_id,
            "stats": {
                "total_duration_ms": 150,
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

    print(f"✓ Created mock execution logs at {exec_log_path}")

    # Create mock RL log
    rl_log_path = Path("logs/test/rl_training.jsonl")

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
                "explanation": "Fast and successful"
            }
        ],
        "timestamp": "2025-12-10T20:00:03.000Z"
    }

    with open(rl_log_path, 'w') as f:
        f.write(json.dumps(rl_log) + "\n")

    print(f"✓ Created mock RL log at {rl_log_path}")

    # Reconstruct episode (using same manifest store)
    from harness import manifest_store as ms
    ms._global_manifest_store = store  # Use our test manifest store

    reconstructor = EpisodeReconstructor(
        execution_log_path=str(exec_log_path),
        rl_log_path=str(rl_log_path)
    )

    episode = reconstructor.reconstruct(exec_id)

    assert episode is not None, "Episode reconstruction failed"
    print(f"✓ Reconstructed episode: {episode.exec_id}")

    # Validate reconstruction
    assert episode.req_id == req_id
    assert episode.exec_id == exec_id
    assert episode.tier == "advanced"
    assert episode.system_prompt == "You are an expert assistant."
    assert episode.user_input == "Create test.txt"
    assert episode.goal == "Create test.txt file"
    assert episode.goal_achieved == True
    assert episode.episode_reward == 0.95
    assert len(episode.step_rewards) == 1
    assert episode.tools_available == [
        {"name": "tool1", "description": "Tool 1"},
        {"name": "tool2", "description": "Tool 2"}
    ]

    print("✓ All reconstruction fields validated!")

    # Test training sample generation
    training_sample = episode.to_training_sample()

    assert "state" in training_sample
    assert "actions" in training_sample
    assert "rewards" in training_sample
    assert "episode_reward" in training_sample
    assert training_sample["goal_achieved"] == True

    print("✓ Training sample generated successfully!")

    # Save to file
    output_path = reconstructor.reconstruct_to_file(exec_id)
    assert output_path is not None
    assert output_path.exists()
    print(f"✓ Saved reconstructed episode to {output_path}")

    # Read and validate
    with open(output_path) as f:
        saved_episode = json.load(f)

    assert saved_episode["exec_id"] == exec_id
    assert saved_episode["input_state"]["system_prompt"] == "You are an expert assistant."
    print("✓ Saved episode validated!")

    print("✓ Episode reconstruction test passed!\n")


def test_batch_reconstruction():
    """Test batch reconstruction"""
    print("Testing batch reconstruction...")

    # Use episodes from previous test
    exec_ids = ["test-exec-0001"]

    # Use the test manifest store
    from harness import manifest_store as ms
    store = ManifestStore(base_dir="logs/test/manifests")
    ms._global_manifest_store = store

    reconstructor = EpisodeReconstructor(
        execution_log_path="logs/test/agent_execution.jsonl",
        rl_log_path="logs/test/rl_training.jsonl"
    )

    episodes = reconstructor.batch_reconstruct(exec_ids)

    assert len(episodes) == 1
    assert episodes[0].exec_id == "test-exec-0001"

    print(f"✓ Batch reconstructed {len(episodes)} episodes")

    # Test training dataset generation manually (to avoid creating new reconstructor)
    output_path = Path("logs/test/training_dataset.jsonl")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        for episode in episodes:
            training_sample = episode.to_training_sample()
            f.write(json.dumps(training_sample) + "\n")

    count = len(episodes)

    assert count == 1
    print(f"✓ Generated training dataset with {count} samples")

    # Validate dataset
    with open("logs/test/training_dataset.jsonl") as f:
        samples = [json.loads(line) for line in f]

    assert len(samples) == 1
    assert "state" in samples[0]
    assert "rewards" in samples[0]

    print("✓ Training dataset validated!")
    print("✓ Batch reconstruction test passed!\n")


if __name__ == "__main__":
    print("=" * 60)
    print("Episode Reconstruction Tests")
    print("=" * 60 + "\n")

    try:
        test_manifest_storage()
        test_episode_reconstruction()
        test_batch_reconstruction()

        print("=" * 60)
        print("✅ ALL RECONSTRUCTION TESTS PASSED!")
        print("=" * 60)

    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        raise
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        raise
