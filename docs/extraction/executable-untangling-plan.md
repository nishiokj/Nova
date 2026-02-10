# Executable Untangling and Extraction Plan

## Goal
Untangle current package/runtime coupling so major components can be deployed independently, without introducing a new abstraction layer.

## Scope
This plan focuses on:
- Removing hard compile/runtime couplings
- Consolidating hook paths
- Splitting control-plane runtime ownership
- Hardening service boundaries for independent deployment

---

## Phase 0: Baseline + Freeze (1 day)

### Objective
Lock behavior before cutting boundaries.

### Commands
```bash
bun run build
bun run --cwd packages/orchestrator build
bun run --cwd packages/harness-daemon build
bun run --cwd packages/decision-watcher build
bun run --cwd packages/orchestrator lint
bun run --cwd packages/harness-daemon lint
```

### Deliverables
- `docs/extraction/baseline.md` containing:
  - Current workspace dependency graph
  - Startup/run commands
  - Current hook/event flow summary

### Exit Gate
- All baseline commands pass with no behavior changes.

---

## Phase 1: Remove `orchestrator -> decision-watcher` Compile Dependency (2-3 days)

### Why
`orchestrator` still imports `decision-watcher` directly (`packages/orchestrator/src/orchestrator.ts`), preventing clean extraction.

### Work
1. Move plan-context helpers currently sourced from `decision-watcher` into orchestrator-local code.
2. Replace imports in `packages/orchestrator/src/orchestrator.ts`.
3. Remove `decision-watcher` from `packages/orchestrator/package.json` dependencies.
4. Keep behavior identical.

### Files
- `packages/orchestrator/src/orchestrator.ts`
- `packages/orchestrator/src/plan-context.ts` (new)
- `packages/orchestrator/package.json`
- `packages/orchestrator/src/index.ts` (if exports change)

### Validation
```bash
rg -n "from 'decision-watcher'" packages/orchestrator/src
bun run --cwd packages/orchestrator build
bun run --cwd packages/harness-daemon build
```

### Exit Gate
- No `decision-watcher` imports remain in orchestrator source.
- Orchestrator builds standalone.

---

## Phase 2: Remove Mixed Hook Ownership from Orchestrator Core (2-4 days)

### Why
Two hook paths coexist:
- Legacy internal hook registry/executor in `packages/orchestrator/src/hooks.ts`
- Control-plane hook system via `runHooksForEvent`

This blocks clean boundaries and creates ownership ambiguity.

### Work
1. Move legacy internal hook registry/executor (`registerHook`, `executeHooks`) out of orchestrator package and into harness-daemon-local runtime code.
2. Keep control-plane hook execution as orchestrator-owned path.
3. Update harness imports that currently pull mixed APIs from orchestrator.
4. Preserve runtime behavior.

### Files
- `packages/orchestrator/src/hooks.ts`
- `packages/orchestrator/src/index.ts`
- `packages/harness-daemon/src/harness/harness.ts`
- `packages/harness-daemon/src/harness/bridge_gateway.ts`
- `packages/harness-daemon/src/harness/*` (new local legacy hook module)

### Validation
```bash
rg -n "executeHooks\\(|registerHook\\(" packages/orchestrator/src
bun run --cwd packages/orchestrator build
bun run --cwd packages/harness-daemon build
bun run --cwd packages/harness-daemon test
```

### Exit Gate
- Orchestrator runtime path uses only control-plane hook execution.
- Harness continues to pass hook-related tests.

---

## Phase 3: Extract Control Plane Server from Harness Daemon (3-5 days)

### Why
Control plane is embedded and started by harness-daemon, coupling deployment lifecycle.

### Work
1. Move control-plane server and routes into a separately deployable package/process.
2. Keep existing bridge command/event compatibility (`harness-client` contract unchanged).
3. Remove control-plane startup from harness-daemon.
4. Update launcher wiring to start control-plane independently.

### Files
- Move out:
  - `packages/harness-daemon/src/harness/control_plane_server.ts`
  - `packages/harness-daemon/src/harness/control_plane_routes.ts`
  - `packages/harness-daemon/src/harness/routes/*`
  - to `packages/control-plane/src/harness/*`
- Update:
  - `packages/harness-daemon/src/harness/daemon.ts`
  - `packages/launcher/index.ts`

### Validation
```bash
# Separate process startup
# 1) harness-daemon
# 2) control-plane

# Verify:
# - control-plane health routes
# - session dispatch through bus
# - model/permission/escalation routes
```

### Exit Gate
- Control-plane can run, restart, and deploy independently from harness-daemon.

---

## Phase 4: Graph/Data Runtime Ownership Cleanup (3-4 days)

### Why
Service ownership is mixed (control-plane starts/manages GraphD in some paths). This causes hidden coupling and startup-order fragility.

### Work
1. Define single owner for GraphD process lifecycle.
2. Non-owner components connect as clients only.
3. Keep `agent-memory` as an independent daemon.
4. Update config defaults and startup docs accordingly.

### Progress
- 2026-02-10: `control-plane` switched to GraphD client-only attach mode (no implicit GraphD bootstrap).
- 2026-02-10: `harness-daemon` switched to GraphD client-only attach mode (no implicit GraphD bootstrap).

### Files
- `packages/control-plane/src/harness/control_plane_server.ts`
- `packages/graphd/src/manager.ts`
- `config/defaults.json`

### Validation
```bash
# Cold-start check with explicit process order:
# graphd -> harness-daemon -> control-plane -> UI clients

# Verify:
# - GraphD health
# - Harness health
# - Control-plane session/project routes
# - Agent-memory endpoints
```

### Exit Gate
- No component implicitly starts another component's datastore runtime.

---

## Phase 5: Deployability Hardening (2-3 days)

### Objective
Turn untangled boundaries into operational deployment units.

### Deliverables
- Per-component runbooks:
  - Runtime daemon
  - Control-plane server
  - GraphD
  - Agent-memory
  - UI clients (`tui`, `dashboard-control`)
- CI jobs per deployable component
- Inter-process smoke tests for compatibility

### Progress
- 2026-02-10: Added deployable runbooks under `docs/runbooks/*`.
- 2026-02-10: Added per-component CI matrix job (`deployable-components`) and inter-process smoke CI job.
- 2026-02-10: Added inter-process smoke script: `scripts/smoke/interprocess-smoke.ts`.
- 2026-02-10: Verified smoke compatibility flow passes locally via `bun run smoke:interprocess`.
- 2026-02-10: Core services (`graphd`, `harness-daemon`, `control-plane`, `agent-memory`) use build+lint verification in component CI; launcher/UI entries run build verification while existing UI type debt is stabilized.

### Validation
```bash
# Per component:
# - start
# - health
# - stop

# Cross-component:
# - bridge command round trip
# - event streaming
# - session operations
# - escalation/permission flow
```

### Exit Gate
- Every target component can be deployed independently with documented startup and health checks.

---

## Execution Order (Strict)
1. Contract core stability checks (`protocol`, `types`, `prompt-protocol`, `shared`)
2. Phase 1 (orchestrator/decision-watcher compile untangle)
3. Phase 2 (hook ownership untangle)
4. Phase 3 (control-plane extraction)
5. Phase 4 (Graph/Data ownership cleanup)
6. Phase 5 (deployment hardening + CI)

---

## Reuse Status During Untangling

### Reusable immediately
- `comms-bus`
- `harness-client`
- `protocol`
- `prompt-protocol`
- `agent-memory`
- `graphd`
- `entity-graph`

### Becomes cleanly reusable after Phases 1-3
- `orchestrator`
- `decision-watcher`
- `harness-daemon` runtime block
