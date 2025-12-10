# RL Training Data Reconstruction - Audit & Design

## Problem Statement

**Current Issue**: We're logging full objects (system prompts, tool definitions) in every log entry instead of using references. This:
- ❌ Bloats log files (system prompts repeated for every episode)
- ❌ Makes reconstruction harder (no clear boundaries)
- ❌ Wastes storage (tool definitions duplicated thousands of times)
- ❌ Unclear what minimal data is needed for reconstruction

**Goal**: Design a clean reference-based system where:
- ✅ Large objects stored once, referenced by ID
- ✅ Clear boundaries between what's logged inline vs referenced
- ✅ Minimal data needed for full episode reconstruction
- ✅ Efficient storage and fast retrieval

## Current Logging Analysis

### What We Log Now (agent_execution.jsonl)

```json
{
  "svc": "agent_context",
  "req_id": "abc-123",
  "exec_id": "abc-123-exec-0001",
  "context": {
    "tier": "advanced",
    "system_prompt": "<FULL 500 CHAR PROMPT INLINED>",  // ❌ Repeated every episode
    "tool_definitions": [                                 // ❌ Repeated every episode
      {"name": "web_search", "description": "..."},
      {"name": "bash_execute", "description": "..."},
      // ... 12 tools
    ],
    "conversation_history": [],                           // ✅ Unique per episode
    "tool_count": 12
  }
}
```

**Problems:**
1. System prompt repeated for every episode (500+ chars × thousands of episodes)
2. Tool definitions repeated for every episode (12 tools × descriptions)
3. No versioning (if prompt changes, can't tell which episodes used which version)

## Proposed Solution: Reference-Based Storage

### Design Principles

1. **Store Once, Reference Many**: Large objects stored in separate files, referenced by ID
2. **Immutable References**: IDs are content-addressable or versioned
3. **Joinable Logs**: All logs can be reconstructed by joining on IDs
4. **Minimal Inline Data**: Only unique-per-episode data inlined

### Storage Architecture

```
logs/
├── agent_execution.jsonl        # Episode execution logs (REFERENCES only)
├── rl_training.jsonl            # RL rewards (REFERENCES only)
│
├── manifests/                   # Referenced objects (immutable)
│   ├── system_prompts/
│   │   ├── tier_simple_v1.json
│   │   ├── tier_standard_v1.json
│   │   └── tier_advanced_v1.json
│   │
│   ├── tool_manifests/
│   │   ├── default_tools_v1.json
│   │   └── default_tools_v2.json
│   │
│   └── conversations/           # For multi-turn episodes
│       └── {req_id}_history.json
│
└── reconstructed/               # Full reconstructed episodes (for training)
    └── {exec_id}_full.json
```

### Example: Refactored Logging

#### Before (Current - Bloated)

```json
{
  "svc": "agent_context",
  "req_id": "abc-123",
  "exec_id": "abc-123-exec-0001",
  "context": {
    "tier": "advanced",
    "system_prompt": "You are an expert personal CLI assistant for complex tasks. This transcript could be from a voice command and thus you should be aware of potential typos. Optimize for correctness and clarity.\n\nPrinciples:\n- Quickly outline the plan...",
    "tool_definitions": [
      {"name": "web_search", "description": "Search the web..."},
      {"name": "bash_execute", "description": "Execute a bash..."},
      // ... 10 more tools
    ]
  }
}
```

**Size**: ~3KB per entry × 1000 episodes = ~3MB

#### After (Proposed - Compact)

```json
{
  "svc": "agent_context",
  "req_id": "abc-123",
  "exec_id": "abc-123-exec-0001",
  "context": {
    "tier": "advanced",
    "system_prompt_id": "tier_advanced_v1",      // Reference
    "tool_manifest_id": "default_tools_v1",      // Reference
    "conversation_history_id": null,             // null = empty
    "user_input": "Create test.txt",             // Inline (unique)
    "input_length": 15
  }
}
```

**Size**: ~200 bytes per entry × 1000 episodes = ~200KB (15x smaller!)

## What Needs to be Reconstructed for RL Training

### Minimal State for Training

For RL training, we need to reconstruct:

1. **Input State** (what agent saw):
   - System prompt (behavior instructions)
   - Available tools (action space)
   - User input (task specification)
   - Conversation history (context)
   - Agent tier (capability level)

2. **Episode Trajectory** (what agent did):
   - Plan created (goals, steps, success criteria)
   - Steps executed (order, tool calls, results)
   - Tool calls (names, arguments, outputs, success/fail)
   - LLM calls (prompts sent, responses received)
   - Durations (per step, per tool call)

3. **Output State** (what happened):
   - Goal achieved (boolean)
   - Reflection (confidence, evidence, gaps)
   - Final response (what user saw)

4. **Reward Signal** (for training):
   - Per-step rewards
   - Episode reward
   - Quality classifications

### Reconstruction Query

```python
def reconstruct_episode(exec_id: str) -> FullEpisode:
    """Reconstruct complete episode for training"""

    # 1. Get execution logs
    logs = query_jsonl("agent_execution.jsonl", exec_id=exec_id)

    # 2. Get RL training log
    rl_log = query_jsonl("rl_training.jsonl", exec_id=exec_id)[0]

    # 3. Resolve references
    system_prompt = load_manifest(
        f"manifests/system_prompts/{logs['agent_context']['system_prompt_id']}.json"
    )
    tool_manifest = load_manifest(
        f"manifests/tool_manifests/{logs['agent_context']['tool_manifest_id']}.json"
    )

    # 4. Build full episode
    return FullEpisode(
        # Input state
        system_prompt=system_prompt,
        tools=tool_manifest["tools"],
        user_input=logs["agent_context"]["user_input"],
        conversation_history=logs["agent_context"]["conversation_history"],
        tier=logs["agent_context"]["tier"],

        # Trajectory
        plan=logs["planning"]["plan"],
        steps_executed=logs["execution_step"],  # List of all steps
        tool_calls=[...],  # Extracted from steps
        llm_calls=[...],   # From execution

        # Outcome
        goal_achieved=logs["episode_summary"]["labels"]["goal_achieved"],
        reflection=logs["episode_summary"]["labels"],
        final_response=logs["episode_summary"]["..."],

        # Rewards
        step_rewards=rl_log["steps"],
        episode_reward=rl_log["episode"]["episode_reward"]
    )
```

## Data Boundaries (What Goes Where)

### Inline in Logs (Unique Per Episode)

✅ **Always Inline:**
- User input
- Conversation history (if not too large)
- Step results
- Tool outputs
- Errors
- Durations
- Reflection details
- Rewards

### Referenced (Shared Across Episodes)

✅ **Always Reference:**
- System prompts
- Tool definitions/schemas
- Model configurations
- Prompt templates

### Conditional (Size-Based)

🔄 **Inline if small, reference if large:**
- Conversation history (<5 turns = inline, >5 turns = reference)
- Tool outputs (<1KB = inline, >1KB = reference with ID)
- LLM responses (<2KB = inline, >2KB = reference)

## Implementation Plan

### Phase 1: Create Manifest Storage

1. **System Prompt Manifests**
   ```bash
   logs/manifests/system_prompts/
   ├── tier_simple_v1.json
   ├── tier_standard_v1.json
   └── tier_advanced_v1.json
   ```

2. **Tool Manifests**
   ```bash
   logs/manifests/tool_manifests/
   └── default_tools_v1.json
   ```

### Phase 2: Update Logging to Use References

1. **Agent Context Log**: Use `system_prompt_id` and `tool_manifest_id`
2. **Planning Log**: No changes (already minimal)
3. **Execution Logs**: Add `tool_output_id` for large outputs
4. **Episode Summary**: Use references for static config

### Phase 3: Create Reconstruction Utility

```python
# harness/rl_reconstructor.py
class EpisodeReconstructor:
    def reconstruct(self, exec_id: str) -> FullEpisode:
        """Reconstruct complete episode with all references resolved"""
        pass

    def batch_reconstruct(self, exec_ids: List[str]) -> List[FullEpisode]:
        """Efficiently reconstruct multiple episodes"""
        pass
```

### Phase 4: Validate Reconstruction

Test that we can fully reconstruct:
- Input state (exactly what agent saw)
- Trajectory (exactly what agent did)
- Outcome (exactly what happened)
- Rewards (shaped rewards for training)

## Storage Savings

### Current (Bloated)

- Episode logs: ~3KB per episode
- 1000 episodes: ~3MB
- 1M episodes: ~3GB

### Proposed (Compact)

- Episode logs: ~200 bytes per episode
- Manifests: ~10KB total (one-time)
- 1000 episodes: ~200KB + 10KB = ~210KB (14x smaller)
- 1M episodes: ~200MB + 10KB = ~200MB (15x smaller!)

## Reconstruction Performance

### Query Pattern

```python
# Efficient batch reconstruction
episodes = EpisodeReconstructor().batch_reconstruct(
    exec_ids=["abc-1", "abc-2", ..., "abc-1000"]
)

# Manifests loaded once and cached
# Episode logs queried in batch
# O(N + M) where N=episodes, M=manifests (M is constant)
```

## Clean Boundaries

### User-Facing Logs (agent_execution.jsonl)

**Purpose**: Debug agent execution, understand what happened
**Contents**: References + execution details
**Used by**: Developers, debugging tools, dashboards

### RL Training Logs (rl_training.jsonl)

**Purpose**: RL reward signals for training
**Contents**: References + rewards + classifications
**Used by**: Training pipeline

### Manifests (logs/manifests/)

**Purpose**: Shared configuration objects
**Contents**: System prompts, tool definitions, etc.
**Used by**: Both user-facing and RL logs (via references)

### Reconstructed Episodes (generated on-demand)

**Purpose**: Full episodes for training
**Contents**: Everything joined and resolved
**Used by**: Training data generation

## Summary

### Current State
❌ Full objects inlined → bloated logs
❌ No clear boundaries → hard to understand
❌ Duplicate data → wasted storage

### Proposed State
✅ References for shared objects → compact logs
✅ Clear boundaries → easy to understand
✅ Manifest storage → efficient, versioned
✅ Reconstruction utility → easy to use

### Next Steps
1. Create manifest storage system
2. Update logging to use references
3. Build reconstruction utility
4. Validate full reconstruction
5. Test with real episodes
