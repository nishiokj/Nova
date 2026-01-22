# Agent Model Config Cleanup Spec

## Problem Statement

The agent/model configuration system has accumulated naming inconsistencies, duplicated logic, and dead code:

1. **Naming chaos**: `ModelOverride` and `ModelSelection` are the same thing
2. **Duplicated merge logic**: Three separate implementations of `modelSelection + llmParams → LLMRequestConfig`
3. **Incomplete types**: `AgentRuntimeConfig` doesn't declare `getModelSelection` but Agent uses it
4. **Dead code**: `lastRequestConfig`, fallback to `{ model: 'unknown' }`

## Source of Truth

- **TUI** is the source of truth for model selection
- **SessionStore** syncs with TUI and stores `modelSelections: Map<agentType, ModelSelection>`
- **Agent** receives its own config pre-resolved at creation time
- **Agent** uses `getModelSelection` callback ONLY for spawning sub-agents

---

## Changes

### 1. Unify Naming: Keep `ModelSelection`, Delete `ModelOverride`

`ModelOverride` and `ModelSelection` represent the same concept: `{provider, model, reasoning?}`.

| Current | After |
|---------|-------|
| `ModelOverride` (orchestrator.ts:127-132) | DELETE |
| `ModelSelection` | KEEP - canonical name |

**Files:**
- `packages/orchestrator/src/orchestrator.ts`: Delete `ModelOverride` interface, import `ModelSelection` from types
- `packages/harness-daemon/src/harness/session_store.ts`: Change `ModelOverride` → `ModelSelection` in imports and usage
- Update any other files importing `ModelOverride`

---

### 2. Extract Shared `buildLLMRequestConfig()`

Create one merge function, delete the three duplicates.

**New file:** `packages/shared/src/llm_config.ts`

```typescript
import type { LLMRequestConfig } from 'types';
import { getCanonicalProvider, getProviderBaseUrl } from 'types';

export interface ModelSelection {
  provider: string;
  model: string;
  reasoning?: string;
}

export interface LLMParams {
  maxTokens: number;
  temperature: number;
}

/**
 * Build a complete LLMRequestConfig from model selection and operational params.
 * This is the ONLY place this merge should happen.
 */
export function buildLLMRequestConfig(
  modelSelection: ModelSelection,
  llmParams: LLMParams
): LLMRequestConfig {
  const canonicalProvider = getCanonicalProvider(modelSelection.provider);
  const baseUrl = getProviderBaseUrl(modelSelection.provider);

  return {
    provider: canonicalProvider,
    model: modelSelection.model,
    maxTokens: llmParams.maxTokens,
    temperature: llmParams.temperature,
    displayProvider: modelSelection.provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(modelSelection.reasoning ? {
      reasoning: { effort: modelSelection.reasoning as 'low' | 'medium' | 'high' }
    } : {}),
  };
}
```

**Delete duplicates:**

| Location | Lines | Action |
|----------|-------|--------|
| `Orchestrator.buildLlmConfig()` | orchestrator.ts:856-881 | Replace with call to shared function |
| `Orchestrator.resolveCompactionLlmConfig()` | orchestrator.ts:938-963 | Replace with call to shared function |
| `Agent.executeAgentToolCall()` | agent.ts:1329-1353 | Replace with call to shared function |

---

### 3. Fix `AgentRuntimeConfig` Type

**Current (incomplete):**
```typescript
// packages/agent/src/types.ts:340-357
export interface AgentRuntimeConfig {
  llm: LLMAdapter;
  toolRegistry: ToolRegistry;
  emit: EventEmitCallback;
  requestId: string;
  agentRegistry?: AgentRegistry;
  llmConfig?: LLMRequestConfig;  // WRONG: optional
  hooks?: AgentHooks;
  internalHookQueue?: InternalHookQueue;
  // MISSING: getModelSelection
}
```

**After:**
```typescript
export interface AgentRuntimeConfig {
  /** LLM adapter for inference */
  llm: LLMAdapter;
  /** Tool registry for tool execution */
  toolRegistry: ToolRegistry;
  /** Event emit callback */
  emit: EventEmitCallback;
  /** Request ID for correlation */
  requestId: string;
  /** LLM configuration for THIS agent (pre-resolved, required) */
  llmConfig: LLMRequestConfig;
  /** Agent registry for sub-agent execution */
  agentRegistry?: AgentRegistry;
  /** Model selection callback for SUB-AGENTS only */
  getModelSelection?: (agentType: string) => ModelSelection | null;
  /** Optional lifecycle hooks */
  hooks?: AgentHooks;
  /** Optional internal hook queue */
  internalHookQueue?: InternalHookQueue;
}
```

Key changes:
- `llmConfig` is now REQUIRED (not optional)
- `getModelSelection` is declared (was missing)
- Comment clarifies: `llmConfig` is for this agent, `getModelSelection` is for sub-agents

---

### 4. Delete Dead Code

| Item | Location | Action |
|------|----------|--------|
| `lastRequestConfig` field | agent.ts:116 | DELETE |
| `lastRequestConfig` assignments | agent.ts:444, etc | DELETE |
| `lastRequestConfig` in error events | agent.ts (search for usages) | Remove or inline the needed values |
| `{ model: 'unknown' }` fallback | agent.ts:138 | REMOVE - throw error if no llmConfig |

**Agent constructor change:**
```typescript
// Before
this.llmConfig = runtime.llmConfig ?? { model: 'unknown' };

// After
if (!runtime.llmConfig) {
  throw new Error('Agent requires llmConfig - no model configured');
}
this.llmConfig = runtime.llmConfig;
```

---

### 5. Update Exports

**`packages/shared/src/index.ts`:**
```typescript
export { buildLLMRequestConfig, type ModelSelection, type LLMParams } from './llm_config.js';
```

**`packages/agent/src/types.ts`:**
- Import `ModelSelection` from shared (don't redefine locally)
- Or re-export if needed for backwards compat

---

### 6. SessionStore Update

**`packages/harness-daemon/src/harness/session_store.ts`:**

```typescript
// Before
import type { ModelOverride } from 'orchestrator';
private modelSelections = new Map<string, ModelOverride>();

// After
import type { ModelSelection } from 'shared';
private modelSelections = new Map<string, ModelSelection>();
```

Update all method signatures accordingly.

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `packages/shared/src/llm_config.ts` | NEW - shared merge function |
| `packages/shared/src/index.ts` | Export new function and types |
| `packages/agent/src/types.ts` | Fix `AgentRuntimeConfig`, import `ModelSelection` |
| `packages/agent/src/agent.ts` | Delete `lastRequestConfig`, require `llmConfig`, use shared function |
| `packages/orchestrator/src/orchestrator.ts` | Delete `ModelOverride`, delete duplicate merge functions, use shared function |
| `packages/harness-daemon/src/harness/session_store.ts` | `ModelOverride` → `ModelSelection` |

---

## Verification Checklist

After implementation, verify:

```bash
# No ModelOverride references remain
grep -r "ModelOverride" packages/ --include="*.ts" | wc -l  # Should be 0

# No lastRequestConfig references remain
grep -r "lastRequestConfig" packages/ --include="*.ts" | wc -l  # Should be 0

# No duplicate merge logic (only shared function)
grep -r "getCanonicalProvider.*modelSelection" packages/ --include="*.ts"  # Only in llm_config.ts

# No fallback to unknown model
grep -r "model: 'unknown'" packages/ --include="*.ts" | wc -l  # Should be 0

# Types compile
pnpm tsc --noEmit

# Tests pass
pnpm test
```

---

## Data Flow After Cleanup

```
TUI (user selects model)
    ↓
SessionStore.modelSelections: Map<agentType, ModelSelection>
    ↓
Orchestrator creates Agent:
    1. modelSelection = sessionStore.getModelSelection(agentType)
    2. llmParams = agentRegistry.getConfig(agentType).llmParams
    3. llmConfig = buildLLMRequestConfig(modelSelection, llmParams)  ← SHARED FUNCTION
    4. new Agent(config, { llmConfig, getModelSelection, ... })
    ↓
Agent execution:
    - Uses this.llmConfig for its own LLM calls
    - Sub-agent spawn: calls getModelSelection(subAgentType) → buildLLMRequestConfig()
```

One merge function. One naming convention. No dead code.
