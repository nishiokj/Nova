# Strict Lint Audit — Core & Infra

**Date:** 2026-03-09
**Scope:** `packages/core/*/src`, `packages/infra/*/src`
**Config:** `eslint.config.js` — `strictTypeChecked` + `stylisticTypeChecked` + custom rules
**Command:** `bun run lint:strict`

## Summary

| Category | Count | Auto-fixable |
|----------|-------|-------------|
| Total violations | 1334 | 291 (fixed) |
| **Remaining after auto-fix** | **1043** | — |
| Dangerous (real bugs) | 36 | 0 |
| Unsafe any pipeline | ~370 | 0 |
| Unnecessary conditions | 305 | 0 |
| Stylistic (post-fix remainder) | ~332 | partial |

### Per-Package Error Counts (files with violations)

| Package | Files |
|---------|-------|
| `infra/harness-daemon` | 24 |
| `core/llm` | 15 |
| `core/tools` | 13 |
| `core/orchestrator` | 9 |
| `infra/graphd` | 6 |
| `core/types` | 6 |
| `core/shared` | 6 |
| `core/agent` | 4 |
| `infra/harness-client` | 3 |
| `infra/comms-bus` | 3 |
| `core/runtime` | 3 |
| `core/context` | 1 |

---

## P0 — Case Fallthrough (Runtime Bug)

### `packages/infra/harness-daemon/src/harness/event_translator.ts:107`

The `workitem_status` case has an inner switch on `status` with four branches (`started`, `completed`, `failed`, `skipped`). If the inner switch doesn't match (which the type says shouldn't happen, but the outer `data` is cast via `as`), execution **falls through into the `tool_call` case** — processing workitem data as tool call data.

```
case 'workitem_status': {
  const itemData = data as { status: 'started' | 'completed' | 'failed' | 'skipped'; ... };
  switch (status) {
    case 'started': return { ... };
    case 'completed': return { ... };
    case 'failed': return { ... };
    case 'skipped': return { ... };
  }
}
// ← NO break/return — falls through

case 'tool_call': {
  const toolData = data as { toolName?: string; ... };
  ...
```

**Fix:** Add `break` or `return null` after the inner switch's closing brace.

---

## P1 — Floating Promises (Silent Failures)

These call async functions and discard the returned promise. If the async operation rejects, it becomes an unhandled promise rejection — potential crash or silent data loss.

### `packages/infra/harness-daemon/src/harness/harness.ts:843`

```ts
private trackSessionHookTask(task: Promise<void>): void {
  this.pendingSessionHookTasks.add(task);
  task.finally(() => {                          // ← .finally() returns a new promise, discarded
    this.pendingSessionHookTasks.delete(task);
  });
}
```

The `.finally()` return is not stored or awaited. If the callback throws, rejection is unhandled.

### `packages/infra/harness-daemon/src/harness/harness.ts:883`

```ts
this.enqueueSessionEffectHook(
  sessionKey,
  { type: 'session_stop', sessionKey, reason: 'session_cleanup' },
  { sessionKey, requestId: 'session_cleanup', workingDir },
  'Session stop hook failed during cleanup'
).finally(() => {                               // ← fire-and-forget
  this.sessionHookRegistry.clearSession(sessionKey);
  this.configuredHookRuntimes.delete(sessionKey);
  this.closingSessionHooks.delete(sessionKey);
});
```

Session cleanup hooks are fire-and-forget. If `enqueueSessionEffectHook` rejects, the `.finally()` still runs, but the overall promise chain is unhandled. If `.finally()` callback itself throws, that rejection is completely lost.

### `packages/infra/harness-daemon/src/harness/harness.ts:1114`

```ts
this.enqueueSessionEffectHook(
  sessionKey,
  { type: 'session_start', sessionKey, workingDir: workingDir ?? this.config.tools.workingDir },
  { sessionKey, requestId: 'session_start', workingDir: workingDir ?? this.config.tools.workingDir },
  'Session start hook failed'
);                                              // ← returned promise discarded entirely
```

Session start hook failure is completely silent. No `.catch()`, no `void` operator, nothing.

### `packages/infra/harness-daemon/src/harness/session_store.ts:431`

```ts
resetExecution(): void {
  ...
  this.executionRuntime?.dispose();             // ← dispose() returns a promise
  this.executionRuntime = null;
  ...
}
```

`dispose()` is async but called in a sync method. If disposal fails (e.g. cleanup of child processes), the error is lost.

### `packages/infra/harness-daemon/src/harness/session_store.ts:661`

```ts
endExecution(): { requestId: string; message: string }[] {
  ...
  this.executionRuntime?.dispose();             // ← same pattern, same problem
  this.executionRuntime = null;
  ...
}
```

Duplicate of the above — same `dispose()` fire-and-forget in a different method.

### `packages/infra/harness-daemon/src/harness/bridge_gateway.ts:256`

```ts
case 'send_text':
case 'send_media':
  this.handleSendText(connectionId, commandData, state);   // ← async method, not awaited
  return;
```

`handleSendText` is async. Called without `await` in the command dispatch switch. If the async handler rejects, the error is unhandled.

---

## P1 — Non-Exhaustive Switches (Missing Cases)

These switches don't cover all discriminated union members. When new variants are added, these locations silently do nothing instead of failing loudly.

### `packages/core/agent/src/agent.ts:1357`

Switch on `terminationReason` in result validation. Missing 12 cases:
- `max_iterations_exceeded`, `max_tool_calls_exceeded`, `max_duration_exceeded`
- `user_stopped`, `goal_state_reached`, `circuit_open`, `timeout`
- `agent_error`, `invalid_action`, `no_action`
- `observer_stopped`, `observer_work_item_stopped`

### `packages/core/orchestrator/src/orchestrator.ts:1883`

Switch on `terminationReason` in stop-hook event creation. Missing 7 cases:
- `user_stopped`, `rate_limit`, `circuit_open`, `timeout`
- `refusal`, `observer_stopped`, `observer_work_item_stopped`

### `packages/core/context/src/context-window.ts:1530`

Switch on `item.type` in `estimateTokenUsage()`. Missing `artifact` — artifact items contribute 0 tokens to the estimate, which will undercount context size.

### `packages/core/context/src/context-window.ts:1576`

Switch on `item.type` in `toTelemetry()`. Missing `artifact` — artifact items get an empty preview string.

### `packages/infra/harness-daemon/src/harness/event_translator.ts:38`

Switch on event `type` in `translateAgentEventCore()`. Missing 13+ event types:
- `files_modified`, `memory_injected`, `git_commit`, `hook_call`
- `rate_limit`, `agent_bounds_hit`
- `run_control_requested`, `run_control_applied`, `run_control_rejected`
- `orchestration_started`, `iteration_started`, `iteration_completed`
- `observer_decision`

### `packages/infra/comms-bus/src/bus_client.ts:95`

Switch on `message.type`. Missing: `subscribe`, `unsubscribe`, `publish`.

### `packages/infra/comms-bus/src/bus_server.ts:367`

Switch on `message.type`. Missing: `error`, `event`.

### `packages/infra/harness-daemon/src/subscribers/graphd_subscriber.ts:180`

Switch on event type in GraphD subscriber. Missing 24+ event types — only handles a small subset.

---

## P1 — Misused Promises (Async in Sync Contexts)

### `packages/core/shared/src/profiler.ts:61-62`

```ts
process.on('SIGINT', () => this.flush());       // flush() is async
process.on('SIGTERM', () => this.flush());      // rejection silently swallowed
```

Signal handlers expect synchronous callbacks. `flush()` returns a promise that is discarded. If writing the profile data fails during shutdown, the error is lost and the profile is silently incomplete. Line 63 correctly uses `flushSync()` for the `exit` handler.

### `packages/core/llm/src/auth/codex-oauth-flow.ts:40`

```ts
const server = createServer(async (req, res) => { ... });
```

Node's `http.createServer` does not handle promise rejections from the request handler. If the async callback throws, it becomes an unhandled rejection rather than sending a 500 response.

---

## P2 — Explicit `any` (Type Safety Holes)

### LLM Provider Message Formatting — systemic pattern across 4 providers

The `formatMessages()` and `normalizeInput()` methods accept `any[]` across all LLM providers, creating a type-safety gap at the most critical boundary (data going to/from external APIs):

| File | Line | Method |
|------|------|--------|
| `core/llm/src/providers/anthropic.ts` | 99 | `formatMessages(messages: any[])` |
| `core/llm/src/providers/openai.ts` | 632 | `normalizeInput(messages: any[])` |
| `core/llm/src/providers/openai-compat.ts` | 303 | `formatMessages(messages: any[])` |
| `core/llm/src/providers/vercel-gateway.ts` | 104 | `formatMessages(messages: any[])` |
| `core/llm/src/providers/vercel-gateway.ts` | 996 | `normalizeInput(messages: any[])` |

These should accept `Message[]` or the appropriate typed array from `types` package.

### Other `any` usage

| File | Line | What |
|------|------|------|
| `core/llm/src/providers/openai.ts` | 302 | `logger: any` param in `pollForCompletion()` |
| `core/context/src/context-window.ts` | 1473 | `(item as any).requestId` — property access via any-cast to extract metadata not on the type |
| `infra/harness-daemon/src/harness/bridge_gateway.ts` | 60 | `getGraphD?(): any` — GraphD client interface returns `any` |
| `infra/comms-bus/src/event_bus.ts` | 88 | `(event as any).runId` — accessing `runId` not present on `AnyEvent` type |

---

## P2 — Loose Equality (`==`/`!=` instead of `===`/`!==`)

| File | Line | Expression | Notes |
|------|------|-----------|-------|
| `core/llm/src/providers/anthropic.ts` | 101 | `m.content != null` | Intentional null+undefined check, should use `=== null \|\| === undefined` or explicit `?? ` |
| `core/llm/src/providers/anthropic.ts` | 108 | `block != null` | Same pattern |
| `core/llm/src/providers/openai.ts` | 711 | `block != null` | Same pattern |
| `core/llm/src/providers/vercel-gateway.ts` | 179 | `block != null` | Same pattern |
| `core/llm/src/providers/vercel-gateway.ts` | 1055 | `block != null` | Same pattern |
| `infra/graphd/src/store.ts` | 1257 | `trace.oldContent != null` | Intentional null+undefined check |
| `infra/graphd/src/utils.ts` | 157 | `value == null` | In `safeInt()` — intentional, checks both null and undefined |
| `infra/graphd/src/utils.ts` | 166 | `value == null` | In `safeFloat()` — same |

**Note:** The `== null` idiom is a common intentional pattern for checking both `null` and `undefined`. For these specific cases, either: (a) allow `== null` / `!= null` via ESLint config `eqeqeq: ['error', 'always', { null: 'ignore' }]`, or (b) rewrite to explicit `=== null || === undefined`.

---

## P3 — `require()` in ESM Module

### `packages/core/shared/src/profiler.ts:277`

```ts
const fs = require('fs');
```

CJS `require()` inside an ESM module (`"type": "module"` in package.json). Should use `import { writeFileSync } from 'node:fs'` at the top of the file.

---

## Bulk Categories (not individually listed)

### `no-unsafe-*` Family (~370 violations)

The `no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-call`, `no-unsafe-return`, `no-unsafe-argument` violations are concentrated in:

- **`harness-daemon/src/harness/config_loader.ts`** — YAML config parsing flows through `any`
- **`harness-daemon/src/harness/skills_loader.ts`** — skill config parsing
- **`harness-daemon/src/harness/harness.ts`** — config access patterns
- **`harness-daemon/src/harness/rpc_method_handlers.ts`** — RPC payload handling
- **LLM providers** — message formatting pipelines (see P2 above)

Root cause: config and RPC payloads enter the system as `unknown`/`any` and are destructured without runtime validation (e.g., Zod schemas). The fix is to add schema validation at ingress points rather than sprinkling type assertions throughout.

### `no-unnecessary-condition` (~305 violations)

Defensive null checks on values TypeScript says can never be null. Two interpretations:
1. **The types are correct** → the checks are dead code and should be removed
2. **The types are wrong** → the runtime can actually produce null, and the types need fixing

Most are in harness-daemon and orchestrator, suggesting the type definitions for config/session state may be overly optimistic.

### `no-unused-vars` (35 violations)

Dead variables — likely remnants of refactoring. Should be deleted.

---

## Recommended Fix Order

1. **P0 fallthrough bug** in event_translator.ts — one-line fix, prevents data corruption
2. **P1 floating promises** — add `void` operator or `.catch()` to intentional fire-and-forget, `await` the rest
3. **P1 non-exhaustive switches** — add missing cases or default clauses
4. **P1 misused promises** — fix profiler signal handlers, wrap HTTP server callback
5. **P2 explicit any** — type the LLM message pipeline properly (biggest ROI)
6. **P2 loose equality** — configure `eqeqeq` to allow `== null` idiom, fix the rest
7. **P3 require** — convert to ESM import
8. **Bulk unsafe-any** — add Zod schemas at config/RPC ingress points
9. **Bulk unnecessary-condition** — audit types vs runtime reality, then clean up
