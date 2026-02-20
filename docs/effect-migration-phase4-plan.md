# Effect Migration Phase 4 — Eliminating Nested Runtimes

## Current State

Phases 1-2 removed `fromAsync`/`runEffect` bridge methods from both `agent.ts` and `orchestrator.ts`. The top-level entry points (`Agent.run()`, `Orchestrator.execute()`) return `Effect.Effect<Result, never>`, and the main execution loops (`executeLoop`, `runExecutionLoop`) are `Effect.gen` generators.

Phase 3 (fiber-based cancellation) failed due to Effect Queue signaling issues across runtime boundaries and was reverted to a 20ms polling loop.

Three categories of nested-runtime issues remain, all in the orchestrator.

## Problem: Nested Effect Runtimes

`runExecutionLoop` is an `Effect.gen`, but it delegates to async code that internally re-enters the Effect runtime via `Effect.runPromise`. This creates independent runtimes that can't share fiber supervision, structured concurrency, or typed error channels.

### Issue 1 — Work execution (3 levels deep)

```
Effect.gen (runExecutionLoop)
  → yield* executeInProgressWorkItemsWithRuntimeControl()       // Effect
    → Effect.promise(async () =>                                 // enters Promise-land
        Promise.all(entries.map(([_, ip]) =>
          executeSingleWorkItem(...)                              // async
            → await Effect.runPromise(agent.run({...}))          // re-enters Effect (nested!)
        ))
      )
```

`executeSingleWorkItem` (line 1045) calls `await Effect.runPromise(agent.run({...}))` and `runHookHandler` (line 485) calls `await Effect.runPromise(Effect.tryPromise({...}).pipe(...))`. Both are nested Effect invocations inside the outer `Effect.promise` wrapper.

### Issue 2 — Termination system (3 async hops between 2 Effect runtimes)

```
Effect.gen (runExecutionLoop)
  → yield* Effect.promise(() =>                                  // Promise wrapper
      terminationPolicy.checkIterationBounds()                   // async method
        → this.callStopHook()                                    // async
          → this.runControlHooks()                               // async
            → Effect.runPromise(                                 // re-enters Effect (nested!)
                runUnifiedDecisionHooks(event, ctx, registry)
              )
    )
```

`TerminationPolicy` and `CadenceAuditor` interfaces return `Promise`, forcing all callers in the Effect.gen to use `yield* Effect.promise(() => ...)`. Their implementations internally call `callStopHook()` → `runControlHooks()` → `Effect.runPromise(runUnifiedDecisionHooks(...))`.

### Issue 3 — Polling-based cancellation

`executeInProgressWorkItemsWithRuntimeControl` (line 1121) wraps a 20ms polling loop inside `Effect.promise(async () => {...})`, calling `Effect.runPromise(this.syncRuntimeControlState(runtime))` each cycle. This adds 0-20ms cancellation latency and prevents fiber-based structured concurrency.

---

## Fix A: Convert Work Execution to Effect

Eliminates `Effect.runPromise(agent.run())` and `Promise.all` inside `Effect.promise`.

### A1. `runHookHandler` (line 485)

- **Change:** `async` → `Effect.Effect<void>`
- **Why:** The `await Effect.runPromise(Effect.tryPromise({...}).pipe(...))` becomes a direct `yield*` — no nested runtime. This is where the abort-race timing bug lived; making it native Effect removes that entire class of issue.

### A2. `executeSingleWorkItem` (line 1045)

- **Change:** `async` returning `Promise<WorkExecutionResult>` → `Effect.Effect<WorkExecutionResult>`
- **Details:**
  - `await this.runHookHandler(...)` → `yield* this.runHookHandler(...)`
  - `await Effect.runPromise(agent.run({...}))` → `yield* agent.run({...})` — the key win
  - `try/catch` → `Effect.catchAll` or `Effect.gen` with `Effect.tryPromise`

### A3. `executeInProgressWorkItems` (line 1103)

- **Change:** `async` returning `Promise<WorkExecutionResult[]>` → `Effect.Effect<WorkExecutionResult[]>`
- **Details:** `Promise.all(entries.map(...))` → `Effect.forEach(entries, ..., { concurrency: 'unbounded' })`

### A4. `executeInProgressWorkItemsWithRuntimeControl` (line 1121)

- **Change:** Remove the `Effect.promise(async () => {...})` wrapper — body becomes direct Effect composition
- **Details:** The polling loop changes shape (see Fix C)

### A5. Call site in `runExecutionLoop` (line 1332)

- Already `yield* this.executeInProgressWorkItemsWithRuntimeControl(...)` — **no change needed**

---

## Fix B: Convert Termination System to Effect

Eliminates the `yield* Effect.promise(() => terminationPolicy.check...())` → async → `Effect.runPromise(runUnifiedDecisionHooks(...))` three-level nesting.

### Interfaces (2 changes)

#### B1. `TerminationPolicy` interface (line 308)

```typescript
// Before
checkIterationBounds(...): Promise<{ terminal: OrchestratorResult | null; shouldContinue: boolean }>;
checkResult(...): Promise<TerminationCheckResult>;

// After
checkIterationBounds(...): Effect.Effect<{ terminal: OrchestratorResult | null; shouldContinue: boolean }>;
checkResult(...): Effect.Effect<TerminationCheckResult>;
```

#### B2. `CadenceAuditor` interface (line 331)

```typescript
// Before
maybeAudit(resultsByWorkId: Map<string, AgentResult>): Promise<void>;

// After
maybeAudit(resultsByWorkId: Map<string, AgentResult>): Effect.Effect<void>;
```

### Core hook pipeline (3 methods)

#### B3. `runControlHooks` (line 2107)

- **Change:** `async` → `Effect.Effect<ControlHookExecutionResult<D>>`
- **Key win:** `await Effect.runPromise(runUnifiedDecisionHooks(...))` → `yield* runUnifiedDecisionHooks(...)` — eliminates the nested runtime at the bottom of every termination chain. `runUnifiedDecisionHooks` already returns `Effect`.

#### B4. `runMappedStopHookDecision` (line 2286)

- **Change:** `async` → `Effect.Effect<StopHookResult | null>`
- **Details:** Calls `runControlHooks` — now a direct `yield*`

#### B5. `callStopHook` (line 2298)

- **Change:** `async` returning `Promise<StopHookResult | null>` → `Effect.Effect<StopHookResult | null>`
- **Details:** Calls `runMappedStopHookDecision` — now a direct `yield*`. Large method (~100 lines) but mechanically straightforward: `async` → `Effect.gen`, `await` → `yield*`.

### Termination condition handlers (7 methods)

#### B6. `checkTerminationConditions` (line 2614)

- **Change:** `async` → `Effect.Effect<TerminationCheckResult>`
- **Details:** Dispatches to all handlers below

#### B7. `handleStandardTermination` (line 2733)

- **Change:** `async` → `Effect.Effect<TerminationCheckResult>`
- **Details:** Used by ~8 termination reasons (user_stopped, refusal, agent bounds, rate_limit, circuit_open, timeout, agent_error, hard error catch-all). Calls `callStopHook` → now `yield*`.

#### B8. `handleUserInputRequired` (line 2787)

- **Change:** `async` → `Effect.Effect<TerminationCheckResult>`
- **Details:** Calls `callStopHook` → now `yield*`

#### B9. `handleObserverStopped` (line 2837)

- **Change:** Already sync → wrap return in `Effect.succeed(...)` (trivial, 1-line change)

#### B10. `handleObserverWorkItemStopped` (line 2857)

- **Change:** Already sync → wrap return in `Effect.succeed(...)` (trivial, 1-line change)

#### B11. `handleContinuableError` (line 2886)

- **Change:** `async` → `Effect.Effect<TerminationCheckResult>`
- **Details:** Calls `callStopHook` → now `yield*`

#### B12. `handleOrchestratorToolCallBounds` (line 2964)

- **Change:** `async` → `Effect.Effect<TerminationCheckResult>`
- **Details:** Calls `callStopHook` → now `yield*`

### Factory methods (2 methods)

#### B13. `createTerminationPolicy` (line 705)

- **Change:** Both closures change from `async () => {...}` to `() => Effect.gen(this, function* () {...})`
- **Details:**
  - `checkIterationBounds` closure calls `callStopHook` → now `yield*`
  - `checkResult` closure calls `checkTerminationConditions` → now `yield*`

#### B14. `createCadenceAuditor` (line 764)

- **Change:** `maybeAudit` closure: `async () => {...}` → `() => Effect.gen(this, function* () {...})`
- **Details:** Calls `callStopHook` → now `yield*`

### Call sites in `runExecutionLoop` (5 removals)

#### B15. Line 1299

```typescript
// Before
const iterationCheck = yield* Effect.promise(() => terminationPolicy.checkIterationBounds({...}));

// After
const iterationCheck = yield* terminationPolicy.checkIterationBounds({...});
```

#### B16. Line 1383

```typescript
// Before
const checkResult = yield* Effect.promise(() => terminationPolicy.checkResult({...}));

// After
const checkResult = yield* terminationPolicy.checkResult({...});
```

#### B17. Line 1432

```typescript
// Before
const stopResult = yield* Effect.promise(() => this.callStopHook({...}));

// After
const stopResult = yield* this.callStopHook({...});
```

#### B18. Line 1478

```typescript
// Before
yield* Effect.promise(() => cadenceAuditor.maybeAudit(resultsByWorkId));

// After
yield* cadenceAuditor.maybeAudit(resultsByWorkId);
```

#### B19. Line 1490

```typescript
// Before
const stopResult = yield* Effect.promise(() => this.callStopHook({...}));

// After
const stopResult = yield* this.callStopHook({...});
```

### New boundary created (1 accepted trade-off)

#### B20. `cadenceCheck` callback in `createAgent` (line 1744)

- **Current:** `await this.runControlHooks(...)` (both async)
- **After:** `await Effect.runPromise(this.runControlHooks(...))` — new nested-runtime boundary
- **Rationale:** `cadenceCheck` implements the `AgentHooks.cadenceCheck` interface, which returns `Promise<AgentCadenceResult>`. Converting it to Effect would cascade into the Agent's `AgentHooks` type in `types.ts` and every hook consumer across the codebase. This is a cross-module boundary — the orchestrator implements the callback, the agent calls it. The nested runtime here is an accepted trade-off.

---

## Fix C: Fiber-Based Cancellation

**Depends on Fix A** (work execution is now Effect, so fibers can supervise agent runs).

### C1. Import `Fiber` (line 10)

Add `Fiber` to the `effect` import:

```typescript
import { Effect, Fiber } from 'effect';
```

### C2. Import `takeRuntimeControl` from runtime package

Add blocking single-take alongside existing `takeAllRuntimeControl`:

```typescript
import {
  takeAllRuntimeControl,
  takeRuntimeControl,
  type RuntimeControlMessage,
  type RuntimeControlQueue,
} from 'runtime';
```

### C3. Create `monitorRuntimeControl` method (new, ~15 lines)

Blocking loop that yields on `takeRuntimeControl(queue)` instead of polling:

```typescript
private monitorRuntimeControl(
  queue: RuntimeControlQueue,
  state: ExecutionState
): Effect.Effect<void> {
  return Effect.gen(this, function* () {
    while (true) {
      const message = yield* takeRuntimeControl(queue); // blocks until message arrives
      this.applyRuntimeControlMessage(message);
      if (this.isRunScopedCancellation(this.runtimeRunControl)) {
        const reason = this.runtimeRunControl.cancellation?.reason
          ?? 'Execution cancelled by runtime control';
        this.quiesceInProgressWork(state, reason);
        return;
      }
    }
  });
}
```

### C4. Rewrite `executeInProgressWorkItemsWithRuntimeControl` body

Replace polling loop with fiber fork/join:

```typescript
private executeInProgressWorkItemsWithRuntimeControl(params: {
  entries: Array<[string, InProgressWork]>;
  context: ContextWindow;
  cwd: string;
  iteration: number;
  runtime?: OrchestratorRuntime;
  state: ExecutionState;
}): Effect.Effect<WorkExecutionResult[]> {
  const { entries, context, cwd, iteration, runtime, state } = params;

  const workEffect = this.executeInProgressWorkItems({ entries, context, cwd, iteration });

  if (!runtime?.controlQueue) {
    return workEffect;
  }

  return Effect.gen(this, function* () {
    const workFiber = yield* Effect.fork(workEffect);
    const monitorFiber = yield* Effect.fork(
      this.monitorRuntimeControl(runtime.controlQueue, state)
    );
    const results = yield* Fiber.join(workFiber);
    yield* Fiber.interrupt(monitorFiber);
    return results;
  });
}
```

This deletes the entire `settled`/`monitorPromise`/`setTimeout(20)` polling loop.

### C5. Runtime package — `takeRuntimeControl` (blocking take)

Verify or implement a blocking single-take from the `RuntimeControlQueue`. `takeAllRuntimeControl` (non-blocking batch drain) already exists. The blocking variant needs to suspend the fiber until a message is available.

### C6. Queue producer signaling (risk area)

The harness pushes cancel messages from outside the Effect runtime. The fiber blocked on `Queue.take(...)` must wake up when the producer calls `Queue.offer(...)` from Promise-land (likely via `Effect.runSync(Queue.offer(...))`).

**This is where Phase 3 failed.** Options if it fails again:

- **Deferred side-channel:** Use an `Effect.Deferred` as a notification mechanism alongside the queue. Producer resolves the Deferred; monitor fiber races `Queue.take` with `Deferred.await`.
- **Native JS signal:** Use a shared `Promise` that resolves on offer, polled via `Effect.tryPromise` with immediate retry (still removes the fixed 20ms interval).
- **Producer in Effect:** Restructure so the producer also runs inside the Effect runtime, ensuring both sides share the same scheduler.

---

## What Does NOT Change

Per the original migration plan's "What NOT to do" section, the following stay as-is:

- **No `Layer`/`Service`/`Context.Tag`** — constructor DI is correct for this codebase
- **No `Ref`/`TMap`** — single-threaded runtime, mutable maps are correct
- **`processToolCalls`** (agent.ts, line 1945) — stays as `Promise<void>` (300+ lines of imperative mutation with sequential tool execution, pre/post hooks, repeat detection, and sub-agent dispatch)
- **`handleLoopError`** (agent.ts) — stays synchronous `instanceof` chain
- **`handleStopHookBlock`** (orchestrator.ts, line 2408) — stays synchronous (returns `boolean`). Called after `callStopHook` resolves; the result is passed in, no async needed.
- **`awaitHookAbort`** (orchestrator.ts, line 466) — already a proper `Effect.async`
- **Agent.ts** — no further changes needed. The `run()` → `executeLoop()` boundary is clean. The only `Effect.runPromise` call is in `executeAgentToolCall` (line 2505) which is inside `processToolCalls` (stays async).
- **`AgentHooks.cadenceCheck` interface** — stays `Promise`-returning to avoid cascading type changes across agent/orchestrator boundary (see B20)

---

## Execution Order

| Phase | Depends On | Methods | Est. Lines |
|-------|-----------|---------|------------|
| Fix A | — | 4 | ~120 |
| Fix B | — | 14 methods + 2 interfaces + 5 call sites | ~400 |
| Fix C | Fix A | 1 new + 1 rewrite + 2 runtime pkg | ~60 |
| **Total** | | **~25 touch points** | **~580** |

- Fix A and Fix B are independent — can be done in parallel or either order
- Fix C depends on Fix A
- Each fix should end with `bun run build` + `bun run test` verification
- Recommended order: **Fix B → Fix A → Fix C** (Fix B is the largest surface area but most mechanical; Fix A unlocks Fix C)

## Verification

After each fix:

1. **TypeScript compilation:** `bun run build` from repo root
2. **Test suite:** `bun run test` — existing test files:
   - `tests/orchestrator/orchestrator.test.ts`
   - `tests/orchestrator/orchestrator.edge-cases.test.ts`
   - `tests/orchestrator/orchestrator.invariants.test.ts`
   - `tests/orchestrator/orchestrator.statemachine.test.ts`
   - `tests/orchestrator/unifiedHooks.test.ts`
   - `tests/agent/agent.test.ts`
3. **Known pre-existing failures:** 3 tests referencing `result.paused` (does not exist on `OrchestratorResult`) — these are pre-existing and unrelated
