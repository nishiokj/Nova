# Termination Checker Refactor

## Summary

The state machine logic for checking termination conditions has been extracted from the main execution loop into a dedicated method. This makes the code significantly more readable and easier to maintain.

## What Changed

### Before

The `executeInner()` method contained **~300 lines** of inline termination condition checks:
- User input needed
- Handoff requested  
- Refusal
- User stopped
- Continuable errors (no_action, invalid_action, stagnation)
- Agent bounds exceeded
- Rate limit / circuit open
- Exception
- Hard error
- Max tool calls exceeded

This made the main execution loop very difficult to follow.

### After

**New Method:** `checkTerminationConditions()`

This dedicated method:
- Encapsulates all termination condition logic
- Returns a structured `TerminationCheckResult` object
- Makes the state machine flow explicit with section comments

**New Type:** `TerminationCheckResult`

```typescript
type TerminationCheckResult = {
  terminal: OrchestratorResult | null;  // Terminal result, or null if continue
  shouldContinue: boolean;              // Whether execution should continue
  newItem?: WorkItem;                   // New work item (for stop hook blocking)
};
```

**Simplified Main Loop:**

The main execution loop now has just ~30 lines of termination handling:

```typescript
// Check terminal conditions (first terminal condition wins)
if (!terminalResult) {
  const checkResult = await this.checkTerminationConditions({ /* ... */ });

  if (checkResult.terminal) {
    terminalResult = checkResult.terminal;
    continue;
  }

  if (checkResult.shouldContinue) {
    // Handle interruption or stop hook blocking
    if (checkResult.newItem) {
      this.enqueue(checkResult.newItem);
      // Reset state...
    }
    inProgress.delete(workId);
    continue;
  }
}
```

## Benefits

1. **Readability:** The main execution loop is now ~300 lines shorter and much easier to follow
2. **Testability:** Termination logic can be tested independently from the orchestrator
3. **Maintainability:** Adding new termination conditions requires editing one clear method
4. **Discoverability:** Section headers like `// TERMINAL: User input needed` make it easy to find specific conditions

## Section Headers Added

The `checkTerminationConditions()` method uses clear section headers:

```typescript
// ============================================================
// TERMINAL: User input needed (via PromptUser tool)
// ============================================================

// ============================================================
// TERMINAL: Handoff requested
// ============================================================

// ============================================================
// TERMINAL: Refusal
// ============================================================

// ============================================================
// TERMINAL: User stopped (explicit "stop" from user)
// ============================================================

// ============================================================
// CONTINUABLE ERRORS: no_action, invalid_action, stagnation
// These are recoverable issues where Ralph Loop can retry with hints
// ============================================================

// ============================================================
// AGENT BOUNDS EXCEEDED: Map agent-level bounds to orchestrator-level
// ============================================================

// ============================================================
// TERMINAL: rate_limit, circuit_open - transient errors that must stop
// ============================================================

// ============================================================
// TERMINAL: exception - agent caught an unexpected error
// ============================================================

// ============================================================
// TERMINAL: Hard error (catch-all for error + !success cases)
// ============================================================

// ============================================================
// BOUND CHECK: Total tool calls
// ============================================================
```

## Additional Improvements

1. **Extracted `emitGoalNotAchieved()` method:** Previously a local closure, now a proper class method for reuse across the class.

## Files Changed

- `packages/orchestrator/src/orchestrator.ts`
  - Added `TerminationCheckResult` type (line ~131)
  - Added `emitGoalNotAchieved()` method (line ~963)
  - Added `checkTerminationConditions()` method (line ~1075)
  - Simplified termination handling in `executeInner()` (line ~633)

## Verification

- ✅ TypeScript compilation passes
- ✅ No lint errors
- ✅ No runtime behavior changes - this is a pure refactor
