# Package Topology

This repo uses grouped package domains to keep core primitives small and visible.

## `packages/core/*`

Core runtime primitives and contracts. These packages should stay low-level and broadly reusable:

- `agent`
- `context`
- `llm`
- `orchestrator`
- `protocol`
- `shared`
- `tools`
- `types`
- `work`

## `packages/infra/*`

Runtime infrastructure, transport, and service wiring:

- `comms-bus`
- `decision-watcher`
- `graphd`
- `harness-client`
- `harness-daemon`

## `packages/plugins/*`

Plugin modules and optional bolt-on subsystems:

- `agent-memory`
- `entity-graph`
- `memory-injector`
- `semantic-compiler`

## `packages/external/*`

Vendored external dependencies kept in-repo:

- `prompt-protocol`

## `packages/apps/*`

User-facing entrypoints and clients:

- `launcher`
- `tui`
- `dashboard`
- `dashboard-compact`
- `dashboard-control`
- `control-plane`

## Boundary Rules

- Keep `core/*` free of app concerns (UI, daemon HTTP routes, dashboard state, etc.).
- `protocol` is not just hooks. It is the execution contract surface for domain state, control decisions/gates/watchers, effects, hook outcomes/policy, and protocol schemas/versioning.
- Prefer importing by package name (`types`, `protocol`, etc.), not filesystem paths.
- Add new user interfaces under `apps/*`; add new transport/runtime services under `infra/*`.
- If a module is tightly coupled to optional capabilities (memory, compilation, etc.), default it to `plugins/*` unless proven generic.
