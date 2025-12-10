# RL Logging Data Flow

## Complete Episode Lifecycle

```
┌────────────────────────────────────────────────────────────────────┐
│ USER REQUEST                                                       │
│ "Create a file called test.txt with hello world"                  │
└────────────────┬───────────────────────────────────────────────────┘
                 │
                 v
┌────────────────────────────────────────────────────────────────────┐
│ AGENT EXECUTION (harness/agent.py)                                │
│                                                                    │
│ 1. PLANNING                                                        │
│    Planner creates execution plan with success criteria           │
│    └─> Plan: 2 steps (create directory, write file)               │
│                                                                    │
│ 2. EXECUTION                                                       │
│    Executor runs plan step-by-step                                │
│    ├─> Step 1: bash_execute("mkdir -p test") ✓                    │
│    └─> Step 2: file_write("test/test.txt", "hello world") ✓       │
│                                                                    │
│ 3. REFLECTION                                                      │
│    Reflector evaluates if goal was achieved                       │
│    └─> goal_achieved: true, confidence: 0.95                      │
│                                                                    │
└────────────────┬───────────────────────────────────────────────────┘
                 │
                 ├─────────────────────────────────────────────┐
                 │                                             │
                 v                                             v
┌────────────────────────────────────┐   ┌────────────────────────────┐
│ USER-FACING LOGS                   │   │ RL EVENT EMISSION          │
│ (logs/agent_execution.jsonl)       │   │ (harness/event_bus.py)     │
│                                    │   │                            │
│ Writes:                            │   │ Emits:                     │
│ ├─ agent_context                   │   │ EPISODE_COMPLETE event     │
│ ├─ planning                        │   │ ├─ req_id                  │
│ ├─ execution_context (per step)    │   │ ├─ exec_id                 │
│ ├─ execution_step (per step)       │   │ ├─ plan (steps, goal)      │
│ └─ episode_summary (RL labels)     │   │ ├─ trace (execution)       │
│                                    │   │ └─ reflection (outcome)    │
│ ✓ Used by user-facing systems      │   │                            │
└────────────────────────────────────┘   └──────────┬─────────────────┘
                                                    │
                                                    v
                                         ┌────────────────────────────┐
                                         │ EVENT BUS                  │
                                         │ (rl_events_queue)          │
                                         │                            │
                                         │ Queues episode event       │
                                         │ (non-blocking, async)      │
                                         └──────────┬─────────────────┘
                                                    │
                                                    v
                                         ┌────────────────────────────┐
                                         │ RL WORKER PROCESS          │
                                         │ (harness/rl_worker.py)     │
                                         │                            │
                                         │ Background process that:   │
                                         │ ├─ Consumes events         │
                                         │ ├─ Never blocks agent      │
                                         │ └─ Processes continuously  │
                                         └──────────┬─────────────────┘
                                                    │
                                                    v
                                         ┌────────────────────────────┐
                                         │ REWARD SHAPER              │
                                         │ (harness/rl_reward_shaper) │
                                         │                            │
                                         │ Analyzes episode:          │
                                         │                            │
                                         │ Episode Reward Calculation:│
                                         │ ├─ Base: 0.6 (achieved)    │
                                         │ ├─ Confidence: +0.19       │
                                         │ ├─ Efficiency: +0.18       │
                                         │ └─ Total: 0.97             │
                                         │                            │
                                         │ Per-Step Rewards:          │
                                         │ ├─ Step 1: 0.23 (good)     │
                                         │ └─ Step 2: 0.74 (excellent)│
                                         └──────────┬─────────────────┘
                                                    │
                                                    v
                                         ┌────────────────────────────┐
                                         │ RL TRAINING LOG            │
                                         │ (logs/rl_training.jsonl)   │
                                         │                            │
                                         │ {                          │
                                         │   "req_id": "abc-123",     │
                                         │   "exec_id": "...-0001",   │
                                         │   "episode": {             │
                                         │     "goal_achieved": true, │
                                         │     "episode_reward": 0.97,│
                                         │   },                       │
                                         │   "steps": [               │
                                         │     {                      │
                                         │       "step_num": 1,       │
                                         │       "reward": 0.23,      │
                                         │       "classification":    │
                                         │         "good"             │
                                         │     },                     │
                                         │     {                      │
                                         │       "step_num": 2,       │
                                         │       "reward": 0.74,      │
                                         │       "classification":    │
                                         │         "excellent",       │
                                         │       "done": true         │
                                         │     }                      │
                                         │   ]                        │
                                         │ }                          │
                                         │                            │
                                         │ ✓ Used for RL training     │
                                         └────────────────────────────┘
```

## Key Data Flows

### 1. Episode Context Flow

```
Agent Context
    ├─ user_input: "Create test.txt"
    ├─ tier: "advanced"
    ├─ system_prompt_id: "tier_advanced_v1"
    ├─ tool_manifest_id: "default_tools_v1"
    └─ conversation_history: []
         │
         v
    Logged to agent_execution.jsonl
         │
         └─> Available for reconstruction
```

### 2. Plan Flow

```
Planning
    ├─ goal: "Create file test.txt with content"
    ├─ goal_type: "task"
    ├─ steps: [
    │   {step_num: 1, objective: "Create directory", tool_hint: "bash_execute"},
    │   {step_num: 2, objective: "Write file", tool_hint: "file_write"}
    │ ]
    └─ success_criteria: "File exists with correct content"
         │
         ├─> Logged to agent_execution.jsonl
         │
         └─> Sent in episode event
              └─> Used by RewardShaper
```

### 3. Execution Flow

```
Execution
    ├─ Step 1: bash_execute
    │   ├─ duration_ms: 150
    │   ├─ status: "completed"
    │   └─ result: "Directory created"
    │
    └─ Step 2: file_write
        ├─ duration_ms: 80
        ├─ status: "completed"
        └─ result: "File written"
             │
             ├─> Logged to agent_execution.jsonl
             │
             └─> Sent in episode event
                  └─> Used by RewardShaper for step classification
```

### 4. Reflection Flow

```
Reflection
    ├─ goal_achieved: true
    ├─ confidence: 0.95
    ├─ evidence: ["File created successfully"]
    └─ gaps: []
         │
         ├─> Logged to agent_execution.jsonl (as RL labels)
         │
         └─> Sent in episode event
              └─> Used by RewardShaper for episode reward
```

### 5. Reward Shaping Flow

```
RewardShaper receives:
    ├─ plan (goal, steps, criteria)
    ├─ trace (steps_executed, tool_calls, failures)
    └─ reflection (goal_achieved, confidence, gaps)
         │
         v
    Calculates episode reward:
         base = 0.6 (goal achieved)
         + confidence_bonus = 0.95 * 0.2 = 0.19
         + efficiency_bonus = 1.0 * 0.2 = 0.2
         - failure_penalty = 0
         = 0.99 (clamped to 1.0)
         │
         v
    Assigns step rewards:
         Step 1: base * 1.5 (excellent, <1s) = 0.23
         Step 2: base * 1.5 + 0.3 (terminal) = 0.74
         │
         v
    Writes to rl_training.jsonl
```

## Data Reference Structure

All logs can be joined using IDs:

```
req_id: "3a5c7ea6-0001"
    │
    ├─ exec_id: "3a5c7ea6-0001-exec-0001"
    │     │
    │     ├─ plan_id: "3a5c7ea6-0001-exec-0001-plan"
    │     │
    │     └─ steps:
    │           ├─ step_id: "3a5c7ea6-0001-exec-0001-step-1"
    │           └─ step_id: "3a5c7ea6-0001-exec-0001-step-2"
    │
    └─ Can have multiple executions (retries, iterations)
```

### Joining Logs for Training

```python
# Get RL training log
rl_log = parse_rl_log(exec_id="abc-123-exec-0001")

# Join with execution logs
execution_logs = query_jsonl(
    "logs/agent_execution.jsonl",
    exec_id="abc-123-exec-0001"
)

# Reconstruct full episode
episode = {
    # From execution logs
    "context": execution_logs["agent_context"],
    "plan": execution_logs["planning"],
    "execution_steps": execution_logs["execution_step"],

    # From RL logs
    "rewards": rl_log["steps"],
    "episode_reward": rl_log["episode"]["episode_reward"],
    "quality": rl_log["episode"]["quality_notes"]
}

# Create training sample
state = episode["context"]
actions = [step["tool_hint"] for step in episode["plan"]["steps"]]
rewards = [step["reward"] for step in episode["rewards"]]
terminal_reward = episode["episode_reward"]
```

## Timing Diagram

```
Time ──────────────────────────────────────────────────────>

Agent:    [Plan][Execute─────────][Reflect][Log][Emit Event][Return Response]
                                                    │              │
                                                    │              └─> User sees response
                                                    │
EventBus:                                     [Queue Event]
                                                    │
                                                    │ (async, non-blocking)
                                                    │
RLWorker:                                           └─>[Consume][Shape Rewards][Write Log]
                                                                                    │
                                                                                    └─> RL log updated
```

**Critical**: Agent returns response to user BEFORE RL worker processes episode.
RL logging has ZERO impact on user experience.

## File System State

After one episode:

```
logs/
├── agent_execution.jsonl
│   ├── {"svc": "agent_context", "req_id": "abc-123", "exec_id": "...-0001", ...}
│   ├── {"svc": "planning", "req_id": "abc-123", "exec_id": "...-0001", ...}
│   ├── {"svc": "execution_context", "req_id": "abc-123", "exec_id": "...-0001", "step_id": "step-1", ...}
│   ├── {"svc": "execution_step", "req_id": "abc-123", "exec_id": "...-0001", "step_id": "step-1", ...}
│   ├── {"svc": "execution_context", "req_id": "abc-123", "exec_id": "...-0001", "step_id": "step-2", ...}
│   ├── {"svc": "execution_step", "req_id": "abc-123", "exec_id": "...-0001", "step_id": "step-2", ...}
│   └── {"svc": "episode_summary", "req_id": "abc-123", "exec_id": "...-0001", ...}
│
└── rl_training.jsonl
    └── {"req_id": "abc-123", "exec_id": "...-0001", "episode": {...}, "steps": [...]}
```

All joined by `req_id` and `exec_id`.

## Summary

1. **Agent executes** normally (plan → execute → reflect)
2. **Logs to execution log** (detailed step-by-step trace)
3. **Emits episode event** (non-blocking, async)
4. **Returns response** to user (zero delay)
5. **RL worker processes** in background
6. **Shapes rewards** based on success/efficiency
7. **Writes RL log** with per-step rewards and classifications
8. **Available for training** (reconstruct via IDs)
