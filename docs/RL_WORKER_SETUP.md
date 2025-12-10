# RL Worker Setup Guide

## Overview

The RL Worker is an optional background process that collects reinforcement learning training data from agent episodes. When enabled, it:

1. Consumes episode completion events from the EventBus
2. Shapes rewards based on episode performance
3. Writes canonicalized RL training logs to `logs/rl_training.jsonl`
4. Operates completely independently from the user-facing agent

**CRITICAL**: The RL worker NEVER influences agent behavior or episodes. It's purely for data collection.

## Quick Start

### Enable RL Worker

Start the system with the `--rl-worker` flag:

```bash
# V2 multiprocess architecture with RL worker
python main.py --v2 --rl-worker

# With custom tier
python main.py --v2 --rl-worker --tier advanced

# With debug logging
python main.py --v2 --rl-worker --debug
```

### Verify It's Running

When the system starts, you should see:

```
============================================================
Starting Voice Agent System V2 (MULTIPROCESS)
  - Main Process: Audio capture, Whisper STT
  - Agent Process: LLM reasoning, tool execution
  - TTS Process: Speech synthesis
  - RL Worker: Reinforcement learning data collection
============================================================
...
Starting RL worker process...
RL worker started (PID: 12345)
```

### Check Logs

Monitor RL training logs as they're written:

```bash
# Watch logs in real-time
tail -f logs/rl_training.jsonl

# Count episodes collected
wc -l logs/rl_training.jsonl

# View latest episode
tail -1 logs/rl_training.jsonl | jq '.'

# Calculate average reward
jq '.episode.episode_reward' logs/rl_training.jsonl | awk '{sum+=$1; n++} END {print sum/n}'
```

## Architecture

### Event Flow

```
Agent Episode Completes
  ├─> Agent emits EPISODE_COMPLETE event to EventBus
  │   └─ Event data: {req_id, exec_id, plan, trace, reflection}
  │
  ├─> EventBus.rl_events_queue (non-blocking)
  │
  └─> RL Worker Process (background)
      ├─ Consumes events via get_episode_event()
      ├─ RewardShaper.process_episode()
      │   ├─ Calculate episode reward
      │   ├─ Assign per-step rewards
      │   └─ Classify quality (excellent/good/ok/poor/failed)
      │
      └─ Write to logs/rl_training.jsonl
```

### Process Hierarchy

```
Main Process (main.py)
  ├─ EventBus (shared across processes)
  ├─ Audio Capture Thread
  ├─ STT Processing Thread
  │
  ├─ Agent Process (agent_worker.py)
  │   └─ TieredAgent (with event_bus parameter)
  │       └─ Emits episode events after completion
  │
  ├─ TTS Process (tts_worker.py)
  │
  └─ RL Worker Process (rl_worker.py) ← NEW!
      └─ Consumes episode events, writes RL logs
```

## Integration Points

### 1. main.py (VoiceAgentSystemV2)

**Added**:
- `rl_worker_enabled` parameter to `__init__()`
- `rl_worker_process` attribute
- RL worker startup in `start()` method (lines 1315-1327)
- RL worker shutdown in `stop()` method (lines 1415-1421)
- `--rl-worker` command-line flag

### 2. harness/agent_worker.py (AgentWorker)

**Modified**:
- Line 92: Pass `event_bus` to `TieredAgent` constructor
- This enables agent to emit episode completion events

### 3. harness/agent.py (Agent/TieredAgent)

**Already implemented**:
- Lines 552-598: Emit `EPISODE_COMPLETE` event after episode summary
- Event includes: req_id, exec_id, plan, trace, reflection

### 4. harness/rl_worker.py (RL Worker)

**Already implemented**:
- `rl_worker_loop()`: Main loop that consumes episode events
- `start_rl_worker()`: Entry point for multiprocessing

## RL Training Log Format

Each episode logged to `logs/rl_training.jsonl`:

```json
{
  "req_id": "8601cf78-0001",
  "exec_id": "8601cf78-0001-exec-0001",
  "plan_id": "8601cf78-0001-exec-0001-plan",

  "episode": {
    "goal_achieved": true,
    "episode_reward": 0.85,
    "quality_notes": "Successfully completed task with efficient tool usage."
  },

  "steps": [
    {
      "step_id": "8601cf78-0001-exec-0001-step-1",
      "step_num": 1,
      "reward": 0.95,
      "done": false,
      "classification": "excellent",
      "explanation": "Fast execution (<1s) with successful outcome"
    },
    {
      "step_id": "8601cf78-0001-exec-0001-step-2",
      "step_num": 2,
      "reward": 0.75,
      "done": true,
      "classification": "good",
      "explanation": "Completed successfully but slower (3s)"
    }
  ]
}
```

## Episode Reconstruction

Use collected logs for training:

```python
from harness.rl_reconstructor import EpisodeReconstructor

# Initialize reconstructor
reconstructor = EpisodeReconstructor()

# Reconstruct single episode
episode = reconstructor.reconstruct("8601cf78-0001-exec-0001")

# Generate training sample
training_sample = episode.to_training_sample()
# Returns: {
#   "exec_id": "...",
#   "goal": "...",
#   "goal_achieved": true,
#   "episode_reward": 0.85,
#   "transitions": [
#     {
#       "step_num": 1,
#       "state": {"messages": [...], "objective": "...", "available_tools": [...]},
#       "action": {"type": "tool_call", "tool_name": "...", "tool_args": {...}},
#       "reward": 0.95,
#       "next_state": {...},
#       "done": false,
#       "classification": "excellent"
#     }
#   ],
#   "tier": "advanced",
#   "num_steps": 2
# }

# Batch reconstruction
episodes = reconstructor.batch_reconstruct(
    exec_ids=["exec-1", "exec-2", "exec-3"],
    filter_successful=True  # Only successful episodes
)

# Generate training dataset
reconstructor.generate_training_dataset(
    exec_ids=exec_ids,
    output_path="training_data.jsonl",
    filter_successful=True
)
```

## Performance Impact

**Zero impact on user-facing agent**:
- RL worker runs in separate process (no GIL contention)
- Episode events are non-blocking queue.put() (< 1ms)
- All reward shaping happens in background
- Logs written asynchronously

**Resource usage**:
- ~10-50MB RAM (for reward shaper + logging)
- Negligible CPU (only processes on episode completion)
- ~300 bytes per episode in `rl_training.jsonl`

## Troubleshooting

### No RL logs being written

**Check 1**: Is RL worker enabled?
```bash
# Should see "RL worker started (PID: ...)" in startup logs
python main.py --v2 --rl-worker
```

**Check 2**: Is RL worker process running?
```bash
ps aux | grep rl_worker
```

**Check 3**: Are episodes completing?
```bash
# Should see episode summaries in agent_execution.jsonl
tail -f logs/agent_execution.jsonl | grep episode_summary
```

**Check 4**: Check RL worker logs
```bash
# Look for RL worker errors in system logs
tail -f logs/voice_agent_v2.log | grep rl_worker
```

### RL worker crashes

**Symptom**: Worker process dies after startup

**Common causes**:
1. EventBus not properly shared (check multiprocessing setup)
2. Log directory permissions (ensure `logs/` is writable)
3. RewardShaper initialization failure

**Debug**:
```bash
# Run with debug logging
python main.py --v2 --rl-worker --debug

# Check for Python traceback in logs
grep -A 20 "RL worker error" logs/voice_agent_v2.log
```

### Old episodes not being processed

**Symptom**: RL logs only contain recent episodes

**Explanation**: RL worker only processes episodes emitted AFTER it starts. Historical episodes in `agent_execution.jsonl` are not retroactively processed.

**Solution**: Use EpisodeReconstructor to manually process historical episodes:

```python
from harness.rl_reconstructor import EpisodeReconstructor
import json

# Load historical exec_ids from agent_execution.jsonl
exec_ids = []
with open("logs/agent_execution.jsonl") as f:
    for line in f:
        entry = json.loads(line)
        if entry.get("svc") == "episode_summary":
            exec_ids.append(entry["exec_id"])

# Reconstruct and save
reconstructor = EpisodeReconstructor()
for exec_id in exec_ids:
    episode = reconstructor.reconstruct(exec_id)
    # Process as needed
```

## Disabling RL Worker

Simply omit the `--rl-worker` flag:

```bash
# Without RL worker
python main.py --v2

# Or use V1 architecture (no RL support yet)
python main.py
```

The agent will still emit episode events (negligible overhead), but nobody will consume them.

## Next Steps

After collecting training data:

1. **Analyze reward distribution**: `jq '.episode.episode_reward' logs/rl_training.jsonl | sort | uniq -c`
2. **Identify failure patterns**: `jq 'select(.episode.goal_achieved == false)' logs/rl_training.jsonl`
3. **Reconstruct for training**: Use `EpisodeReconstructor.batch_reconstruct()` to generate training samples
4. **Train RL model**: Use transitions in training samples for policy gradient, Q-learning, or behavior cloning

See `docs/RL_RECONSTRUCTION_AUDIT.md` for full reconstruction system documentation.
