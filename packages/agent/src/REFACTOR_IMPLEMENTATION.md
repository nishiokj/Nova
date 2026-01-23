# agent.ts Refactor Implementation

## Status: Phase 1 Complete ✅

Completed: 2026-01-23

---

## Overview

Refactored `executeLoop` to eliminate duplication and improve readability by extracting helper functions and consolidating state handling into a single switch statement.

---

## Phase 1: Extracted Helper Functions

### 1.1 `checkBounds()` (lines 144-168)

Consolidates tool call and duration bounds checking into a single function.

```typescript
private checkBounds(
  metrics: AgentMetrics,
  workItem: WorkItem,
  elapsedMs: number
): 'bounds:tool_calls' | 'bounds:duration' | null
```

**Responsibilities:**
- Checks if `metrics.toolCallsMade >= workItem.bounds.maxToolCalls`
- Checks if `elapsedMs >= workItem.bounds.maxDurationMs`
- Emits `agent_bounds_hit` event when a bound is hit
- Returns termination reason or `null` if no bound hit

**Before:** 21 lines of inline code duplicated in executeLoop
**After:** Single function call with clear return value

---

### 1.2 `compactIfNeeded()` (lines 173-204)

Consolidates context compaction logic including the `localReadFiles` rebuild.

```typescript
private async compactIfNeeded(
  localContext: ContextWindow,
  localReadFiles: Set<string>,
  workItem: WorkItem
): Promise<void>
```

**Responsibilities:**
- Checks `localContext.isNearFull()`
- Attempts LLM-assisted compaction via `compactWithLedger()`
- Falls back to basic `compact()` on failure
- Rebuilds `localReadFiles` from compacted context (key improvement)
- Emits `context_threshold` hook event

**Before:** 29 lines of inline code with `localReadFiles.clear()` + rebuild separate from compaction
**After:** Single async call that handles everything internally

---

### 1.3 `buildIterationRequest()` (lines 209-249)

Consolidates LLM request building into a single function.

```typescript
private buildIterationRequest(
  workItem: WorkItem,
  globalContext: ContextWindow,
  localContext: ContextWindow,
  cwd: string,
  iteration: number,
  maxIterations: number
): {
  messages: Array<Record<string, unknown>>;
  tools: ToolDefinition[] | undefined;
  toolChoice: 'none' | 'auto' | undefined;
}
```

**Responsibilities:**
- Calls `buildSystemPromptComponents()`
- Gathers and filters allowed tools via `filterAllowedTools()`
- Handles last-iteration logic (withholds tools, injects synthesis instruction)
- Calls `buildMessages()` with all components
- Returns ready-to-use request parameters

**Before:** 19 lines of inline code with multiple intermediate variables
**After:** Single function call returning destructured result

---

### 1.4 `handleHandoff()` (lines 254-271)

Eliminates duplicate handoff handling code.

```typescript
private handleHandoff(
  structuredOutput: Record<string, unknown> | null,
  result: AgentResult
): 'return' | 'continue' | null
```

**Responsibilities:**
- Extracts `handoffSpec` from structured output
- Sets `result.needsHandoff`, `result.handoffSpec`, `result.terminationReason`
- Returns loop control directive

**Before:** 15 lines duplicated at lines 740-754 AND 780-795
**After:** Single function, single call site

---

### 1.5 `resolveAction()` (lines 276-341)

New unified function combining all action resolution logic.

```typescript
private resolveAction(
  action: AgentAction | null,
  structuredOutput: Record<string, unknown> | null,
  responseText: string | undefined,
  content: string,
  result: AgentResult
): 'done' | 'handoff' | 'user_input' | 'continue' | 'no_action'
```

**Responsibilities:**
- Checks `awaitingUserInput` from structured output
- Checks if `PromptUser` already set `needsUserInput`
- Handles `action === 'done'` with goal state validation and refusal check
- Handles `action === 'handoff'`
- Handles `action === 'continue'`
- Returns `'no_action'` for unrecognized cases
- Sets result fields as side effects: `terminationReason`, `success`, `response`, `needsUserInput`, `userPrompt`, `isRefusal`, `error`

**Before:** 100+ lines of duplicate if/else chains inside and outside `toolCalls.length > 0` block
**After:** Single function call + switch statement

---

## Deleted Code

### Removed Methods

1. **`handleAwaitingUserInput()`** - Logic moved into `resolveAction()`
2. **`handleCompletionAction()`** - Logic moved into `resolveAction()`

### Removed Inline Code

1. **`emitTurnCompleted` lambda** - Unused; `finalizeIteration()` handles this
2. **Duplicate state handling** - Consolidated into single switch

---

## New executeLoop Structure

```typescript
for (let iteration = 0; iteration < maxIterations; iteration++) {
  profiler.instant(...);

  // 1. Pre-checks
  if (this.hooks?.shouldStop?.()) {
    result.terminationReason = 'user_stopped';
    break;
  }
  const boundHit = this.checkBounds(metrics, workItem, elapsedMs);
  if (boundHit) {
    result.terminationReason = boundHit;
    break;
  }

  // 2. Context management
  await this.compactIfNeeded(localContext, localReadFiles, workItem);

  // 3. Build + execute LLM call
  const { messages, tools, toolChoice } = this.buildIterationRequest(...);
  const { response, buffer } = await this.streamWithResilience(...);

  // 4. Parse response (unchanged)
  const content = response.content ?? '';
  const toolCalls = response.toolCalls ?? [];
  const structuredOutput = this.parseStructuredOutput(content);
  // ... artifact extraction, reasoning, etc.

  // 5. Process tools (if any)
  if (toolCalls.length > 0) {
    await this.processToolCalls(...);
    if (result.terminationReason) {
      this.finalizeIteration(...);
      return;
    }
  }

  // 6. Handle action (ONE switch)
  const resolved = this.resolveAction(action, structuredOutput, responseText, content, result);

  switch (resolved) {
    case 'done':
    case 'user_input':
      this.finalizeIteration(...);
      if (result.terminationReason === 'invalid_action') return;
      return;

    case 'handoff': {
      const handoffResult = this.handleHandoff(structuredOutput, result);
      this.finalizeIteration(...);
      if (handoffResult === 'return') return;
      continue;
    }

    case 'continue':
      this.finalizeIteration(...);
      continue;

    case 'no_action': {
      // Handle implicit continue for tool calls or output schema
      if (toolCalls.length > 0 || (this.config.outputSchema && !action)) {
        this.finalizeIteration(...);
        continue;
      }
      // Terminate
      result.terminationReason = 'no_action';
      result.error = '...';
      this.finalizeIteration(...);
      break;
    }
  }
}
```

---

## Metrics

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| `executeLoop` lines | 454 | 329 | -125 (27%) |
| Duplicate handoff code | 30 | 0 | -30 (100%) |
| Duplicate state handling | 100+ | 0 | -100+ (100%) |
| Total `agent.ts` lines | 2027 | 2051 | +24 |
| Helper methods added | 0 | 5 | +5 |
| Dead methods removed | 0 | 2 | -2 |

**Note:** Total lines increased slightly because helpers add clarity and reusability. The key improvement is that `executeLoop` is now readable with clear separation of concerns.

---

## Test Results

```
bun test packages/agent/src/agent.test.ts

✓ Agent > returns response when structured output action is done
✓ Agent > halts on repeated identical tool calls without progress

2 pass, 0 fail
```

---

## Remaining Work (Phase 2+)

### Phase 2: Further Loop Restructuring (Optional)
- Extract artifact extraction into helper
- Extract response parsing into helper
- Extract TUI emission logic into helper

### Phase 3: Sub-agent Callbacks (Separate PR)
- Add `SubAgentCallbacks` interface
- Move explorer validation to callback registration
- Enable per-agent-type post-processing hooks

---

## Files Modified

- `packages/agent/src/agent.ts` - Main refactoring
- `packages/agent/src/REFACTOR_SPEC.md` - Updated with actual results
- `packages/agent/src/REFACTOR_IMPLEMENTATION.md` - This file (created)
