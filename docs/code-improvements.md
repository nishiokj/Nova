# Code Improvement Opportunities

High-priority improvements for code slimming, naming standardization, orthogonality, and clarity.

---

## HIGH PRIORITY - Code Slimming

### 1. **Extract 500+ line `executeLoop` into State Machine**
**Location:** `packages/agent/src/agent.ts:200`
**Status:** PENDING - Large architectural refactor

**Problem:** Monolithic method with deep nesting mixing concerns (bounds checking, compaction, LLM calls, action handling).

**Refactor:**
```typescript
// Before: Single 500+ line method
private async executeLoop(...) { ... }

// After: State machine pattern
class AgentLoop {
  private state: LoopState = 'initial';

  private async checkBounds() { /* ... */ }
  private async compactContext() { /* ... */ }
  private async executeIteration() { /* ... */ }
  private async handleActions() { /* ... */ }

  async run() { /* orchestrate states */ }
}
```

### 2. **Extract 300+ line `processToolCalls` into ToolProcessor**
**Location:** `packages/agent/src/agent.ts:1000`
**Status:** PENDING - Large architectural refactor

**Problem:** Handles parallel execution, duplicate detection, hook integration - single responsibility violation.

**Refactor:**
```typescript
class ToolProcessor {
  private duplicateDetector: DuplicateDetector;
  private executor: ParallelToolExecutor;
  private hookIntegration: HookIntegration;

  async process(toolCalls, context, options): Promise<ToolResult> { /* ... */ }
}
```

### 3. **Remove Dead Code: `lastRequestConfig`**
**Status:** DONE

- Deleted `lastRequestConfig` field from Agent
- Removed fallback to `{ model: 'unknown' }`
- Made `llmConfig` required in Agent constructor
- Updated event emission to use `this.llmConfig` directly

---

## MEDIUM PRIORITY - Orthogonality & Extraction

### 4. **Extract Circuit Breaker into Registry Class**
**Status:** DONE

Created `packages/agent/src/circuit-breaker-registry.ts`:
- `CircuitBreakerRegistry` class with singleton pattern
- `getState()`, `reset()`, `resetAll()`, `getStatus()`, `isOpen()` methods
- Backwards-compatible exports: `getProviderCircuitState`, `resetProviderCircuit`, `getCircuitStatus`

### 5. **Extract Bounds Checking to `BoundsChecker`**
**Status:** DONE

Created `packages/orchestrator/src/bounds-checker.ts`:
- `BoundsChecker` class with `check()` method
- `ExecutionLimits`, `ExecutionState`, `BoundsCheckResult` types
- Integrated into Orchestrator constructor

### 6. **Extract Compaction Logic to Strategy Interface**
**Location:** `packages/context/src/context-window.ts:600`
**Status:** PENDING - Requires careful planning

**Problem:** Compaction tightly coupled to ContextWindow, hard to test/swap strategies.

**Refactor:**
```typescript
interface CompactionStrategy {
  compact(params: CompactOptions): Promise<CompactResult>;
}

class LedgerCompactionStrategy implements CompactionStrategy {
  async compact(params: CompactOptions): Promise<CompactResult> { /* ... */ }
}

// Usage: context.compact(new LedgerCompactionStrategy(), options)
```

---

## MEDIUM PRIORITY - Naming Standardization

### 7. **Unify `ModelOverride` → `ModelSelection`**
**Status:** DONE

- Deleted `ModelOverride` interface from orchestrator
- Updated all usages to `ModelSelection` from agent package
- Updated SessionStore, Harness, BridgeGateway imports

### 8. **Consolidate Magic Constants**
**Status:** DONE

Created `packages/agent/src/constants.ts`:
- `TOOL_LIMITS` namespaced object with `MAX_IDENTICAL_CALLS`, `MAX_OUTPUT_LENGTH`, `MAX_FILE_READ_OUTPUT_LENGTH`
- `getMaxOutputLength()` helper function
- `REFUSAL_PATTERNS` array and `isRefusal()` helper function

---

## LOW PRIORITY - Clarity & Type Safety

### 9. **Fix Incomplete Type: `AgentRuntimeConfig`**
**Status:** DONE

Updated `packages/agent/src/types.ts`:
- Made `llmConfig` required (not optional)
- Added `getModelSelection?: (agentType: string) => ModelSelectionInfo | null`
- Added `ModelSelectionInfo` interface

### 10. **Create Consolidated `buildLLMRequestConfig`**
**Status:** DONE

Created `packages/shared/src/llm_config.ts`:
- Single `buildLLMRequestConfig()` function
- Replaced 3 duplicate implementations (Orchestrator x2, Agent x1)
- Exported from `packages/shared/src/index.ts`

---

## Impact Summary

| Priority | Items | Status |
|----------|-------|--------|
| HIGH #1 | Extract executeLoop | PENDING |
| HIGH #2 | Extract processToolCalls | PENDING |
| HIGH #3 | Remove lastRequestConfig | DONE |
| MEDIUM #4 | CircuitBreakerRegistry | DONE |
| MEDIUM #5 | BoundsChecker | DONE |
| MEDIUM #6 | CompactionStrategy | PENDING |
| MEDIUM #7 | ModelOverride → ModelSelection | DONE |
| MEDIUM #8 | Consolidate constants | DONE |
| LOW #9 | Fix AgentRuntimeConfig | DONE |
| LOW #10 | buildLLMRequestConfig | DONE |

**Completed:** 7/10 items
**Remaining:** 3 large architectural refactors (#1, #2, #6)

---

## Files Created/Modified

**New Files:**
- `packages/agent/src/circuit-breaker-registry.ts`
- `packages/agent/src/constants.ts`
- `packages/orchestrator/src/bounds-checker.ts`
- `packages/shared/src/llm_config.ts`

**Modified Files:**
- `packages/agent/src/agent.ts` - Removed dead code, uses new modules
- `packages/agent/src/types.ts` - Fixed AgentRuntimeConfig
- `packages/agent/src/index.ts` - Updated exports
- `packages/orchestrator/src/orchestrator.ts` - Uses shared buildLLMRequestConfig, BoundsChecker
- `packages/orchestrator/src/index.ts` - Updated exports
- `packages/shared/src/index.ts` - Exports buildLLMRequestConfig
- `packages/harness-daemon/src/harness/*.ts` - ModelSelection imports

---

## Remaining Work

The three pending items (#1, #2, #6) are substantial refactors:

1. **executeLoop State Machine** (~500 lines) - Would require:
   - New `AgentLoop` class
   - State machine with clear transitions
   - Extracted methods for each concern
   - Careful handling of context mutations

2. **ToolProcessor** (~300 lines) - Would require:
   - New `ToolProcessor` class
   - `DuplicateDetector` sub-component
   - `ParallelToolExecutor` sub-component
   - Hook integration abstraction

3. **CompactionStrategy** - Would require:
   - Strategy interface
   - `MechanicalCompactionStrategy`
   - `LedgerCompactionStrategy`
   - Updates to ContextWindow API

These should be approached incrementally with careful testing.
