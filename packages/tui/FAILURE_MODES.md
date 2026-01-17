# TUI Failure Modes Analysis

This document catalogs all identified crash points and failure modes in the TUI package, ordered from critical to least critical.

---

## Fixed Issues (ERROR_HANDLING_SPEC.md - V1)

The following 7 issues were addressed via structural error handling:

1. **Connection retry with exponential backoff** - Connection state machine in `bridge_client.ts`
2. **Bridge event validation at boundary** - `validateBridgeEvent()` function in `bridge_client.ts`
3. **Streaming text cap (5MB)** - `MAX_STREAMING_BYTES` limit in `store.ts`
4. **Auto-reconnect on connection drop** - `scheduleReconnect()` in `bridge_client.ts`
5. **Streaming throttle race condition** - Fixed via connection state management
6. **Double cleanup guard** - `cleanupCalled` flag in `index.tsx`
7. **SIGHUP handler** - Added `process.on('SIGHUP')` in `index.tsx`

---

## Attempted Fixes (ERROR_HANDLING_SPEC_V2.md)

The following 6 issues had fixes attempted. Verify these are working correctly:

### 1. State Machine Re-entrance Crashes ✓

**File**: `store.ts` - `saveAnswerAndAdvance()`
**Trigger**: User rapidly presses Enter twice during question flow
**Impact**: State corruption, undefined question access, crash

**Applied Fix**: Added `questionProcessing` flag with try/finally guard.

```typescript
private questionProcessing = false;

saveAnswerAndAdvance(): boolean {
  if (this.questionProcessing || !this.activeQuestion) return false;
  this.questionProcessing = true;
  try {
    // ... logic
  } finally {
    this.questionProcessing = false;
  }
}
```

---

### 2. Cursor Overflow on Empty Lists ✓

**File**: `store.ts` - `moveThemeCursor()`
**Trigger**: List loaded async, user presses key before ready
**Impact**: NaN cursor position, corrupts rendering

**Applied Fix**: Early return when `total <= 0`.

```typescript
moveThemeCursor(delta: number, total: number): void {
  if (total <= 0) return;  // Guard against empty list
  this.themeCursor = (this.themeCursor + delta + total) % total;
  this.emit();
}
```

**Note**: `moveModelsCursor()` and `moveSessionsCursor()` already had guards.

---

### 3. Response Handler Chained Property Access ✓

**File**: `index.tsx` - `handleResponse()`
**Trigger**: Invalid metadata object from bridge
**Impact**: Property access on undefined, crash

**Applied Fix**: Added optional chaining for `tools_used` array access.

```typescript
if (data.tools_used?.length) {
  metaLines.push(`Tools: ${data.tools_used.join(", ")}`);
}
```

---

### 4. GraphD Fetch Has No Timeout ✓

**File**: `index.tsx` - `fetchGraphdSessions()`, `deleteGraphdSession()`
**Trigger**: GraphD server hangs or network is slow
**Impact**: App blocks on fetch indefinitely

**Applied Fix**: Added `fetchWithTimeout()` helper with AbortController.

```typescript
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
```

---

### 5. Store Batch Cascading Updates ✓

**File**: `store.ts` - `batch()` and `emit()`
**Trigger**: Batch calls listener which modifies store
**Impact**: Multiple renders, inconsistent state

**Applied Fix**: Clone listeners array before iteration to prevent modification during execution.

```typescript
private emit(): void {
  if (this.batchDepth > 0) {
    this.batchDirty = true;
    return;
  }
  const listeners = [...this.listeners];  // Clone to prevent modification
  for (const listener of listeners) {
    listener();
  }
}
```

---

### 6. Question Input No Length Limit ✓

**File**: `store.ts` - `appendQuestionInput()`, `setQuestionInput()`
**Trigger**: User pastes 1MB into question answer
**Impact**: Render timeout, message queue overflow

**Applied Fix**: Enforced `MAX_INPUT_LENGTH` (100KB) limit.

```typescript
appendQuestionInput(text: string): void {
  const available = MAX_INPUT_LENGTH - this.questionInput.length;
  if (available <= 0) return;
  this.questionInput += text.slice(0, available);
  this.emit();
}
```

---

## Remaining Issues - CRITICAL

### 7. React Key Changes on History Reorder

**File**: `index.tsx`
**Trigger**: History compacted or reordered
**Impact**: React reconciliation issues, component state loss

```typescript
{visibleHistoryLines.map((line, index) => (
  <Box key={`hist-${index}`}>  // Key changes if list reordered
```

**Fix**: Use message ID as key: `key={line.requestId ?? `hist-${index}`}`

---

## Remaining Issues - HIGH (Hangs and Freezes)

### 8. Large Paste Processed Synchronously

**File**: `useBracketedPaste.ts`
**Trigger**: User pastes file > 10MB
**Impact**: App freezes while processing

```typescript
if (pasteBuffer.length > 10 * 1024 * 1024) {
  onPaste(partialText);  // Entire 10MB processed in event handler
}
```

**Fix**: Yield to event loop with setTimeout between chunks.

---

### 9. Regex Catastrophic Backtracking

**File**: `index.tsx` - `parseTextSegments()`
**Trigger**: Message with pathological pattern like `***...***` (1000 asterisks)
**Impact**: Component render never completes

```typescript
// Patterns like /\*\*[^*]+\*\*/g can catastrophically backtrack
```

**Fix**: Memoize parseTextSegments, add input length limit.

---

### 10. History Splice Operation Blocking

**File**: `store.ts` - `addMessage()`
**Trigger**: After 500+ messages, splice removes 100+ items at once
**Impact**: UI freezes during O(n) splice

```typescript
this.history.splice(0, this.history.length - this.maxHistory);
```

**Fix**: Use array rotation or lazy deletion.

---

## Remaining Issues - MEDIUM (Silent Failures)

### 11. Session Channel Subscription Leak

**File**: `bridge_client.ts` - `handleBusEvent()`
**Trigger**: Session key changes multiple times rapidly
**Impact**: Memory leak, old subscriptions never cleaned

```typescript
if (data.session_key) {
  this.subscribe(`session/${data.session_key}`);  // Old channel still subscribed
}
```

**Fix**: Track old keys, unsubscribe in cleanup.

---

### 12. sendAuthCommand Timeout Listener Leak

**File**: `bridge_client.ts` - `sendAuthCommand()`
**Trigger**: Network timeout before response arrives
**Impact**: Memory leak, event listener never removed if response arrives after timeout

**Fix**: Use AbortController or bidirectional cleanup.

---

### 13. FileCache Refresh Errors Swallowed

**File**: `index.tsx`
**Trigger**: File system read errors, permission denied
**Impact**: Autocomplete stops working silently

```typescript
setInterval(() => {
  fileCache.refreshIfNeeded().catch(() => {});  // Error swallowed
});
```

**Fix**: Log errors, notify user if autocomplete unavailable.

---

### 14. Logger mkdir/write Failures

**File**: `logger.ts`
**Trigger**: No write permission, disk full
**Impact**: Logs lost without notification

**Fix**: Log to stderr if file logging fails, buffer and retry.

---

### 15. GraphD Delete Silent Failure

**File**: `index.tsx` - `deleteGraphdSession()`
**Trigger**: GraphD returns 500, session already deleted
**Impact**: User thinks delete succeeded

**Fix**: Return detailed error object, parse response body.

---

## Remaining Issues - MEDIUM (State Corruption)

### 16. Question Queue Validation Missing

**File**: `store.ts` - `setQuestionQueue()`
**Trigger**: Empty array or array with undefined elements
**Impact**: Accessing undefined options on next question

**Fix**: Validate each question has required fields.

---

### 17. Model Selection with Stale List

**File**: `store.ts` - `selectModel()`
**Trigger**: User selects model while list refreshes
**Impact**: Wrong model selected or undefined

**Fix**: Re-validate cursor position on every selection.

---

## Remaining Issues - LOW (Resource Leaks)

### 18. Listeners Set Never Cleaned

**File**: `store.ts`
**Trigger**: React StrictMode or rapid component remounts
**Impact**: Event listeners accumulate

**Fix**: Add duplicate subscription detection, WeakMap tracking.

---

### 19. InputBuffer Bulk Insert Array Copies

**File**: `buffer.ts` - `insertBulkText()`
**Trigger**: Paste 10MB of text
**Impact**: Multiple intermediate arrays created

```typescript
[...before, ...chars, ...after]  // Creates O(n) copies
```

**Fix**: Use Buffer API or manual array copy loop.

---

### 20. File Cache Symlink Traversal

**File**: `file_cache.ts`
**Trigger**: Symlink loop or symlink to system directory
**Impact**: Infinite loop or system directory indexed

**Fix**: Track inodes, detect loops, skip symlinks.

---

## Remaining Issues - LOW (Signal/Shutdown)

### 21. Session Close Timeout Too Short

**File**: `index.tsx`
**Trigger**: Slow network
**Impact**: Session marked "active" forever

```typescript
setTimeout(() => {
  client.close();
}, 50);  // 50ms too short
```

**Fix**: Increase to 500ms, use Promise.race for timeout.

---

## Remaining Issues - LOW (Input Validation)

### 22. Slash Command Argument Sanitization

**File**: `index.tsx`
**Trigger**: Path traversal in command arguments
**Impact**: Potential information leak

**Fix**: Sanitize arguments, whitelist commands.

---

### 23. UTF-8 Decoding Incomplete Sequences

**File**: `useBracketedPaste.ts`
**Trigger**: Large paste splits multibyte UTF-8 at buffer boundary
**Impact**: Garbled text inserted

**Fix**: Use TextDecoder with streaming mode.

---

## Remaining Issues - LOW (UI/UX Degradation)

### 24. Terminal Size Zero Handling

**File**: `index.tsx`
**Trigger**: Terminal size unavailable
**Impact**: Division errors or broken layout

**Fix**: Enforce strict minimum (80x24), abort if terminal too small.

---

### 25. useEffect Store Dependency

**File**: `index.tsx`
**Trigger**: Terminal resizes rapidly
**Impact**: Effect re-runs more than needed

**Fix**: Extract invalidation to separate effect.

---

### 26. Voice State Interval Cleanup

**File**: `index.tsx`
**Trigger**: App unmounts while recording
**Impact**: Interval continues, setState on unmounted component

**Fix**: Wrap in null check, clear in stopVoiceRecording.

---

### 27. Backpressure on stdin During Paste

**File**: `useBracketedPaste.ts`
**Trigger**: User pastes rapidly then switches modes
**Impact**: Buffer grows, stdin stalls

**Fix**: Use `stdin.pause()` during paste, implement proper buffering.

---

### 28. File Cache Permission Errors Ignored

**File**: `file_cache.ts`
**Trigger**: File with no read permissions
**Impact**: Incomplete file list

**Fix**: Log errors, count successfully scanned vs failed.

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| V1 Structural Fixes | 7 | ✓ Fixed |
| V2 Targeted Fixes | 6 | ✓ Attempted |
| Remaining CRITICAL | 1 | React keys |
| Remaining HIGH | 3 | Paste sync, regex, history splice |
| Remaining MEDIUM-Silent | 5 | Subscription leaks, logger, swallowed errors |
| Remaining MEDIUM-State | 2 | Queue validation, stale list |
| Remaining LOW-Resource | 3 | Listener leaks, array copies, symlinks |
| Remaining LOW-Signal | 1 | Short timeout |
| Remaining LOW-Input | 2 | Sanitization, UTF-8 |
| Remaining LOW-UI | 5 | Terminal size, effect deps, backpressure |
| **TOTAL** | **35** | 13 fixed, 22 remaining |

---

## Recommended Fix Order (Remaining Issues)

1. **Critical #7**: React keys for history reconciliation
2. **High #8-10**: Paste chunking, regex safety, history management
3. **Medium #11-17**: Subscription cleanup, validation, error handling
4. **Low #18-28**: Resource cleanup, input validation, UI polish
