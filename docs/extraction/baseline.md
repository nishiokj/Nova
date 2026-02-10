# Extraction Baseline (Phase 0 Freeze)

Date: 2026-02-10
Scope: workspace baseline before extraction boundary cuts.

## Baseline Command Results

All required phase 0 commands passed.

```bash
bun run build
bun run --cwd packages/orchestrator build
bun run --cwd packages/harness-daemon build
bun run --cwd packages/decision-watcher build
bun run --cwd packages/orchestrator lint
bun run --cwd packages/harness-daemon lint
```

Status:
- `bun run build`: PASS
- `bun run --cwd packages/orchestrator build`: PASS
- `bun run --cwd packages/harness-daemon build`: PASS
- `bun run --cwd packages/decision-watcher build`: PASS
- `bun run --cwd packages/orchestrator lint`: PASS
- `bun run --cwd packages/harness-daemon lint`: PASS

## Current Workspace Dependency Graph

Workspace-local dependency edges (`package -> dependency`) at baseline:

```text
agent -> context
agent -> llm
agent -> protocol
agent -> shared
agent -> tools
agent -> types
agent -> work
agent-memory -> harness-client
agent-memory -> protocol
agent-memory -> types
comms-bus -> types
context -> types
dashboard -> graphd
decision-watcher -> agent
decision-watcher -> agent-memory
decision-watcher -> llm
decision-watcher -> protocol
decision-watcher -> shared
decision-watcher -> types
harness-client -> comms-bus
harness-daemon -> agent
harness-daemon -> comms-bus
harness-daemon -> context
harness-daemon -> decision-watcher
harness-daemon -> entity-graph
harness-daemon -> graphd
harness-daemon -> harness-client
harness-daemon -> llm
harness-daemon -> memory-injector
harness-daemon -> orchestrator
harness-daemon -> shared
harness-daemon -> tools
harness-daemon -> types
harness-daemon -> work
llm -> types
memory-injector -> agent-memory
orchestrator -> agent
orchestrator -> comms-bus
orchestrator -> context
orchestrator -> decision-watcher
orchestrator -> llm
orchestrator -> protocol
orchestrator -> tools
orchestrator -> types
orchestrator -> work
protocol -> shared
tools -> shared
tools -> types
tui -> comms-bus
tui -> entity-graph
tui -> harness-client
tui -> types
work -> types
```

## Startup / Run Commands

Primary run paths (current):

```bash
# Full launcher path (daemon + control plane + TUI)
bun run start
# equivalent: bun run --cwd packages/launcher start

# Daemon only
bun run start:daemon
# equivalent: bun run --cwd packages/harness-daemon start

# Split startup path from launcher
bun run start:split
bun run start:split:restart

# TUI only (expects daemon/bus available)
bun run start:tui
# equivalent: bun run --cwd packages/tui start

# Control-plane direct
bun run packages/harness-daemon/src/harness/control_plane_server.ts
```

Build / lint paths used for extraction gates:

```bash
bun run build
bun run --cwd packages/orchestrator build
bun run --cwd packages/harness-daemon build
bun run --cwd packages/decision-watcher build
bun run --cwd packages/orchestrator lint
bun run --cwd packages/harness-daemon lint
```

## Current Hook / Event Flow Summary

### Runtime event flow

1. Bridge requests enter `BridgeGateway` and execution streams through `streamRunEvents` in `packages/harness-daemon/src/harness/bridge_gateway.ts`.
2. Harness run path builds an event emitter via `createEventEmitCallback` in `packages/harness-daemon/src/harness/harness.ts`.
3. Orchestrator emits lifecycle/control events (for example `iteration_started`, `hook_call`, and termination-control events) in `packages/orchestrator/src/orchestrator.ts`.
4. EventBus subscribers translate `AgentEvent -> BridgeEvent` via `translateAgentEvent` in `packages/harness-daemon/src/harness/event_translator.ts`.
5. Bridge/TUI and control-plane consumers receive translated stream events.

### Hook ownership at baseline (mixed paths)

Two hook paths are live at baseline:

1. Legacy internal hook path:
   - `executeHooks`/`registerHook` from `packages/orchestrator/src/hooks.ts`
   - Orchestrator enqueues internal hook work items and executes handlers via `executeHooks` (`packages/orchestrator/src/orchestrator.ts`)
   - Harness also calls `executeHooks` directly in `emitInternalHookAsync` (`packages/harness-daemon/src/harness/harness.ts`)

2. Control-plane hook path:
   - `runHooksForEvent` via orchestrator hook registry (`packages/orchestrator/src/hookRunner/runHooksForEvent.ts`)
   - `callStopHook` in `packages/orchestrator/src/orchestrator.ts` maps control decisions to stop behavior
   - Harness creates watcher-backed control hooks via `createWatcherHookRegistryForSession` in `packages/harness-daemon/src/harness/harness.ts`

This mixed ownership is the exact phase 2 untangling target.
