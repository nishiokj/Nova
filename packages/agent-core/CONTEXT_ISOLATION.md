# Context Window Isolation

Agents now work on isolated context clones instead of mutating global state.

## Architecture

- **Orchestrator** owns global context, only it mutates it
- **Agents** clone input context, work on clone, return result
- **Sub-agents** are opaque - parent only sees response, not internal execution

## Changes

### `src/types/context.ts`
- `clone()` - creates independent copy
- `isNearFull(threshold)` - checks capacity

### `src/agent/types.ts`
- `AgentResult.localContext` - agent's execution snapshot (for future use)

### `src/agent/agent.ts`
- `run()` clones context at start, returns `localContext`
- `executeAgentToolCall()` no longer merges sub-agent context back

### `src/orchestrator/orchestrator.ts`
- Auto-compact at 80% fullness before each iteration
- Adds agent response to global context after terminal states

### `src/orchestrator/dag-executor.ts`
- Comment noting agents clone internally

## Behavior

| Aspect | Before | After |
|--------|--------|-------|
| Agent context | Mutates input | Works on clone |
| Sub-agent | Merges back | Opaque, response only |
| Compaction | Manual | Auto at 80% |
| Persisted | All tool calls | Responses only |
