# Cockpit Message Durability Patch Spec

## Goal

Make cockpit session messaging resilient to race conditions, stale overwrites, and cross-session contamination while preserving low-latency live streaming.

This patch prioritizes:

1. Agent/user messages for a session must not disappear from UI due to refresh timing.
2. Live streaming stays direct (SSE/EventBus), not gated on DB write completion.
3. State updates must be session-scoped and race-safe.
4. Obsolete fallback logic that causes stale leakage should be removed.

## Hard Invariants

1. `refreshFocus()` results must never overwrite a newer focus target.
2. Streaming state must be scoped to the active session message list, not global singleton text.
3. Message dedupe must be conservative: duplicate messages are preferable to accidental drops.
4. Stateful metadata arrays must not be blindly appended.

## Patch Scope (Surgical)

### P0. Focus Refresh Race Guard (frontend)

Files:

- `packages/dashboard-control/src/hooks/use-cockpit-store.ts`
- `packages/dashboard-control/src/App.tsx`
- `packages/dashboard-control/src/hooks/use-cockpit-store.test.tsx`

Changes:

1. Add a monotonic `focusRequestSeq` counter in the store.
2. Each `refreshFocus(target)` captures `requestSeq` and target identity (`type:id`).
3. Before `setFocusData(...)`, verify:
   - `requestSeq` is still latest.
   - current `focusTarget` still matches captured target.
4. Drop stale results silently if either check fails.

Why:

- Prevents older in-flight requests from replacing state for a newer focus selection.

Acceptance tests:

1. Start refresh for session A, switch focus to session B before A resolves, ensure A result is discarded.
2. Concurrent `refreshAll()` + focus change does not regress selected session data.

---

### P0. Remove Global Streaming Text Fallback (obsolete + risky)

Files:

- `packages/dashboard-control/src/hooks/use-cockpit-store.ts`
- `packages/dashboard-control/src/components/center/EventDrawer.tsx`
- `packages/dashboard-control/src/hooks/use-cockpit-store.test.tsx`
- `packages/dashboard-control/src/components/left/FileExplorer.test.tsx`

Changes:

1. Delete `streamingText` and `streamingRequestId` from `CockpitState`.
2. Delete synthetic append path in `selectFilteredEvents(...)` that injects a message from global `streamingText`.
3. Make streaming visibility depend only on real `events[]` entries with `payload.streaming === true`.
4. Update `EventDrawer` memo deps to remove `streamingText`.

Why:

- Global fallback is the primary cross-session leak vector.
- Stream chunks are already represented as explicit events by `injectStreamChunk()`.

Acceptance tests:

1. Stream in session A, switch to session B, ensure no session A text appears in B.
2. Streamed chunks still render live in active session.

Deleted obsolete code:

1. Global fallback message injection in `selectFilteredEvents`.
2. Store fields and logic solely supporting that fallback.

---

### P0. Message Reconciliation: No False-Drop Keys

Files:

- `packages/dashboard-control/src/hooks/use-cockpit-store.ts`

Changes:

1. Tighten `messageReconcileKeys(...)`:
   - Keep: `db:id`, stable `id`, `requestId+role` keys.
   - Remove broad `role-content` fallback key (high false-positive drop risk).
2. Keep merge policy biased toward retention: if uncertain, keep local message.
3. In `handleSendMessage`, after `postCockpitSessionMessage(...)` returns `requestId`, patch the optimistic user event with that `requestId` so canonical reconciliation is precise.

Why:

- Broad content-based keys can collapse distinct repeated messages and make them disappear.

Acceptance tests:

1. Two assistant messages with same content but different requests both remain visible.
2. Optimistic user message reconciles correctly once canonical server message arrives.

---

### P0. Backend Event Dedupe Must Be Order-Independent and Conservative

Files:

- `packages/harness-daemon/src/harness/routes/cockpit.ts`
- `packages/harness-daemon/src/harness/control_plane_routes.test.ts`

Changes:

1. Replace current single-pass dedupe in `buildSessionEvents(...)` with two-pass logic:
   - Pass 1: index messages-table entries (`id` numeric, no `eventType`) by `requestId+role` only when `requestId` is non-empty.
   - Pass 2: include all messages-table entries.
   - Pass 3: include agent-event messages unless there is a table match for same non-empty `requestId+role`.
2. Do not dedupe messages with missing `requestId`.

Why:

- Current dedupe depends on iteration order and can keep both duplicates or drop valid events unpredictably.

Acceptance tests:

1. Same data set with reversed ordering yields identical deduped output.
2. Missing-`requestId` messages are not dropped by dedupe.

---

### P0. Metadata Merge Semantics: Append Only for Explicit Keys

Files:

- `packages/graphd/src/store.ts`
- `packages/graphd/src/store.test.ts` (add coverage if absent)

Changes:

1. Replace global “append any array on merge” behavior with append allowlist:
   - Append keys: `agent_events`, `packets`, `escalations`, `review_decisions`.
2. For all other array keys, replace value instead of append.

Why:

- Stateful arrays (example: `paused_work_items`) become stale/zombie when blindly appended.

Acceptance tests:

1. `paused_work_items` update replaces existing array.
2. `agent_events` update still appends.

---

## Live Stream Guarantee (must remain)

No change to direct live path:

1. SSE/EventBus stream remains primary low-latency source for active session rendering.
2. Persistence remains async and eventual via `GraphDSubscriber`.

Regression guard:

1. Keep and extend `packages/harness-daemon/src/subscribers/graphd_subscriber.test.ts` to ensure streaming events persist (`agent_message`, `agent_reasoning`).

## Explicit Non-Goals for This Patch

1. No protocol redesign of WebSocket bridge publish semantics.
2. No first-class status taxonomy cleanup (`closed`) in this patch.
3. No broad architecture rewrite of cockpit event APIs.

## Commit Plan (small, reviewable)

1. Frontend race guard + stale-drop tests.
2. Remove global streaming fallback + update tests.
3. Tighten reconcile keys + optimistic requestId patching.
4. Backend dedupe rewrite + route tests.
5. GraphD metadata array allowlist + store tests.

## Rollback Safety

1. Each commit is behaviorally isolated.
2. If needed, revert any single commit without invalidating the others.
3. Frontend changes favor retention over deletion to avoid message loss during rollback windows.
