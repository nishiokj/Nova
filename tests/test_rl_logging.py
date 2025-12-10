"""
Test RL Logging System

This test verifies that the RL logging pipeline works end-to-end:
1. Agent emits episode complete events
2. EventBus queues events
3. RewardShaper processes episodes
4. Canonicalized RL logs are written
"""

import json
import time
from pathlib import Path
from harness.rl_reward_shaper import RewardShaper, StepClassification


def test_reward_shaper():
    """Test RewardShaper reward calculation"""
    print("Testing RewardShaper...")

    # Create a temporary reward shaper
    reward_shaper = RewardShaper(log_dir="logs/test")

    # Mock episode data (successful episode)
    episode_data = {
        "req_id": "test-req-001",
        "exec_id": "test-req-001-exec-0001",
        "plan": {
            "goal": "Create a test file",
            "goal_type": "task",
            "steps": [
                {
                    "step_num": 1,
                    "objective": "Create directory",
                    "tool_hint": "bash_execute",
                    "status": "completed"
                },
                {
                    "step_num": 2,
                    "objective": "Write file",
                    "tool_hint": "file_write",
                    "status": "completed"
                }
            ]
        },
        "trace": {
            "steps_executed": [
                {
                    "step_id": "step-1",
                    "step_num": 1,
                    "objective": "Create directory",
                    "tool_hint": "bash_execute",
                    "status": "completed",
                    "result": "Directory created",
                    "error": None,
                    "duration_ms": 150
                },
                {
                    "step_id": "step-2",
                    "step_num": 2,
                    "objective": "Write file",
                    "tool_hint": "file_write",
                    "status": "completed",
                    "result": "File written",
                    "error": None,
                    "duration_ms": 80
                }
            ],
            "tool_calls": 2,
            "tool_failures": 0,
            "llm_calls": 3,
            "had_failures": False
        },
        "reflection": {
            "goal_achieved": True,
            "confidence": 0.95,
            "gaps": [],
            "evidence": ["Directory created successfully", "File written successfully"]
        }
    }

    # Shape rewards
    episode_reward = reward_shaper.shape_rewards(episode_data)

    # Assertions
    assert episode_reward.req_id == "test-req-001"
    assert episode_reward.exec_id == "test-req-001-exec-0001"
    assert episode_reward.goal_achieved == True
    assert 0.7 <= episode_reward.episode_reward <= 1.0  # Should be high for successful episode
    assert len(episode_reward.steps) == 2

    # Check step rewards
    step1 = episode_reward.steps[0]
    assert step1.step_num == 1
    assert step1.done == False
    assert step1.classification in ["excellent", "good"]
    assert step1.reward > 0

    step2 = episode_reward.steps[1]
    assert step2.step_num == 2
    assert step2.done == True  # Last step
    assert step2.classification in ["excellent", "good"]
    assert step2.reward > 0

    print(f"✓ Episode reward: {episode_reward.episode_reward:.3f}")
    print(f"✓ Step 1 reward: {step1.reward:.3f} ({step1.classification})")
    print(f"✓ Step 2 reward: {step2.reward:.3f} ({step2.classification})")
    print("✓ RewardShaper test passed!\n")

    return episode_reward


def test_failed_episode():
    """Test reward shaping for failed episode"""
    print("Testing failed episode...")

    reward_shaper = RewardShaper(log_dir="logs/test")

    # Mock failed episode data
    episode_data = {
        "req_id": "test-req-002",
        "exec_id": "test-req-002-exec-0001",
        "plan": {
            "goal": "Delete a non-existent file",
            "goal_type": "task",
            "steps": [
                {
                    "step_num": 1,
                    "objective": "Delete file",
                    "tool_hint": "bash_execute",
                    "status": "failed"
                }
            ]
        },
        "trace": {
            "steps_executed": [
                {
                    "step_id": "step-1",
                    "step_num": 1,
                    "objective": "Delete file",
                    "tool_hint": "bash_execute",
                    "status": "failed",
                    "result": None,
                    "error": "File not found",
                    "duration_ms": 50
                }
            ],
            "tool_calls": 1,
            "tool_failures": 1,
            "llm_calls": 1,
            "had_failures": True
        },
        "reflection": {
            "goal_achieved": False,
            "confidence": 0.2,
            "gaps": ["File does not exist"],
            "evidence": []
        }
    }

    episode_reward = reward_shaper.shape_rewards(episode_data)

    # Assertions for failed episode
    assert episode_reward.goal_achieved == False
    assert episode_reward.episode_reward < 0.3  # Should be low for failed episode
    assert len(episode_reward.steps) == 1

    step1 = episode_reward.steps[0]
    assert step1.classification == "failed"
    assert step1.reward < 0  # Negative reward for failure

    print(f"✓ Episode reward: {episode_reward.episode_reward:.3f}")
    print(f"✓ Step 1 reward: {step1.reward:.3f} ({step1.classification})")
    print("✓ Failed episode test passed!\n")


def test_rl_log_format():
    """Test that RL log format matches specification"""
    print("Testing RL log format...")

    reward_shaper = RewardShaper(log_dir="logs/test")

    episode_data = {
        "req_id": "test-req-003",
        "exec_id": "test-req-003-exec-0001",
        "plan": {
            "goal": "Test task",
            "goal_type": "task",
            "steps": [
                {"step_num": 1, "objective": "Step 1", "tool_hint": "tool1", "status": "completed"}
            ]
        },
        "trace": {
            "steps_executed": [
                {
                    "step_id": "step-1",
                    "step_num": 1,
                    "objective": "Step 1",
                    "tool_hint": "tool1",
                    "status": "completed",
                    "result": "Success",
                    "error": None,
                    "duration_ms": 100
                }
            ],
            "tool_calls": 1,
            "tool_failures": 0,
            "llm_calls": 1,
            "had_failures": False
        },
        "reflection": {
            "goal_achieved": True,
            "confidence": 0.8,
            "gaps": [],
            "evidence": ["Success"]
        }
    }

    episode_reward = reward_shaper.shape_rewards(episode_data)
    log_dict = episode_reward.to_dict()

    # Verify required fields
    assert "req_id" in log_dict
    assert "exec_id" in log_dict
    assert "plan_id" in log_dict
    assert "episode" in log_dict
    assert "steps" in log_dict
    assert "timestamp" in log_dict

    # Verify episode fields
    episode = log_dict["episode"]
    assert "goal_achieved" in episode
    assert "episode_reward" in episode
    assert "quality_notes" in episode

    # Verify step fields
    step = log_dict["steps"][0]
    assert "step_id" in step
    assert "step_num" in step
    assert "reward" in step
    assert "done" in step
    assert "classification" in step

    print("✓ RL log format valid!")
    print(f"✓ Log structure: {json.dumps(log_dict, indent=2)[:500]}...")
    print("✓ RL log format test passed!\n")


def test_end_to_end_logging():
    """Test that logs are written correctly"""
    print("Testing end-to-end logging...")

    # Clean up test log
    test_log = Path("logs/test/rl_training.jsonl")
    if test_log.exists():
        test_log.unlink()

    reward_shaper = RewardShaper(log_dir="logs/test")

    # Create and log episode
    episode_data = {
        "req_id": "test-req-004",
        "exec_id": "test-req-004-exec-0001",
        "plan": {
            "goal": "End to end test",
            "goal_type": "task",
            "steps": [
                {"step_num": 1, "objective": "Test", "tool_hint": "test_tool", "status": "completed"}
            ]
        },
        "trace": {
            "steps_executed": [
                {
                    "step_id": "step-1",
                    "step_num": 1,
                    "objective": "Test",
                    "tool_hint": "test_tool",
                    "status": "completed",
                    "result": "Success",
                    "error": None,
                    "duration_ms": 100
                }
            ],
            "tool_calls": 1,
            "tool_failures": 0,
            "llm_calls": 1,
            "had_failures": False
        },
        "reflection": {
            "goal_achieved": True,
            "confidence": 0.9,
            "gaps": [],
            "evidence": []
        }
    }

    # Process episode
    reward_shaper.process_episode(episode_data)

    # Verify log was written
    assert test_log.exists(), "RL training log should exist"

    # Read and verify content
    with open(test_log) as f:
        lines = f.readlines()
        assert len(lines) == 1, "Should have one log entry"

        log_entry = json.loads(lines[0])
        assert log_entry["req_id"] == "test-req-004"
        assert log_entry["exec_id"] == "test-req-004-exec-0001"
        assert "episode" in log_entry
        assert "steps" in log_entry

    print("✓ Log file created successfully!")
    print(f"✓ Log location: {test_log}")
    print("✓ End-to-end logging test passed!\n")


if __name__ == "__main__":
    print("=" * 60)
    print("RL Logging System Tests")
    print("=" * 60 + "\n")

    try:
        # Run tests
        test_reward_shaper()
        test_failed_episode()
        test_rl_log_format()
        test_end_to_end_logging()

        print("=" * 60)
        print("✅ ALL TESTS PASSED!")
        print("=" * 60)

    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        raise
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        raise
