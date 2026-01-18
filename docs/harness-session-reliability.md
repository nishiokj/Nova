# Harness Session Reliability

This document captures the concrete fixes for data loss, session store usage, session-key propagation, and memory TTL.

## What Changed

### 1) SessionStore is now the single in-memory session cache
- The harness now uses `SessionStore` for context + paused state instead of raw maps.
- This consolidates hydration, persistence, and session cleanup behavior in one path.

Key flows:
- `getOrCreateSessionStore()` returns a session cache with a `ContextWindow` and paused state.
- `SessionStore.persistContext()` is used for all normal completion and error paths.

### 2) Session TTL eviction to save RAM
- New config: `context.session_ttl_ms` (default: 1,800,000 ms / 30 minutes).
- The harness evicts idle session stores on every `run()` and `resume()`.
- Sessions with active paused state are never evicted (so user prompts remain resumable).
- Set `session_ttl_ms` to `0` to disable TTL eviction.

### 3) Session key propagation on all event emits
- `createEventEmitCallback` is now called with `sessionKey` in both `run()` and `resume()`.
- This ensures every emitted event is tagged with the session and becomes eligible for GraphD persistence.

### 4) Data loss mitigations
- User messages are persisted immediately (before LLM execution) via `messageAdd`.
- `persistToGraphD()` only writes the user message if it was not already saved.
- GraphD event subscriber is configured as immediate (no batching) to reduce loss on crash.
- Context snapshots are persisted on every completion and error path, plus on explicit session close.

## Config Update

`config/harness_config.json`:
```json
{
  "context": {
    "max_tokens": 200000,
    "session_ttl_ms": 1800000
  }
}
```

## Remaining Risks (not fixed here)
- `sessionUpdateMetadata()` is a read-merge-write and can lose updates under high concurrency.
- Context mutations are not locked per session; concurrent requests can interleave updates.
- If the process is hard-killed between the immediate user-message write and later context persistence, the last context snapshot can still be stale (though the user input is preserved).

## Touchpoints

- Session store + TTL: `packages/harness-daemon/src/harness/harness.ts`
- Session store implementation: `packages/harness-daemon/src/harness/session_store.ts`
- Config schema + loader: `packages/harness-daemon/src/harness/config_schema.ts`, `packages/harness-daemon/src/harness/config_loader.ts`
- GraphD subscriber immediate mode: `packages/harness-daemon/src/harness/harness.ts`
