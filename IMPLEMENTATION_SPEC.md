# Implementation Spec

## Goal
Apply all High/Medium/Low fixes plus watcher prompt builder and hook logging de-dup, with minimal behavior change.

## Primary Files
- `packages/orchestrator/src/orchestrator.ts`
- `packages/harness-daemon/src/harness/harness.ts`
- `packages/harness-daemon/src/harness/permissions.ts`
- `packages/decision-watcher/src/watcher-agent.ts`
- `packages/decision-watcher/src/types.ts`
- `packages/decision-watcher/src/session-init.ts`
- `packages/agent/src/types.ts`
- `packages/agent/src/agent.ts`

---

## Patch 1 — Fix termination reason when queue drains
**File:** `packages/orchestrator/src/orchestrator.ts`
- In the “Queue is empty” return block, set `terminationReason` to `initialResult.terminationReason ?? 'agent_error'` instead of hard-coding `'goal_state_reached'`.

---

## Patch 2 — Guard model-selection errors
**File:** `packages/orchestrator/src/orchestrator.ts`
- Wrap the `createAgent(...)` call in the ready-items loop in `try/catch`.
- On error:
  - `const errorMessage = err instanceof Error ? err.message : String(err)`
  - `const errorResult = this.createErrorResult(errorMessage, context)`
  - `this.completedWork.set(item.workId, errorResult)`
  - If `item.workId === this.initialWorkId`, return `createResult({ success:false, error:errorMessage, terminationReason:'agent_error', ... })` (same shape as unknown-agent branch).

---

## Patch 3 — Remove unused boundsChecker + dead helper
**File:** `packages/orchestrator/src/orchestrator.ts`
- Delete the `BoundsChecker` import, field, and constructor initialization.
- Delete `private handleInterruption(...)` (unused).

---

## Patch 4 — Fix comment contradictions
**Files:**
- `packages/orchestrator/src/orchestrator.ts`
- `packages/decision-watcher/src/watcher-agent.ts`

Changes:
- Update comments for compaction defaults to “0.70”.
- Update hysteresis comment to match 0.70/0.70 behavior (or make it generic).
- In watcher cadence prompt text, replace “every 3 minutes” with “periodic cadence audit” (or “periodic cadence audit (~1–2 min)” if you want to be explicit).

---

## Patch 5 — Add `goal_state_reached` trigger & fix handler
**Files:**
- `packages/decision-watcher/src/types.ts`
- `packages/decision-watcher/src/watcher-agent.ts`

Changes:
1. Add `'goal_state_reached'` to `WatcherTrigger` union.
2. Add `goal_state_reached` entry to `VALID_ACTIONS_BY_TRIGGER` (same actions as `work_item_completed`).
3. Add `goal_state_reached` entry in `TIMEOUT_BY_TRIGGER` (use `90_000`).
4. Map `goal_state_reached` to `formatGoalReachedContext` in `formatSnapshotForTrigger`.
5. Add fallback handling for `goal_state_reached` (mirror `work_item_completed`).
6. In `handleGoalReached(...)`, call `runAndLog(config, 'goal_state_reached', ...)` instead of `'work_item_completed'`.

---

## Patch 6 — Cancel watcher run on timeout (AbortSignal)
**Files:**
- `packages/decision-watcher/src/watcher-agent.ts`
- `packages/decision-watcher/src/session-init.ts`
- `packages/harness-daemon/src/harness/harness.ts`
- `packages/agent/src/types.ts`
- `packages/agent/src/agent.ts`

Changes:
1. Update watcher config type to: `runAgent: (objective: string, trigger: WatcherTrigger, signal?: AbortSignal) => Promise<WatcherAction>`.
2. In `runAndLog(...)`, create an `AbortController`, pass `controller.signal` to `config.runAgent(...)`, and call `controller.abort()` on timeout.
3. Update `runWatcherAgent(...)` to accept `signal?: AbortSignal`.
   - If `signal?.aborted`, return `{ watcherAction: 'allow', reason: 'Watcher aborted' }` early.
   - Pass `signal` into `agent.run({ ..., signal })`.
4. Update `AgentRunParams` with optional `signal?: AbortSignal`.
5. Update `Agent.run(...)` and `executeLoop(...)` to accept the signal and check at least once per iteration:
   - `if (signal?.aborted) throw new Error('aborted');`

---

## Patch 7 — prompt_user fallback uses options
**File:** `packages/decision-watcher/src/watcher-agent.ts`
- In `getFallbackAction('prompt_user')`, if `ctx.event.type === 'user_input_required'` and options exist, select the first option (string or label). Otherwise fall back to `"Continue"`.

---

## Patch 8 — Model selection single source of truth
**File:** `packages/harness-daemon/src/harness/harness.ts`
1. Update the header comment to say config is not the model selection source of truth; session selections are.
2. When updating GraphD session metadata in `run(...)`, use the actual selection from `SessionStore`:
   - If present, use `selection.provider`/`selection.model`.
   - If missing, omit those fields and log a warning.
3. In `runWatcherAgent(...)`, remove fallback to `standard` selection:
   - Only use `store?.getModelSelection('watcher')`.
   - If missing, return `{ watcherAction: 'allow', reason: 'No model selection for watcher' }`.

---

## Patch 9 — Permission request timeout & cleanup
**Files:**
- `packages/harness-daemon/src/harness/harness.ts`
- `packages/harness-daemon/src/harness/permissions.ts`

Changes:
1. Add `PermissionChecker.cancelPendingRequest(requestId: string)` to delete the pending entry without modifying grants/denials.
2. In `preToolUse` when `decision.granted === 'ask'`, wrap the response in a `Promise.race` with a timeout (e.g. `PERMISSION_REQUEST_TIMEOUT_MS = 60_000`).
3. On timeout:
   - Call `permissionChecker.cancelPendingRequest(request.requestId)`.
   - Return `{ action: 'block', message: 'Permission request timed out' }`.

---

## Patch 10 — Mark sessions inactive when pruned
**File:** `packages/harness-daemon/src/harness/harness.ts`
- In `pruneSessionStores(...)`, before deleting an entry, if GraphD is ready, call `this.graphd!.sessionUpdateStatus(sessionKey, 'inactive')`.

---

## Patch 11 — Logging hook de-dup
**File:** `packages/harness-daemon/src/harness/harness.ts`
- Inside `createWatcherHookRegistryForSession(...)`, add helpers:
  - `async function safeAppend(label: string, op: () => Promise<void>)` to centralize warnings.
  - `async function getWorkItemLogSafe(...)` to wrap `getOrCreateWorkItemLog(...)` and return `null` on error.
- Replace repeated `.catch(console.warn)` and repeated get-or-create error handling with these helpers.
- Preserve behavior (no logic changes).

---

## Patch 12 — Watcher prompt builder extraction
**File:** `packages/decision-watcher/src/watcher-agent.ts`
- Add a shared helper:
  - `buildWatcherObjective({ config, ctx, workItemLogContent, snapshotContext, headerLines?, taskText })`
  - Include: Session Context, WorkItem Context, workitem log block, snapshot context, then task text.
- Update handlers (`handlePromptUser`, `handleBoundsExceeded`, `handleAgentError`, `handleGoalReached`, `handleWorkItemCompleted`, `handleCadenceAudit`, `handleHandoffApproval`) to use the builder and provide only trigger-specific task text.
- No behavior change beyond comment update.

---

## Acceptance Criteria
- Orchestrator returns correct `terminationReason` even when queue drains.
- Missing model selection produces structured `agent_error` instead of throwing.
- Watcher `goal_state_reached` decisions are logged under the correct trigger.
- Watcher timeouts abort the underlying watcher run.
- Permission prompts time out and do not leak pending requests.
- Model selection metadata reflects runtime selection only.
- Comments align with actual thresholds.
- Logging hook code is shorter and centralized with no behavior changes.

---

## Optional Validation
- Compile TypeScript (or run unit tests if available).
- Run a quick async session to verify watcher logging + hooks still fire.
