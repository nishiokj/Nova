# RL Logging System - Implementation Summary

## What Was Built

A complete **reinforcement learning training data pipeline** that:

1. ✅ **Emits finished episodes to EventBus** - Agent emits episode complete events after execution
2. ✅ **Assigns per-step rewards** - RewardShaper analyzes each step and assigns rewards
3. ✅ **Writes canonicalized logs** - Separate RL training logs with structured format
4. ✅ **References data by key** - All data joinable via req_id, exec_id, step_id
5. ✅ **Never influences user-facing agent** - Completely decoupled background process
6. ✅ **Never feeds back into episodes** - RL logs only used for future training

## Architecture Overview

```
Episode Completion Flow:
┌─────────────────────────────────────────────────────────┐
│ Agent.run()                                             │
│  ├─ Planning                                            │
│  ├─ Execution                                           │
│  ├─ Reflection                                          │
│  ├─ Log episode summary (agent_execution.jsonl)        │
│  └─ Emit EPISODE_COMPLETE event ──────────┐            │
└────────────────────────────────────────────┼────────────┘
                                             │
                                             v
                                    ┌────────────────┐
                                    │   EventBus     │
                                    │ (rl_events_    │
                                    │     queue)     │
                                    └────────┬───────┘
                                             │
                                             v
┌────────────────────────────────────────────────────────┐
│ RL Worker (Background Process)                        │
│  ├─ Consumes episode events                           │
│  ├─ RewardShaper.shape_rewards()                      │
│  │   ├─ Analyze plan & trace                          │
│  │   ├─ Assign per-step rewards                       │
│  │   └─ Calculate episode reward                      │
│  └─ Write to rl_training.jsonl                        │
└────────────────────────────────────────────────────────┘
```

## Files Created/Modified

### New Files

1. **`harness/rl_reward_shaper.py`** (359 lines)
   - `RewardShaper` class
   - Per-step reward calculation
   - Episode reward aggregation
   - Quality classification (excellent/good/ok/poor/failed)

2. **`harness/rl_worker.py`** (56 lines)
   - Background process for RL logging
   - Consumes episode events
   - Processes through RewardShaper

3. **`docs/RL_LOGGING_GUIDE.md`** (Comprehensive guide)
   - Architecture diagrams
   - Usage examples
   - Log format specifications
   - Integration guide

4. **`docs/RL_SYSTEM_SUMMARY.md`** (This file)
   - Implementation summary
   - Quick reference

5. **`tests/test_rl_logging.py`** (300+ lines)
   - Unit tests for RewardShaper
   - End-to-end logging tests
   - Log format validation

### Modified Files

1. **`harness/event_bus.py`**
   - Added `EPISODE_COMPLETE` message type
   - Added `rl_events_queue` for episode events
   - Added `emit_episode_complete()` method
   - Added `get_episode_event()` method

2. **`harness/agent.py`**
   - Added `event_bus` parameter to Agent.__init__()
   - Emit episode complete event after reflection
   - Added `event_bus` parameter to TieredAgent.__init__()
   - Pass event_bus to child Agent instances

## Log Files

### `logs/agent_execution.jsonl` (Existing)

**User-facing execution logs** - Contains:
- Agent context (system prompt, tools, tier)
- Planning results
- Execution context per step
- Execution step details
- Episode summaries with RL labels from Reflector

### `logs/rl_training.jsonl` (New)

**Canonicalized RL training logs** - Contains:
- Episode-level reward and quality assessment
- Per-step rewards with classifications
- References to execution logs via IDs
- Quality notes and explanations

**Sample Entry:**

```json
{
  "req_id": "3a5c7ea6-0001",
  "exec_id": "3a5c7ea6-0001-exec-0001",
  "plan_id": "3a5c7ea6-0001-exec-0001-plan",
  "episode": {
    "goal_achieved": true,
    "episode_reward": 0.85,
    "quality_notes": "Goal achieved with 90% confidence. Executed 3 steps."
  },
  "steps": [
    {
      "step_id": "3a5c7ea6-0001-exec-0001-step-1",
      "step_num": 1,
      "reward": 0.15,
      "done": false,
      "classification": "good",
      "explanation": "Good execution: completed successfully"
    },
    {
      "step_id": "3a5c7ea6-0001-exec-0001-step-2",
      "step_num": 2,
      "reward": 0.20,
      "done": false,
      "classification": "excellent",
      "explanation": "Excellent execution: fast and successful"
    },
    {
      "step_id": "3a5c7ea6-0001-exec-0001-step-3",
      "step_num": 3,
      "reward": 0.50,
      "done": true,
      "classification": "good",
      "explanation": "Good execution; Terminal step"
    }
  ],
  "timestamp": "2025-12-10T20:15:30.123Z"
}
```

## Reward Shaping Logic

### Episode Reward (0.0 to 1.0)

```python
episode_reward = base_reward + confidence_bonus + efficiency_bonus - failure_penalty

# Components:
base_reward = 0.6 if goal_achieved else 0.1 * partial_progress
confidence_bonus = reflection.confidence * 0.2  # 0.0 to 0.2
efficiency_bonus = efficiency * 0.2             # 0.0 to 0.2
failure_penalty = tool_failures * 0.1           # 0.1 per failure
```

### Step Rewards

Steps are classified and rewarded:

| Classification | Criteria | Multiplier |
|---------------|----------|------------|
| **EXCELLENT** | Fast (<1s) + successful | 1.5x |
| **GOOD** | Successful (<5s) | 1.2x |
| **OK** | Completed but slow | 1.0x |
| **POOR** | Inefficient/unnecessary | 0.5x |
| **FAILED** | Step failed or error | -0.5x |

Terminal steps get +0.3 bonus if goal achieved.

## Integration Example

```python
from harness.event_bus import EventBus
from harness.agent import TieredAgent
from harness.rl_worker import start_rl_worker
from multiprocessing import Process

# Create EventBus
event_bus = EventBus()

# Create agent with EventBus
agent = TieredAgent(
    config=config,
    tool_registry=registry,
    tier_configs=tier_configs,
    event_bus=event_bus  # Enable RL logging
)

# Start RL worker in background
rl_worker = Process(
    target=start_rl_worker,
    args=(event_bus, "logs"),
    daemon=True
)
rl_worker.start()

# Use agent normally - RL logging happens automatically
response = agent.run("Create test.txt", tier="advanced")
# Episode automatically logged to rl_training.jsonl
```

## Data References for Training Reconstruction

All logs use consistent IDs for efficient joins:

```python
# To reconstruct full episode:

# 1. Get RL training log
rl_log = get_rl_log(exec_id="abc123-exec-0001")

# 2. Get full execution context
execution_logs = query_execution_logs(exec_id="abc123-exec-0001")

# 3. Join on step_id
for step in rl_log["steps"]:
    step_id = step["step_id"]
    execution_detail = get_execution_step(step_id=step_id)

    # Now you have:
    # - step["reward"]: RL reward
    # - step["classification"]: Quality label
    # - execution_detail: Full step context, tool calls, results
```

## Key Guarantees

✅ **NEVER influences user-facing agent**
- EventBus emission happens AFTER episode completes
- RL worker runs in separate background process
- Zero coupling between RL logging and agent execution

✅ **NEVER fed back into episodes**
- RL logs only in `rl_training.jsonl`
- Agent only reads from `agent_execution.jsonl`
- Strict separation of concerns

✅ **Data integrity via references**
- All data joinable via req_id, exec_id, step_id
- No duplication of large objects
- Efficient reconstruction for training

✅ **Quality labels for RL training**
- Per-step rewards shaped based on success/efficiency
- Episode-level rewards account for goal achievement
- Human-readable explanations for interpretability

## Testing

All tests passing ✅

```bash
PYTHONPATH=. python3 tests/test_rl_logging.py
```

Tests cover:
- ✅ Reward shaping for successful episodes
- ✅ Reward shaping for failed episodes
- ✅ Log format validation
- ✅ End-to-end logging pipeline

## Next Steps for RL Training

1. **Collect Episodes**: Let system run and accumulate RL logs
2. **Extract Training Samples**: Parse `rl_training.jsonl`
3. **Join with Context**: Query `agent_execution.jsonl` for full details
4. **Generate Datasets**: Create state-action-reward tuples
5. **Train Models**: Use for policy gradient, Q-learning, etc.

## Monitoring

```bash
# Watch RL logs being written
tail -f logs/rl_training.jsonl

# Count episodes
wc -l logs/rl_training.jsonl

# Average episode reward
jq '.episode.episode_reward' logs/rl_training.jsonl | awk '{sum+=$1; n++} END {print sum/n}'

# Success rate
jq '.episode.goal_achieved' logs/rl_training.jsonl | grep true | wc -l
```

## Performance Impact

- **Agent execution**: Zero overhead (event emission is async queue put)
- **Background processing**: RL worker runs in separate process
- **Log file size**: ~1KB per episode (compact JSON)
- **Memory**: Minimal (queue-based processing)

## Summary

✅ Complete RL logging pipeline implemented
✅ Canonicalized logs with per-step rewards
✅ Quality tags and classifications
✅ References for efficient reconstruction
✅ Zero impact on user-facing agent
✅ Fully tested and documented
