# Refactor adapter.ts: Stateless Adapter + Provider Modules

## Problem Statement

`adapter.ts` (2248 lines) has three fundamental issues:

1. **Duplicated code**: Provider implementations exist in both `adapter.ts` and `providers/*.ts`
2. **Misplaced concerns**: Retry, circuit breaker, and fallback logic belong at the agent/orchestrator level, not the adapter
3. **Broken concurrency**: Circuit breaker uses shared mutable state with no synchronization, causing race conditions

### Current Architecture (Broken)
```
Agent
  ↓
Adapter (circuit breaker, retry, fallback, rate-limit-wait) ← stateful, races
  ↓
Provider APIs
```

### Target Architecture
```
Agent/Orchestrator (retry, fallback, circuit breaker)
  ↓
Adapter (stateless: resolve config → delegate to provider → return/throw)
  ↓
Provider Modules (format request → HTTP → parse response)
  ↓
Provider APIs
```

---

## Critical Bugs to Fix

### Bug 1: Circuit Breaker is Globally Shared
```typescript
// adapter.ts:176 - ONE circuit state for ALL providers
private circuitState: CircuitBreakerState;

// adapter.ts:341-342 - circuitKey is only used for error messages!
circuitState: this.circuitState,        // Same object for all calls
circuitKey: `${provider}:${model}`,     // Does NOT partition state
```
**Impact**: OpenAI failures trip the circuit for Anthropic.

### Bug 2: Circuit Breaker Has Race Conditions
```typescript
// retry.ts:203-204 - non-atomic read-modify-write
state.lastFailure = Date.now();
state.failures++;  // Lost updates under concurrency
```
**Impact**: Failure counts can be lost; circuit may not trip when it should.

### Bug 3: PartialStreamError Only in OpenAI-Compat
| Stream Method | Has PartialStreamError |
|---------------|------------------------|
| `streamOpenAICompat` (adapter.ts) | ✅ Yes (lines 2167-2199) |
| `streamOpenAI` (adapter.ts) | ❌ No |
| `streamAnthropic` (adapter.ts) | ❌ No |
| All provider modules | ❌ No |

**Impact**: Mid-stream failures lose partial content for OpenAI and Anthropic.

### Bug 4: Type Duplication with Subtle Differences
```typescript
// adapter.ts:167
reasoning?: LLMRequestConfig['reasoning'];

// providers/types.ts:30
reasoning?: { effort?: string };
```
**Impact**: Type mismatches possible when passing between modules.

---

## Refactoring Plan

### Phase 1: Delete Resilience Logic from Adapter

**Rationale**: The adapter lacks context to make good retry decisions. The agent knows if a request is critical, if fallback is acceptable, etc.

**Delete from adapter.ts:**
- `circuitState` field and all circuit breaker usage
- `resilienceConfig` field
- `withResilience()` method
- Rate-limit wait-and-retry logic in `respond()` and `stream()`
- Fallback logic in `respond()` and `stream()`
- `fallbackConfig` field and `updateFallback()` method

**Keep in adapter.ts:**
- `resolveRequestConfig()` - stateless config resolution
- `ProviderKeyService` integration - stateless key lookup
- `updateApiKey()` / `hasApiKey()` - these update the key cache, not resilience state
- `PartialStreamError` class - useful for callers

**Move to agent/orchestrator (separate task):**
- Circuit breaker with proper per-provider state and synchronization
- Retry with backoff
- Fallback model selection
- Rate limit handling decisions

### Phase 2: Consolidate Types

**File:** `packages/llm/src/providers/types.ts`

1. Import `LLMRequestConfig` from `types` package
2. Fix `ResolvedRequestConfig.reasoning` to use `LLMRequestConfig['reasoning']`
3. Delete the duplicate `ResolvedRequestConfig` from adapter.ts
4. Delete `parseApiError` from types.ts (use the one in response_schemas.ts)

```typescript
// providers/types.ts - updated
import type { LLMRequestConfig } from 'types';

export interface ResolvedRequestConfig {
  provider: LLMProvider;
  displayProvider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: LLMRequestConfig['reasoning'];  // Use the canonical type
}
```

### Phase 3: Create Provider Registry

**File:** `packages/llm/src/providers/registry.ts` (~20 lines)

```typescript
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { LLMProviderAdapter } from './types.js';

// Providers are stateless - use singletons, not factories
const PROVIDERS: Record<string, LLMProviderAdapter> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  'openai-compat': new OpenAICompatProvider(),
};

export function getProvider(name: string): LLMProviderAdapter {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unsupported provider: ${name}`);
  return provider;
}
```

### Phase 4: Add PartialStreamError to All Providers

**Files:** `providers/openai.ts`, `providers/anthropic.ts`, `providers/openai-compat.ts`

Wrap the streaming loop in each provider:

```typescript
// Pattern for all stream methods
async *streamXxx(context, params): AsyncGenerator<string, LLMResponse> {
  // ... setup ...

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // ... process chunks, yield deltas ...
    }
  } catch (streamError) {
    // Preserve partial work
    const cause = streamError instanceof Error ? streamError : new Error(String(streamError));
    throw new PartialStreamError(
      'Stream interrupted',
      cause,
      fullContent,
      partialToolCalls
    );
  } finally {
    reader.releaseLock();
  }

  return { content: fullContent, ... };
}
```

**Note:** `PartialStreamError` should be exported from a shared location (keep in adapter.ts or move to types.ts).

### Phase 5: Simplify adapter.ts

**Target:** ~200-250 lines (down from 2248)

**New structure:**
```typescript
// adapter.ts - simplified

import { getProvider } from './providers/registry.js';
import type { ResolvedRequestConfig, ProviderContext } from './providers/types.js';

export class LLMRouterAdapter implements LLMAdapter {
  private apiKeys: Partial<Record<LLMProvider, string>>;
  private baseUrls: Partial<Record<LLMProvider, string>>;
  private logger: AdapterLogger;
  private providerKeyService?: ProviderKeyService;

  constructor(config: LLMClientConfig = {}, logger?: AdapterLogger, providerKeyService?: ProviderKeyService) {
    this.apiKeys = config.apiKeys ?? {};
    this.baseUrls = config.baseUrls ?? {};
    this.logger = logger ?? consoleLogger;
    this.providerKeyService = providerKeyService;
  }

  // Key management (stateless lookups + cache updates)
  updateApiKey(provider: LLMProvider, apiKey: string): void { ... }
  hasApiKey(provider: LLMProvider): boolean { ... }
  setProviderKeyService(service: ProviderKeyService): void { ... }

  // Config resolution (stateless)
  private resolveRequestConfig(llm: LLMRequestConfig): ResolvedRequestConfig { ... }

  // Simple delegation - no retry, no fallback, no circuit breaker
  async respond(params: RespondParams): Promise<LLMResponse> {
    const resolved = this.resolveRequestConfig(params.llm);
    const provider = getProvider(resolved.provider);
    const context: ProviderContext = {
      config: resolved,
      logger: this.logger,
      startTime: Date.now(),
    };
    return provider.respond(context, params);
  }

  async *stream(params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const resolved = this.resolveRequestConfig(params.llm);
    const provider = getProvider(resolved.provider);
    const context: ProviderContext = {
      config: resolved,
      logger: this.logger,
      startTime: Date.now(),
    };
    return yield* provider.stream(context, params);
  }
}
```

### Phase 6: Delete Dead Code

**From adapter.ts - delete entirely:**
- `registerModel()` - no-op method
- `resetCircuitBreaker()` - no longer needed
- `updateFallback()` - no longer needed
- `withResilience()` - moved to orchestrator
- `respondOpenAI()`, `respondAnthropic()`, `respondOpenAICompat()` - in providers
- `streamOpenAI()`, `streamAnthropic()`, `streamOpenAICompat()` - in providers
- `formatAnthropicTools()`, `formatAnthropicMessages()` - in providers
- `formatOpenAITools()`, `formatOpenAICompatTools()` - in providers
- `formatOpenAICompatMessages()` - in providers
- `normalizeInput()`, `normalizeOpenAICompatContent()` - in providers
- `parseOutputText()`, `parseToolCalls()` - in providers
- `pollForCompletion()` - in providers
- `isReasoningModel()`, `supportsSamplingParams()`, `supportsPromptCacheRetention()` - in providers
- `buildSchemaInstruction()` - in providers
- `DEFAULT_PROVIDER_BASE_URLS` - move to resolveRequestConfig or delete if unused

**From providers/types.ts:**
- `parseApiError()` function - use from response_schemas.js directly

---

## Files Changed Summary

| File | Action | Lines Before | Lines After |
|------|--------|--------------|-------------|
| `adapter.ts` | Simplify | 2248 | ~200 |
| `providers/registry.ts` | Create | 0 | ~20 |
| `providers/types.ts` | Fix types, delete parseApiError | 89 | ~75 |
| `providers/openai.ts` | Add PartialStreamError | 758 | ~780 |
| `providers/anthropic.ts` | Add PartialStreamError | 335 | ~355 |
| `providers/openai-compat.ts` | Already has it, verify | 629 | ~630 |
| `index.ts` | Update exports | 62 | ~65 |

**Net reduction:** ~1800 lines from adapter.ts

---

## Out of Scope (Future Work)

These are important but separate tasks:

1. **Implement resilience at orchestrator level**
   - Circuit breaker with per-provider partitioning
   - Proper synchronization (mutex or immutable state)
   - Retry with exponential backoff
   - Fallback model selection

2. **Delete retry.ts circuit breaker code** (after orchestrator has its own)

3. **Rate limit coordination across agents** (if multiple agents share quotas)

---

## Verification

1. **Build:** `pnpm --filter llm build` - must compile
2. **Tests:** `pnpm --filter llm test` - existing tests must pass
3. **Integration:** Manual test with harness
   - Normal request succeeds
   - 429 error surfaces to agent (no automatic retry)
   - Stream interruption returns PartialStreamError with content
4. **Grep for dead code:** Ensure no orphaned imports/exports

---

## Migration Notes

**Breaking changes for orchestrator/agent:**
- Adapter no longer retries automatically
- Adapter no longer handles fallback
- Adapter no longer has circuit breaker
- `RateLimitError` will bubble up instead of being waited on

**Agent must be updated to:**
- Catch errors and decide whether to retry
- Implement its own fallback logic
- Optionally implement circuit breaker at orchestrator level

If agent changes are not ready, the adapter refactor can be done in two phases:
1. Phase A: Consolidate to providers, keep resilience logic temporarily
2. Phase B: Delete resilience logic after agent is updated
