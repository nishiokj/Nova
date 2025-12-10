# RL Logging System Guide

## Overview

The RL logging system provides **canonicalized episode logs for reinforcement learning training**. It operates completely independently from the user-facing agent workflow and never influences ongoing episodes.

## Architecture

```
┌─────────────┐
│   Agent     │
│  (run())    │
└──────┬──────┘
       │
       │ 1. Completes Episode
       │ 2. Logs to agent_execution.jsonl
       │ 3. Emits EPISODE_COMPLETE event
       │
       v
┌──────────────┐
│  EventBus    │  (rl_events_queue)
└──────┬───────┘
       │
       │ 4. Queues episode data
       │
       v
┌──────────────┐
│  RL Worker   │  (background process)
│  (consumer)  │
└──────┬───────┘
       │
       │ 5. Receives episode event
       │
       v
┌──────────────┐
│RewardShaper  │
│              │
│ - Analyzes   │
│ - Assigns    │
│   per-step   │
│   rewards    │
└──────┬───────┘
       │
       │ 6. Writes canonicalized log
       │
       v
┌──────────────┐
│rl_training.  │
│    jsonl     │
└──────────────┘
```

## Key Components

### 1. EventBus (`harness/event_bus.py`)

**New Features:**
- `rl_events_queue`: Queue for episode completion events
- `emit_episode_complete(episode_data)`: Called by Agent when episode finishes
- `get_episode_event(timeout)`: Called by RL worker to consume events

### 2. RewardShaper (`harness/rl_reward_shaper.py`)

**Responsibilities:**
- Receives complete episode data (plan, trace, reflection)
- Assigns per-step rewards based on:
  - Step success/failure
  - Tool execution efficiency
  - Contribution to overall goal
  - Duration and resource usage
- Calculates episode-level reward
- Generates quality classifications and explanations

**Reward Philosophy:**
```python
# Episode reward components:
- Base reward: 0.6 for goal achievement
- Confidence bonus: 0.0 to 0.2 based on reflection confidence
- Efficiency bonus: 0.0 to 0.2 for efficient execution
- Failure penalty: -0.1 per tool failure
# Total: 0.0 to 1.0

# Step rewards:
- EXCELLENT: Fast, successful execution (1.5x multiplier)
- GOOD: Successful completion (1.2x multiplier)
- OK: Completed but suboptimal (1.0x multiplier)
- POOR: Inefficient or unnecessary (0.5x multiplier)
- FAILED: Step failed (-0.5x multiplier)
```

### 3. RL Worker (`harness/rl_worker.py`)

**Background Process:**
- Runs independently in separate process
- Consumes episode events from EventBus
- Processes each episode through RewardShaper
- Never blocks agent execution

### 4. Agent Integration (`harness/agent.py`)

**Changes:**
- Agent constructor accepts optional `event_bus` parameter
- After logging episode summary, emits episode complete event
- **Critically**: Episode emission happens AFTER user-facing response
- Never blocks or delays user interaction

## Log Files

### User-Facing Logs

**`logs/agent_execution.jsonl`**
- Full agent context
- Planning results
- Execution steps
- Episode summaries with RL labels from Reflector

### RL Training Logs

**`logs/rl_training.jsonl`**
- **Canonicalized format** for training
- Per-step rewards
- Episode-level rewards
- Quality tags and classifications
- **References step IDs** for joining with execution logs
- **NEVER fed back into user-facing agent**

## Sample RL Training Log Entry

```json
{
  "req_id": "3a5c7ea6-0001",
  "exec_id": "3a5c7ea6-0001-exec-0001",
  "plan_id": "3a5c7ea6-0001-exec-0001-plan",

  "episode": {
    "goal_achieved": true,
    "episode_reward": 0.85,
    "quality_notes": "Goal achieved with 90% confidence. Executed 3 steps with 2 tool calls."
  },

  "steps": [
    {
      "step_id": "3a5c7ea6-0001-exec-0001-step-1",
      "step_num": 1,
      "reward": 0.15,
      "done": false,
      "classification": "good",
      "explanation": "Good execution: completed successfully; Used tool: file_read"
    },
    {
      "step_id": "3a5c7ea6-0001-exec-0001-step-2",
      "step_num": 2,
      "reward": 0.20,
      "done": false,
      "classification": "excellent",
      "explanation": "Excellent execution: fast and successful; Used tool: bash_execute"
    },
    {
      "step_id": "3a5c7ea6-0001-exec-0001-step-3",
      "step_num": 3,
      "reward": 0.50,
      "done": true,
      "classification": "good",
      "explanation": "Good execution: completed successfully; Terminal step"
    }
  ],

  "timestamp": "2025-12-10T20:15:30.123Z"
}
```

## Data References

All logs use **reference keys** for efficient storage and reconstruction:

- `req_id`: Request ID (links all logs for a request)
- `exec_id`: Execution ID (unique per episode)
- `plan_id`: Plan ID (derived from exec_id)
- `step_id`: Step ID (derived from exec_id + step_num)

To reconstruct full episode for training:

1. Query `agent_execution.jsonl` by `exec_id` for full execution context
2. Query `rl_training.jsonl` by `exec_id` for shaped rewards
3. Join on `step_id` to get per-step details + rewards

## Usage

### Starting the System with RL Logging

```python
from harness.event_bus import EventBus
from harness.agent import TieredAgent
from harness.rl_worker import start_rl_worker
from multiprocessing import Process

# Create EventBus
event_bus = EventBus()

# Create TieredAgent with EventBus
tiered_agent = TieredAgent(
    config=agent_config,
    tool_registry=tool_registry,
    tier_configs=tier_configs,
    event_bus=event_bus  # Pass EventBus for RL logging
)

# Start RL worker process
rl_process = Process(
    target=start_rl_worker,
    args=(event_bus, "logs"),
    daemon=True
)
rl_process.start()

# Run agent normally - RL logging happens automatically
response = tiered_agent.run("Create a file called test.txt", tier="advanced")
```

### Reading RL Training Logs

```python
import json

# Read canonicalized RL logs
with open("logs/rl_training.jsonl") as f:
    for line in f:
        episode = json.loads(line)

        print(f"Episode: {episode['exec_id']}")
        print(f"Reward: {episode['episode']['episode_reward']:.3f}")
        print(f"Goal Achieved: {episode['episode']['goal_achieved']}")

        for step in episode['steps']:
            print(f"  Step {step['step_num']}: "
                  f"reward={step['reward']:.3f}, "
                  f"classification={step['classification']}")
```

## Critical Guarantees

✅ **RL logging NEVER influences user-facing agent**
✅ **Episode events emitted AFTER response is complete**
✅ **RL worker runs in background process**
✅ **No blocking or delays in agent execution**
✅ **Canonicalized logs separate from execution logs**
✅ **Data referenced by keys for efficient reconstruction**

## Training Data Pipeline

1. **Collect Episodes**: RL training logs accumulate in `rl_training.jsonl`
2. **Join with Context**: Query `agent_execution.jsonl` for full execution details
3. **Reconstruct Episodes**: Combine plan, trace, steps, and rewards
4. **Generate Samples**: Create training samples with state-action-reward tuples
5. **Train Model**: Use samples to fine-tune policy or value functions

## Customizing Reward Shaping

Edit `harness/rl_reward_shaper.py` to adjust reward logic:

```python
class RewardShaper:
    def _calculate_episode_reward(self, ...):
        # Customize episode reward calculation
        base_reward = 0.6  # Adjust base
        confidence_bonus = confidence * 0.3  # Adjust bonus
        # ...

    def _assign_step_rewards(self, ...):
        # Customize per-step reward logic
        if classification == StepClassification.EXCELLENT:
            reward_multiplier = 2.0  # More aggressive rewards
        # ...
```

## Monitoring

Check RL worker health:

```bash
# Check if RL worker is processing episodes
tail -f logs/rl_training.jsonl

# Count episodes logged
wc -l logs/rl_training.jsonl

# View recent episode rewards
tail -n 10 logs/rl_training.jsonl | jq '.episode.episode_reward'
```

## Debugging

Enable debug logging:

```python
import logging
logging.basicConfig(level=logging.DEBUG)

# Will show:
# - "Emitted episode complete event for {req_id}"
# - "Processing episode: {req_id}"
# - "Episode {req_id} processed and logged"
```
