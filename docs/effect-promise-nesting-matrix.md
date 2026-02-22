# Effect/Promise Nesting Map

This maps where `Effect` composition is primary and where `Promise` / `async` boundaries are used in:
- `packages/core/orchestrator/src/orchestrator.ts`
- `packages/core/agent/src/agent.ts`

## `orchestrator.ts`

### 1) Primary Effect-first execution flow
- `Orchestrator.execute(...)` -> `Effect.Effect<OrchestratorResult, never>`
- `executeInner(...)` -> `Effect.Effect<OrchestratorResult>`
- `runExecutionLoop(...)` -> `Effect.gen(...)`
- `executeInProgressWorkItems(...)` -> `Effect.forEach(..., { concurrency: 'unbounded' })`
- `executeInProgressWorkItemsWithRuntimeControl(...)` -> `Effect.fork` + `monitorControlQueue`
- `checkTerminationConditions(...)`, `handle...` handlers, `runControlHooks(...)` and related helpers

### 2) Promise islands (bridges inside Effect)
- `createHookQueue(...)` creates internal hook work items with `handler: (signal?) => this.executeEffectHook(event, context, signal)`
- `executeEffectHook(...)` is `async` and delegates to runtime executor callback (Promise)
- `runHookHandler(...)`
  - accepts `handler: (signal?) => Promise<void>`
  - wraps via `Effect.tryPromise(...)`
  - races with `Effect.raceFirst(this.awaitHookAbort(...))`
- `awaitHookAbort(...)` uses `Effect.async(...)` and abort event listeners
- `runExecutionLoop(...)` invokes:
  - `yield* Effect.promise(() => Promise.resolve(runtime.onIteration!(...)))`
- `createAgent(...)` defines `cadenceCheck` as `async` and in cadence path calls:
  - `await Effect.runPromise(this.runControlHooks<'cadence_audit'>(...))`

### 3) What this means in practice
- Orchestrator is largely **Effect-owned**.
- Promises are mainly used for **runtime callbacks** (hook execution, external iterator hooks, callback bridges) and then re-entered into Effect.

---

## `agent.ts`

### 1) Primary Effect-first execution flow
- `Agent.run(...)` -> `Effect.gen(...)`
- `executeLoop(...)` -> `Effect.gen(...)`
- `buildIterationRequest(...)` and `buildMemoryInjection(...)` -> `Effect.Effect<...>`
- `streamWithResilience(...)` -> `Effect.Effect<{ response: LLMResponse }, ...>`
- `autoReadTargetFiles(...)` -> `Effect.gen(...)`
- `executeAgentToolCall(...)` -> `Effect.gen(...)`

### 2) Promise islands (bridges inside Effect)
- `executeLoop(...)` uses:
  - `yield* Effect.tryPromise(...)` for cadence hook callback
  - `yield* Effect.promise(() => this.processToolCalls(...))` to call async tool processor
- `processToolCalls(...)` is `async`
  - awaits tool hooks and tool dispatch
  - invokes `flushParallel()` to `await Promise.all(batch.map((item) => item.run()))`
- `applyPreToolUseHook(...)` and `applyPostToolUseHook(...)` are `async`
- `streamWithResilience(...)` internally uses `Stream.runForEach` over `llm.stream(...)` (stream likely promise-like, but wrapped in Effect)
- `autoReadTargetFiles(...)` calls tool read operations with `Effect.tryPromise` wrapper
- `Agent.run(...)` also catches effect-level defects and returns to Effect context.

### 3) What this means in practice
- Agent is also Effect-first, but a few richer async flows remain:
  - tool-call processing is currently `async` and includes `Promise.all`
  - hook callbacks (`preToolUse`, `postToolUse`) are async and directly awaited in tool pipeline
  - these are then re-normalized into `Effect` via `Effect.promise`/`Effect.tryPromise` where called from effect context.
