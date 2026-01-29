# Memory Injector - Bugs Found

## Summary

| Test Suite | Pass | Fail | Total |
|------------|------|------|-------|
| memory-injector/injector.test.ts | 27 | 4 | 31 |
| agent/memory-integration.test.ts | 14 | 2 | 16 |
| **Total** | **41** | **6** | **47** |

---

## CRITICAL BUGS (Crashes in Production)

### BUG #1: Null/Undefined Content Crashes Injector
**File**: `packages/memory-injector/src/injector.ts:57`
**Severity**: CRITICAL - Crashes on null/undefined content
**Status**: CONFIRMED (3 test failures)

```typescript
// Current code
const itemTokens = Math.ceil(item.content.length / 4);  // CRASHES if content is null
```

**Root Cause**: `p.preference` and `d.decision` can be null/undefined from the API, but code assumes they're always strings.

**Test Output**:
```
TypeError: null is not an object (evaluating 'item.content.length')
TypeError: undefined is not an object (evaluating 'item.content.length')
```

**Fix**: Filter out null/undefined content before processing:
```typescript
const items: ScoredItem[] = [
  ...prefsResult.preferences
    .filter(p => typeof p.preference === 'string' && p.preference.trim())  // ADD THIS
    .map(p => ({
      content: p.preference,
      score: p.rank ?? 0,
    })),
  // ... same for decisions
].sort((a, b) => b.score - a.score);
```

---

## HIGH SEVERITY BUGS (Incorrect Behavior)

### BUG #2: File Content Leaks Into Memory Query
**File**: `packages/agent/src/agent.ts:1084`
**Severity**: HIGH - Privacy/Security Issue
**Status**: CONFIRMED (1 test failure)

```typescript
// buildMemoryQuery uses getItemsForLLM() which converts file_content to user messages
const items = globalContext.getItemsForLLM();
const userMessages = items
  .filter(item => item.type === 'message' && (item as { role?: string }).role === 'user')
```

**Root Cause**: `getItemsForLLM()` converts `file_content` items to `{ type: 'message', role: 'user' }`. These get included in the memory query.

**Impact**: Sensitive file contents (like .env files, credentials, API keys) are sent to the memory search API.

**Test Output**:
```
Expected to not contain: "[File:"
Received: "[File: /path/to/file.ts]\n```typescript\nexport function secret() { return \"API_KEY\"; }\n```"
```

**Fix**: Filter by original item type, not the LLM-formatted type:
```typescript
// Option 1: Use _items directly (internal access)
const userMessages = globalContext._items
  .filter(item => item.type === 'message' && item.role === 'user')
  .slice(-3);

// Option 2: Add a dedicated method to ContextWindow
// getOriginalUserMessages(): MessageItem[]
```

---

### BUG #3: Artifact Content Leaks Into Memory Query
**File**: `packages/agent/src/agent.ts:1084`
**Severity**: HIGH - Privacy/Security Issue
**Status**: CONFIRMED (1 test failure)

**Root Cause**: Same as #2 - `getItemsForLLM()` batches artifacts into a user message at the end.

**Impact**: Artifact data (function signatures, API routes, constants) is sent to memory search.

**Test Output**:
```
Expected to not contain: "API_KEY"
Received: "[DISCOVERED ARTIFACTS: 1]\n[const] /secret.env\nAPI_KEY=secret123"
```

---

### BUG #4: Empty Content Items Pollute Output
**File**: `packages/memory-injector/src/injector.ts:37-45`
**Severity**: MEDIUM - Malformed Output
**Status**: CONFIRMED (1 test failure)

**Root Cause**: Items with empty/whitespace-only content are included in output.

**Output**:
```
## Relevant Memory




```

**Fix**: Filter empty content:
```typescript
.filter(p => typeof p.preference === 'string' && p.preference.trim())
```

---

## MEDIUM SEVERITY BUGS (Potential Issues)

### BUG #5: Token Estimation is Wildly Wrong for Non-ASCII
**File**: `packages/memory-injector/src/injector.ts:57`
**Severity**: HIGH - Silent context overflow
**Status**: DOCUMENTED (behavior test passes, but incorrect by design)

```typescript
const itemTokens = Math.ceil(item.content.length / 4);  // Wrong for CJK, emoji, code
```

**Impact**:
- Chinese text: 26 chars → estimated 7 tokens, actual ~26-50 tokens (4-7x underestimate)
- Emoji: 10 emojis → estimated 5 tokens, actual ~10-20 tokens
- Code with generics: Special chars split into many tokens

**Result**: Context window can silently overflow by 2-7x the limit.

---

### BUG #6: First Item Too Large = All Data Lost
**File**: `packages/memory-injector/src/injector.ts:58`
**Severity**: MEDIUM - Silent data loss
**Status**: DOCUMENTED (passes but problematic design)

```typescript
if (tokens + itemTokens > maxTokens) break;  // Skips ALL remaining items
```

**Impact**: If the highest-ranked item exceeds `maxTokens`, the loop breaks immediately and never checks subsequent smaller items that would fit.

**Example**:
- Item 1: 5000 chars (1250 tokens) - too big → **break**
- Item 2: 100 chars (25 tokens) - **never checked!**
- Result: null (even though item 2 would fit)

**Fix**: Continue to next item instead of breaking:
```typescript
if (tokens + itemTokens > maxTokens) continue;  // Try next item
```

---

### BUG #7: No Deduplication Between Preferences and Decisions
**File**: `packages/memory-injector/src/injector.ts:37-46`
**Severity**: LOW - Wastes tokens
**Status**: DOCUMENTED (test passes showing duplicate)

**Root Cause**: Same content can appear in both preferences and decisions. Both are included.

---

### BUG #8: Silent Error Swallowing
**File**: `packages/memory-injector/src/injector.ts:32-33`
**Severity**: MEDIUM - Impossible to debug
**Status**: DOCUMENTED

```typescript
client.preferences.search(...).catch(() => ({ preferences: [] }))
```

**Impact**:
- Network failures look identical to "no relevant memories"
- Database timeouts are invisible
- Production debugging is impossible

**Fix**: Log before returning fallback:
```typescript
.catch(err => {
  console.warn('[memory-injector] preferences search failed:', err.message);
  return { preferences: [] };
})
```

---

### BUG #9: Empty Query Sent to API
**File**: `packages/memory-injector/src/injector.ts:31-34` + `packages/agent/src/agent.ts:1075-1095`
**Severity**: LOW - Wasted API calls
**Status**: DOCUMENTED

**Root Cause**:
1. `buildMemoryQuery` can return empty string when no objective and no user messages
2. `inject()` doesn't validate query before sending

**Fix**: Early return on empty query:
```typescript
async inject({ query, maxTokens }: InjectParams): Promise<string | null> {
  if (!query.trim()) return null;  // ADD THIS
  // ...
}
```

---

## Test Files

### packages/memory-injector/src/injector.test.ts
Tests the core injector logic:
- Null/undefined content handling (3 failures)
- Empty query handling
- API response shape mismatches
- Score sorting with NaN/Infinity
- Token estimation issues
- Output format issues (1 failure)
- Duplicate content

### packages/agent/src/memory-integration.test.ts
Tests the Agent integration:
- Empty query generation
- Message filtering issues (2 failures)
- Query truncation issues
- Type coercion issues
- Error handling

---

## Recommended Priority

1. **CRITICAL**: Fix null/undefined content crash (BUG #1)
2. **HIGH**: Fix file/artifact content leaking to memory query (BUG #2, #3)
3. **MEDIUM**: Filter empty content (BUG #4)
4. **MEDIUM**: Add error logging (BUG #8)
5. **LOW**: Improve token estimation, deduplication, empty query handling
