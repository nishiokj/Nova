# Package Topology

This repo uses grouped package domains to keep core primitives small and visible.

## `packages/core/*`

Core runtime primitives and contracts. These packages should stay low-level and broadly reusable:

- `agent`
- `context`
- `llm`
- `orchestrator`
- `@nova/protocol`
- `shared`
- `tools`
- `types`
- `work`

## `packages/infra/*`

Runtime infrastructure, transport, and service wiring:

- `comms-bus`
- `graphd`
- `harness-daemon`
- `@nova/client`

## `packages/clients/*`

Language-specific clients that consume `@nova/protocol` without depending on daemon internals:

- `python` (`nova-client`)

## `packages/plugins/*`

Plugin modules and optional bolt-on subsystems:

- `memory` (primary install surface for memory + entity graph features)
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

## Boundary Rules

- Keep `core/*` free of app concerns (UI, daemon HTTP routes, dashboard state, etc.).
- Keep core distribution lean: plugin code and plugin deps are opt-in, not bundled with core package installs.
- `@nova/protocol` is the language-neutral wire contract for bus messages, bridge commands/events, RPC procedures, validators, channels, and conformance fixtures. It must not depend on daemon runtime code.
- `@nova/client` is the TypeScript service client. It should depend on `@nova/protocol` and transport libraries, not `harness-daemon`, `comms-bus`, or `shared`.
- `packages/clients/*` clients should validate against `packages/core/protocol/fixtures/conformance.json` and avoid importing or shelling into daemon packages.
- The root `nova` app package and the SDK packages are separate publish surfaces. Do not re-export `@nova/protocol` or `@nova/client` from root `nova`.
- Prefer importing by package name (`types`, `@nova/protocol`, `@nova/client`, etc.), not filesystem paths.
- Add new user interfaces under `apps/*`; add new transport/runtime services under `infra/*`.
- If a module is tightly coupled to optional capabilities (memory, compilation, etc.), default it to `plugins/*` unless proven generic.
