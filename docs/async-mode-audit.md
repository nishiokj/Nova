# Async Mode Audit

**Date**: 2026-01-27
**Scope**: Bridge gateway, Telegram connector, watcher agent, orchestrator, harness

---

## Critical Issues

### 1. Async process crash leaves orphaned state

**Location**: `bridge_gateway.ts:1758-1785`

`handleAsyncStart` calls `this.harness.run()` and `this.streamRunEvents()`, then immediately sends a success response. If the run crashes mid-execution:

- `state.activeRequestId` remains set indefinitely (no cleanup)
- `decisionDatabases` and `watcherEngines` maps are never freed (only cleaned in `closeSession`)
- Salience files and decision log files on disk persist indefinitely
- Client has no way to know the run failed

**Fix**: Track async run in `ConnectionState`. Clean up `activeRequestId` when `streamRunEvents` completes or errors. Emit `async_complete`/`async_error` to the run channel on termination.

---

### 2. No async state in ConnectionState

**Location**: `bridge_gateway.ts:88-96`

```typescript
interface ConnectionState {
  sessionKey: string | null;
  lastSessionKey: string | null;
  workingDir: string | null;
  activeRequestId: string | null;  // ← no "asyncMode" flag
  planMode: boolean;
  ralphLoop: RalphLoopInfo | null;
}
```

No field distinguishes async from sync requests. Consequences:
- No prevention of concurrent async runs in the same session
- No way to route incoming messages correctly during async execution
- Compare to `ralphLoop` which has its own state tracking

**Fix**: Add `asyncRun: AsyncRunInfo | null` to `ConnectionState`.

---

### 3. No duplicate-async prevention (TUI or Telegram)

**Location**: `tui/index.tsx:2848-2871`, `telegram/index.ts:211-268`

Unlike Ralph Loop which checks `store.isRalphActive()` (line 2809), the `/async` handler has zero state guards. Sending `/async` twice creates two overlapping background runs.

**Fix**: Guard in gateway (single source of truth). Reject `async_start` if `state.asyncRun` is already set.

---

### 4. Unsafe `as` cast on watcher structured output

**Location**: `harness.ts:1759`

```typescript
const structured = result.structuredOutput as (WatcherAction & Record<string, unknown>) | undefined;
```

No runtime validation. Malformed LLM output passes through with missing `watcherAction`, causing undefined behavior in watcher-agent switch statements.

**Fix**: Runtime check that `structured` is an object with a string `watcherAction` field before using it.

---

## High Severity

### 5. TUI has no async result handling

`tui/index.tsx:2848-2871` sends `async_start` but never subscribes to progress or completion events. Compare to Ralph Loop which handles `ralph_iteration` (line 915) and `ralph_loop_complete` (line 1278).

### 6. Fire-and-forget hook execution

`orchestrator.ts:297` uses `void (async () => { ... })()`. If a hook handler throws outside its internal try-catch, the rejection is silently swallowed.

### 7. Memory leak: watcher engines and decision databases

`harness.ts:575-576` only cleans these maps in `closeSession()`. Async runs that complete never trigger cleanup. Long-lived sessions accumulate stale engines.

### 8. Watcher inherits full ToolRegistry

`harness.ts:1732-1740` gives the watcher the same `this.toolRegistry` with no `allowedTools` filter. If `dangerousMode` is globally set, the watcher inherits it.

---

## Medium Severity

### 9. Unknown termination reasons silently allowed

`watcher-agent.ts:57` returns `{ decision: 'allow' }` for any unknown `terminationReason`. New reasons added without updating the watcher will bypass review.

### 10. Callback error handling missing

`watcher-agent.ts:137, 248` — `onCreateWorkItems` and `onDecision` are called without try-catch. A throwing callback breaks the promise chain.

### 11. Silent decision log write failures

`watcher-agent.ts:242-246` silently catches append failures. No retry, no warning, no metric.

### 12. Watcher agent context unbounded

`harness.ts:1743` creates a 200K context window without compaction. Multiple tool calls in a single watcher invocation can grow without bound.

### 13. Disconnect doesn't cancel async execution

`bridge_gateway.ts:132-141` cleans up session state but doesn't cancel in-flight async runs.

### 14. Telegram timeout not adjusted for async

`telegram/index.ts` uses the same timeout for async operations as regular messages.

---

## Low Severity

### 15. `streamRunEvents` error leaves stale activeRequestId

`bridge_gateway.ts:1916-1937` — event iterator error emitted to bus but `state.activeRequestId` is never cleared.

### 16. Duration timer reset race in stop hook blocking

`orchestrator.ts:723` — `startTime = Date.now()` resets during parallel execution, making duration bounds artificially low.

### 17. Context serialization unwrapped

`agent.ts:1516` — `ContextWindow.deserialize()` called without try-catch.

### 18. Hardcoded LLM token limits in decision engine

`engine/index.ts:414, 473` — `maxTokens: 1000` / `1500` with no relationship to actual model limits.

---

## Patch Spec (Critical Only)

### Patch 1: Async state tracking + duplicate prevention + cleanup

**File**: `packages/harness-daemon/src/harness/bridge_gateway.ts`

1. Add `AsyncRunInfo` interface and `asyncRun` field to `ConnectionState`
2. In `handleAsyncStart`: reject if `state.asyncRun` is already set; set `state.asyncRun` on success
3. In `streamRunEvents`: accept optional `onComplete` callback; clear `state.asyncRun` and `state.activeRequestId` when stream finishes
4. In `handleDisconnect`/`handleSessionClose`: clear `asyncRun`

### Patch 2: Runtime validation for watcher structured output

**File**: `packages/harness-daemon/src/harness/harness.ts`

Replace unsafe `as` cast with:
```typescript
if (structured && typeof structured === 'object' && typeof structured.watcherAction === 'string') {
  // use it
} else {
  // fallback to continue
}
```

### Patch 3: Wrap watcher callbacks in try-catch

**File**: `packages/decision-watcher/src/watcher-agent.ts`

Wrap `config.onCreateWorkItems?.(...)` and `config.onDecision?.(...)` in try-catch blocks.
