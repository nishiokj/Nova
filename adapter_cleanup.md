# Implementation Spec: Refactor adapter.ts to Reduce Code Duplication

## Goal
Reduce spaghetti code in `packages/llm/src/adapter.ts` (2428 lines) by:
1. Extracting rate limit parsing utilities to separate file
2. Removing unnecessary debug logging lines
3. Replacing repeated switch statements with a provider strategy map
4. Consolidating duplicated error handling logic

**End State:** A cleaner, more maintainable adapter with ~400-600 fewer lines and zero behavioral changes.

## Approach

### Design Principles (User Constraints)
- **Be cautious about new abstractions** - don't create new provider classes/interfaces
- Preserve existing provider implementations in `adapter.ts`
- Maintain backward compatibility with public API (`createAdapter()`)
- Keep all provider-specific logic (OpenAI Responses API, Anthropic Messages API, etc.) in `adapter.ts`

### Refactoring Strategy

**1. Extract Rate Limit Utilities**
Move ~150 lines of rate limit parsing to `packages/llm/src/rate-limits.ts`:
- `parseRateLimitHeaders()`
- `classifyRateLimitType()`
- `createRateLimitError()`

**2. Eliminate Switch Statement Duplication**
Replace 4+ identical switch statements with a provider strategy map inside `adapter.ts`:
- Creates a single source of truth for provider routing
- Reduces code duplication without new abstractions
- Easier to add new providers later

**3. Consolidate Duplicated Error Handling**
Extract the rate-limit-wait-and-retry pattern that's duplicated in both `respond()` and `stream()`:
- Creates a reusable helper method within the adapter class
- Applies to both methods identically

**4. Remove Unnecessary Debug Lines**
Clean up verbose debug logging throughout the file:
- Remove redundant logger calls that duplicate information
- Keep critical logging (errors, warnings, important state changes)

## Q&A Decisions

- **Q**: Are you okay with extracting rate limit, unnecessary debug lines, repeated switch statements, duplicated error handling?
  **A**: "I am fine with extracting the rate limit, unnecessary debug lines, repeated switch statements, duplicated error handling"
  **Implication**: Proceed with these specific refactors, but avoid aggressive reorganization or new provider abstractions

- **Q**: Which approach do you prefer? (Aggressive split, Conservative split, Minimal changes)
  **A**: "I want to be cautious about new abstractions"
  **Implication**: Avoid Option A (aggressive split with new provider files). Stay focused on extracting utilities and reducing duplication without introducing new interfaces or class hierarchies.

- **Q**: Breaking change tolerance?
  **A**: N/A (implicit from existing code structure)
  **Implication**: The public API must remain unchanged. Only internal refactoring.

- **Q**: Provider extensibility concerns?
  **A**: User has existing utility modules (`packages/types/src/providers.ts`, `packages/harness-daemon/src/harness/local_providers.ts`)
  **Implication**: Don't create competing abstractions. Work with existing patterns.

## Implementation Steps

1. **[File: packages/llm/src/rate-limits.ts] CREATE** - Extract rate limit utilities
   - Create new file `rate-limits.ts`
   - Move `parseRateLimitHeaders()` from adapter.ts (lines ~150-200)
   - Move `classifyRateLimitType()` from adapter.ts (lines ~250-300)
   - Move `createRateLimitError()` from adapter.ts (lines ~320-380)
   - Import `RateLimitInfo`, `RateLimitType`, `RateLimitError` from `./retry.js`
   - Export all functions
   - Update imports in adapter.ts

2. **[File: packages/llm/src/adapter.ts] UPDATE** - Update imports
   - Add: `import { parseRateLimitHeaders, classifyRateLimitType, createRateLimitError } from './rate-limits.js';`
   - Remove the moved functions from adapter.ts

3. **[File: packages/llm/src/adapter.ts] REFACTOR** - Create provider strategy map
   - After the constructor (~line 400), add:
     ```typescript
     private createProviderHandlers() {
       return {
         respond: {
           openai: this.respondOpenAI.bind(this),
           anthropic: this.respondAnthropic.bind(this),
           'openai-compat': this.respondOpenAICompat.bind(this),
         },
         stream: {
           openai: this.streamOpenAI.bind(this),
           anthropic: this.streamAnthropic.bind(this),
           'openai-compat': this.streamOpenAICompat.bind(this),
         },
       };
     }
     private readonly providerHandlers = this.createProviderHandlers();
     ```
   - In `respond()` method, replace the switch statement (~line 700) with:
     ```typescript
     const handler = this.providerHandlers.respond[resolved.provider];
     if (!handler) throw new Error(`Unsupported provider: ${resolved.provider}`);
     return handler(params, resolved);
     ```
   - In `stream()` method, replace the switch statement (~line 800) with:
     ```typescript
     const handler = this.providerHandlers.stream[resolved.provider];
     if (!handler) throw new Error(`Unsupported provider: ${resolved.provider}`);
     return handler(params, resolved);
     ```
   - In fallback retry blocks (~lines 750 and 850), replace switches similarly

4. **[File: packages/llm/src/adapter.ts] REFACTOR** - Extract rate limit retry helper
   - Add private method `handleRateLimitRetry()` that encapsulates:
     - Check if error is RateLimitError and worth waiting
     - Log warning
     - Wait using `sleep()`
     - Retry once using providerHandlers
   - Replace the duplicated rate-limit-wait-and-retry blocks in both `respond()` and `stream()` with calls to this helper

5. **[File: packages/llm/src/adapter.ts] CLEANUP** - Remove unnecessary debug lines
   - Remove redundant `this.logger.debug()` calls that duplicate already-logged information
   - Specifically look for:
     - Debug calls right before fetch that log the same parameters being sent
     - Debug calls right after fetch that log the full response body
     - Debug calls in `pollForCompletion()` that log every poll iteration
   - Keep: error logs, warnings, and critical state changes
   - Keep: the `resolveRequestConfig` debug log (useful for API key resolution debugging)

6. **[File: packages/llm/src/index.ts] UPDATE** - Export new utilities
   - Add exports for new rate-limit functions:
     ```typescript
     export {
       parseRateLimitHeaders,
       classifyRateLimitType,
       createRateLimitError,
     } from './rate-limits.js';
     ```

## Key Files Reference

- `packages/llm/src/adapter.ts` (2428 lines): Main file to refactor. Contains:
  - LLMRouterAdapter class with provider implementations
  - Rate limit parsing utilities (to be extracted)
  - Duplicated switch statements (to be replaced)
  - Verbose debug logging (to be cleaned up)

- `packages/llm/src/retry.ts`: Contains resilience logic, RateLimitError class, and related types. Import from here for rate-limit extraction.

- `packages/llm/src/index.ts`: Barrel export file. Need to add exports for new utilities.

- `packages/llm/src/adapter.test.ts`: Comprehensive test suite. Tests should continue to pass after refactoring.

- `packages/types/src/providers.ts`: Existing provider registry (don't modify this, just be aware of it).

## Constraints & Gotchas

- **Don't** create new provider classes or interfaces - the user is cautious about new abstractions
- **Don't** change the public API - `createAdapter()` must work exactly as before
- **Don't** modify provider implementations (respondOpenAI, respondAnthropic, etc.) - they're complex and working
- **Must maintain** all existing behavior - this is a refactoring, not a functional change
- **Watch out for**: The `withResilience()` wrapper that wraps provider calls - it needs to still work after switch replacement
- **Watch out for**: The fallback logic that retries with different models - it also has switch statements that need replacement
- **Tests must pass** - Run tests after all changes to verify no behavioral changes

## Artifacts

```typescript
// Rate limit types (from retry.ts)
export type RateLimitType = 'window' | 'quota' | 'billing' | 'unknown';

export interface RateLimitInfo {
  type: RateLimitType;
  retryAfterMs?: number;
  limitType?: string;
  remaining?: number;
  resetAt?: Date;
  message: string;
}

export class RateLimitError extends Error {
  public readonly info: RateLimitInfo;
  public readonly provider: string;
  public readonly model: string;
  public readonly status: number;
  
  isWorthWaiting(maxWaitMs: number = 60000): boolean;
  static isRateLimitError(error: unknown): error is RateLimitError;
}

// Provider types (from types/src/providers.ts)
export type LLMProvider = 'anthropic' | 'openai' | 'openai-compat';

// Current switch pattern (to be replaced):
switch (resolved.provider) {
  case 'openai':
    return this.respondOpenAI(params, resolved);
  case 'anthropic':
    return this.respondAnthropic(params, resolved);
  case 'openai-compat':
    return this.respondOpenAICompat(params, resolved);
  default:
    throw new Error(`Unsupported provider: ${resolved.provider}`);
}
```

## Expected Outcome

- `packages/llm/src/adapter.ts`: Reduced from ~2428 to ~1800-2000 lines
- `packages/llm/src/rate-limits.ts`: New file (~150 lines) with extracted utilities
- No behavioral changes
- All tests pass
- More maintainable code with less duplication
