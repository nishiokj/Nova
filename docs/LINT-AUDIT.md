# Strict Lint Audit — Core & Infra

**Date:** 2026-03-09
**Scope:** `packages/core/*/src`, `packages/infra/*/src`
**Config:** `eslint.config.js` — `strictTypeChecked` + `stylisticTypeChecked` + custom rules
**Command:** `bun run lint:strict`

## Summary

| Category | Count | Auto-fixable |
|----------|-------|-------------|
| Total violations (initial) | 1334 | 291 (fixed) |
| After auto-fix | 1043 | — |
| **After manual remediation** | **832** | — |
| Dangerous (real bugs) | 36 → 0 | all fixed |
| Unsafe any pipeline | ~370 → ~225 | 0 |
| Unnecessary conditions | 305 → 322 | 0 |
| Stylistic (post-fix remainder) | ~332 → ~285 | partial |

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

## P0 — Case Fallthrough (Runtime Bug) — FIXED

### `packages/infra/harness-daemon/src/harness/event_translator.ts:104`

The `workitem_status` case had an inner switch on `status` with four branches (`started`, `completed`, `failed`, `skipped`). If the inner switch didn't match (which the type says shouldn't happen, but the outer `data` is cast via `as`), execution **fell through into the `tool_call` case** — processing workitem data as tool call data.

**Fix applied:** Added `return null;` after the inner switch's closing brace.

**Test added:** `tests/harness-daemon/harness/event_translator.test.ts`
- Verifies all 4 known statuses produce `kind: 'work'` progress events
- Verifies unrecognized inner status returns `null` (not a `tool_call` event)
- Verifies `tool_call` events still translate independently

---

## P1 — Floating Promises (Silent Failures) — FIXED

These called async functions and discarded the returned promise. Fixed by adding the `void` operator to explicitly mark intentional fire-and-forget patterns.

**Why `void` is sufficient (not `.catch()`):** All 6 promises either catch errors internally or can't reject:
- `enqueueSessionEffectHook` wraps with `.then(() => {}, (error) => { logger.warning(...) })` — already caught
- `ManagedRuntime.dispose()` on `Layer.empty` resolves instantly, can't reject
- `handleSendText` has `.catch()` on every internal `await`

### `packages/infra/harness-daemon/src/harness/harness.ts:843` — FIXED

```ts
void task.finally(() => {                    // ← void acknowledges fire-and-forget
  this.pendingSessionHookTasks.delete(task);
});
```

### `packages/infra/harness-daemon/src/harness/harness.ts:883` — FIXED

```ts
void this.enqueueSessionEffectHook(          // ← void acknowledges fire-and-forget
  sessionKey,
  { type: 'session_stop', ... },
  ...
).finally(() => { ... });
```

### `packages/infra/harness-daemon/src/harness/harness.ts:1114` — FIXED

```ts
void this.enqueueSessionEffectHook(          // ← void acknowledges fire-and-forget
  sessionKey,
  { type: 'session_start', ... },
  ...
);
```

### `packages/infra/harness-daemon/src/harness/session_store.ts:431` — FIXED

```ts
void this.executionRuntime?.dispose();       // ← void acknowledges async in sync context
```

### `packages/infra/harness-daemon/src/harness/session_store.ts:661` — FIXED

```ts
void this.executionRuntime?.dispose();       // ← same pattern
```

**Test added:** `tests/harness-daemon/harness/session_store_execution.test.ts` (7 tests)
- `close()` calls `dispose()` on the execution runtime
- `endExecution()` calls `dispose()` on the execution runtime
- `close()` without active execution does not throw
- `endExecution()` clears execution state (requestId, handle)
- New execution can start after `endExecution()`
- Concurrent `startExecution()` returns false
- Rejecting `dispose()` does not crash `close()`

### `packages/infra/harness-daemon/src/harness/bridge_gateway.ts:256` — FIXED

```ts
void this.handleSendText(connectionId, commandData, state);  // ← void acknowledges async dispatch
```

### Why tests didn't catch these

These are **linter-class bugs, not test-class bugs**:

| Bug type | Correct tool | Rationale |
|----------|-------------|-----------|
| "Promise return discarded without acknowledgment" | **Linter** | Structural code property — not observable behavior |
| "`dispose()` is called on teardown" | **Test** | Behavioral contract — tests added above |
| "Async errors don't become unhandled rejections" | **Both** | Linter catches structural gap; test verifies error handling |

The hook lifecycle promises (`harness.ts`) already catch errors internally via `enqueueSessionEffectHook`'s `.then(() => {}, (error) => { ... })`. The `void` operator documents intent and prevents regression if someone removes the internal error handling.

The `dispose()` calls (`session_store.ts`) had no test coverage because tests never started executions — they tested model selections and disk persistence but not the execution lifecycle. Tests now cover this.

---

## P1 — Non-Exhaustive Switches (Missing Cases) — FIXED (3 of 8 actual issues)

Analysis revealed the audit overstated this category. Of 8 flagged locations:
- **2 were real bugs** (missing `artifact` case in context-window.ts)
- **1 was a lint-only issue** (graphd_subscriber.ts missing `default: break`)
- **5 had correct `default` cases** — not flagged by `switch-exhaustiveness-check` with default config

### `packages/core/context/src/context-window.ts:1530` — FIXED

`estimateTokenUsage()` missing `artifact` case. Artifact items contributed 0 tokens, undercounting context size.

**Fix:** Added `case 'artifact'` with estimate based on `name`, `sourcePath`, `signature`, `insight`.

**Root cause fix:** Also persisted `_metrics` (inputTokens, percentageUsed, etc.) in the context file's YAML frontmatter so disk hydration restores real API-reported token counts instead of relying on this heuristic. Previously, `_loadFromDisk()` left all metrics at 0 — the heuristic was a workaround for missing metric persistence.

### `packages/core/context/src/context-window.ts:1576` — FIXED

`toTelemetry()` missing `artifact` case. Artifact items got empty preview string.

**Fix:** Added `case 'artifact': preview = \`${item.kind}: ${item.name}\`; break;`

### `packages/infra/harness-daemon/src/subscribers/graphd_subscriber.ts:180` — FIXED

`deriveWorkflowState()` handles 5 of 31 event types with no `default`. By design — only workflow-relevant events need handling.

**Fix:** Added `default: break;`

### Not bugs (correct `default` cases, no changes needed)

| File | Line | Why it's correct |
|------|------|-----------------|
| `agent.ts` | 1357 | `default` returns base result — only 3 of 15 reasons need special handling |
| `orchestrator.ts` | 1883 | `default: return null` — most reasons don't produce control events |
| `event_translator.ts` | 38 | `default: return null` — TUI only cares about ~15 of 31 event types |
| `bus_client.ts` | 95 | `default` emits error — client only receives server-side messages |
| `bus_server.ts` | 367 | `default` sends error — server only receives client-side messages |

---

## P1 — Misused Promises (Async in Sync Contexts) — FIXED

### `packages/core/shared/src/profiler.ts:61-62` — FIXED

Signal handlers called `this.flush()` (async) — process could exit before the write completes, silently losing the profile.

**Fix:** Changed to `this.flushSync()` — the synchronous write method that already existed and was correctly used for the `exit` handler. Also converted `require('fs')` (P3 fix) to `import { writeFileSync } from 'node:fs'` at the top of the file, and collapsed the dead Bun/non-Bun branch (both paths were identical).

### `packages/core/llm/src/auth/codex-oauth-flow.ts:40` — FIXED

Node's `createServer` accepts `(req, res) => void` and ignores the return value. The async handler's promise was silently discarded — any double-fault (e.g. `res.writeHead(500)` throws inside the inner catch because connection closed) became an unhandled rejection.

**Fix:** Extracted handler to a named `async function handleOAuthCallback()`, called it from a synchronous `createServer` callback with `void handleOAuthCallback(...).catch(...)`. The outer `.catch()` guards against double-faults by checking `res.headersSent` before attempting a 500 response.

---

## P2 — Explicit `any` (Type Safety Holes) — FIXED

### LLM Provider Message Pipeline — systemic type fix

The entire LLM message pipeline was typed with `any[]` at every boundary. Root cause: `RespondParams.messages` was declared as `Message[]` (simple `{role, content}` type), but the actual data flowing through is `LLMItem[]` (discriminated union: `LLMMessageItem | LLMFunctionCallItem | LLMFunctionCallOutputItem | LLMReasoningItem`). Providers used `any[]` to escape this mismatch.

**Fix applied — 4 layers deep:**

1. **Root type:** `RespondParams.messages` changed from `Message[]` to `LLMItem[]` (`types/src/llm.ts`)
2. **Agent layer:** `buildMessages()` return type from `Record<string, unknown>[]` to `LLMItem[]`, `buildIterationRequest()` return type updated, `streamWithResilience()` param type updated, removed `as unknown as Message[]` double-cast (`agent/src/agent.ts`)
3. **Provider interface:** `LLMProviderAdapter.formatMessages` changed from `Message[]` to `LLMItem[]` (`llm/src/providers/types.ts`)
4. **Provider implementations:** All 4 providers' `formatMessages`/`normalizeInput` methods changed from `any[]` to `LLMItem[]` with proper type narrowing:
   - `anthropic.ts` — filter narrowed to `LLMMessageItem` via type predicate, content blocks typed as `ContentBlock`
   - `openai.ts` — content block filter changed to `Record<string, unknown>` type guard
   - `openai-compat.ts` — `any[]` → `LLMItem[]`
   - `vercel-gateway.ts` — both `formatMessages` and `normalizeInput` updated, content block filters fixed

| File | Line | Before → After |
|------|------|----------------|
| `types/src/llm.ts` | 295 | `messages: Message[]` → `messages: LLMItem[]` |
| `llm/src/providers/types.ts` | 120 | `formatMessages?(messages: Message[])` → `formatMessages?(messages: LLMItem[])` |
| `llm/src/providers/anthropic.ts` | 100 | `formatMessages(messages: any[])` → `formatMessages(messages: LLMItem[])` |
| `llm/src/providers/openai.ts` | 633 | `normalizeInput(messages: any[])` → `normalizeInput(messages: LLMItem[])` |
| `llm/src/providers/openai-compat.ts` | 304 | `formatMessages(messages: any[])` → `formatMessages(messages: LLMItem[])` |
| `llm/src/providers/vercel-gateway.ts` | 104, 996 | Both `any[]` → `LLMItem[]` |
| `agent/src/agent.ts` | 367 | `messages: Record<string, unknown>[]` → `messages: LLMItem[]` |
| `agent/src/agent.ts` | 677 | `messages: Message[]` → `messages: LLMItem[]` |
| `agent/src/agent.ts` | 960 | Removed `as unknown as Message[]` cast |

### Other `any` usage — FIXED

| File | Line | Fix |
|------|------|-----|
| `core/llm/src/providers/openai.ts` | 302 | `logger: any` → `logger: AdapterLogger` (already done in previous session) |
| `core/context/src/context-window.ts` | 1511 | Removed `(item as any).requestId` — `MessageItem` has no `requestId`, field was always `undefined` (dead code) |
| `infra/harness-daemon/src/harness/bridge_gateway.ts` | 60 | `getGraphD?(): any` → `getGraphD?(): GraphDManager \| null` (matches `harness.ts:621`) |
| `infra/comms-bus/src/event_bus.ts` | 88 | `(event as any).runId` → `('runId' in event ? (event as { runId?: string }).runId : undefined)` (already done in previous session) |

**Type-checked:** All affected packages pass `tsc --noEmit` (types, llm, agent, context, harness-daemon, comms-bus).

---

## P2 — Loose Equality (`==`/`!=` instead of `===`/`!==`) — FIXED

All 8 instances rewritten to strict equality:

| File | Before → After |
|------|----------------|
| `anthropic.ts` | `m.content != null` → `m.content !== null && m.content !== undefined` |
| `anthropic.ts` | `block != null` → `block !== null && block !== undefined` |
| `openai.ts` | `block != null && typeof block === 'object'` → `block !== null && typeof block === 'object'` |
| `vercel-gateway.ts` (×2) | Same pattern as openai |
| `graphd/store.ts` | `trace.oldContent != null` → `trace.oldContent !== undefined` (type is `string \| undefined`) |
| `graphd/utils.ts` (×2) | `value == null` → `value === null \|\| value === undefined` |

---

## P3 — `require()` in ESM Module — FIXED

### `packages/core/shared/src/profiler.ts:277`

`require('fs')` inside an ESM module, used for `writeFileSync` in `flushSync()`. Both branches of a dead Bun/non-Bun check were identical.

**Fix:** Replaced with `import { writeFileSync } from 'node:fs'` at the top of the file. Collapsed the dead branch.

---

## Bulk Categories (not individually listed)

### `no-unsafe-*` Family (225 violations, down from ~370)

The `no-unsafe-assignment` (95), `no-unsafe-member-access` (98), `no-unsafe-call` (8), `no-unsafe-return` (13), `no-unsafe-argument` (11) violations are concentrated in:

- **`harness-daemon/src/harness/config_loader.ts`** — YAML config parsing flows through `any`
- **`harness-daemon/src/harness/skills_loader.ts`** — skill config parsing
- **`harness-daemon/src/harness/harness.ts`** — config access patterns
- **`harness-daemon/src/harness/rpc_method_handlers.ts`** — RPC payload handling

Root cause: config and RPC payloads enter the system as `unknown`/`any` and are destructured without runtime validation (e.g., Zod schemas). The fix is to add schema validation at ingress points rather than sprinkling type assertions throughout. The LLM provider message pipeline violations were eliminated by the P2 `LLMItem[]` type fix.

### Remaining stylistic/mechanical (285 violations)

| Rule | Count | Fix approach |
|------|-------|-------------|
| `prefer-nullish-coalescing` | 61 | Case-by-case: `\|\|` → `??` only safe when `''`/`0`/`false` aren't valid LHS values |
| `no-non-null-assertion` | 56 | Replace `!` with null checks or refactor control flow |
| `no-base-to-string` | 22 | Add `.toString()` or template expression fixes |
| `restrict-template-expressions` | 15 | Type-narrow before template interpolation |
| `no-deprecated` | 13 | Update deprecated API usage |
| `use-unknown-in-catch-callback-variable` | 12 | Add `: unknown` to `.catch(err => ...)` params |
| `no-empty-function` | 9 | Remove or add `// intentional noop` comment |
| Other (8 rules) | 34 | Various |

### `no-unnecessary-condition` (322 violations)

Defensive null checks on values TypeScript says can never be null. Two interpretations:
1. **The types are correct** → the checks are dead code and should be removed
2. **The types are wrong** → the runtime can actually produce null, and the types need fixing

Most are in harness-daemon and orchestrator, suggesting the type definitions for config/session state may be overly optimistic. Requires per-case analysis — cannot be mechanically fixed.

### `no-unused-vars` (35 violations) — FIXED (35 cleaned)

Dead imports, unused constants, and unused assignments across 16 files. All removed:

- **core/agent** — Removed `isBoundsTerminationReason` function + `BOUNDS_TERMINATION_REASONS` constant (dead code), unused `schemaId` param from `buildSchemaReminder()`, `MessageItem` import
- **core/orchestrator** — Removed 5 unused decision type imports (`AgentErrorDecision`, `BoundsDecision`, etc.)
- **core/tools** — Removed `tmpdir` import from `write.ts`
- **core/llm** — Removed dead `isReasoningModel` function (logic already in `supportsSamplingParams`)
- **infra/graphd** — Removed `GraphDStats` import, `ENABLE_WAL`/`ENABLE_NORMAL_SYNC` constants
- **infra/harness-client** — Removed `ReadyData`/`ResponseData` imports (already re-exported via `export type *`)
- **infra/harness-daemon** — Removed 15 unused imports/vars across 8 files (`randomUUID`, `fs`, `RateLimitData`, `ResolvedAgentConfig`, `HookDefinition`, `PermissionedTool`, `PermissionRequest`, `SessionGetResponse`, `GraphDSession`, `scryptSync` ×2, `LLMProvider`, `AgentEventType`, `ProgressData`/`ResponseData`, `Effect`), removed dead `responseHasContent` assignment, prefixed unused `result` param with `_`

### `consistent-type-imports` (12 violations) — FIXED

Inline `import()` type annotations replaced with top-level `import type` across 9 files (agent.ts, prompts.ts, context-window.ts, codex-oauth-flow.ts, llm.ts, manager.ts, server.ts, bridge_gateway.ts, types.ts).

### `prefer-optional-chain` (11 violations) — FIXED

`a && a.b` patterns replaced with `a?.b` across 5 files (context-window.ts, server.ts, store.ts, run.ts ×8).

### `no-unnecessary-type-conversion` (6 violations) — FIXED

Redundant `String()` on strings and `Number()` on numbers removed across 3 files (agent.ts, run.ts, graphd_subscriber.ts).

---

## Recommended Fix Order

1. ~~**P0 fallthrough bug** in event_translator.ts~~ — **DONE** (+ test)
2. ~~**P1 floating promises** — add `void` operator~~ — **DONE** (+ test for dispose lifecycle)
3. ~~**P1 non-exhaustive switches** — add missing cases or default clauses~~ — **DONE** (3 real issues fixed, 5 non-issues documented)
4. ~~**P1 misused promises** — fix profiler signal handlers, wrap HTTP server callback~~ — **DONE** (flushSync for signals, catch wrapper for OAuth)
5. ~~**P2 explicit any** — type the LLM message pipeline properly (biggest ROI)~~ — **DONE** (systemic type fix across 4 layers)
6. ~~**P2 loose equality** — rewrite to strict equality~~ — **DONE** (8 instances)
7. ~~**P3 require** — convert to ESM import~~ — **DONE** (folded into profiler fix)
8. **Bulk unsafe-any** — add Zod schemas at config/RPC ingress points
9. **Bulk unnecessary-condition** — audit types vs runtime reality, then clean up

### Additional fixes discovered during remediation

- **Context metric persistence** — `ContextWindow._loadFromDisk()` did not restore `_metrics` from disk, leaving `percentageUsed` at 0 after hydration. Fixed by persisting `inputTokens`, `peakInputTokens`, `totalOutputTokens`, `percentageUsed`, `totalCachedTokens` in the YAML frontmatter. This was the root cause of `compactHydratedContextIfNeeded` relying on the char-heuristic instead of real token counts.
