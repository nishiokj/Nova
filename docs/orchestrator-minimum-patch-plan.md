# Orchestrator minimum patch plan (low-hanging fruit)

Target: `@packages/agent-core/src/orchestrator/orchestrator.ts`

Goals of this patch plan:
- **Less work per iteration** (hot path): fewer `Date.now()` calls, fewer object allocations, fewer repeated event payload objects.
- **Clearer bounds semantics** (iterations/tool calls/duration) and fewer off-by-one ambiguities.
- **Better TS ergonomics**: narrow types, remove dead imports, keep helpers DRY without adding net-new complexity.

This is intentionally a **surgical plan**: replace small pieces of the existing code rather than introducing new abstractions.

---

## 0) Remove unused imports (free win)

### Change
In `orchestrator.ts`, remove unused type imports:
- `LLMRequestConfig` (unused)
- `AgentResult` (unused)

### Why
- Avoids wasted type-checking/IDE noise.
- Keeps the file tighter and more self-evident.

### What it looks like after
The import block becomes smaller; no runtime change.

---

## 1) Cache iteration timing + avoid repeated `Date.now()` (hot path)

### Current issue
Within each loop iteration the code calls `Date.now()` multiple times:
- to compute `elapsed`
- inside result creation metrics
- later again for log/event payloads

This is minor but happens on the hot path for every iteration.

### Minimal patch
At the top of each loop iteration, compute `now` once:
```ts
const now = Date.now();
const elapsed = now - startTime;
```
Then replace later `Date.now() - startTime` in that iteration with `elapsed` (or with `now - startTime` if `elapsed` must reflect the same `now`).

### Why it improves things
- Fewer system calls and fewer micro-allocations.
- More consistent metrics timestamps within a single iteration.

### Post-patch behavior
No functional change—just cheaper and more deterministic elapsed reporting.

---

## 2) Move tool-call bound check earlier (cheaper early exit)

### Current issue
`maxToolCalls` is checked **after** agent execution and multiple terminal checks. If the agent blew the budget, we still do extra work (events/logging checks) before returning.

### Minimal patch
After updating `totalToolCalls`/`totalLlmCalls` (right after `agent.run` resolves), check tool-call budget immediately:
- If exceeded, emit `goal_not_achieved`, add agent result to context (if desired for debugging continuity), and return.

This is a pure reorder of existing logic. No new concepts.

### Why it improves things
- Reduces unnecessary work once we already know we must stop.
- Makes the control flow more “bounds first” after agent execution.

### Post-patch behavior
Same termination reason (`max_tool_calls_exceeded`), but returns sooner.

---

## 3) Consolidate repeated `goal_not_achieved` event payloads (reduce allocations + duplication)

### Current issue
Several termination branches build nearly identical payloads:
```ts
this.emit(createEvent('goal_not_achieved', { goal, reason: '...', completed: 0, failed: 0/1, skipped: 0 }))
```
This duplication increases file size and makes future changes error-prone.

### Minimal patch
Introduce a tiny local helper **inside** `execute` (to avoid adding new exported utilities):
```ts
const emitGoalNotAchieved = (reason: string, failed = 0) =>
  this.emit(createEvent('goal_not_achieved', { goal, reason, completed: 0, failed, skipped: 0 }));
```
Then replace each repeated block with `emitGoalNotAchieved('max_iterations_exceeded')`, etc.

### Why it improves things
- Less duplicated code → fewer maintenance mistakes.
- Slightly fewer object constructions (still one per call, but reduces repeated literal creation and review surface).

### Post-patch behavior
No event schema changes; event payloads remain identical.

---

## 4) Fix/clarify the `WorkItem.bounds.maxLlmCalls` mapping (likely correctness bug)

### Current code
In `createWorkItem`:
```ts
maxLlmCalls: agentBudget?.maxIterations ?? this.config.maxIterations,
```
This maps *iterations* → *LLM calls*, which are not the same unit.

### Minimal patch options (choose the least invasive that matches your existing budget model)

**Option A (safest semantics):** rename the mapping to be explicit and preserve behavior
- If `WorkItem.bounds.maxLlmCalls` is actually intended to be “agent loop iterations”, then it should be `maxIterations`, not `maxLlmCalls`.
- That would require changing the `WorkItem` type and is *not* minimal.

**Option B (minimal behavior fix):** stop pretending iterations == LLM calls
- Use orchestrator’s maxIterations only where the name matches.
- Set `maxLlmCalls` to `undefined` or a derived value if the `WorkItem` supports it.

**Option C (minimal within current schema):** map from a *real* max LLM calls budget
- If runtime config has a `maxLlmCalls` somewhere, use it.
- Otherwise fall back to a conservative derived limit, e.g. `maxIterations` (but document it).

### Recommendation
Do **Option C** if runtime config already has (or can easily get) an LLM-call budget; otherwise do **Option B** and document that work item doesn’t enforce LLM call count.

### Why this matters
Incorrect bounds metadata can cause:
- dashboards to show misleading limits
- agent behaviors to optimize for wrong constraints
- inconsistent enforcement if some layers interpret bounds differently

---

## 5) Make `createAgent` fallback consistent with `execute` default agentType

### Current issue
`execute(..., agentType = 'standard')` defaults agent type, but `createAgent` returns `null` if the registry has no runtime for that type.

If `'standard'` is not present in `AgentRegistry`, orchestration fails immediately.

### Minimal patch
If registry lookup fails, try a fallback runtime:
- first try requested `agentType`
- then try `'standard'` (if different)
- then `null`

This is a small conditional in `createAgent`, no new dependencies.

### Why it improves things
- More robust execution in environments where the registry is partially configured.
- Avoids user-facing “Unknown agent type” for a reasonable default.

### Post-patch behavior
Still fails if no suitable runtime exists, but does not fail due to missing alias.

---

## 6) Reduce per-iteration allocations in `iteration_completed` event

### Current issue
Every iteration constructs an event payload with a `result` object and slices response:
```ts
response: result.response?.slice(0, 200)
```

### Minimal patch
- Only slice when response is present and longer than 200.
- (Optional) store a `const responsePreview = ...` so it’s computed once.

### Why it improves things
Tiny CPU/memory win on hot path (especially if responses are often short).

### Post-patch behavior
Event payload identical for long responses; for short responses it avoids extra work.

---

## 7) Compacting: avoid calling `compact()` when already compacted “this iteration”

### Current issue
The loop compacts whenever `context.isNearFull(0.8)`. If the compact doesn’t recover enough (or context grows again due to agent output), it may compact repeatedly on subsequent iterations.

This may be desirable, but compacting can be expensive.

### Minimal patch
Add a simple hysteresis gate using a threshold pair (no new state persisted outside execute):
- compact when ≥ 0.8
- don’t compact again until usage drops below e.g. 0.7

Implementation is tiny: a local boolean `let compactedRecently = false;` and toggle it based on `context.metrics.percentageUsed`.

### Why it improves things
Prevents repeated expensive compactions when hovering around the threshold.

### Post-patch behavior
Compaction still happens when needed, just not thrash-y.

---

## Expected system state after patch

- Orchestrator loop does **less bookkeeping work per iteration**.
- Termination paths are **more uniform** and easier to maintain.
- `WorkItem` bounds metadata is **less misleading** (or correctly mapped).
- Agent selection is **more resilient** to registry misconfiguration.
- Context compaction is **less likely to thrash** near the threshold.

---

## Verification checklist (fast)

1. Typecheck:
   - `pnpm -w -C ../../packages/agent-core lint` (or the repo’s equivalent)
2. Run a simple orchestration flow:
   - confirm events still fire with identical names/payload shapes
   - confirm termination reasons unchanged
3. Run with forced bounds:
   - small `maxIterations`, small `maxToolCalls`, small `maxDurationMs` to ensure each branch triggers correctly

---

## Patch size expectations

All suggested changes are designed to be done in-place within `orchestrator.ts` with:
- **net negative** lines (deduplication + unused imports)
- or **very small net positive** lines (one tiny helper + optional hysteresis flag)
