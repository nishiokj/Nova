# TUI Error Handling - Minimum Patch Spec V2

Six targeted fixes to address the remaining critical and high-severity issues.

---

## 1. State Machine Re-entrance Guard

**Problem**: `saveAnswerAndAdvance()` can be called twice rapidly, corrupting state.

**Solution**: Add processing flag to prevent re-entrance.

**File**: `store.ts`

**Changes**:

```typescript
// Add to private members (near line 130)
private questionProcessing = false;

// Replace saveAnswerAndAdvance() implementation
saveAnswerAndAdvance(): boolean {
  // Guard against re-entrance
  if (this.questionProcessing || !this.activeQuestion) return false;
  this.questionProcessing = true;

  try {
    // Save the current answer
    const answer = this.getQuestionAnswer();
    this.questionAnswers.set(this.activeQuestion.requestId, answer);

    // Check if there are more questions in the queue
    if (this.questionQueue.length > 0) {
      const nextQuestion = this.questionQueue.shift()!;
      this.activeQuestion = nextQuestion;
      this.questionSelection = [];
      this.questionCursor = 0;
      this.questionInput = nextQuestion.defaultValue || "";
      this.emit();
      return true; // More questions remaining
    }

    return false; // No more questions
  } finally {
    this.questionProcessing = false;
  }
}
```

**Scope**: ~15 lines modified. Prevents double-submit crashes.

---

## 2. Cursor Bounds Guards

**Problem**: Cursor operations on empty lists produce NaN via modulo of zero.

**Solution**: Early return when list is empty.

**File**: `store.ts`

**Changes**:

```typescript
// Update moveThemeCursor (around line 947)
moveThemeCursor(delta: number, total: number): void {
  if (total <= 0) return;  // Guard against empty list
  this.themeCursor = (this.themeCursor + delta + total) % total;
  this.emit();
}

// Update moveModelsCursor (around line 989)
moveModelsCursor(delta: number): void {
  const count = this.modelsList.length;
  if (count <= 0) return;  // Guard against empty list
  this.modelsCursor = (this.modelsCursor + delta + count) % count;
  this.emit();
}

// Update moveSessionsCursor (around line 1040)
moveSessionsCursor(delta: number): void {
  const count = this.sessionsList.length;
  if (count <= 0) return;  // Guard against empty list
  this.sessionsCursor = (this.sessionsCursor + delta + count) % count;
  this.emit();
}

// Update selectQuestionOption (around line 794)
selectQuestionOption(delta: number): void {
  if (!this.activeQuestion?.options) return;
  const count = this.activeQuestion.options.length;
  if (count <= 0) return;  // Guard against empty list
  this.questionCursor = (this.questionCursor + delta + count) % count;
  this.emit();
}
```

**Scope**: ~4 lines added across 4 methods. Prevents NaN cursor corruption.

---

## 3. Response Handler Defensive Access

**Problem**: Chained property access on potentially undefined objects.

**Solution**: Use optional chaining and nullish coalescing throughout.

**File**: `index.tsx` - `handleResponse()`

**Changes**:

```typescript
const handleResponse = (data?: ResponseData) => {
  if (!data) return;

  const metadata = data.metadata ?? {};
  const kind = typeof metadata.kind === 'string' ? metadata.kind : null;
  const content = data.content ?? "";
  const error =
    typeof data.error === 'string'
      ? data.error
      : typeof metadata.error === 'string'
        ? metadata.error
        : "";

  // ... existing kind checks ...

  const requestId = data.request_id ?? undefined;
  const metaLines: string[] = [];
  if (data.duration_ms != null) {
    metaLines.push(`Duration: ${Math.round(data.duration_ms)}ms`);
  }
  // Use optional chaining for tools_used
  if (data.tools_used?.length) {
    metaLines.push(`Tools: ${data.tools_used.join(", ")}`);
  }
  if (error) {
    metaLines.push(`Error: ${error}`);
  }

  // ... rest unchanged ...
};
```

**Scope**: ~5 lines changed. Prevents undefined property access crashes.

---

## 4. Fetch Timeout Wrapper

**Problem**: GraphD fetches can hang indefinitely.

**Solution**: Create a timeout wrapper using AbortController.

**File**: `index.tsx`

**Changes**:

```typescript
// Add helper function near top of file (after imports)
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Update fetchGraphdSessions()
async function fetchGraphdSessions(): Promise<GraphDSession[]> {
  const baseUrl = resolveGraphdUrl();
  const response = await fetchWithTimeout(`${baseUrl}/export?table=sessions`);
  if (!response.ok) {
    throw new Error(`GraphD export failed (${response.status})`);
  }
  const payload = (await response.json()) as { data?: string };
  if (!payload.data) return [];
  return payload.data
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GraphDSession);
}

// Update deleteGraphdSession()
async function deleteGraphdSession(sessionKey: string): Promise<boolean> {
  const baseUrl = resolveGraphdUrl();
  const response = await fetchWithTimeout(
    `${baseUrl}/session/${encodeURIComponent(sessionKey)}`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    return false;
  }
  const payload = (await response.json()) as { deleted?: boolean };
  return payload.deleted === true;
}
```

**Scope**: ~25 lines added. Prevents indefinite hangs on network issues.

---

## 5. Batch Re-entrance Protection

**Problem**: Listeners called during batch can modify store, causing cascading updates.

**Solution**: Track batch depth and defer listener-triggered mutations.

**File**: `store.ts`

**Changes**:

```typescript
// The existing batch() implementation already has batchDepth tracking.
// Add a guard to prevent listener re-entrance during emission:

// Update the batch() method (around line 255)
batch(fn: () => void): void {
  this.batchDepth++;
  try {
    fn();
  } finally {
    this.batchDepth--;
    if (this.batchDepth === 0 && this.batchDirty) {
      this.batchDirty = false;
      // Clone listeners to prevent modification during iteration
      const listeners = [...this.listeners];
      for (const listener of listeners) {
        listener();
      }
    }
  }
}

// Update emit() to be safe during listener execution
private emit(): void {
  if (this.batchDepth > 0) {
    this.batchDirty = true;
    return;
  }
  // Clone listeners to prevent modification during iteration
  const listeners = [...this.listeners];
  for (const listener of listeners) {
    listener();
  }
}
```

**Scope**: ~6 lines changed. Prevents cascading update corruption.

---

## 6. Question Input Length Limit

**Problem**: User can paste unlimited text into question answers.

**Solution**: Cap input at 100KB in the question input handler.

**File**: `store.ts`

**Changes**:

```typescript
// Add constant at top (after MAX_INPUT_LENGTH)
const MAX_QUESTION_INPUT_LENGTH = 100 * 1024; // 100KB

// Update appendQuestionInput (around line 840)
appendQuestionInput(text: string): void {
  // Enforce limit
  const available = MAX_QUESTION_INPUT_LENGTH - this.questionInput.length;
  if (available <= 0) return;
  this.questionInput += text.slice(0, available);
  this.emit();
}

// Update setQuestionInput (around line 832)
setQuestionInput(text: string): void {
  // Enforce limit
  this.questionInput = text.slice(0, MAX_QUESTION_INPUT_LENGTH);
  this.emit();
}
```

**Scope**: ~8 lines added. Prevents memory exhaustion from question input.

---

## Summary

| Fix | Files Changed | Lines Added | Issues Addressed |
|-----|---------------|-------------|------------------|
| 1. Re-entrance guard | store.ts | ~15 | Critical #1 |
| 2. Cursor bounds | store.ts | ~4 | Critical #2 |
| 3. Response safety | index.tsx | ~5 | Critical #3 |
| 4. Fetch timeout | index.tsx | ~25 | High #5 |
| 5. Batch protection | store.ts | ~6 | Medium #14 |
| 6. Question input cap | store.ts | ~8 | Low #21 |
| **Total** | 2 files | ~63 lines | 6 issues |

---

## Implementation Order

1. **Cursor bounds (2)** - Smallest change, immediate safety
2. **Re-entrance guard (1)** - Prevents state corruption
3. **Response safety (3)** - Prevents undefined crashes
4. **Fetch timeout (4)** - Prevents hangs
5. **Batch protection (5)** - Prevents cascading updates
6. **Question input cap (6)** - Matches existing input limits

---

## Not Addressed (Deferred)

These issues require more invasive changes:

| Issue | Reason Deferred |
|-------|-----------------|
| React keys (#4) | Requires HistoryLine type change to include requestId |
| Large paste chunking (#6) | Requires async refactor of paste handler |
| Regex backtracking (#7) | Requires regex rewrite or input sanitization |
| History splice (#8) | Requires data structure change (ring buffer) |
| Subscription leak (#9) | Requires tracking previous session key |
| Auth listener leak (#10) | Requires AbortController integration |

These can be addressed in a follow-up pass.
