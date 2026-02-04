# Orchestrator State Machine Analysis

## 1. Core State Tracking

The orchestrator maintains these state containers:

```typescript
workQueue: WorkItem[]           // Pending work items
completedWork: Map<workId, AgentResult>  // Completed work
inProgress: Map<workId, {item, agent}>   // Currently executing
initialWorkId: string           // The root work item ID
realignCount: number            // Realign attempts (max 3)
```

---

## 2. Work Item Lifecycle

### Creation Paths

| Source | Creates Via | Agent Type | Context Inherited |
|--------|-------------|------------|-------------------|
| Initial user request | `createWorkItem()` | From `execute()` param | None (fresh) |
| Handoff spec (plan approval) | `parseHandoffSpec()` | From spec's `agent` field | Goal from plan |
| Watcher split/realign | `enqueueDeferredWork()` | From watcher's decision | Goal from watcher |
| Interruption handling | `createWorkItem()` | Same agent type | Continues conversation |
| Cadence audit | `enqueueDeferredWork()` | From watcher decision | Goal from watcher |

### Context Inheritance

```typescript
// Agent.run() creates a LOCAL context:
const localContext = new ContextWindow(
  `${globalContext.sessionKey}:${this.config.type}:${workItem.workId}`,
  globalContext.maxTokens
);
// Agent reads from globalContext, writes to localContext
// GlobalContext is NEVER mutated by agent directly
```

**Critical Finding:** When agents are created, they receive:
- `globalContext`: Read-only, session-wide context
- `workItem.objective`: Their specific goal
- `workItem.bounds`: Resource limits (maxToolCalls, maxLlmCalls, maxDurationMs)
- `memoryInjector`: For retrieving relevant memory

**But:** The objective only comes from `workItem.objective`. There's no automatic inheritance of prior agent reasoning or intermediate results unless:
1. The previous agent's response is in `globalContext` (via `context.addAgentResultContext()`)
2. Memory is injected via `memoryInjector`

---

## 3. Agent Creation Patterns

```typescript
private createAgent(agentType, context, workId, objective, runtime): Agent | null {
  // 1. Check registry
  if (!this.agentRegistry?.has(agentType)) return null;

  // 2. Get config, apply plan mode or async mode modifications
  let config = this.agentRegistry.getConfig(agentType);

  // 3. If async mode: CLEAR outputSchema (critical!)
  if (asyncMode?.enabled && agentType !== 'watcher' && agentType !== 'planner') {
    config = { ...config, outputSchema: undefined };
  }

  // 4. Build LLM config from model selection
  const llmConfig = this.buildLlmConfig(config.llmParams, agentType);

  // 5. Wire cadence check hook (every 30 tool calls or 2 min)
  const cadenceCheck = async (metrics) => { ... };

  // 6. Create agent with all dependencies
  return new Agent(config, { llm, toolRegistry, emit, agentRegistry, ... });
}
```

**Potential Issue:** The `config` object is **shallow copied** with spread, meaning nested objects share references. If async mode modifies `config`, the next agent of the same type could see stale config.

---

## 4. Termination Reasons & Decision Mapping

The orchestrator checks termination conditions in this order:

| Condition | Termination Reason | Watcher Event | Decision Type |
|-----------|-------------------|---------------|---------------|
| `needsUserInput` | `user_input_required` | `user_input_required` | `PromptAnswerDecision` |
| `needsHandoff` | `handoff_requested` | `handoff_requested` | `HandoffDecision` |
| `isRefusal` | `refusal` | - | - |
| `user_stopped` | `user_stopped` | `user_stopped` | - |
| `watcher_stopped` | `watcher_stopped` | - | - |
| `no_action/invalid_action/stagnation` | varies | `agent_error` | `AgentErrorDecision` |
| Agent bounds exceeded | `max_*_exceeded` | `bounds_exceeded` | `BoundsDecision` |
| `rate_limit/circuit_open` | same | - | - |
| `timeout` | `timeout` | - | - |
| `agent_error` | `agent_error` | `agent_error` | `AgentErrorDecision` |
| Orchestrator bounds | `max_*_exceeded` | `bounds_exceeded` | `BoundsDecision` |
| Goal reached | `goal_state_reached` | `goal_state_reached` | `QualityGateDecision` |

---

## 5. Watcher Decision → Orchestrator Action Mapping

### QualityGateDecision
```
passed     → allow termination
failed     → block, inject issues as system message
needs_human → block, inject concerns
```

### BoundsDecision
```
realign  → block, re-inject guidance, increment realignCount
split    → enqueue new workItems, reset realignCount
wrap_up  → allow with summary
abort    → allow with reason
```

### PromptAnswerDecision
```
answer   → block, inject answer as USER message (not system!)
escalate → allow (pause for user)
defer    → allow
```

### CadenceDecision
```
continue        → no-op
inject_guidance → add system message
realign         → block, inject guidance
split           → enqueue new workItems
stop            → allow termination
```

### HandoffDecision
```
approve → parse spec, enqueue workItems
reject  → block, inject feedback
modify  → block, inject changes
```

### WorkItemCompletedDecision
```
accept   → allow
retry    → block, re-inject guidance
split    → enqueue new workItems
escalate → allow
```

---

## 6. Critical State Transitions

### When a spec is approved

```typescript
// In checkTerminationConditions, when handoff_requested:
if (stopResult && stopResult.decision === 'allow') {
  const workItems = this.parseHandoffSpec(result.handoffSpec, goal);
  // Disable plan mode after approval!
  if (this.planModeOptions?.enabled) {
    this.planModeOptions = undefined;
  }
  for (const item of workItems) {
    this.enqueue(item);
  }
  return { terminal: null, shouldContinue: true };
}
```

**Potential Issue:** `planModeOptions` is mutated in-place, not reset for future sessions.

### When an agent returns

```typescript
// After agent.run() completes:
totalLlmCalls += result.metrics.llmCallsMade;
totalToolCalls += result.metrics.toolCallsMade;
context.updateMetrics(...);  // Merge token metrics
context.addAgentResultContext(result);  // Add to global context

if (goalStateReached) {
  this.completedWork.set(workId, result);
  inProgress.delete(workId);
  // Check if this was the initial work...
}
```

### When an agent blocks (watcher decides to retry)

```typescript
// handleStopHookBlock() creates new work item:
const newItem = this.createWorkItem(stopResult.reason, agentType);
this.enqueue(newItem);
this.completedWork.delete(this.initialWorkId);  // Clear old!
this.initialWorkId = newItem.workId;  // Track new root
```

---

## 7. Identified State Concerns

### A. Realign Counter Management

```typescript
// Incremented when bounds exceeded + watcher says realign:
if (isBoundsExceeded) {
  this.realignCount++;
  if (this.realignCount > this.config.maxRealigns) {
    return false;  // Force termination
  }
}

// Reset when deferred work is added:
if (deferredWorkAdded) {
  this.realignCount = 0;  // Reset - splitting work is progress
}
```

**Issue:** Realign counter is never reset on successful goal completion. If a session has multiple sequential goals, the counter persists.

### B. Initial Work ID Tracking

```typescript
// When interruption detected:
const newItem = this.createWorkItem('Continue with user input', agentType);
this.resetWorkTracking(newItem);  // Clears completedWork[initialWorkId], updates initialWorkId
startTime = Date.now();  // Reset timer
```

**Issue:** The initial work's result is deleted from `completedWork`, so its response is lost. If the user asks "what did you do?", the original work's output is gone.

### C. Context Accumulation

Each agent's result is added to global context via `addAgentResultContext()`. However:
- Context can grow unboundedly if many agents run
- Compaction happens at 70% capacity, but only removes old items
- Agent results added to global context may contain redundant information

### D. Handoff Spec Parsing

```typescript
// Dependencies are remapped from planner IDs to generated workIds:
const idMap = new Map<string, string>();
for (const specItem of cast.workItems) {
  const workItem = createWorkItem({...});
  if (specItem.id) {
    idMap.set(specItem.id, workItem.workId);
  }
}
// Then resolve dependencies using the map
```

**Potential Issue:** If the planner uses an ID that wasn't defined earlier in the spec, it becomes an "unknown dependency" and is dropped (with a warning). The workItem still executes, just without the intended ordering.

### E. Parallel Execution Race Conditions

```typescript
// Multiple agents execute in parallel:
const executions = Array.from(inProgress.entries()).map(async ([workId, { item, agent }]) => {
  const result = await agent.run({ globalContext: context, workItem: item, cwd });
  return { workId, item, result };
});
const results = await Promise.all(executions);
```

All parallel agents share the same `globalContext` for READING. But if they both write to the same file, there's no collision detection at the orchestrator level. The `domain` field exists but isn't used for scheduling.

### F. Async Mode OutputSchema Clearing

```typescript
if (this.config.asyncMode?.enabled && agentType !== 'watcher' && agentType !== 'planner') {
  config = { ...config, outputSchema: undefined };
}
```

This is correct for async workers, but **shallow copy** means nested objects in `config` are still shared. If `config.llmParams` or `config.budget` were modified, other agents would see the change.

---

## 8. Agent Bounds vs Orchestrator Bounds

| Level | Limit | Checked Where | Consequence |
|-------|-------|---------------|-------------|
| Agent | `workItem.bounds.maxToolCalls` | `Agent.checkBounds()` | Agent terminates with `max_tool_calls_exceeded` |
| Agent | `workItem.bounds.maxDurationMs` | `Agent.checkBounds()` | Agent terminates with `max_duration_exceeded` |
| Agent | `workItem.bounds.maxLlmCalls` | `Agent.executeLoop()` | Agent terminates with `max_iterations_exceeded` |
| Orchestrator | `config.maxIterations` | Main loop | All work stops, harvest partial results |
| Orchestrator | `config.maxToolCalls` | After each result | All work stops, harvest partial results |

**Key Insight:** Orchestrator iteration != agent iteration. Orchestrator iterates once per "batch" of parallel agent runs. Agent iterates once per LLM call.

---

## 9. Post-Completion Flows

When work queue empties with completed initial work:

```typescript
if (initialWorkCompleted && this.workQueue.length === 0 && inProgress.size === 0) {
  // Check for interruption
  if (runtime?.checkInterruption?.()) {
    // Continue with new work item
  }
  // Call stop hook for quality gate
  if (runtime?.hookRegistry) {
    const stopResult = await this.callStopHook(...);
    if (stopResult?.decision === 'block') {
      // Watcher rejected - create new work
      const newItem = this.createWorkItem(stopResult.reason, agentType);
      this.enqueue(newItem);
      continue;
    }
  }
  // Emit goal_achieved and return
}
```

---

## 10. Summary of Potential Issues

| # | Issue | Impact | Location |
|---|-------|--------|----------|
| 1 | Realign counter persists across multiple goals in same session | Premature termination | `handleStopHookBlock()` |
| 2 | Initial work result deleted when interruption/realign occurs | Lost context | `resetWorkTracking()` |
| 3 | Plan mode mutated in place without reset between sessions | Stale state | `checkTerminationConditions()` |
| 4 | Shallow config copy could cause cross-agent config bleed | Incorrect agent config | `createAgent()` |
| 5 | Domain field unused for parallel execution scheduling | File conflicts | Main loop |
| 6 | Unknown dependencies silently dropped in handoff parsing | Incorrect ordering | `parseHandoffSpec()` |
| 7 | No deduplication of work items with same objective | Redundant work | `enqueue()` |
| 8 | Context growth unbounded between compactions | OOM risk | Main loop |
| 9 | Global context shared for read but no write coordination | Race conditions | `Promise.all(executions)` |
| 10 | Cadence check every 30 tool calls can miss fast-running agents | Missed oversight | `cadenceCheck` |

---

## 11. Recommendations

### High Priority

1. **Reset realignCount** on successful goal completion or new `execute()` call
2. **Archive initial work result** instead of deleting on interruption
3. **Deep clone config** in `createAgent()` to prevent cross-agent bleed
4. **Use domain field** to prevent parallel agents from modifying same files

### Medium Priority

5. **Add dependency validation** in `parseHandoffSpec()` - fail if unknown deps
6. **Deduplicate work items** by objective hash before enqueueing
7. **Track context growth rate** and trigger earlier compaction if needed

### Low Priority

8. **Consider adaptive cadence** - check more frequently for high-activity agents
9. **Add work item lineage tracking** for debugging
10. **Expose orchestrator metrics** (realign count, queue depth) via events
