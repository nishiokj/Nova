# Effect Migration Plan

## Current State

The codebase uses Effect in three tiers with different levels of commitment:

### Tier 1: Genuine Effect (working well, leave alone)

- **`runtime/control.ts`** — `Queue.Queue<RuntimeControlMessage>` for cancel flow. Typed E channel (`RuntimeExecutionError`). Functions return proper `Effect.Effect<A, E>`.
- **`llm/policies.ts`** — `resilientCall` composes `Effect.timeoutFail`, `Effect.retry` with `Schedule`, `Effect.tap`/`Effect.catchAll` for circuit breaker state. Typed error channel: `Effect.Effect<T, Error | CircuitOpenError | TimeoutError | RetriesExhaustedError>`.
- **`unifiedHooks/runner.ts`** — `Effect.gen` with `yield*`. `Effect.forEach` with `{ concurrency: 'unbounded' }` for parallel hook execution. `Effect.suspend` for deferred callbacks. `Effect.timeoutFail` per hook. Errors fully absorbed: `Effect.Effect<Result, never>`.

### Tier 2: Effect as Ceremony (orchestrator.ts)

The orchestrator wraps async work in Effect and immediately unwraps it via a `fromAsync`/`runEffect` bridge:

```typescript
private fromAsync<R>(operation: () => Promise<R>): Effect.Effect<R, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}
private runEffect<R, E>(effect: Effect.Effect<R, E>): Promise<R> {
  return Effect.runPromise(effect);
}
```

Pattern everywhere: `Promise → fromAsync → Effect → runEffect → Promise`. The E channel is `unknown` — untyped, unused. The execution loop (`runExecutionLoop`) is pure imperative async (`while`, `await`, mutable state). Effect is only present at boundaries calling into Tier 1 code.

One legitimate use: `Effect.acquireUseRelease` in `execute()` for onStart/cleanup lifecycle.

### Tier 3: Effect as LLM Call Wrapper (agent.ts)

Same `fromAsync`/`runEffect` bridge. `executeLoop` uses `Effect.gen` with `yield*` but every `yield*` is either:
1. `this.fromAsync(() => somePromise)` — wrapping own methods
2. `this.streamWithResilience(...)` — the one place that genuinely benefits (composes `resilientCall`)

`run()` returns `Effect.Effect<AgentResult, never>` — errors fully folded into result, E channel is `never`.

### What's Missing

| Concept | Current State | Effect Equivalent |
|---------|--------------|-------------------|
| Dependency injection | Constructor params | `Layer` + `Context.Tag` |
| Error handling | Try/catch → result object | Typed E channel |
| Concurrency | `Promise.all` + `AbortController` | `Fiber` + structured interruption |
| Resource lifecycle | Manual cleanup callbacks | `Scope` + `acquireRelease` |
| Shared mutable state | `Map`, instance fields | `Ref`, `TMap` |
| Runtime boundary | `Effect.runPromise` at every bridge | Single `Effect.runPromise` at edge |

---

## Migration Plan

### Phase 1: Agent internals — `fromAsync` → native Effect methods

**Why:** Biggest bang for buck. Eliminates round-tripping on the hot path. Enables typed LLM errors from `resilientCall` to flow through the generator instead of being caught in `handleLoopError` and flattened to strings.

**What:** `compactIfNeeded`, `buildIterationRequest`, `processToolCalls` — all private methods the agent controls — return `Effect.Effect<T, E>` instead of `Promise<T>`.

```typescript
// Before: Promise wrapped in Effect
yield* this.fromAsync(() => this.compactIfNeeded(localContext, localReadFiles, workItem));

// After: method returns Effect directly
yield* this.compactIfNeeded(localContext, localReadFiles, workItem);
```

**Typed LLM errors:** With `executeLoop` genuinely in Effect, `streamWithResilience`'s typed errors can be matched compositionally:

```typescript
const llmResult = yield* this.streamWithResilience({...}).pipe(
  Effect.catchTag("RateLimitError", (e) => /* set rateLimitInfo */),
  Effect.catchTag("TimeoutError", (e) => /* set timeout termination */),
);
```

This replaces the monolithic `handleLoopError` try/catch + instanceof chain.

### Phase 2: Orchestrator `executeInner` — Promise → Effect

**Why:** Eliminates the bridge in `execute()`. Makes `executeInner` composable with the `acquireUseRelease` scope without wrapping.

```typescript
// Before
execute(...): Effect.Effect<OrchestratorResult, never> {
  return Effect.acquireUseRelease(
    Effect.sync(() => runtime?.onStart?.(context)),
    () => Effect.tryPromise({ try: () => this.executeInner(...) }),  // Promise bridge
    ...
  )
}

// After
execute(...): Effect.Effect<OrchestratorResult, never> {
  return Effect.acquireUseRelease(
    Effect.sync(() => runtime?.onStart?.(context)),
    () => this.executeInner(...),  // already Effect
    ...
  )
}
```

Remove `this.runEffect(...)` calls inside the orchestrator — `runUnifiedDecisionHooks`, `takeAllRuntimeControl`, `agent.run()` all return Effect values that can be `yield*`'d directly when the orchestrator loop is Effect-native.

### Phase 3: Cancellation — polling loop → Fiber + Queue.take

**Why:** Correctness improvement. Eliminates 50Hz polling loop, `settled` flag, and manual cleanup. The control queue is already `Queue.Queue` from Effect.

**Before (orchestrator.ts:1148-1171):**
```typescript
let settled = false;
const monitorPromise = (async () => {
  while (!settled) {
    await this.syncRuntimeControlState(runtime);
    if (this.isRunScopedCancellation(...)) {
      this.quiesceInProgressWork(state, reason);
    }
    await new Promise(resolve => setTimeout(resolve, 20));  // 50Hz polling
  }
})();
```

**After:**
```typescript
const workFiber = yield* Effect.fork(
  this.executeInProgressWorkItems({ entries, context, cwd, iteration })
);
const monitorFiber = yield* Effect.fork(
  this.monitorRuntimeControl(runtime, state)  // blocks on Queue.take, no polling
);

const results = yield* Fiber.join(workFiber);
yield* Fiber.interrupt(monitorFiber);
```

`monitorRuntimeControl` uses `yield* Queue.take(queue)` — blocks the fiber until a message arrives, then interrupts the work fiber. No polling, no `settled` flag, no manual cleanup.

---

## What NOT To Do

- **Don't introduce Layers/Services/Context.** Constructor-based DI works. Layers would mean rewriting every call site for zero functional benefit.
- **Don't convert the termination state machine.** `checkTerminationConditions` → `handleStandardTermination` → `handleStopHookBlock` is complex business logic that reads fine as imperative code.
- **Don't convert `processToolCalls`.** 300 lines of sequential tool execution with pre/post hooks, parallel batching, and mutation. The imperative version is more readable.
- **Don't use `Ref` or `TMap` for the work queue.** Single-threaded runtime. Mutable maps are correct.
- **Don't try to type every E channel.** The orchestrator's `OrchestratorResult` with `terminationReason` is a fine domain model. Typed E only pays off at the agent-to-LLM boundary where `RateLimitError | CircuitOpenError | TimeoutError` carry actionable data.
