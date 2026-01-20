# State Handling: Minimum Patch Spec v2

## Problem Statement

`AgentResult.terminationReason` is typed as `string`, allowing arbitrary values that bypass compile-time checks. The orchestrator receives these values but has no dispatch logic—everything falls through to generic error handling, losing diagnostic value.

**Current state:**
- Agent emits: `goal_state_reached`, `invalid_action`, `refusal`, `rate_limit`, `circuit_open`, `retries_exhausted`, `bounds:tool_calls`, `bounds:duration`, `no_action`, `stagnation:tool_repeat`, `iterations_exhausted`, `user_input_required`, `handoff_requested`, `exception:*`
- Orchestrator expects: `goal_state_reached`, `max_iterations_exceeded`, `max_tool_calls_exceeded`, `max_duration_exceeded`, `user_input_required`, `handoff_requested`, `agent_error`, `refusal`
- Gap: Agent-specific reasons are not handled; they fall through to `agent_error` via the generic error check

---

## Design Principles

1. **Type the contract** - Union type eliminates string drift
2. **Log, don't surface** - Agent-internal reasons (`stagnation`, `no_action`, `invalid_action`) are logged but mapped to `agent_error` for the orchestrator contract
3. **Surface what callers can act on** - `rate_limit` and `circuit_open` are surfaced because callers may implement retry/backoff
4. **No semantic overloading** - Keep `bounds:tool_calls` and `bounds:duration` distinct; don't collapse into `iterations_exhausted`
5. **Each phase is independently deployable** - No phase depends on a future phase

---

## Phase 1: Type Safety Foundation

**Goal:** Establish compile-time enforcement of termination reasons.

### Changes

#### 1.1 Create shared type (`packages/shared/src/termination.ts`)

```typescript
/**
 * Agent-level termination reasons.
 * These are set by the Agent and consumed by the Orchestrator.
 */
export type AgentTerminationReason =
  // Success states
  | 'goal_state_reached'

  // User interaction
  | 'user_input_required'
  | 'handoff_requested'

  // Bounds exceeded (agent-level)
  | 'iterations_exhausted'
  | 'bounds:tool_calls'
  | 'bounds:duration'

  // Transient errors (retryable by caller)
  | 'rate_limit'
  | 'circuit_open'

  // Semantic errors (agent misbehavior)
  | 'invalid_action'
  | 'no_action'
  | 'stagnation:tool_repeat'
  | 'refusal'

  // Catch-all for unexpected errors
  | 'exception';

/**
 * Orchestrator-level termination reasons.
 * These are the public contract returned to callers.
 */
export type OrchestratorTerminationReason =
  | 'goal_state_reached'
  | 'user_input_required'
  | 'handoff_requested'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'rate_limit'
  | 'circuit_open'
  | 'refusal'
  | 'agent_error';
```

#### 1.2 Update `packages/shared/src/index.ts`

```typescript
export * from './termination.js';
```

#### 1.3 Update `packages/agent/src/types.ts`

```typescript
import type { AgentTerminationReason } from 'shared';

export interface AgentResult {
  // ...existing fields...
  terminationReason: AgentTerminationReason;
  // ...
}
```

#### 1.4 Update `packages/orchestrator/src/orchestrator.ts`

```typescript
import type { OrchestratorTerminationReason } from 'shared';

// Remove local TerminationReason type, use imported one
export interface OrchestratorResult {
  // ...existing fields...
  terminationReason: OrchestratorTerminationReason;
  // ...
}
```

#### 1.5 Fix agent exception handling

Current code builds dynamic strings like `exception:${message}`. Change to fixed `'exception'`:

```typescript
// packages/agent/src/agent.ts (in catch block around line 301)
// Before:
result.terminationReason = `exception:${message}`;

// After:
result.terminationReason = 'exception';
result.error = message; // Error detail goes here, not in terminationReason
```

### Verification

```bash
# Type errors should surface any string assignments that don't match the union
pnpm tsc --noEmit
```

### Rollback

Revert the type imports and restore `string` typing. No runtime behavior changes in this phase.

---

## Phase 2: Orchestrator Dispatch

**Goal:** Add explicit handling for agent termination reasons with proper logging and mapping.

**Depends on:** Phase 1

### Changes

#### 2.1 Add logging for agent-specific termination reasons

In `packages/orchestrator/src/orchestrator.ts`, in the results processing loop (around line 650), add explicit checks **before** the generic error check:

```typescript
// After the handoff check, before the refusal check:

// LOG + MAP: Agent semantic errors
// These indicate agent misbehavior - log for debugging, map to agent_error
const agentSemanticErrors: AgentTerminationReason[] = [
  'invalid_action',
  'no_action',
  'stagnation:tool_repeat',
];

if (agentSemanticErrors.includes(result.terminationReason)) {
  this.log('warning', `Agent semantic error: ${result.terminationReason}`, {
    workId,
    error: result.error,
    terminationReason: result.terminationReason,
  });
  // Fall through to generic error handling below
}

// SURFACE: Transient errors (caller may retry)
if (result.terminationReason === 'rate_limit') {
  this.log('warning', 'Rate limit hit', { workId, rateLimitInfo: result.rateLimitInfo });
  emitGoalNotAchieved('rate_limit', 1);
  await this.notifyStopHook(context, 'agent_error', result.response, iteration, agentType);
  context.addAgentResultContext(result);
  terminalResult = this.createResult({
    success: false,
    response: result.response ?? '',
    error: result.error ?? 'Rate limit exceeded',
    terminationReason: 'rate_limit',
    metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
  });
  continue;
}

if (result.terminationReason === 'circuit_open') {
  this.log('warning', 'Circuit breaker open', { workId, error: result.error });
  emitGoalNotAchieved('circuit_open', 1);
  await this.notifyStopHook(context, 'agent_error', result.response, iteration, agentType);
  context.addAgentResultContext(result);
  terminalResult = this.createResult({
    success: false,
    response: result.response ?? '',
    error: result.error ?? 'Circuit breaker open - service unavailable',
    terminationReason: 'circuit_open',
    metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
  });
  continue;
}
```

#### 2.2 Update bounds termination handling

The orchestrator already handles bounds via `BoundsChecker`. Ensure agent bounds reasons are logged:

```typescript
// In the results loop, add logging for agent bounds
if (result.terminationReason === 'bounds:tool_calls' || result.terminationReason === 'bounds:duration') {
  this.log('info', 'Agent hit internal bounds', {
    workId,
    reason: result.terminationReason,
    isIncomplete: result.isIncomplete,
  });
  // Continue processing - these may have partial results
}
```

### Verification

1. Trigger a rate limit and verify `terminationReason: 'rate_limit'` in result
2. Trigger stagnation and verify log message + `terminationReason: 'agent_error'` in result
3. Existing tests should pass unchanged

### Rollback

Remove the new if-blocks. Behavior reverts to generic error handling (no functional regression).

---

## Phase 3: Remove `retries_exhausted` Indirection

**Goal:** Eliminate redundant termination reason by using the underlying error.

**Depends on:** Phase 1

### Rationale

`retries_exhausted` wraps another error. The wrapper loses information about *what* was retried. The underlying error (`rate_limit`, `circuit_open`, timeout) is more actionable.

### Changes

#### 3.1 Ensure `RetriesExhaustedError` exposes cause

Check `packages/llm/src/resilience.ts`:

```typescript
export class RetriesExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly cause?: Error  // Ensure this exists
  ) {
    super(message);
    this.name = 'RetriesExhaustedError';
  }
}
```

#### 3.2 Update agent error handling

```typescript
// packages/agent/src/agent.ts (in catch block)
} else if (error instanceof RetriesExhaustedError) {
  // Use underlying error's classification
  const cause = error.cause;
  if (cause instanceof RateLimitError) {
    result.terminationReason = 'rate_limit';
    result.rateLimitInfo = cause.info;
  } else if (cause instanceof CircuitOpenError) {
    result.terminationReason = 'circuit_open';
  } else {
    result.terminationReason = 'exception';
  }
  result.error = `Retries exhausted after ${error.attempts} attempts: ${error.message}`;
}
```

#### 3.3 Remove `retries_exhausted` from union type

It's no longer used.

### Verification

1. Trigger retries exhaustion via rate limit → verify `terminationReason: 'rate_limit'`
2. Trigger retries exhaustion via other error → verify `terminationReason: 'exception'`

### Rollback

Restore `retries_exhausted` to union and revert error handling. No behavioral regression.

---

## Phase 4: Sub-Agent Exception Safety

**Goal:** Prevent uncaught exceptions in sub-agent execution from losing context.

**Depends on:** Phase 1

### Problem

In `executeAgentToolCall`, `subAgent.run()` is not wrapped in try-catch. If it throws, the exception propagates but `mergeSubAgentResults` is never called, losing artifacts and file reads.

### Changes

#### 4.1 Wrap sub-agent execution

```typescript
// packages/agent/src/agent.ts in executeAgentToolCall

const subAgent = new Agent(agentConfig, { /* ... */ });

let subResult: AgentResult;
try {
  subResult = await subAgent.run({
    globalContext: mergedContext,
    workItem: subWorkItem,
    cwd,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  this.emit(createEvent('agent_error', {
    agentType: agentConfig.type,
    error: message,
  }, workItem.workId));

  // Create minimal result to preserve merge behavior
  subResult = {
    success: false,
    response: '',
    error: `Sub-agent threw: ${message}`,
    metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
    filesRead: [],
    invalidatedPaths: [],
    toolErrors: [message],
    terminationReason: 'exception',
    needsUserInput: false,
    isRefusal: false,
    localContext: mergedContext,
  };
}

// Merge results regardless of success/failure
this.mergeSubAgentResults(parentLocalContext, subResult);
```

### Verification

1. Create a sub-agent that throws → verify parent agent receives error result, not exception
2. Verify artifacts from sub-agent context are preserved in parent

### Rollback

Remove try-catch. Behavior reverts to exception propagation (existing behavior, not a regression).

---

## Out of Scope (Deferred)

These items from the original spec are deferred:

1. **Parallel work item user prompt aggregation** - No evidence this is a real problem. If two parallel tasks both need user input, that's likely a workflow design issue.

2. **Hook timeout tracking** - Nice to have, but doesn't affect correctness. Can be added independently.

3. **Compaction failure logging** - Already has silent fallback which works. Enhanced logging is polish, not critical path.

4. **Null checks for `extractStructuredAction`** - Need to verify these methods exist and their behavior before speccing changes.

---

## File Change Summary

| Phase | File | Change |
|-------|------|--------|
| 1 | `packages/shared/src/termination.ts` | New file with union types |
| 1 | `packages/shared/src/index.ts` | Export new types |
| 1 | `packages/agent/src/types.ts` | Use `AgentTerminationReason` |
| 1 | `packages/agent/src/agent.ts` | Change `exception:*` to `exception` |
| 1 | `packages/orchestrator/src/orchestrator.ts` | Use `OrchestratorTerminationReason` |
| 2 | `packages/orchestrator/src/orchestrator.ts` | Add dispatch logic |
| 3 | `packages/llm/src/resilience.ts` | Ensure `cause` property exists |
| 3 | `packages/agent/src/agent.ts` | Unwrap `RetriesExhaustedError` |
| 3 | `packages/shared/src/termination.ts` | Remove `retries_exhausted` |
| 4 | `packages/agent/src/agent.ts` | Wrap `subAgent.run()` |

---

## Testing Strategy

Each phase has its own verification steps. Integration test:

```typescript
describe('termination reason contract', () => {
  it('surfaces rate_limit to orchestrator result', async () => {
    // Mock LLM to throw RateLimitError
    // Verify orchestrator result has terminationReason: 'rate_limit'
  });

  it('maps stagnation to agent_error with logging', async () => {
    // Create agent that repeats same tool call
    // Verify orchestrator result has terminationReason: 'agent_error'
    // Verify log contains 'stagnation:tool_repeat'
  });

  it('preserves sub-agent context on exception', async () => {
    // Create sub-agent that throws after reading files
    // Verify parent agent has those files in filesRead
  });
});
```
