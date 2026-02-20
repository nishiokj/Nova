# Effect-First Runtime Migration Plan

## Scope Lock

- Full breaking migration to Effect-first runtime across `llm`, `tools`, `agent`, `orchestrator`, and harness integration.
- No compatibility wrappers; old Promise/AsyncGenerator surfaces are removed, not deprecated.
- No dual execution path flags; one runtime path only.

## Non-Negotiable Invariants

1. Every started work unit has a terminal lifecycle event.
2. Pause/cancel cannot return until child fibers/resources are finalized.
3. No subprocess survives scope exit (normal, error, pause, cancel).
4. No fire-and-forget execution in orchestrator, hooks, tools, or sub-agent calls.
5. Retries/timeouts/circuit behavior are expressed only via Effect policies (single source of truth).

## Patch Sets (Surgical Sequence)

### Patch 01: Runtime Kernel Package

- **Files**
  - `package.json`
  - `packages/core/runtime/package.json`
  - `packages/core/runtime/src/index.ts`
  - `packages/core/runtime/src/control.ts`
  - `packages/core/runtime/src/supervision.ts`
  - `packages/core/runtime/src/cancellation.ts`
  - `packages/core/runtime/src/errors.ts`
  - `packages/core/runtime/src/tracing.ts`
- **Work**
  - Add Effect runtime primitives (`Queue` control channel, `FiberSet` supervision, scoped finalizer helpers, typed execution errors).
- **Delete**
  - None.
- **Gate**
  - Package builds/lints standalone.

### Patch 02: Shared Type Contract Rewrite

- **Files**
  - `packages/core/types/src/llm.ts`
  - `packages/core/types/src/tools.ts`
  - `packages/core/types/src/events.ts`
  - `packages/core/types/src/event_schemas.ts`
  - `packages/core/types/src/index.ts`
  - `packages/core/agent/src/types.ts`
  - `packages/core/orchestrator/src/orchestrator.ts`
- **Work**
  - Change core interfaces to Effect-native (`LLMAdapter`, tool executor contracts, run control events, cancellation/pause metadata).
- **Delete**
  - Old type members that imply Promise-only flow.

### Patch 03: Protocol Patch Semantics for In-Flight Cancellation

- **Files**
  - `packages/core/protocol/src/effects/patches.ts`
  - `packages/core/orchestrator/src/hookRunner/applyPatches.ts`
  - `packages/core/protocol/src/index.ts`
- **Work**
  - Extend `cancel_work` semantics to target queued + in-progress work.
  - Add explicit patch data for cancellation scope/reason.
  - Enforce validation for new cancellation semantics.
- **Delete**
  - Queue-only cancellation assumption.

### Patch 04: LLM Adapter + Providers Effect-First

- **Files**
  - `packages/core/llm/src/adapter.ts`
  - `packages/core/llm/src/index.ts`
  - `packages/core/llm/src/providers/types.ts`
  - `packages/core/llm/src/providers/openai.ts`
  - `packages/core/llm/src/providers/anthropic.ts`
  - `packages/core/llm/src/providers/openai-compat.ts`
  - `packages/core/llm/src/providers/vercel-gateway.ts`
  - `packages/core/llm/src/providers/codex.ts`
  - `packages/core/llm/src/providers/registry.ts`
  - `packages/core/llm/package.json`
- **Work**
  - Convert provider `respond/stream` to Effect/Stream with scoped abort + reader cleanup + typed interruption causes.
  - Migrate polling/timeout/retry to `Schedule` + `Effect.timeout`.
- **Delete**
  - `packages/core/llm/src/retry.ts` and all exports/imports tied to it.

### Patch 05: Tool Runtime with Scoped Resource Control

- **Files**
  - `packages/core/tools/src/types.ts`
  - `packages/core/tools/src/registry.ts`
  - `packages/core/tools/src/index.ts`
  - `packages/core/tools/src/builtins/bash.ts`
  - `packages/core/tools/src/builtins/read.ts`
  - `packages/core/tools/src/builtins/write.ts`
  - `packages/core/tools/src/builtins/web_fetch.ts`
  - `packages/core/tools/src/builtins/web_search.ts`
  - `packages/core/tools/package.json`
- **Work**
  - Make tool execution Effect-based.
  - Propagate cancellation context.
  - Enforce `acquireRelease` on subprocess/network resources.
  - Replace Promise timeout wrappers with interruption-safe scope finalizers.
- **Delete**
  - `executeWithTimeout` path in `packages/core/tools/src/registry.ts`.

### Patch 06: Agent Loop Decomposition and Supervision

- **Files**
  - `packages/core/agent/src/agent.ts`
  - `packages/core/agent/src/types.ts`
  - `packages/core/agent/src/index.ts`
  - `packages/core/agent/package.json`
- **Work**
  - Replace imperative loop with Effect loop.
  - Split iteration phases into composable effects.
  - Supervise parallel tool calls + sub-agent calls under shared scope.
  - Propagate control messages (`continue`, `stop`, `pause`) through typed directives.
  - Make iteration finalization single-path.
- **Delete**
  - `packages/core/agent/src/microqueue.ts` and fire-and-forget patterns.

### Patch 07: Remove Agent-Side Circuit Registry

- **Files**
  - `packages/core/agent/src/circuit-breaker-registry.ts`
  - `packages/core/agent/src/index.ts`
  - `packages/core/agent/src/agent.ts`
- **Work**
  - Remove agent-local circuit state.
  - Consume llm/runtime policy services only.
- **Delete**
  - `packages/core/agent/src/circuit-breaker-registry.ts` entirely.

### Patch 08: Orchestrator State Machine to Supervised Fibers

- **Files**
  - `packages/core/orchestrator/src/orchestrator.ts`
  - `packages/core/orchestrator/src/execution_state.ts`
  - `packages/core/orchestrator/src/index.ts`
  - `packages/core/orchestrator/package.json`
- **Work**
  - Replace `while` + `Promise.all` with supervised fiber execution.
  - Make hook handlers scoped (no `void` async).
  - Centralize pause/cancel/resume via control queue.
  - Quiesce before returning paused/cancelled results.
- **Delete**
  - Ad hoc in-progress lifecycle handling that relies on mutable maps without supervision.

### Patch 09: Hook Runner and Effect Hooks Under Scope

- **Files**
  - `packages/core/orchestrator/src/hookRunner/runHooksForEvent.ts`
  - `packages/core/orchestrator/src/orchestrator.ts`
- **Work**
  - Make hook execution interruptible/time-bounded within orchestrator scope.
  - Preserve policy semantics while ensuring hard cancellation closes outstanding hook work.
- **Delete**
  - `runHookHandler` fire-and-forget behavior.

### Patch 10: Harness-Daemon Control-Plane Integration

- **Files**
  - `packages/infra/harness-daemon/src/harness/types.ts`
  - `packages/infra/harness-daemon/src/harness/harness.ts`
  - `packages/infra/harness-daemon/src/harness/orchestrator_runner.ts`
  - `packages/infra/harness-daemon/src/harness/bridge_gateway.ts`
  - `packages/infra/harness-daemon/src/harness/session_store.ts`
- **Work**
  - Store active execution handles.
  - Implement `abort/pause/resume` with control-channel operations.
  - Remove regex-based stop polling as primary cancel path.
  - Guarantee `session_stop` after quiesce completion.
- **Delete**
  - Implicit “queue user message as stop” cancellation model.

### Patch 11: Test Suite Migration + New Failure-Proofing Tests

- **Files**
  - `tests/llm/adapter.test.ts`
  - `tests/agent/agent.test.ts`
  - `tests/orchestrator/orchestrator.test.ts`
  - `tests/orchestrator/orchestrator.edge-cases.test.ts`
  - `tests/orchestrator/orchestrator.invariants.test.ts`
  - `tests/tools/builtins/bash.test.ts`
  - `tests/pause-resume-flow.test.ts`
  - `tests/harness-daemon/harness/bridge_gateway.test.ts`
- **Work**
  - Rewrite tests for Effect runtime execution.
  - Add explicit orphan-prevention tests:
    - interrupt long bash
    - cancel in-flight hook
    - cancel sub-agent tree
    - pause-quiesce correctness

### Patch 12: Dead Code Purge + Final Normalization

- **Files**
  - `packages/core/llm/src/index.ts`
  - `packages/core/agent/src/index.ts`
  - `packages/core/tools/src/index.ts`
  - `packages/core/orchestrator/src/index.ts`
- **Work**
  - Remove obsolete exports/imports.
  - Eliminate compatibility comments/docs.
  - Ensure all package surfaces reflect new runtime.
- **Delete**
  - Any stale APIs not reachable from new execution graph.

## Validation Gates (Must Pass After Each Major Patch Set)

1. **Type/Lint gates**
   - `bun run --cwd packages/core/types lint`
   - `bun run --cwd packages/core/runtime lint`
   - `bun run --cwd packages/core/llm lint`
   - `bun run --cwd packages/core/tools lint`
   - `bun run --cwd packages/core/agent lint`
   - `bun run --cwd packages/core/orchestrator lint`
   - `bun run --cwd packages/infra/harness-daemon lint`
2. **Focused tests**
   - `vitest run tests/llm/adapter.test.ts`
   - `vitest run tests/tools/builtins/bash.test.ts`
   - `vitest run tests/agent/agent.test.ts`
   - `vitest run tests/orchestrator/orchestrator.test.ts`
   - `vitest run tests/orchestrator/orchestrator.edge-cases.test.ts`
   - `vitest run tests/harness-daemon/harness/bridge_gateway.test.ts`
3. **Full regression**
   - `bun run test`
4. **Soak checks**
   - Repeated pause/resume/cancel runs with long-running tools and nested sub-agents.
   - Assert no live child process/fiber leftovers.
   - Assert no dangling in-progress work IDs in traces.

## Definition of Done

- Zero references to removed APIs/files.
- Pause/cancel paths are deterministic and quiescent (no orphan process/fiber leakage).
- Traces show balanced start/end events for every work unit and hook/tool execution.
- Orchestrator and harness expose explicit operational control (`pause`, `resume`, `cancel`) instead of implicit interruption heuristics.
