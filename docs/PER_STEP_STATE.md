# Per-Step State for RL Training

## The Critical Missing Piece

**Problem identified**: The original `steps_executed` structure only had:
- ✅ `action` (what the model did)
- ✅ `result` (outcome)
- ❌ **Missing: STATE** (what the model saw when choosing that action)

This made it **impossible to do proper RL training** because we couldn't create (state, action, reward) tuples.

## Solution

**Embed `step_context` in each step** during episode reconstruction. This gives us the **observation** (state) per step.

## Before vs After

### Before (Incomplete)

```json
{
  "steps_executed": [
    {
      "step_id": "step-1",
      "step_num": 1,
      "status": "completed",
      "action": {
        "type": "tool_call",
        "tool_name": "file_write"
      },
      "result": {
        "duration_ms": 50,
        "tool_success": true
      }
    }
  ]
}
```

**Problem**: No state! We don't know:
- What was the model's objective for this step?
- What messages did the model see?
- What tools were available?

### After (Complete RL Tuple)

```json
{
  "steps_executed": [
    {
      "step_id": "step-1",
      "step_num": 1,
      "status": "completed",

      "step_context": {
        "step_objective": "Create file with content",
        "messages": [
          { "role": "system", "content": "You are an expert assistant." },
          { "role": "user", "content": "Create test.txt with hello world" }
        ],
        "available_tools": ["file_write", "bash_execute"],
        "tool_hint": "file_write",
        "system_prompt_id": "test_prompt_v1",
        "tool_manifest_id": "test_tools_v1"
      },

      "action": {
        "type": "tool_call",
        "tool_name": "file_write",
        "tool_args": { "path": "test.txt", "content": "hello world" }
      },

      "result": {
        "tool_success": true,
        "tool_output": "File written successfully",
        "duration_ms": 50
      }
    }
  ]
}
```

**Now we have**:
- ✅ **STATE**: `step_context` (what model observed)
- ✅ **ACTION**: `action` (what model did)
- ✅ **REWARD**: From RL logs (shaped reward)
- ✅ **NEXT_STATE**: Next step's `step_context`

Perfect for RL training! 🎯

## Implementation Details

### 1. Logging Already Captures Context

The `AgentExecutionLogger` already logs `execution_context` per step:

```python
# harness/agent_execution_logger.py
def log_execution_context(
    self,
    req_id: str,
    exec_id: str,
    step_id: str,
    step_num: int,
    step_objective: str,
    tool_hint: Optional[str],
    messages: List[Dict[str, Any]],  # What model saw!
    available_tools: List[str],      # Action space!
    system_prompt_id: str,
    tool_manifest_id: str,
    dependencies: Optional[List[int]] = None
):
    # Logs to agent_execution.jsonl with svc="execution_context"
```

This creates log entries like:

```json
{
  "ts": "2025-12-10T20:00:02.000Z",
  "svc": "execution_context",
  "req_id": "abc-123",
  "exec_id": "abc-123-exec-0001",
  "step_id": "step-1",
  "context": {
    "step_num": 1,
    "step_objective": "Create file",
    "tool_hint": "file_write",
    "messages": [
      { "role": "system", "content": "..." },
      { "role": "user", "content": "..." }
    ],
    "available_tools": ["file_write", "bash_execute"],
    "system_prompt_id": "tier_advanced_v1",
    "tool_manifest_id": "default_tools_v1"
  }
}
```

### 2. Reconstruction Joins Context with Steps

The `EpisodeReconstructor` now:

1. Queries `execution_context` logs (state per step)
2. Queries `execution_step` logs (action per step)
3. **Joins them by `step_id`**
4. Embeds `step_context` in each step

```python
# harness/rl_reconstructor.py
def reconstruct(self, exec_id: str) -> FullEpisode:
    # Query execution contexts (STATE per step)
    execution_contexts = self._query_jsonl(
        self.execution_log_path, exec_id, svc="execution_context"
    )

    # Query execution steps (ACTION per step)
    execution_steps = self._query_jsonl(
        self.execution_log_path, exec_id, svc="execution_step"
    )

    # Join by step_id
    context_map = {
        ctx.get("step_id"): ctx.get("context", {})
        for ctx in execution_contexts
    }

    # Enrich steps with context
    enriched_steps = []
    for step in execution_steps:
        step_id = step.get("step_id")
        step_context = context_map.get(step_id, {})

        enriched_step = {
            **step,  # Original step (action, result)
            "step_context": {
                "step_objective": step_context.get("step_objective"),
                "messages": step_context.get("messages", []),
                "available_tools": step_context.get("available_tools", []),
                "tool_hint": step_context.get("tool_hint"),
                "system_prompt_id": step_context.get("system_prompt_id"),
                "tool_manifest_id": step_context.get("tool_manifest_id"),
            }
        }
        enriched_steps.append(enriched_step)

    # Use enriched steps in FullEpisode
    return FullEpisode(
        ...
        steps_executed=enriched_steps,  # Now has step_context!
        ...
    )
```

### 3. Training Samples Have Clean RL Transitions

The `to_training_sample()` method now creates proper RL transitions:

```python
def to_training_sample(self) -> Dict[str, Any]:
    """
    Convert to RL training format.

    Each step is a complete RL transition:
    - state: step_context (what model saw)
    - action: tool call (what model did)
    - reward: shaped reward
    - next_state: next step_context (for value functions)
    """
    transitions = []

    for i, step in enumerate(self.steps_executed):
        step_context = step.get("step_context", {})
        action_data = step.get("action", {})

        # Build state (what model saw)
        state = {
            "step_objective": step_context.get("step_objective"),
            "messages": step_context.get("messages", []),
            "available_tools": step_context.get("available_tools", []),
            "tool_hint": step_context.get("tool_hint"),
        }

        # Build action (what model did)
        action = {
            "type": action_data.get("type"),
            "tool_name": action_data.get("tool_name"),
            "tool_args": action_data.get("tool_args", {}),
        }

        # Get next state (for bootstrapping)
        next_state = None
        if i + 1 < len(self.steps_executed):
            next_step = self.steps_executed[i + 1]
            next_context = next_step.get("step_context", {})
            next_state = {
                "step_objective": next_context.get("step_objective"),
                "messages": next_context.get("messages", []),
                "available_tools": next_context.get("available_tools", []),
                "tool_hint": next_context.get("tool_hint"),
            }

        transition = {
            "step_num": i + 1,
            "state": state,
            "action": action,
            "reward": step_reward["reward"],
            "next_state": next_state,
            "done": (i == len(self.steps_executed) - 1),
            "classification": step_reward.get("classification"),
        }

        transitions.append(transition)

    return {
        "exec_id": self.exec_id,
        "goal": self.goal,
        "goal_achieved": self.goal_achieved,
        "episode_reward": self.episode_reward,
        "transitions": transitions,  # Clean RL tuples!
        "rewards": [t["reward"] for t in transitions],
        "tier": self.tier,
        "num_steps": len(transitions)
    }
```

## Training Sample Format

### Complete Training Sample

```python
{
  "exec_id": "abc-123-exec-0001",
  "goal": "Create test.txt with hello world",
  "goal_achieved": True,
  "episode_reward": 0.95,

  "transitions": [
    {
      "step_num": 1,

      "state": {
        "step_objective": "Write file with content",
        "messages": [
          { "role": "system", "content": "You are an expert assistant." },
          { "role": "user", "content": "Create test.txt with hello world" }
        ],
        "available_tools": ["file_write", "bash_execute"],
        "tool_hint": "file_write"
      },

      "action": {
        "type": "tool_call",
        "tool_name": "file_write",
        "tool_args": { "path": "test.txt", "content": "hello world" }
      },

      "reward": 0.95,
      "next_state": None,  # Terminal step
      "done": True,
      "classification": "excellent"
    }
  ],

  "rewards": [0.95],
  "tier": "advanced",
  "num_steps": 1
}
```

### Using for RL Training

```python
from harness.rl_reconstructor import EpisodeReconstructor

# Reconstruct episodes
reconstructor = EpisodeReconstructor()
episodes = reconstructor.batch_reconstruct(exec_ids)

# Generate training samples
training_samples = [ep.to_training_sample() for ep in episodes]

# Now you have clean (state, action, reward, next_state) tuples!
for sample in training_samples:
    for transition in sample["transitions"]:
        state = transition["state"]           # What model saw
        action = transition["action"]         # What model did
        reward = transition["reward"]         # Shaped reward
        next_state = transition["next_state"] # Next observation
        done = transition["done"]             # Terminal flag

        # Use for policy gradient, Q-learning, etc.
        # loss = compute_policy_gradient(state, action, reward)
        # Q_target = reward + gamma * Q(next_state) if not done else reward
```

## Benefits for RL

### 1. Policy Gradient Methods

```python
# State -> action distribution
state = transition["state"]
action = transition["action"]
reward = transition["reward"]

# Compute log probability
log_prob = model.compute_log_prob(state, action)

# Policy gradient update
loss = -log_prob * reward
```

### 2. Q-Learning / Actor-Critic

```python
# Bootstrapping requires next_state
state = transition["state"]
action = transition["action"]
reward = transition["reward"]
next_state = transition["next_state"]
done = transition["done"]

# TD target
if done:
    target = reward
else:
    next_value = value_network(next_state)
    target = reward + gamma * next_value

# Update Q-function
loss = (Q(state, action) - target) ** 2
```

### 3. Behavior Cloning (Imitation)

```python
# Learn from successful episodes only
if sample["goal_achieved"]:
    for transition in sample["transitions"]:
        state = transition["state"]
        action = transition["action"]

        # Supervised learning
        predicted_action = model(state)
        loss = cross_entropy(predicted_action, action)
```

### 4. Reward Modeling

```python
# Learn to predict reward from (state, action) pairs
for transition in sample["transitions"]:
    state = transition["state"]
    action = transition["action"]
    reward = transition["reward"]

    predicted_reward = reward_model(state, action)
    loss = (predicted_reward - reward) ** 2
```

## Data Flow

```
Agent Execution
  │
  ├─> Logs execution_context (svc="execution_context")
  │   - step_objective
  │   - messages (what model saw)
  │   - available_tools
  │   - tool_hint
  │
  └─> Logs execution_step (svc="execution_step")
      - action (what model did)
      - result (outcome)
      - duration_ms

           ↓

Episode Reconstruction
  │
  ├─> Query execution_context logs (STATE per step)
  ├─> Query execution_step logs (ACTION per step)
  └─> Join by step_id
      │
      └─> Enriched steps with embedded step_context
            │
            └─> FullEpisode.steps_executed = [
                  {
                    "step_context": {...},  # STATE
                    "action": {...},        # ACTION
                    "result": {...}         # OUTCOME
                  }
                ]

           ↓

Training Sample Generation
  │
  └─> to_training_sample()
      │
      └─> transitions = [
            {
              "state": step_context,
              "action": action,
              "reward": reward,
              "next_state": next_step_context,
              "done": is_terminal
            }
          ]
```

## Testing

Run the comprehensive test:

```bash
PYTHONPATH=. python3 tests/test_step_context.py
```

Tests validate:
- ✅ Each step has `step_context` embedded
- ✅ `step_context` includes objective, messages, tools
- ✅ Training samples have (state, action, reward, next_state) format
- ✅ Works for single and multi-step episodes
- ✅ Terminal steps have `done=True`, `next_state=None`

## Summary

### What Was Fixed

✅ **Per-step state** now embedded in `steps_executed`
✅ **Clean RL transitions** with (state, action, reward, next_state)
✅ **Ready for RL training** (policy gradient, Q-learning, etc.)
✅ **Validated with tests** proving complete reconstruction

### Before (Broken)

```python
step = {
  "action": {...},  # What model did
  "result": {...}   # Outcome
}
# ❌ Missing: What model SAW when choosing action!
```

### After (Fixed)

```python
transition = {
  "state": {...},       # What model saw ✅
  "action": {...},      # What model did ✅
  "reward": 0.95,       # Shaped reward ✅
  "next_state": {...},  # Next observation ✅
  "done": False         # Terminal flag ✅
}
# ✅ Perfect RL tuple!
```

### Impact

This was **the critical missing piece** for RL training. Without per-step state, you cannot:
- Train policy networks (need state → action mapping)
- Do Q-learning (need state-action pairs)
- Use actor-critic methods (need state values)
- Perform behavior cloning (need state → action examples)

**Now all of this is possible!** 🎉

The RL training pipeline is **complete and production-ready**.
