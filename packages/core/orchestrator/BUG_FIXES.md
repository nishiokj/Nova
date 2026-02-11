# Orchestrator Bug Fixes Plan

Three bugs from `orchestrator.edge-cases.test.ts`. All are signal-dropping bugs — valid hook decisions silently ignored. Each has a failing test.

---

## Bug 1: Failed Quality Gate with Empty Issues Silently Passes

**Root cause:** `[].join('\n')` → `''`, then `!''` → `true` at the orchestrator guard.

**Files:**
- `packages/core/orchestrator/src/decision_mappers.ts:57,59`
- `packages/core/orchestrator/src/orchestrator.ts:2157`

### Fix 1a: `decision_mappers.ts` — Fallback reasons for empty arrays

```typescript
// Line 57 (failed verdict)
return { decision: 'block', reason: decision.issues.join('\n') || 'Quality gate failed' };

// Line 59 (needs_human verdict — same pattern)
return { decision: 'block', reason: decision.concerns.join('\n') || 'Quality gate requires human review' };
```

### Fix 1b: `orchestrator.ts:2157` — Don't conflate "no reason" with "not a block"

```typescript
// before
if (stopResult.decision !== 'block' || !stopResult.reason) {
  return false;
}

// after
if (stopResult.decision !== 'block') {
  return false;
}
const reason = stopResult.reason || 'Hook blocked termination';
```

Replace `stopResult.reason` with `reason` at lines 2164, 2175, 2192, 2227.

### Second-order effects

**12 call sites invoke `handleStopHookBlock`** — the guard change at line 2157 affects all of them. Currently, a `decision: 'block'` with empty reason is silently dropped at every call site. After the fix, all block decisions are respected. Tracing each path that uses the `reason` value:

| terminationReason | What `reason` becomes | Current behavior (empty reason) | New behavior |
|---|---|---|---|
| `user_input_required` (line 2175) | Injected as user message | Silent termination — observer's answer lost | Injects fallback, continues. Observer still failed to provide content, but we don't lie about success |
| `handoff_requested` (line 2192) | Injected as rejection feedback | Silent handoff success | Injects generic rejection. Planner revises |
| bounds_exceeded (line 2227) | Becomes new work item goal | Silent termination | Creates work item with fallback goal |
| Other reasons (line 2227) | Becomes new work item goal | Silent termination | Creates work item with fallback goal |

**In all cases, the current behavior (silently ignoring an explicit `decision: 'block'`) is strictly worse.** The fix ensures the hook's decision is authoritative. The message content is secondary — and 1a prevents empty reasons at the quality-gate source anyway.

**Risk: `mapBoundsDecisionToStopResult` for `'realign'`** passes `decision.guidance` as reason. If guidance is empty string, same pattern applies. After fix: empty-guidance realign still blocks (creates work item with fallback goal). This is correct — the hook said block, we block.

---

## Bug 2: Empty Handoff Silently Becomes goal_state_reached

**Root cause:** `isHandoffSpecCandidate` rejects empty `workItems`, preventing the orchestrator's correct fallback (line 2478 — log warning + pause for user) from ever executing.

**File:**
- `packages/core/agent/src/agent.ts:3188`

### Fix

```typescript
// before
if (!Array.isArray(spec.workItems) || spec.workItems.length === 0) return false;
// after
if (!Array.isArray(spec.workItems)) return false;
```

### Second-order effects

**`terminationReason` changes from `'goal_state_reached'` to `'handoff_requested'`.** This is the entire point — but downstream consumers see different values:

1. **Line 1233:** `if (initialResult.terminationReason === 'goal_state_reached')` gates `goal_achieved` event emission. After fix, empty handoffs no longer emit `goal_achieved`. **Correct** — a handoff with no work items is not goal achievement.

2. **`handoff_requested` hook event now fires for empty handoffs.** Previously, no hook saw this scenario because the agent filtered it out. After fix, hooks registered for `handoff_requested` will receive a spec with `workItems: []`. Any hook that examines `workItems` must tolerate empty arrays. **Acceptable** — hooks should be defensive about input shape, and an empty array is a valid array.

3. **Result `paused: true` is set.** Empty handoff now returns a paused result (line 2485) instead of a success result. The harness/UI will show "Planning complete. Ready to execute." instead of success. **Correct** — stops the system and waits for user/observer decision.

4. **`parseHandoffSpec` return path:** With empty `workItems`, `parseHandoffSpec` returns `[]`. Line 2461's `workItems.length > 0` fails → falls through to warning at 2478 → pause at 2482. No items are enqueued. **Safe** — the empty array case is already handled.

---

## Bug 3: Alternating Realign/Split Bypasses maxRealigns (Infinite Loop)

**Root cause:** `split` maps to `decision: 'allow'` with `deferredWork` (decision_mappers.ts:73). In `handleStopHookBlock`, splits hit the deferred-work path (line 2144) which resets `realignCount = 0` and returns `true` at line 2153 — **never reaching the increment at line 2204**. Only realigns reach the increment. So alternating split/realign keeps the counter at 0 or 1 forever.

**File:**
- `packages/core/orchestrator/src/orchestrator.ts` — `handleStopHookBlock` (lines 2127-2233)

### Fix: Restructure to enforce bounds cap first

Move the bounds increment + hard cap check to the **top** of the method, before deferred-work processing. Delete the counter reset. Delete the now-redundant duplicate bounds block.

```typescript
private handleStopHookBlock(...): boolean {
  if (!stopResult) return false;

  // === HARD SAFETY CAP (moved to top) ===
  const boundsReasons = [
    'max_iterations_exceeded', 'max_tool_calls_exceeded', 'max_duration_exceeded',
  ];
  const isBoundsExceeded = boundsReasons.includes(terminationReason ?? '');
  if (isBoundsExceeded) {
    this.realignCount++;
    this.log('info', 'Bounds hook call count incremented', {
      realignCount: this.realignCount, maxRealigns: this.config.maxRealigns, terminationReason,
    });
    if (this.realignCount > this.config.maxRealigns) {
      this.log('warning', 'Max realigns exceeded, forcing termination', {
        realignCount: this.realignCount, terminationReason,
      });
      return false;  // deferred work NOT enqueued (correct — we're terminating)
    }
  }

  // === DEFERRED WORK ===
  const queueSizeBefore = this.workQueue.length;
  this.enqueueDeferredWork(stopResult);
  const deferredWorkAdded = this.workQueue.length > queueSizeBefore;

  if (deferredWorkAdded) {
    // DELETED: this.realignCount = 0
    this.log('info', 'Deferred work added', { ... });
    if (stopResult.decision !== 'block') {
      return true;
    }
  }

  // Bug 1b fix applied here
  if (stopResult.decision !== 'block') {
    return false;
  }
  const reason = stopResult.reason || 'Hook blocked termination';

  // ... rest unchanged (user_input_required, handoff_requested, default handling)
  // DELETED: duplicate bounds_exceeded block (was lines 2198-2218)
```

### Second-order effects

**1. Semantic shift: `realignCount` now means "total bounds hook calls", not "consecutive realigns without splits."**

The old model: splits = progress → reset counter. The new model: every bounds_exceeded call counts, period. This is a deliberate rejection of the "splitting is progress" assumption. The infinite loop bug proves that assumption is exploitable.

Concrete impact:
- **Split-only sequence:** 3 consecutive splits now hits the cap at `maxRealigns=3`. Previously: unlimited. A legitimate observer that decomposes work across 4+ bounds_exceeded events will now be capped. `maxRealigns` defaults to 3 — this is generous. If a real workflow needs more, the config can be increased.
- **Mixed sequence:** realign→split→realign now counts as 3, not 1. The counter is cumulative and monotonic (within a single handleStopHookBlock lifetime).

**2. Order of operations: bounds check before deferred work enqueue.**

When hitting the cap, the final hook's deferred work is NOT enqueued — `return false` fires before `enqueueDeferredWork`. This is correct: if we're force-terminating, orphaned work items would never execute. The caller's `harvestCompletedWork` collects what's already done.

**3. Patch system escape hatch is preserved.**

`applyPatches.ts:153` can still reset `realignCount` to 0 via `reset_counter: realign` patch. This runs inside `callStopHook` BEFORE `handleStopHookBlock`, so a hook that deliberately issues a reset patch can bypass the cap. This is intentional — patches are an explicit opt-in mechanism, not the automatic reset we're removing.

**4. Hook context exposure.**

`realignCount` is exposed read-only in `HookContext/StateView` (line 1814). After fix, hooks see higher values for the same sequence (splits now count). **Any hook that branches on `realignCount` will see different behavior.** This is a semantic contract change — the field now means "how many times has bounds_exceeded fired" rather than "how many consecutive realigns since last split." This should be documented.

**5. Deferred work is still enqueued for sub-cap calls.**

For bounds_exceeded calls that DON'T hit the cap, flow proceeds normally: deferred work is enqueued, function returns `true`. The only change is the counter isn't reset afterward. Splits still work — they add work items and signal continue. They just don't forgive prior realigns.

---

## Interaction between fixes

Bug 1b and Bug 3 both modify `handleStopHookBlock`. They compose cleanly:

1. Top of method: bounds cap check (Bug 3)
2. Deferred work processing, no reset (Bug 3)
3. Decision guard without reason check (Bug 1b)
4. Reason fallback variable (Bug 1b)
5. Per-terminationReason paths use `reason` (Bug 1b)
6. Default path uses `reason`, no duplicate bounds block (Bug 1b + Bug 3)

---

## Verification

```bash
# Edge-case tests (3 should flip from failing to passing)
cd packages/core/orchestrator && bun test orchestrator.edge-cases.test.ts

# Main orchestrator tests (regression check)
bun test orchestrator.test.ts

# Invariant tests (regression check — uses realignCount semantics)
bun test orchestrator.invariants.test.ts

# State machine tests (uses realignCount in state model)
bun test orchestrator.statemachine.test.ts
```
