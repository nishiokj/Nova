# Microqueue: minimum, surgical hot-path patch plan (Bun single CPU)

## Goal
Reduce **single-thread CPU monopolization** on the hot path (agent execution + orchestration loop) by introducing **cooperative yielding** via a microqueue.

We want:
- very low net-new code
- minimal behavior changes
- improved responsiveness under tool-call bursts / large contexts

## Where the CPU hot paths are today
### 1) `Agent.processToolCalls()` (tight synchronous loop)
File: `@packages/agent-core/src/agent/agent.ts`

Hot-path synchronous work per tool call includes:
- event creation + `emit(createEvent(...))`
- context mutation: `localContext.appendItem(...)`, `localReadFiles` bookkeeping
- repeat detection: `JSON.stringify(call.arguments)`, string slicing
- flush parallel batch: `Promise.all(...)` then result handling loop

On Bun (single CPU), if an LLM returns many tool calls (or tool results are large), these synchronous sections can **block the event loop**, delaying:
- IPC / HTTP handlers
- log/event drain
- other async operations

### 2) `Agent.buildMessages()` (O(n) over full context)
File: `@packages/agent-core/src/agent/agent.ts`

Every LLM call:
- merges global + local items
- scans all items to build `callIdsWithOutputs`
- loops again to build messages

This is also a synchronous burst proportional to context length.

### 3) `Orchestrator.execute()` (loop governor)
File: `@packages/agent-core/src/orchestrator/orchestrator.ts`

Even though most work is awaited, each iteration performs:
- context `isNearFull` + `compact` (can be expensive)
- multiple emits and `slice` operations
- loop continues immediately

A single `await Promise.resolve()` yield per iteration helps avoid starving the microtask queue when combined with other synchronous work.

## Proposed minimal patch: microqueue cooperative yielding
### Key idea
Introduce a tiny utility that allows us to **periodically yield** during large synchronous bursts.

This is not about parallelism; it’s about **fairness** on a single CPU.

### 1) Add a tiny microqueue helper (net-new: ~40–70 LOC)
New file:
- `@packages/agent-core/src/shared/microqueue.ts`

Minimal API:
- `createMicroQueue({ yieldEvery?: number, timeSliceMs?: number })`
- `yieldIfNeeded(): Promise<void>`

Implementation approach (simple and Bun-friendly):
- count operations and `await Promise.resolve()` every N ops
- optionally also yield if time slice exceeded (`Date.now()` delta)

This keeps code small and avoids introducing dependencies.

### 2) Wire microqueue into `Agent.processToolCalls()` (lowest-hanging fruit)
Surgical changes:
- instantiate `const mq = createMicroQueue({ yieldEvery: 10 });`
- inside the `for (const call of toolCalls)` loop, after each iteration (or after every few), call:
  - `await mq.yieldIfNeeded();`
- inside `flushParallel()` result handling loop, also call `await mq.yieldIfNeeded()`

Why this helps:
- prevents long runs of synchronous bookkeeping (emit/context/JSON stringify) from blocking the event loop
- makes tool-call bursts “chunked” without changing ordering/semantics

### 3) Optional: protect the message-building hot path
Two options:

**Option A (smallest diff)**: *skip this* for now.
- microqueue only in tool calls already yields a lot in typical runs

**Option B (still small, but broader)**:
- convert `buildMessages()` to `async`
- add periodic `await mq.yieldIfNeeded()` inside the loops over `allItems`

Why this helps:
- large histories won’t cause a single synchronous “scan spike” per LLM call

Tradeoff:
- makes the call site `await this.buildMessages(...)` (slightly wider diff)

### 4) Add a yield in `Orchestrator.execute()`
Surgical one-liner:
- near end of each loop iteration (or just before calling `agent.run`):
  - `await Promise.resolve();`

Why this helps:
- increases scheduling fairness between iterations
- ensures compaction + emit bursts don’t chain tightly with subsequent work

## Why this is safe
- We are not changing ordering of tool results or messages
- We are not adding concurrency
- We only yield control **between** logically independent steps

## Expected outcome
After patch:
- under heavy tool-call bursts, the daemon remains responsive
- reduced tail latency for unrelated requests/events
- fewer “stall” periods due to long synchronous loops

## Patch footprint summary
- **New**: `src/shared/microqueue.ts`
- **Edit**: `src/agent/agent.ts` (add microqueue yields in tool-call handling; optionally async message building)
- **Edit**: `src/orchestrator/orchestrator.ts` (single yield per iteration)

## Validation
- `npx tsc --noEmit` in `packages/agent-core`
- run any existing harness-daemon integration that triggers many tool calls
- optionally add a micro-benchmark (dev-only) to simulate 100 tool calls and observe event-loop responsiveness
