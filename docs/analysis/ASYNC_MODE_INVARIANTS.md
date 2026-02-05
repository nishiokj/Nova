# Async Mode Invariants - Complete State Matrix

## Executive Summary

This document enumerates ALL possible states in the async agent system and defines how EVERY state combination must be handled. No undefined behavior.

**State Dimensions:**
- **N = 16** Agent/Orchestrator termination states that can trigger the watcher
- **M = 6** Watcher action types
- **E = 5** Error/edge case states (timeouts, malformed responses, etc.)

**Total combinations:** N×M + E = 96 + 5 = **101 state transitions** that must be defined

---

## Part 1: Agent Termination States (N = 16)

These are ALL possible `terminationReason` values that can trigger the stop hook.

### 1.1 Success States

| # | State | Source | StopHook Trigger | Watcher Handler |
|---|-------|--------|------------------|-----------------|
| 1 | `goal_state_reached` | Agent completed task | Yes | `handleGoalReached` |

### 1.2 User Interaction States

| # | State | Source | StopHook Trigger | Watcher Handler |
|---|-------|--------|------------------|-----------------|
| 2 | `user_input_required` | PromptUser tool called | Yes | `handlePromptUser` |
| 3 | `handoff_requested` | Planner agent handoff | Yes | `handleHandoffApproval` |
| 4 | `user_stopped` | User typed "stop" | Yes | Pass-through (allow) |

### 1.3 Bounds Exceeded States

| # | State | Source | StopHook Trigger | Watcher Handler |
|---|-------|--------|------------------|-----------------|
| 5 | `max_iterations_exceeded` | Orchestrator iteration limit | Yes | `handleBoundsExceeded` |
| 6 | `max_tool_calls_exceeded` | Total tool calls exceeded | Yes | `handleBoundsExceeded` |
| 7 | `max_duration_exceeded` | Time limit exceeded | Yes | `handleBoundsExceeded` |

### 1.4 Transient Error States

| # | State | Source | StopHook Trigger | Watcher Handler |
|---|-------|--------|------------------|-----------------|
| 8 | `rate_limit` | API rate limit hit | Yes | Pass-through (allow) |
| 9 | `circuit_open` | Circuit breaker tripped | Yes | Pass-through (allow) |
| 10 | `timeout` | Request timeout | Yes | Pass-through (allow) |

### 1.5 Semantic Error States (Agent Misbehavior)

| # | State | Source | StopHook Trigger | Watcher Handler |
|---|-------|--------|------------------|-----------------|
| 11 | `no_action` | Agent didn't decide | Yes | Pass-through (allow) |
| 12 | `invalid_action` | Invalid action format | Yes | Pass-through (allow) |
| 13 | `refusal` | LLM refused task | Yes | Pass-through (allow) |
| 14 | `stagnation:tool_repeat` | Repeated same tool call | Yes (internal) | Ralph Loop handles |

### 1.6 Error & Intervention States

| # | State | Source | StopHook Trigger | Watcher Handler |
|---|-------|--------|------------------|-----------------|
| 15 | `agent_error` / `exception` | Runtime exception | Yes | `handleAgentError` |
| 16 | `cadence_audit` | Periodic 60s check | Yes | `handleCadenceAudit` |

### 1.7 Terminal State (No Override)

| # | State | Source | StopHook Trigger | Watcher Handler |
|---|-------|--------|------------------|-----------------|
| - | `watcher_stopped` | Watcher mid-agent stop | No (result of stop) | N/A |

---

## Part 2: Watcher Action Types (M = 6)

These are ALL possible `watcherAction` values the watcher can return.

| # | Action | Effect | Creates Work Items | StopHookResult.decision |
|---|--------|--------|-------------------|-------------------------|
| 1 | `answer` | Answer a prompt_user question | No | `block` |
| 2 | `realign` | Inject guidance, redirect agent | No | `block` |
| 3 | `split` | Decompose work into focused items | Yes | `allow` + deferredWork |
| 4 | `create_work_item` | Add follow-up work | Yes | `allow` + deferredWork |
| 5 | `quality_gate` | Validate work completion | No | `allow` (pass) / `block` (fail) |
| 6 | `continue` | Allow execution to proceed | No | `allow` |

---

## Part 3: Valid Action Matrix (Trigger → Actions)

**NOT all watcher actions are valid for all triggers.** Invalid combinations MUST be rejected.

| Trigger | Valid Actions | Invalid Actions (REJECT) |
|---------|---------------|--------------------------|
| `prompt_user` | `answer` | realign, split, create_work_item, quality_gate, continue |
| `bounds_exceeded` | `realign`, `split`, `create_work_item` | answer, quality_gate, continue |
| `agent_error` | `realign`, `continue` | answer, split, create_work_item, quality_gate |
| `goal_state_reached` | `quality_gate`, `split`, `create_work_item` | answer, realign, continue |
| `cadence_audit` | `continue`, `realign`, `split`, `create_work_item` | answer, quality_gate |
| `handoff_approval` | `continue`, `realign` | answer, split, create_work_item, quality_gate |
| `scope_collision` | `continue`, `realign` | answer, split, create_work_item, quality_gate |
| `session_init` | (none) | All actions |

### Invariant: Invalid Action Rejection

```
WHEN watcher returns action A for trigger T:
  IF A not in VALID_ACTIONS_BY_TRIGGER[T]:
    THEN use fallback action for T
    AND log warning: "Invalid action {A} for trigger {T}, using fallback"
```

---

## Part 4: Complete State Handling Matrix (N × M)

### Legend
- ✅ = Valid and handled
- ❌ = Invalid (use fallback)
- 🔄 = Creates new work, continues loop
- ⏹️ = Terminates execution
- 📝 = Injects message into context

### 4.1 `goal_state_reached` (Work completed)

| Watcher Action | Valid | StopHookResult | Orchestrator Behavior |
|----------------|-------|----------------|----------------------|
| `quality_gate` (passed=true) | ✅ | `decision: 'allow'` | ⏹️ Terminate successfully |
| `quality_gate` (passed=false) | ✅ | `decision: 'block', reason: issues` | 🔄 📝 Re-enqueue with feedback |
| `split` | ✅ | `decision: 'allow', deferredWork: [...]` | 🔄 Enqueue deferred work, continue |
| `create_work_item` | ✅ | `decision: 'allow', deferredWork: [...]` | 🔄 Enqueue deferred work, continue |
| `answer` | ❌ | FALLBACK: `quality_gate(passed=true)` | ⏹️ Terminate |
| `realign` | ❌ | FALLBACK: `quality_gate(passed=true)` | ⏹️ Terminate |
| `continue` | ❌ | FALLBACK: `quality_gate(passed=true)` | ⏹️ Terminate |

### 4.2 `user_input_required` (Agent asked a question)

| Watcher Action | Valid | StopHookResult | Orchestrator Behavior |
|----------------|-------|----------------|----------------------|
| `answer` | ✅ | `decision: 'block', reason: answer.text` | 🔄 📝 Inject answer as user message, continue |
| `realign` | ❌ | FALLBACK: `answer` with generic text | 🔄 Continue with fallback answer |
| `split` | ❌ | FALLBACK: `answer` | 🔄 Continue |
| `create_work_item` | ❌ | FALLBACK: `answer` | 🔄 Continue |
| `quality_gate` | ❌ | FALLBACK: `answer` | 🔄 Continue |
| `continue` | ❌ | FALLBACK: `answer` | 🔄 Continue |

### 4.3 `bounds_exceeded` (max_iterations, max_tool_calls, max_duration)

| Watcher Action | Valid | StopHookResult | Orchestrator Behavior |
|----------------|-------|----------------|----------------------|
| `realign` | ✅ | `decision: 'block', reason: guidance` | 🔄 📝 Increment realignCount, if ≤3 create new work item |
| `realign` (realignCount > 3) | ✅ | `decision: 'block'` | ⏹️ **Force terminate** (max realigns) |
| `split` | ✅ | `decision: 'allow', deferredWork: [...]` | 🔄 Enqueue deferred work, reset realignCount, continue |
| `create_work_item` | ✅ | `decision: 'allow', deferredWork: [...]` | 🔄 Enqueue deferred work, reset realignCount, continue |
| `answer` | ❌ | FALLBACK: `realign` with wrap-up message | 🔄 or ⏹️ depending on realignCount |
| `quality_gate` | ❌ | FALLBACK: `realign` | 🔄 or ⏹️ |
| `continue` | ❌ | FALLBACK: `realign` | 🔄 or ⏹️ |

### 4.4 `agent_error` / `exception`

| Watcher Action | Valid | StopHookResult | Orchestrator Behavior |
|----------------|-------|----------------|----------------------|
| `realign` | ✅ | `decision: 'block', reason: diagnosis` | 🔄 📝 Create new work item with error context |
| `continue` | ✅ | `decision: 'allow'` | ⏹️ Terminate with error |
| `answer` | ❌ | FALLBACK: `continue` | ⏹️ Terminate |
| `split` | ❌ | FALLBACK: `continue` | ⏹️ Terminate |
| `create_work_item` | ❌ | FALLBACK: `continue` | ⏹️ Terminate |
| `quality_gate` | ❌ | FALLBACK: `continue` | ⏹️ Terminate |

### 4.5 `cadence_audit` (Periodic check every 60s)

| Watcher Action | Valid | StopHookResult | Orchestrator Behavior |
|----------------|-------|----------------|----------------------|
| `continue` | ✅ | `decision: 'allow', systemMessage?: guidance` | 📝 Optional guidance injection, continue |
| `realign` | ✅ | `decision: 'block', reason: new_direction` | 🔄 📝 Create new work item |
| `split` | ✅ | `decision: 'allow', deferredWork: [...]` | 🔄 Enqueue deferred work, continue |
| `create_work_item` | ✅ | `decision: 'allow', deferredWork: [...]` | 🔄 Enqueue work, continue |
| `answer` | ❌ | FALLBACK: `continue` | Continue unchanged |
| `quality_gate` | ❌ | FALLBACK: `continue` | Continue unchanged |

### 4.6 `handoff_requested` (Planner wants to hand off)

| Watcher Action | Valid | StopHookResult | Orchestrator Behavior |
|----------------|-------|----------------|----------------------|
| `continue` | ✅ | `decision: 'allow'` | ⏹️ Parse handoff spec, enqueue work items, terminate planner |
| `realign` | ✅ | `decision: 'block', reason: feedback` | 🔄 📝 Reject plan, re-enqueue planner for revision |
| `answer` | ❌ | FALLBACK: `continue` | Approve handoff |
| `split` | ❌ | FALLBACK: `continue` | Approve handoff |
| `create_work_item` | ❌ | FALLBACK: `continue` | Approve handoff |
| `quality_gate` | ❌ | FALLBACK: `continue` | Approve handoff |

### 4.7 Pass-Through States (No Watcher Decision)

These states always return `decision: 'allow'` and terminate:

| State | Reason |
|-------|--------|
| `user_stopped` | Explicit user command, cannot override |
| `rate_limit` | Transient, let caller decide retry |
| `circuit_open` | Transient, let caller decide retry |
| `timeout` | Transient, let caller decide retry |
| `refusal` | LLM refused, cannot force compliance |
| `no_action` | Semantic error, Ralph Loop handles |
| `invalid_action` | Semantic error, Ralph Loop handles |

---

## Part 5: Error & Edge Case States (E = 5)

### 5.1 StopHook Returns `null`

**Cause:** `runtime.stopHook` is undefined OR stopHook threw exception

```typescript
if (!stopResult) return false;  // Allow normal termination
```

| Scenario | Handling |
|----------|----------|
| `stopHook` not configured | Return `null` → terminate normally |
| `stopHook` throws | Catch, log warning, return `null` → terminate |
| `stopHook` returns `undefined` | Treated as `null` → terminate |

**Invariant:**
```
WHEN callStopHook returns null:
  THEN handleStopHookBlock returns false
  AND orchestrator proceeds with normal termination
  AND no crash occurs
```

### 5.2 StopHook Times Out

**Current state:** NO explicit timeout in `callStopHook`. Watcher is expected to handle its own timeout.

**Per-trigger timeouts defined in watcher-agent.ts:**
```typescript
TIMEOUT_BY_TRIGGER: {
  session_init: 60_000,
  prompt_user: 120_000,    // Most critical
  work_item_completed: 90_000,
  bounds_exceeded: 75_000,
  cadence_audit: 60_000,
  agent_error: 75_000,
  scope_collision: 60_000,
  handoff_approval: 90_000,
}
```

**Invariant:**
```
WHEN watcher agent exceeds trigger-specific timeout:
  THEN watcher MUST return fallback action for that trigger
  AND log timeout warning
  AND NOT propagate timeout to orchestrator
```

### 5.3 Malformed StopHookResult

| Malformation | Handling |
|--------------|----------|
| `decision` missing or invalid | Treat as `'allow'` |
| `decision: 'block'` but no `reason` | Treat as `'allow'` |
| `deferredWork` is null/empty | Skip enqueueDeferredWork |
| `deferredWork[i].bounds` invalid | Use orchestrator config defaults |
| `systemMessage` missing | Don't inject system message |
| Extra unknown fields | Ignore (forward compatible) |

**Invariant:**
```
WHEN StopHookResult has malformed fields:
  THEN use defensive defaults (null-coalescing, optional chaining)
  AND never crash
  AND log warning with details
```

### 5.4 WatcherAction Schema Violation

**Cause:** LLM returns invalid JSON or wrong schema

| Violation | Handling |
|-----------|----------|
| Invalid JSON | Parse error → use trigger fallback |
| Missing `watcherAction` | Use trigger fallback |
| Missing `reason` | Use trigger fallback |
| Wrong action for trigger | Use trigger fallback |
| Malformed `workItems` | Skip work items, continue with action |
| Malformed `qualityGate` | Treat as `passed: true` |

**Fallback Actions by Trigger:**
```typescript
getFallbackAction(trigger): WatcherAction {
  switch (trigger) {
    case 'prompt_user': return { watcherAction: 'answer', reason: 'Continue', answer: { text: 'Continue' } };
    case 'cadence_audit': return { watcherAction: 'continue', reason: 'Continue' };
    case 'bounds_exceeded': return { watcherAction: 'realign', reason: 'Wrap up', realign: { systemMessage: 'Wrap up' } };
    case 'agent_error': return { watcherAction: 'continue', reason: 'Continue' };
    case 'work_item_completed': return { watcherAction: 'quality_gate', reason: 'Passed', qualityGate: { passed: true } };
    case 'handoff_approval': return { watcherAction: 'continue', reason: 'Approved' };
    default: return { watcherAction: 'continue', reason: 'Continue' };
  }
}
```

### 5.5 Realign Infinite Loop Prevention

**Cause:** Watcher keeps returning `realign` on bounds_exceeded

**Invariant:**
```
WHEN terminationReason in [max_iterations_exceeded, max_tool_calls_exceeded, max_duration_exceeded]:
  AND decision === 'block' (realign):
    THEN realignCount++
    IF realignCount > MAX_REALIGNS (3):
      THEN force termination (return false)
    ELSE:
      Create new work item with fresh bounds

WHEN deferredWork is added (split/create_work_item):
  THEN realignCount = 0  // Splitting is progress, resets counter
```

---

## Part 6: Invariants Summary

### Invariant 1: Watcher Attachment
```
WHEN asyncMode.enabled === true:
  THEN createWatcherStopHookForSession() MUST be called BEFORE runOrchestrator()
  AND runtime.stopHook MUST be set to the returned stopHook
  AND logging hooks MUST be registered
```

### Invariant 2: Stop Hook Invocation Points
```
StopHook MUST be called at these orchestrator points:
  - goal_state_reached (line 796)
  - user_input_required (line 1549)
  - handoff_requested (line 1581)
  - max_iterations_exceeded (line 547)
  - max_tool_calls_exceeded (line 1872)
  - agent_error/exception (lines 1826, 1849)
  - cadence_audit (line 742 + mid-agent line 1009)
  - user_stopped, rate_limit, circuit_open, timeout, refusal (pass-through)
```

### Invariant 3: Decision Routing
```
FOR each terminationReason:
  MUST route to exactly ONE handler function
  MUST NOT fall through to default without explicit allow
```

### Invariant 4: Action Validation
```
WHEN watcher returns action:
  IF action not in VALID_ACTIONS_BY_TRIGGER[trigger]:
    THEN use getFallbackAction(trigger)
    AND log warning
```

### Invariant 5: Deferred Work Priority
```
WHEN stopResult.deferredWork is non-empty:
  THEN enqueueDeferredWork() MUST be called BEFORE checking decision
  AND if work was added: continue loop (even if decision is 'allow')
```

### Invariant 6: Realign Limit
```
WHEN bounds_exceeded AND decision is 'block':
  THEN realignCount++
  IF realignCount > 3: force terminate
WHEN deferredWork added:
  THEN realignCount = 0
```

### Invariant 7: Error Isolation
```
WHEN stopHook throws:
  THEN catch, log warning, return null
  AND orchestrator continues with normal termination
  AND never crash
```

### Invariant 8: WorkItem Log Lifecycle
```
FOR each WorkItem:
  ON creation: .watcher/{date}/{sessionId}/workitems/{workId}.jsonl created with 'init' entry
  ON each turn: 'message' entry appended
  ON each tool call: 'tool_call' entry appended
  ON watcher decision: 'decision' entry appended
  ON status change: 'status' entry appended
  ON completion: 'metrics' entry appended
```

### Invariant 9: Context Persistence
```
Watcher context MUST be session-scoped:
  - Created ONCE per session (not per invocation)
  - Cached in harness.watcherContexts map
  - Accumulates across watcher invocations
  - Cleaned up in closeSession()
```

### Invariant 10: Hook WorkItem Log Access
```
ALL hooks that write to workitem logs MUST use getOrCreateWorkItemLog():
  - agent_message: calls getOrCreateWorkItemLog (fires BEFORE turn_completed)
  - tool_call_completed: calls getOrCreateWorkItemLog (can fire before turn_completed)
  - files_modified: calls getOrCreateWorkItemLog
  - agent_completed: calls getOrCreateWorkItemLog
  - turn_completed: calls getOrCreateWorkItemLog (original creator)

NEVER use this.workItemLogs.get() directly - the log may not exist yet due to hook ordering
```

### Invariant 11: StopHook WorkId Accuracy
```
WHEN stopHook is invoked for a specific work item:
  THEN ctx.workId MUST be that triggering work item's id
  AND watcher MUST read the correct workitem log for that agent
```

---

## Part 7: Exhaustive State Verification

### 7.1 Termination State Verification Matrix (N=16)

For EACH termination reason, we specify:
- **Trigger**: How to cause this state
- **Code Path**: Exact lines that handle it
- **Watcher Handler**: Which function processes it
- **Verification**: How to prove it works

#### State 1: `goal_state_reached`
| Property | Value |
|----------|-------|
| **Trigger** | Agent returns `{ action: "done", goalStateReached: true }` |
| **Orchestrator Code** | `orchestrator.ts:784-855` - checks `initialWorkCompleted` |
| **StopHook Call** | `orchestrator.ts:797` - `runtime.stopHook(stopContext)` |
| **Watcher Handler** | `watcher-agent.ts:83-84` - routes to `handleGoalReached` |
| **Handler Code** | `watcher-agent.ts:621-725` |
| **Valid Actions** | `quality_gate`, `split`, `create_work_item` |
| **Verification** |
```typescript
// Test: goal_state_reached triggers watcher
it('calls stopHook on goal_state_reached', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'allow' });
  const result = await orchestrator.execute({
    runtime: { stopHook: mockStopHook },
    // ... config that causes agent to return goalStateReached: true
  });
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({ terminationReason: 'goal_state_reached' })
  );
});
```

#### State 2: `user_input_required`
| Property | Value |
|----------|-------|
| **Trigger** | Agent calls `PromptUser` tool |
| **Orchestrator Code** | `orchestrator.ts:1549` - checks `result.needsUserInput` |
| **StopHook Call** | `orchestrator.ts:1549` - `callStopHook(..., 'user_input_required', ...)` |
| **Watcher Handler** | `watcher-agent.ts:74-75` - routes to `handlePromptUser` |
| **Handler Code** | `watcher-agent.ts:262-416` |
| **Valid Actions** | `answer` (ONLY) |
| **Verification** |
```typescript
it('calls stopHook on user_input_required with userPrompt', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({
    decision: 'block',
    reason: 'Use TypeScript'
  });
  // Configure agent to call PromptUser tool
  const result = await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({
      terminationReason: 'user_input_required',
      userPrompt: expect.objectContaining({ question: expect.any(String) })
    })
  );
});
```

#### State 3: `handoff_requested`
| Property | Value |
|----------|-------|
| **Trigger** | Planner agent returns `{ action: "handoff", handoffSpec: { ... } }` |
| **Orchestrator Code** | `orchestrator.ts:1581` - checks `result.needsHandoff` |
| **StopHook Call** | `orchestrator.ts:1581` - `callStopHook(..., 'handoff_requested', ...)` |
| **Watcher Handler** | `watcher-agent.ts:88-89` - routes to `handleHandoffApproval` |
| **Handler Code** | `watcher-agent.ts:862-962` |
| **Valid Actions** | `continue`, `realign` |
| **Verification** |
```typescript
it('calls stopHook on handoff_requested with handoffSpec', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'allow' });
  // Configure planner agent to return handoff
  await orchestrator.execute({ runtime: { stopHook: mockStopHook }, agentType: 'planner', ... });
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({
      terminationReason: 'handoff_requested',
      handoffSpec: expect.any(Object)
    })
  );
});
```

#### State 4: `user_stopped`
| Property | Value |
|----------|-------|
| **Trigger** | User types "stop" command |
| **Orchestrator Code** | `orchestrator.ts:1653` - checks `result.terminationReason === 'user_stopped'` |
| **StopHook Call** | `orchestrator.ts:1653` - `callStopHook(..., 'user_stopped', ...)` |
| **Watcher Handler** | `watcher-agent.ts:90-92` - returns `{ decision: 'allow' }` directly |
| **Handler Code** | N/A (pass-through) |
| **Valid Actions** | None (always allows termination) |
| **Verification** |
```typescript
it('allows termination on user_stopped regardless of watcher', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'block', reason: 'ignored' });
  const result = await orchestrator.execute({
    runtime: {
      stopHook: mockStopHook,
      checkStopRequest: () => true // Simulate user stop
    },
    ...
  });
  expect(result.terminationReason).toBe('user_stopped');
});
```

#### State 5: `max_iterations_exceeded`
| Property | Value |
|----------|-------|
| **Trigger** | `iteration > this.config.maxIterations` |
| **Orchestrator Code** | `orchestrator.ts:547` - iteration limit check |
| **StopHook Call** | `orchestrator.ts:547` - `callStopHook(..., 'max_iterations_exceeded', ...)` |
| **Watcher Handler** | `watcher-agent.ts:76-79` - routes to `handleBoundsExceeded` |
| **Handler Code** | `watcher-agent.ts:418-546` |
| **Valid Actions** | `realign`, `split`, `create_work_item` |
| **Verification** |
```typescript
it('calls stopHook when max_iterations_exceeded', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'allow' });
  await orchestrator.execute({
    config: { maxIterations: 1 }, // Force immediate limit
    runtime: { stopHook: mockStopHook },
    ...
  });
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({ terminationReason: 'max_iterations_exceeded' })
  );
});
```

#### State 6: `max_tool_calls_exceeded`
| Property | Value |
|----------|-------|
| **Trigger** | `totalToolCalls >= this.config.maxToolCalls` |
| **Orchestrator Code** | `orchestrator.ts:1872` - tool call limit check |
| **StopHook Call** | `orchestrator.ts:1872` - `callStopHook(..., 'max_tool_calls_exceeded', ...)` |
| **Watcher Handler** | `watcher-agent.ts:76-79` - routes to `handleBoundsExceeded` |
| **Handler Code** | `watcher-agent.ts:418-546` |
| **Valid Actions** | `realign`, `split`, `create_work_item` |
| **Verification** |
```typescript
it('calls stopHook when max_tool_calls_exceeded', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'allow' });
  await orchestrator.execute({
    config: { maxToolCalls: 1 },
    runtime: { stopHook: mockStopHook },
    // Agent that makes tool calls
    ...
  });
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({ terminationReason: 'max_tool_calls_exceeded' })
  );
});
```

#### State 7: `max_duration_exceeded`
| Property | Value |
|----------|-------|
| **Trigger** | Agent returns `terminationReason: 'bounds:duration'` |
| **Orchestrator Code** | `orchestrator.ts:1783` - maps agent reason to orchestrator reason |
| **StopHook Call** | `orchestrator.ts:1783` - `callStopHook(..., 'max_duration_exceeded', ...)` |
| **Watcher Handler** | `watcher-agent.ts:76-79` - routes to `handleBoundsExceeded` |
| **Handler Code** | `watcher-agent.ts:418-546` |
| **Valid Actions** | `realign`, `split`, `create_work_item` |
| **Verification** |
```typescript
it('calls stopHook when max_duration_exceeded', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'allow' });
  await orchestrator.execute({
    config: { maxDurationMs: 1 }, // 1ms - immediate timeout
    runtime: { stopHook: mockStopHook },
    ...
  });
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({ terminationReason: 'max_duration_exceeded' })
  );
});
```

#### State 8: `rate_limit`
| Property | Value |
|----------|-------|
| **Trigger** | LLM returns rate limit error |
| **Orchestrator Code** | `orchestrator.ts:1804` - checks `result.terminationReason === 'rate_limit'` |
| **StopHook Call** | `orchestrator.ts:1804` - `callStopHook(..., 'rate_limit', ...)` |
| **Watcher Handler** | `watcher-agent.ts:94-97` - returns `{ decision: 'allow' }` directly |
| **Handler Code** | N/A (pass-through) |
| **Valid Actions** | None (always allows termination) |
| **Verification** |
```typescript
it('allows termination on rate_limit', async () => {
  const mockLLM = { chat: vi.fn().mockRejectedValue(new RateLimitError()) };
  const result = await orchestrator.execute({ llm: mockLLM, ... });
  expect(result.terminationReason).toBe('rate_limit');
});
```

#### State 9: `circuit_open`
| Property | Value |
|----------|-------|
| **Trigger** | Circuit breaker trips after repeated failures |
| **Orchestrator Code** | `orchestrator.ts:1804` - checks `result.terminationReason === 'circuit_open'` |
| **StopHook Call** | `orchestrator.ts:1804` - `callStopHook(..., 'circuit_open', ...)` |
| **Watcher Handler** | `watcher-agent.ts:94-97` - returns `{ decision: 'allow' }` directly |
| **Handler Code** | N/A (pass-through) |
| **Valid Actions** | None (always allows termination) |
| **Verification** | Same pattern as rate_limit |

#### State 10: `timeout`
| Property | Value |
|----------|-------|
| **Trigger** | LLM request times out |
| **Orchestrator Code** | `orchestrator.ts:1804` - checks `result.terminationReason === 'timeout'` |
| **StopHook Call** | `orchestrator.ts:1804` - `callStopHook(..., 'timeout', ...)` |
| **Watcher Handler** | `watcher-agent.ts:94-97` - returns `{ decision: 'allow' }` directly |
| **Handler Code** | N/A (pass-through) |
| **Valid Actions** | None (always allows termination) |
| **Verification** | Same pattern as rate_limit |

#### State 11: `no_action`
| Property | Value |
|----------|-------|
| **Trigger** | Agent response missing action field |
| **Orchestrator Code** | `orchestrator.ts:1700` - continuable error handling |
| **StopHook Call** | `orchestrator.ts:1700` - `runtime.stopHook({ terminationReason: 'no_action', ... })` |
| **Watcher Handler** | `watcher-agent.ts:102-105` - returns `{ decision: 'allow' }` directly |
| **Handler Code** | N/A (pass-through, Ralph Loop handles) |
| **Valid Actions** | None (allows termination, Ralph Loop can override) |
| **Verification** |
```typescript
it('calls stopHook on no_action for Ralph Loop opportunity', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'block', reason: 'retry' });
  const mockLLM = { chat: vi.fn().mockResolvedValue({ content: 'no action field' }) };
  await orchestrator.execute({ llm: mockLLM, runtime: { stopHook: mockStopHook }, ... });
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({ terminationReason: 'no_action' })
  );
});
```

#### State 12: `invalid_action`
| Property | Value |
|----------|-------|
| **Trigger** | Agent response has invalid action value |
| **Orchestrator Code** | `orchestrator.ts:1700` - continuable error handling |
| **StopHook Call** | `orchestrator.ts:1700` - `runtime.stopHook({ terminationReason: 'invalid_action', ... })` |
| **Watcher Handler** | `watcher-agent.ts:102-105` - returns `{ decision: 'allow' }` directly |
| **Handler Code** | N/A (pass-through, Ralph Loop handles) |
| **Valid Actions** | None (allows termination, Ralph Loop can override) |
| **Verification** | Same pattern as no_action |

#### State 13: `refusal`
| Property | Value |
|----------|-------|
| **Trigger** | LLM refuses to complete task |
| **Orchestrator Code** | `orchestrator.ts:1630` - checks `result.isRefusal` |
| **StopHook Call** | `orchestrator.ts:1630` - `callStopHook(..., 'refusal', ...)` |
| **Watcher Handler** | `watcher-agent.ts:99-101` - returns `{ decision: 'allow' }` directly |
| **Handler Code** | N/A (pass-through) |
| **Valid Actions** | None (always allows termination) |
| **Verification** |
```typescript
it('allows termination on refusal', async () => {
  const mockLLM = { chat: vi.fn().mockResolvedValue({ content: 'I cannot help with that' }) };
  const result = await orchestrator.execute({ llm: mockLLM, ... });
  expect(result.terminationReason).toBe('refusal');
});
```

#### State 14: `stagnation:tool_repeat`
| Property | Value |
|----------|-------|
| **Trigger** | Agent repeats same tool call multiple times |
| **Orchestrator Code** | `orchestrator.ts:1700` - continuable error handling |
| **StopHook Call** | `orchestrator.ts:1700` - via continuable error path |
| **Watcher Handler** | Falls through to default |
| **Handler Code** | N/A |
| **Valid Actions** | None |
| **Verification** | Verify tool repeat detection in agent tests |

#### State 15: `agent_error` / `exception`
| Property | Value |
|----------|-------|
| **Trigger** | Agent throws exception or returns error |
| **Orchestrator Code** | `orchestrator.ts:1826, 1849` - error handling paths |
| **StopHook Call** | `orchestrator.ts:1826` - `callStopHook(..., 'agent_error', ...)` |
| **Watcher Handler** | `watcher-agent.ts:80-82` - routes to `handleAgentError` |
| **Handler Code** | `watcher-agent.ts:548-619` |
| **Valid Actions** | `realign`, `continue` |
| **Verification** |
```typescript
it('calls stopHook on agent_error', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'allow' });
  const mockAgent = { run: vi.fn().mockRejectedValue(new Error('boom')) };
  await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({ terminationReason: 'agent_error' })
  );
});
```

#### State 16: `cadence_audit`
| Property | Value |
|----------|-------|
| **Trigger** | 60 seconds elapsed OR 30 tool calls since last audit |
| **Orchestrator Code** | `orchestrator.ts:742` (loop level) + `orchestrator.ts:1009` (mid-agent) |
| **StopHook Call** | `orchestrator.ts:742` - `callStopHook(..., 'cadence_audit', ...)` |
| **Watcher Handler** | `watcher-agent.ts:85-86` - routes to `handleCadenceAudit` |
| **Handler Code** | `watcher-agent.ts:727-860` |
| **Valid Actions** | `continue`, `realign`, `split`, `create_work_item` |
| **Verification** |
```typescript
it('calls stopHook for cadence_audit after 60 seconds', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'allow' });
  vi.useFakeTimers();
  const promise = orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  vi.advanceTimersByTime(61000); // 61 seconds
  await promise;
  expect(mockStopHook).toHaveBeenCalledWith(
    expect.objectContaining({ terminationReason: 'cadence_audit' })
  );
});
```

---

### 7.2 Watcher Action Verification Matrix (M=6)

For EACH watcher action, verify the orchestrator handles it correctly.

#### Action 1: `answer`
| Property | Value |
|----------|-------|
| **Valid Triggers** | `prompt_user` ONLY |
| **StopHookResult** | `{ decision: 'block', reason: 'the answer' }` |
| **Orchestrator Handling** | `orchestrator.ts:1356-1368` - injects as user message |
| **Verification** |
```typescript
it('injects answer as user message on user_input_required', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({
    decision: 'block',
    reason: 'Use React',
    systemMessage: 'Watcher answered'
  });
  // ... execute with PromptUser call
  // Verify context has user message "Use React"
  expect(context.messages).toContainEqual(
    expect.objectContaining({ role: 'user', content: 'Use React' })
  );
});
```

#### Action 2: `realign`
| Property | Value |
|----------|-------|
| **Valid Triggers** | `bounds_exceeded`, `agent_error`, `cadence_audit`, `handoff_approval` |
| **StopHookResult** | `{ decision: 'block', reason: 'new direction', systemMessage: 'guidance' }` |
| **Orchestrator Handling** | `orchestrator.ts:1407-1419` - creates new work item |
| **Realign Limit** | Max 3 realigns on bounds_exceeded before force termination |
| **Verification** |
```typescript
it('creates new work item on realign', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({
    decision: 'block',
    reason: 'Focus on tests only'
  });
  await orchestrator.execute({ config: { maxIterations: 1 }, runtime: { stopHook: mockStopHook }, ... });
  // Verify new work item was created and enqueued
  expect(orchestrator.workQueue).toContainEqual(
    expect.objectContaining({ goal: 'Focus on tests only' })
  );
});

it('force terminates after 3 realigns on bounds_exceeded', async () => {
  let realignCount = 0;
  const mockStopHook = vi.fn().mockImplementation(() => {
    realignCount++;
    return { decision: 'block', reason: `realign ${realignCount}` };
  });
  const result = await orchestrator.execute({
    config: { maxIterations: 1 },
    runtime: { stopHook: mockStopHook },
    ...
  });
  expect(realignCount).toBe(4); // Called 4 times, 4th forced termination
  expect(result.success).toBe(false);
});
```

#### Action 3: `split`
| Property | Value |
|----------|-------|
| **Valid Triggers** | `bounds_exceeded`, `goal_state_reached`, `cadence_audit` |
| **StopHookResult** | `{ decision: 'allow', deferredWork: [...] }` |
| **Orchestrator Handling** | `orchestrator.ts:1322-1341` - enqueues deferred work |
| **Verification** |
```typescript
it('enqueues deferred work on split and continues loop', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({
    decision: 'allow',
    deferredWork: [
      { goal: 'Task 1', objective: 'Do task 1', agent: 'standard' },
      { goal: 'Task 2', objective: 'Do task 2', agent: 'standard' },
    ]
  });
  await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  // Verify both work items were enqueued
  expect(orchestrator.workQueue.length).toBeGreaterThanOrEqual(2);
});

it('continues loop even with decision=allow if deferredWork added', async () => {
  const iterations = [];
  const mockStopHook = vi.fn().mockImplementation((ctx) => {
    iterations.push(ctx.iteration);
    if (iterations.length === 1) {
      return { decision: 'allow', deferredWork: [{ goal: 'More work', objective: 'Do it', agent: 'standard' }] };
    }
    return { decision: 'allow' };
  });
  await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(iterations.length).toBeGreaterThan(1); // Loop continued
});
```

#### Action 4: `create_work_item`
| Property | Value |
|----------|-------|
| **Valid Triggers** | `bounds_exceeded`, `goal_state_reached`, `cadence_audit` |
| **StopHookResult** | `{ decision: 'allow', deferredWork: [...] }` |
| **Orchestrator Handling** | Same as `split` |
| **Verification** | Same as `split` |

#### Action 5: `quality_gate`
| Property | Value |
|----------|-------|
| **Valid Triggers** | `goal_state_reached` ONLY |
| **StopHookResult (pass)** | `{ decision: 'allow' }` |
| **StopHookResult (fail)** | `{ decision: 'block', reason: 'Issues: ...' }` |
| **Orchestrator Handling (pass)** | Terminate successfully |
| **Orchestrator Handling (fail)** | Re-enqueue with issues as feedback |
| **Verification** |
```typescript
it('terminates on quality_gate passed', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'allow' });
  const result = await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(result.success).toBe(true);
});

it('re-enqueues on quality_gate failed', async () => {
  const mockStopHook = vi.fn().mockResolvedValueOnce({
    decision: 'block',
    reason: 'Missing tests'
  }).mockResolvedValue({ decision: 'allow' });
  await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(mockStopHook).toHaveBeenCalledTimes(2); // Re-ran after feedback
});
```

#### Action 6: `continue`
| Property | Value |
|----------|-------|
| **Valid Triggers** | `cadence_audit`, `agent_error`, `handoff_approval` |
| **StopHookResult** | `{ decision: 'allow', systemMessage?: 'optional guidance' }` |
| **Orchestrator Handling** | Injects systemMessage if present, then terminates or continues |
| **Verification** |
```typescript
it('injects systemMessage even on decision=allow', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({
    decision: 'allow',
    systemMessage: 'Remember to write tests'
  });
  await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(context.messages).toContainEqual(
    expect.objectContaining({ role: 'system', content: expect.stringContaining('tests') })
  );
});
```

---

### 7.3 N×M Cross-Verification Matrix

Every trigger×action combination must be verified. This table shows the expected behavior and test status.

| Trigger | answer | realign | split | create_work_item | quality_gate | continue |
|---------|--------|---------|-------|------------------|--------------|----------|
| `goal_state_reached` | ❌ FALLBACK | ❌ FALLBACK | ✅ enqueue | ✅ enqueue | ✅ pass/fail | ❌ FALLBACK |
| `user_input_required` | ✅ inject | ❌ FALLBACK | ❌ FALLBACK | ❌ FALLBACK | ❌ FALLBACK | ❌ FALLBACK |
| `handoff_requested` | ❌ FALLBACK | ✅ reject | ❌ FALLBACK | ❌ FALLBACK | ❌ FALLBACK | ✅ approve |
| `user_stopped` | N/A | N/A | N/A | N/A | N/A | N/A |
| `max_iterations_exceeded` | ❌ FALLBACK | ✅ realign (max 3) | ✅ enqueue | ✅ enqueue | ❌ FALLBACK | ❌ FALLBACK |
| `max_tool_calls_exceeded` | ❌ FALLBACK | ✅ realign (max 3) | ✅ enqueue | ✅ enqueue | ❌ FALLBACK | ❌ FALLBACK |
| `max_duration_exceeded` | ❌ FALLBACK | ✅ realign (max 3) | ✅ enqueue | ✅ enqueue | ❌ FALLBACK | ❌ FALLBACK |
| `rate_limit` | N/A | N/A | N/A | N/A | N/A | N/A |
| `circuit_open` | N/A | N/A | N/A | N/A | N/A | N/A |
| `timeout` | N/A | N/A | N/A | N/A | N/A | N/A |
| `no_action` | N/A | N/A | N/A | N/A | N/A | N/A |
| `invalid_action` | N/A | N/A | N/A | N/A | N/A | N/A |
| `refusal` | N/A | N/A | N/A | N/A | N/A | N/A |
| `agent_error` | ❌ FALLBACK | ✅ diagnose | ❌ FALLBACK | ❌ FALLBACK | ❌ FALLBACK | ✅ terminate |
| `cadence_audit` | ❌ FALLBACK | ✅ redirect | ✅ enqueue | ✅ enqueue | ❌ FALLBACK | ✅ guidance |

**Legend:**
- ✅ = Valid, verify with specific test
- ❌ FALLBACK = Invalid, verify fallback is used
- N/A = Pass-through state, watcher doesn't decide

**Fallback Verification Test:**
```typescript
it('uses fallback when watcher returns invalid action for trigger', async () => {
  // Watcher returns 'answer' for bounds_exceeded (invalid)
  const mockStopHook = vi.fn().mockResolvedValue({
    watcherAction: 'answer',
    answer: { text: 'invalid' }
  });
  await orchestrator.execute({
    config: { maxIterations: 1 },
    runtime: { stopHook: mockStopHook },
    ...
  });
  // Should use fallback (realign with wrap-up)
  // Verify fallback behavior occurred
});
```

---

### 7.3.1 WatcherAction → StopHookResult Transformation Verification

Each watcher handler transforms a `WatcherAction` into a `StopHookResult`. This is the critical translation layer.

#### Handler: `handlePromptUser` (watcher-agent.ts:262-416)
```
INPUT: WatcherAction { watcherAction: 'answer', answer: { text: 'Use React', contextAddendum: '...' } }
OUTPUT: StopHookResult {
  decision: 'block',
  reason: 'Use React',
  systemMessage: '[Watcher Decision] ...'
}
```
**Verification:**
```typescript
it('handlePromptUser transforms answer action to block with reason', async () => {
  const action: WatcherAction = {
    watcherAction: 'answer',
    reason: 'Based on project preferences',
    answer: { text: 'Use React', contextAddendum: 'Project uses React throughout' }
  };
  const result = await handlePromptUser(config, ctx);
  expect(result).toEqual({
    decision: 'block',
    reason: 'Use React',
    systemMessage: expect.stringContaining('Based on project preferences')
  });
});
```

#### Handler: `handleBoundsExceeded` (watcher-agent.ts:418-546)
```
INPUT (realign): WatcherAction { watcherAction: 'realign', realign: { systemMessage: 'Focus on tests' } }
OUTPUT: StopHookResult {
  decision: 'block',
  reason: 'Focus on tests',
  systemMessage: '[Watcher Realign] ...'
}

INPUT (split): WatcherAction { watcherAction: 'split', workItems: [...] }
OUTPUT: StopHookResult {
  decision: 'allow',
  deferredWork: [{ goal, objective, agent, ... }]
}
```
**Verification:**
```typescript
it('handleBoundsExceeded transforms realign to block', async () => {
  mockRunAgent.mockResolvedValue({
    watcherAction: 'realign',
    reason: 'Too much scope',
    realign: { systemMessage: 'Focus only on auth module' }
  });
  const result = await handleBoundsExceeded(config, ctx);
  expect(result.decision).toBe('block');
  expect(result.reason).toContain('auth module');
});

it('handleBoundsExceeded transforms split to allow with deferredWork', async () => {
  mockRunAgent.mockResolvedValue({
    watcherAction: 'split',
    reason: 'Breaking into smaller tasks',
    workItems: [
      { goal: 'Task 1', objective: 'Do X', agent: 'standard' },
      { goal: 'Task 2', objective: 'Do Y', agent: 'standard' }
    ]
  });
  const result = await handleBoundsExceeded(config, ctx);
  expect(result.decision).toBe('allow');
  expect(result.deferredWork).toHaveLength(2);
});
```

#### Handler: `handleGoalReached` (watcher-agent.ts:621-725)
```
INPUT (pass): WatcherAction { watcherAction: 'quality_gate', qualityGate: { passed: true } }
OUTPUT: StopHookResult { decision: 'allow' }

INPUT (fail): WatcherAction { watcherAction: 'quality_gate', qualityGate: { passed: false, issues: ['Missing tests'] } }
OUTPUT: StopHookResult {
  decision: 'block',
  reason: 'Quality issues: Missing tests',
  systemMessage: '[Quality Gate Failed] ...'
}
```
**Verification:**
```typescript
it('handleGoalReached returns allow on quality_gate passed', async () => {
  mockRunAgent.mockResolvedValue({
    watcherAction: 'quality_gate',
    reason: 'All checks pass',
    qualityGate: { passed: true }
  });
  const result = await handleGoalReached(config, ctx);
  expect(result.decision).toBe('allow');
});

it('handleGoalReached returns block on quality_gate failed', async () => {
  mockRunAgent.mockResolvedValue({
    watcherAction: 'quality_gate',
    reason: 'Missing coverage',
    qualityGate: { passed: false, issues: ['No tests for auth module'] }
  });
  const result = await handleGoalReached(config, ctx);
  expect(result.decision).toBe('block');
  expect(result.reason).toContain('No tests');
});
```

#### Handler: `handleCadenceAudit` (watcher-agent.ts:727-860)
```
INPUT (continue): WatcherAction { watcherAction: 'continue' }
OUTPUT: StopHookResult { decision: 'allow', systemMessage?: 'optional guidance' }

INPUT (realign): WatcherAction { watcherAction: 'realign', realign: { systemMessage: '...' } }
OUTPUT: StopHookResult { decision: 'block', reason: '...', systemMessage: '...' }

INPUT (split): WatcherAction { watcherAction: 'split', workItems: [...] }
OUTPUT: StopHookResult { decision: 'allow', deferredWork: [...] }
```

#### Handler: `handleAgentError` (watcher-agent.ts:548-619)
```
INPUT (realign): WatcherAction { watcherAction: 'realign', realign: { systemMessage: 'Try different approach' } }
OUTPUT: StopHookResult { decision: 'block', reason: 'Try different approach' }

INPUT (continue): WatcherAction { watcherAction: 'continue' }
OUTPUT: StopHookResult { decision: 'allow' }
```

#### Handler: `handleHandoffApproval` (watcher-agent.ts:862-962)
```
INPUT (approve): WatcherAction { watcherAction: 'continue' }
OUTPUT: StopHookResult { decision: 'allow' }

INPUT (reject): WatcherAction { watcherAction: 'realign', realign: { systemMessage: 'Plan needs more detail' } }
OUTPUT: StopHookResult { decision: 'block', reason: 'Plan needs more detail' }
```

---

### 7.4 Error State Verification (E=5)

#### Error 1: StopHook Returns `null`
```typescript
it('terminates normally when stopHook returns null', async () => {
  const mockStopHook = vi.fn().mockResolvedValue(null);
  const result = await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  // Should not crash, should terminate normally
  expect(result).toBeDefined();
});

it('terminates normally when stopHook is undefined', async () => {
  const result = await orchestrator.execute({ runtime: {}, ... });
  expect(result).toBeDefined();
});
```

#### Error 2: StopHook Throws Exception
```typescript
it('catches stopHook exception and terminates normally', async () => {
  const mockStopHook = vi.fn().mockRejectedValue(new Error('watcher crashed'));
  const result = await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  // Should not crash, should log warning
  expect(result).toBeDefined();
});
```

#### Error 3: Malformed StopHookResult
```typescript
it('treats missing decision as allow', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ reason: 'no decision field' });
  const result = await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(result).toBeDefined(); // Terminates normally
});

it('treats block without reason as allow', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({ decision: 'block' }); // No reason
  const result = await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(result).toBeDefined(); // Terminates normally
});

it('handles invalid deferredWork gracefully', async () => {
  const mockStopHook = vi.fn().mockResolvedValue({
    decision: 'allow',
    deferredWork: 'not an array' // Invalid
  });
  const result = await orchestrator.execute({ runtime: { stopHook: mockStopHook }, ... });
  expect(result).toBeDefined(); // Should not crash
});
```

#### Error 4: WatcherAction Schema Violation
```typescript
it('uses trigger fallback when watcherAction is invalid JSON', async () => {
  // Simulate LLM returning invalid JSON
  const mockRunAgent = vi.fn().mockResolvedValue({ invalid: 'not a WatcherAction' });
  // ... verify fallback is used
});

it('uses trigger fallback when watcherAction is missing', async () => {
  const mockRunAgent = vi.fn().mockResolvedValue({ reason: 'no action field' });
  // ... verify fallback is used
});
```

#### Error 5: Realign Infinite Loop
```typescript
it('force terminates after MAX_REALIGNS (3) on bounds_exceeded', async () => {
  let callCount = 0;
  const mockStopHook = vi.fn().mockImplementation(() => {
    callCount++;
    return { decision: 'block', reason: `attempt ${callCount}` };
  });

  const result = await orchestrator.execute({
    config: { maxIterations: 1 },
    runtime: { stopHook: mockStopHook },
    ...
  });

  // Called 4 times: 3 realigns + 1 forced termination
  expect(callCount).toBe(4);
  expect(result.success).toBe(false);
});

it('resets realignCount when deferredWork is added', async () => {
  let callCount = 0;
  const mockStopHook = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 2) {
      // Second call returns split, should reset counter
      return { decision: 'allow', deferredWork: [{ goal: 'x', objective: 'x', agent: 'standard' }] };
    }
    return { decision: 'block', reason: `attempt ${callCount}` };
  });

  await orchestrator.execute({
    config: { maxIterations: 1 },
    runtime: { stopHook: mockStopHook },
    ...
  });

  // Should be able to realign more than 3 times because counter was reset
  expect(callCount).toBeGreaterThan(4);
});
```

---

### 7.5 Code Path Tracing

For debugging, here are the exact function call sequences for each major path:

#### Path: goal_state_reached → quality_gate(passed)
```
orchestrator.executeInner()
  → line 784: if (initialWorkCompleted && ...)
  → line 797: stopResult = await runtime.stopHook(stopContext)
    → watcher-agent.ts createWatcherStopHook()
      → line 83: case 'goal_state_reached': return handleGoalReached(config, ctx)
        → line 621-725: handleGoalReached()
          → returns { decision: 'allow' }
  → line 820: if (this.workQueue.length > 0) - NO
  → line 827: if (stopResult.decision === 'block') - NO
  → line 846: return orchestratorResult (SUCCESS)
```

#### Path: bounds_exceeded → realign (within limit)
```
orchestrator.executeInner()
  → line 547: if (iteration > this.config.maxIterations)
  → line 547: stopResult = await this.callStopHook(..., 'max_iterations_exceeded', ...)
    → watcher-agent.ts createWatcherStopHook()
      → line 76-79: case 'max_iterations_exceeded': return handleBoundsExceeded(...)
        → returns { decision: 'block', reason: 'Focus on X' }
  → line 1313: handleStopHookBlock(stopResult, ...)
    → line 1384-1405: isBoundsExceeded = true, realignCount++
    → line 1407-1419: create new work item, enqueue
    → returns true
  → line 550: continue (loop continues)
```

#### Path: bounds_exceeded → realign (limit exceeded)
```
orchestrator.executeInner()
  → line 547: stopResult = await this.callStopHook(..., 'max_iterations_exceeded', ...)
  → line 1313: handleStopHookBlock(stopResult, ...)
    → line 1384: realignCount++ (now 4)
    → line 1392: if (this.realignCount > Orchestrator.MAX_REALIGNS)
    → line 1398: return false (FORCE TERMINATION)
  → line 548: if (!handleStopHookBlock...) → terminates
```

---

### 7.6 Runtime Verification Script

Execute after each async run to verify all invariants:

```bash
#!/bin/bash
# verify-async-invariants.sh

SESSION_DIR="$1"
if [ -z "$SESSION_DIR" ]; then
  echo "Usage: $0 <session_dir>"
  echo "Example: $0 .watcher/2026-01-29/tui_1769668553930_tx2h03"
  exit 1
fi

ERRORS=0

echo "=== Verifying Async Mode Invariants ==="
echo "Session: $SESSION_DIR"
echo ""

# Invariant 1: Session directory exists
if [ -d "$SESSION_DIR" ]; then
  echo "✅ Session directory exists"
else
  echo "❌ Session directory missing"
  ERRORS=$((ERRORS + 1))
fi

# Invariant 8: WorkItem log lifecycle
WORKITEMS_DIR="$SESSION_DIR/workitems"
if [ -d "$WORKITEMS_DIR" ]; then
  WORKITEM_COUNT=$(ls -1 "$WORKITEMS_DIR"/*.jsonl 2>/dev/null | wc -l)
  if [ "$WORKITEM_COUNT" -gt 0 ]; then
    echo "✅ WorkItem logs exist ($WORKITEM_COUNT files)"

    # Invariant 10: Check for message/tool_call entries
    for f in "$WORKITEMS_DIR"/*.jsonl; do
      MSG_COUNT=$(grep -c '"type":"message"' "$f" 2>/dev/null || echo 0)
      TOOL_COUNT=$(grep -c '"type":"tool_call"' "$f" 2>/dev/null || echo 0)
      INIT_COUNT=$(grep -c '"type":"init"' "$f" 2>/dev/null || echo 0)

      if [ "$INIT_COUNT" -eq 0 ]; then
        echo "  ❌ $(basename $f): Missing init entry"
        ERRORS=$((ERRORS + 1))
      elif [ "$MSG_COUNT" -eq 0 ] && [ "$TOOL_COUNT" -eq 0 ]; then
        echo "  ⚠️  $(basename $f): No messages or tool calls (may be incomplete)"
      else
        echo "  ✅ $(basename $f): $MSG_COUNT messages, $TOOL_COUNT tool calls"
      fi
    done
  else
    echo "❌ WorkItem logs directory empty"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "❌ WorkItem logs directory missing"
  ERRORS=$((ERRORS + 1))
fi

# Decision log
DECISIONS_LOG="$SESSION_DIR/decisions.jsonl"
if [ -f "$DECISIONS_LOG" ]; then
  DECISION_COUNT=$(wc -l < "$DECISIONS_LOG")
  echo "✅ Decision log exists ($DECISION_COUNT entries)"

  # Check for each trigger type
  for trigger in prompt_user bounds_exceeded goal_state_reached cadence_audit agent_error handoff_approval; do
    COUNT=$(grep -c "\"trigger\":\"$trigger\"" "$DECISIONS_LOG" 2>/dev/null || echo 0)
    if [ "$COUNT" -gt 0 ]; then
      echo "  - $trigger: $COUNT decisions"
    fi
  done
else
  echo "⚠️  Decision log missing (watcher may not have been invoked)"
fi

# Work log
WORK_LOG="$SESSION_DIR/work-log.jsonl"
if [ -f "$WORK_LOG" ]; then
  echo "✅ Work log exists"

  SESSION_START=$(grep -c '"type":"session_start"' "$WORK_LOG" 2>/dev/null || echo 0)
  WORKITEM_CREATED=$(grep -c '"type":"workitem_created"' "$WORK_LOG" 2>/dev/null || echo 0)
  WORKITEM_STATUS=$(grep -c '"type":"workitem_status"' "$WORK_LOG" 2>/dev/null || echo 0)

  if [ "$SESSION_START" -eq 0 ]; then
    echo "  ❌ Missing session_start entry"
    ERRORS=$((ERRORS + 1))
  else
    echo "  ✅ Has session_start"
  fi

  echo "  - workitem_created: $WORKITEM_CREATED"
  echo "  - workitem_status: $WORKITEM_STATUS"
else
  echo "❌ Work log missing"
  ERRORS=$((ERRORS + 1))
fi

# Salience file
SALIENCE="$SESSION_DIR/salience.md"
if [ -f "$SALIENCE" ]; then
  echo "✅ Salience file exists"
else
  echo "❌ Salience file missing"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [ $ERRORS -eq 0 ]; then
  echo "✅ All invariants verified"
  exit 0
else
  echo "❌ $ERRORS invariant violations found"
  exit 1
fi
```

Usage:
```bash
chmod +x verify-async-invariants.sh
./verify-async-invariants.sh .watcher/2026-01-29/tui_1769668553930_tx2h03
```

---

## Part 8: Known Issues & Fixes

### FIXED: createWatcherStopHookForSession never called
- **Location:** harness.ts runOrchestrator
- **Fix:** Auto-create watcher stop hook if not provided when asyncMode enabled

### FIXED: stopHook is undefined
- **Location:** harness.ts runtime object
- **Fix:** Created and cached per session

### FIXED: Hooks not registered
- **Location:** harness.ts
- **Fix:** Registered when watcher stop hook created

### FIXED: Fresh watcher context each call
- **Location:** harness.ts:1887
- **Fix:** Now uses session-scoped cached context

### FIXED: Deferred work enqueued but immediately returned
- **Location:** orchestrator.ts:795, 1665
- **Fix:** Check queue size and continue if work added

### FIXED: handleStopHookBlock ignores deferred work on 'allow'
- **Location:** orchestrator.ts:1320
- **Fix:** Returns true if deferred work was added

### FIXED: Watcher realign action ignored when realign is null
- **Location:** watcher-agent.ts (all handlers)
- **Fix:** Uses action.reason as systemMessage when action.realign is null

### FIXED: Infinite realign loop on bounds exceeded
- **Location:** orchestrator.ts handleStopHookBlock
- **Fix:** Added realignCount limit (MAX_REALIGNS=3)

### FIXED: WorkItem logs empty - agent_message fires before turn_completed
- **Location:** harness.ts createWatcherStopHookForSession hook registration
- **Symptom:** workitems/*.jsonl files only have `init` and `status` entries, no messages/tool calls
- **Root cause:** Hook execution order race condition:
  1. Agent enqueues `agent_message` hook BEFORE `turn_completed`
  2. `turn_completed` handler calls `getOrCreateWorkItemLog()` which populates `this.workItemLogs` map
  3. `agent_message` handler calls `this.workItemLogs.get()` which returns undefined (log not created yet)
  4. Message is silently dropped
- **Fix:** All hooks (`agent_message`, `tool_call_completed`, `files_modified`, `agent_completed`) now call `getOrCreateWorkItemLog()` instead of `.get()`

---

## Appendix A: Type Definitions Reference

### AgentTerminationReason (packages/shared/src/termination.ts)
```typescript
type AgentTerminationReason =
  | 'goal_state_reached'
  | 'user_input_required'
  | 'handoff_requested'
  | 'user_stopped'
  | 'iterations_exhausted'
  | 'bounds:tool_calls'
  | 'bounds:duration'
  | 'rate_limit'
  | 'circuit_open'
  | 'timeout'
  | 'invalid_action'
  | 'no_action'
  | 'stagnation:tool_repeat'
  | 'refusal'
  | 'watcher_stopped'
  | 'exception';
```

### OrchestratorTerminationReason (packages/shared/src/termination.ts)
```typescript
type OrchestratorTerminationReason =
  | 'goal_state_reached'
  | 'user_input_required'
  | 'handoff_requested'
  | 'user_stopped'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'rate_limit'
  | 'circuit_open'
  | 'timeout'
  | 'refusal'
  | 'agent_error'
  | 'no_action'
  | 'invalid_action'
  | 'cadence_audit'
  | 'watcher_stopped';
```

### WatcherTrigger (packages/decision-watcher/src/types.ts)
```typescript
type WatcherTrigger =
  | 'session_init'
  | 'prompt_user'
  | 'bounds_exceeded'
  | 'agent_error'
  | 'work_item_completed'
  | 'scope_collision'
  | 'cadence_audit'
  | 'handoff_approval';
```

### WatcherActionType (packages/decision-watcher/src/types.ts)
```typescript
type WatcherActionType =
  | 'answer'
  | 'realign'
  | 'split'
  | 'create_work_item'
  | 'quality_gate'
  | 'continue';
```

### StopHookResult (packages/agent/src/types.ts)
```typescript
interface StopHookResult {
  decision: 'allow' | 'block';
  reason?: string;
  systemMessage?: string;
  deferredWork?: Array<{
    goal: string;
    objective: string;
    agent: string;
    background: boolean;
    dependencies?: string[];
    targetPaths?: string[];
    bounds?: { maxToolCalls?: number; maxLlmCalls?: number; maxDurationMs?: number };
  }>;
}
```

---

## Appendix B: State Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR LOOP                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │   Execute    │───>│   Check      │───>│   Termination        │  │
│  │   Agent      │    │   Bounds     │    │   Condition?         │  │
│  └──────────────┘    └──────────────┘    └──────────────────────┘  │
│         │                   │                      │                │
│         │                   │                      ▼                │
│         │                   │            ┌──────────────────────┐  │
│         │                   │            │   Call StopHook      │  │
│         │                   │            │   (if attached)      │  │
│         │                   │            └──────────────────────┘  │
│         │                   │                      │                │
│         │                   │     ┌────────────────┼────────────┐  │
│         │                   │     │                │            │  │
│         │                   │     ▼                ▼            ▼  │
│         │                   │  ┌──────┐     ┌──────────┐   ┌─────┐│
│         │                   │  │ null │     │ 'allow'  │   │block││
│         │                   │  └──────┘     └──────────┘   └─────┘│
│         │                   │     │                │            │  │
│         │                   │     │         ┌──────┴──────┐     │  │
│         │                   │     │         │             │     │  │
│         │                   │     │         ▼             ▼     │  │
│         │                   │     │    ┌─────────┐  ┌─────────┐ │  │
│         │                   │     │    │ No      │  │ Has     │ │  │
│         │                   │     │    │ Deferred│  │ Deferred│ │  │
│         │                   │     │    │ Work    │  │ Work    │ │  │
│         │                   │     │    └─────────┘  └─────────┘ │  │
│         │                   │     │         │             │     │  │
│         │                   │     │         ▼             │     │  │
│         │                   │     │    ┌─────────┐        │     │  │
│         │                   │     └───>│TERMINATE│        │     │  │
│         │                   │          └─────────┘        │     │  │
│         │                   │                             │     │  │
│         │                   │               ┌─────────────┘     │  │
│         │                   │               │                   │  │
│         │                   │               ▼                   │  │
│         │                   │         ┌───────────┐             │  │
│         │                   │         │  Enqueue  │             │  │
│         │                   │         │  Deferred │             │  │
│         │                   │         │  Work     │             │  │
│         │                   │         └───────────┘             │  │
│         │                   │               │                   │  │
│         │                   │               │                   │  │
│         │◄──────────────────┴───────────────┴───────────────────┘  │
│         │                                                           │
│  ┌──────┴──────┐                                                   │
│  │  CONTINUE   │                                                   │
│  │  LOOP       │                                                   │
│  └─────────────┘                                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Appendix C: Decision Flow for Each Trigger

### C.1 goal_state_reached
```
Agent says "done"
    │
    ▼
Call stopHook(goal_state_reached)
    │
    ├─► Watcher returns quality_gate(passed=true)
    │       └─► TERMINATE (success)
    │
    ├─► Watcher returns quality_gate(passed=false)
    │       └─► Re-inject issues as user message
    │           └─► Create new work item
    │               └─► CONTINUE
    │
    ├─► Watcher returns split/create_work_item
    │       └─► Enqueue deferred work
    │           └─► CONTINUE
    │
    └─► Watcher returns invalid action
            └─► FALLBACK: quality_gate(passed=true)
                └─► TERMINATE
```

### C.2 bounds_exceeded
```
Iteration/tool/time limit hit
    │
    ▼
Call stopHook(max_*_exceeded)
    │
    ├─► Watcher returns realign
    │       │
    │       ├─► realignCount <= 3
    │       │       └─► Create new work item
    │       │           └─► CONTINUE
    │       │
    │       └─► realignCount > 3
    │               └─► FORCE TERMINATE
    │
    ├─► Watcher returns split/create_work_item
    │       └─► Enqueue deferred work
    │           └─► Reset realignCount
    │               └─► CONTINUE
    │
    └─► Watcher returns invalid action
            └─► FALLBACK: realign("wrap up")
                └─► (follow realign flow)
```

### C.3 user_input_required
```
Agent called PromptUser
    │
    ▼
Call stopHook(user_input_required)
    │
    ├─► Watcher returns answer
    │       └─► Inject answer as user message
    │           └─► Create work item "Continue"
    │               └─► CONTINUE
    │
    └─► Watcher returns invalid action
            └─► FALLBACK: answer("Continue")
                └─► CONTINUE
```

---

*Last updated: 2026-01-29*
*Covers: orchestrator.ts, watcher-agent.ts, harness.ts, termination.ts, types.ts*
