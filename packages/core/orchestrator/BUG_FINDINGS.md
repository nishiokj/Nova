# Orchestrator Bug Findings

Three bugs found via edge case test suite (`orchestrator.edge-cases.test.ts`).
Each has a failing test that asserts the correct behavior.

---

## Bug 1: Failed Quality Gate with Empty Issues Silently Passes

**Severity:** High — a observer can return `verdict: 'failed'` and the orchestrator ignores it.

**Root Cause:** Two functions conspire to drop the failure signal.

**Step 1** — `decision_mappers.ts:57`:
```ts
case 'failed':
  return { decision: 'block', reason: decision.issues.join('\n') };
```
When `issues` is `[]`, `[].join('\n')` produces `''` (empty string).
The StopHookResult becomes `{ decision: 'block', reason: '' }`.

**Step 2** — `orchestrator.ts:2157`:
```ts
if (stopResult.decision !== 'block' || !stopResult.reason) {
  return false;  // false = don't continue, let termination proceed
}
```
`!''` is `true`, so the condition short-circuits. The block is treated as a no-op.
Execution terminates as `goal_state_reached` with `success: true`.

**Data flow:**
```
QualityGateDecision { verdict: 'failed', issues: [] }
  → mapQualityDecisionToStopResult
  → StopHookResult { decision: 'block', reason: '' }
  → handleStopHookBlock checks !reason → '' is falsy → returns false
  → orchestrator treats goal as reached → success: true
```

**Impact:** Any quality gate hook that returns `failed` without populating the `issues` array will be silently ignored. The orchestrator reports success despite the observer explicitly rejecting the work.

**Failing test:** `"BUG: Failed Quality Gate with Empty Issues Silently Passes"` — asserts `result.success === false`, gets `true`.

**Fix options:**
- `decision_mappers.ts:57`: Use a fallback reason: `decision.issues.join('\n') || 'Quality gate failed'`
- `orchestrator.ts:2157`: Check `decision === 'block'` without requiring `reason`: separate the "should we block?" decision from "what message to inject?"

---

## Bug 2: Empty Handoff Silently Becomes goal_state_reached

**Severity:** Medium — planner thinks it delegated work, orchestrator thinks the goal was achieved. Silent semantic mismatch.

**Root Cause:** The agent's `isHandoffSpecCandidate` rejects specs with empty workItems, so the handoff path never fires.

**Step 1** — `agent.ts:3188`:
```ts
private isHandoffSpecCandidate(parsed: unknown): parsed is HandoffSpec {
  // ...
  if (!Array.isArray(spec.workItems) || spec.workItems.length === 0) return false;
  // ...
}
```
The spec has `workItems: []` (length 0), so this returns `false`.

**Step 2** — Since `isHandoffSpecCandidate` returns false, `handleHandoff` (agent.ts:611) never sets `result.needsHandoff = true`. The agent falls through to the structured output's `goalStateReached: true` field.

**Step 3** — `orchestrator.ts:2423`:
```ts
if (result.needsHandoff && result.handoffSpec) {
```
`needsHandoff` is `false`, so this entire block is skipped. The orchestrator proceeds to the `goalStateReached` check and terminates with `goal_state_reached`.

**Data flow:**
```
LLM returns: { action: 'handoff', goalStateReached: true, handoffSpec: { workItems: [] } }
  → Agent.isHandoffSpecCandidate({ workItems: [] }) → false
  → Agent never sets needsHandoff = true
  → Agent returns { goalStateReached: true, needsHandoff: false }
  → Orchestrator skips handoff block (line 2423)
  → Orchestrator sees goalStateReached: true → terminationReason: 'goal_state_reached'
```

The `handoff_requested` hook never fires. The planner explicitly said `action: 'handoff'` but the orchestrator reports the goal was reached.

**Impact:** If a planner produces a plan with no concrete work items (e.g., "nothing to do" or a degenerate plan), the system silently reports success instead of flagging the empty plan for review. The orchestrator and planner disagree about what happened.

**Failing test:** `"BUG: Empty Handoff Spec Silently Becomes goal_state_reached"` — asserts `result.terminationReason === 'handoff_requested'`, gets `'goal_state_reached'`.

**Fix options:**
- `agent.ts:3188`: Allow empty workItems in `isHandoffSpecCandidate` (let the orchestrator handle the empty case)
- `orchestrator.ts:2478-2479`: Already has the correct fallback ("log warning and pause for user") — it just never reaches it because the agent filters first

---

## Bug 3: Alternating Realign/Split Bypasses maxRealigns (Infinite Loop)

**Severity:** Critical — the orchestrator can loop forever with no termination.

**Root Cause:** `handleStopHookBlock` resets `realignCount` to 0 whenever deferred work is added, and the realign check only looks at the current counter value.

**The cycle:**

```
orchestrator.ts:2144-2145 (inside handleStopHookBlock):
  if (deferredWorkAdded) {
    this.realignCount = 0; // Reset - splitting work is progress
    ...
  }

orchestrator.ts:2204-2211 (later in same function):
  if (isBoundsExceeded) {
    this.realignCount++;
    if (this.realignCount > this.config.maxRealigns) {
      return false; // Force termination
    }
  }
```

With `maxRealigns: 2`, the intended behavior is: after 2 consecutive realigns, force-terminate. But the split path resets the counter:

```
Hook call 1: realign → realignCount becomes 1
Hook call 2: split  → deferredWorkAdded=true → realignCount reset to 0
Hook call 3: realign → realignCount becomes 1
Hook call 4: split  → deferredWorkAdded=true → realignCount reset to 0
Hook call 5: realign → realignCount becomes 1
Hook call 6: split  → realignCount reset to 0
... (forever)
```

`realignCount` never exceeds 1. The `> maxRealigns` check at line 2211 never fires. The loop continues indefinitely.

**Why the reset exists:** Line 2143 comments say "splitting work is progress." The assumption is that a split means the observer made a constructive change (broke work into pieces), so the realign counter should reset. But this assumption fails when a hook alternates strategies — the "progress" is illusory.

**Impact:** A misbehaving or adversarial observer hook can prevent the orchestrator from ever terminating. The only escape is an external kill signal. This defeats the purpose of `maxRealigns` as a safety bound.

**Failing test:** `"BUG: Alternating Realign/Split Bypasses maxRealigns"` — asserts `hookCalls <= 3` (2 realigns + 1 forced termination), gets `7` (3 realigns + 3 splits + 1 safety abort).

**Fix options:**
- Track `totalRealigns` separately from the resettable `realignCount`. Check `totalRealigns > maxRealigns` as a hard cap.
- Don't reset `realignCount` to 0 on split. Instead, decrement by 1 (so splits give partial credit but can't fully erase realign history).
- Add a `maxTotalBoundsHookCalls` config that caps the total number of times the bounds_exceeded hook can fire regardless of decision type.
