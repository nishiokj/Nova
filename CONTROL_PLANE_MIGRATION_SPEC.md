# Control Plane Protocol & Hooks Migration Spec

This document defines the **non-negotiable** architecture and migration plan for the control plane. It replaces the previous `control-plane` package with a strict `packages/protocol` single source of truth and **removes all backwards-compatibility paths**.

**Principles (hard requirements):**
- **Single source of truth** for all discriminated unions, hooks, and patches.
- **No circular dependencies**. Core types live with the state owner, and everything imports from there.
- **No backwards-compatibility slop**. No aliasing legacy types, no re-export bridges.
- **`assertNever` everywhere** for exhaustive handling of discriminated unions.
- **Orchestrator owns execution semantics** (runner + registry + state mutation).
- **Plugins implement behavior only**; they cannot mutate orchestrator state directly.

---

## Target Architecture

### 1) `packages/protocol` (single source of truth)
**Lives here:**
- Discriminated unions: `Event`, `Decision`, `HookOutcome`, `StatePatch`
- Hook interfaces: `Hook<Evt, D>`, `HookPolicy`, `HookContext`, `StateView`
- Protocol versioning: `PROTOCOL_VERSION`, schema hash, optional schemas (Zod/JSON)
- Utility: `assertNever(x: never, msg?: string): never`

**Why:** This package is the **only** source for protocol types. Everything else imports from it.

### 2) `packages/orchestrator/src/hooks` (runner/executor)
**Lives here:**
- Hook runner/executor: `runHooksForEvent()`
- Ordering/priority semantics
- Timeouts, retries, backoff
- Policy enforcement (fail-open/closed semantics)
- Deterministic decision reduction (HookReport → Decision/Patches)
- Instrumentation + logging for observability

**Why:** Execution semantics are part of the control plane. The orchestrator owns the event loop and must be deterministic and observable.

### 3) `packages/orchestrator/src/hookRegistry` (centralized registration)
**Lives here:**
- **Only** official registration entrypoint
- Event → hook list mapping
- Registration-time validation:
  - Unique IDs
  - Required policy + declared criticality
  - Declared idempotency
  - Compatible protocol version

**Why:** Centralized wiring enables auditability and prevents hidden coupling.

### 4) `packages/hooks-*` (plugins / implementations)
**Lives here:**
- Hook implementations grouped by domain: `hooks-watcher`, `hooks-safety`, `hooks-quality`, etc.

**Constraints:**
- Plugins **only** depend on `packages/protocol` (and small shared utils).
- Plugins **do not** import orchestrator internals or mutate state directly.
- Plugins **do not** register themselves via side effects. Registration is explicit in orchestrator registry.

### 5) Agent-side hooks
If agent-local hooks exist:
- Use `@agent/protocol` or extend `packages/protocol` with an agent namespace.
- The agent can have its own local runner.
- **Any hook that can terminate/pause/spawn/rebudget must route through orchestrator hooks.**

---

## Exhaustiveness: `assertNever`

All discriminated unions (events, decisions, patches, policies, outcomes) **must** be handled with exhaustive `switch` statements and `assertNever` in the default branch. No `as`-casting shortcuts.

**Example:**
```ts
import { assertNever } from 'protocol';

function handleDecision(d: Decision) {
  switch (d.kind) {
    case 'approved':
      return ...;
    case 'rejected':
      return ...;
    default:
      return assertNever(d, `Unhandled decision: ${String((d as { kind: string }).kind)}`);
  }
}
```

---

## Migration Plan

### Phase 1: Create `packages/protocol`
**Goal:** Establish the only source of truth.

**Actions:**
- Create `packages/protocol` with a clear module layout (example):  
  - `src/domain/*` (events, termination, state)  
  - `src/control/*` (decisions, gates)  
  - `src/effects/*` (patches, commands)  
  - `src/hooks/*` (outcomes, policies, hook interfaces only)  
  - `src/protocol/*` (schemas, prompts, version)  
  - `src/assertNever.ts`  
  - `src/index.ts` (barrel exports)
- Move all relevant types from `packages/control-plane` into `packages/protocol`.
- **No re-exports** in other packages (shared/agent). Remove legacy alias types.

**Verification:**
1. `bun run --cwd packages/protocol build`
2. No imports remain from `control-plane`.

---

### Phase 2: Replace imports across packages
**Goal:** All packages compile against `packages/protocol` only.

**Actions:**
- Update imports in:
  - `packages/agent`
  - `packages/orchestrator`
  - `packages/decision-watcher`
  - `packages/harness-daemon`
- Delete any alias types (e.g., `AgentTerminationReason`, `OrchestratorTerminationReason`).
- Update any string-typed fields to `TerminationReason` or appropriate protocol type.

**Verification:**
1. Individual package builds pass.
2. Full `bun run build` passes.

---

### Phase 3: Orchestrator hook runner
**Goal:** Execution semantics live only in orchestrator.

**Actions:**
- Implement `packages/orchestrator/src/hooks/runHooksForEvent.ts` with:
  - Priority ordering and parallel execution by priority
  - Timeouts, retries, backoff
  - Policy enforcement (fail-closed/open)
  - Deterministic reduction to `Decision` + `StatePatch[]`
  - Audit + instrumentation
- Replace any plugin-owned runner logic.
- Ensure **exhaustive union handling** with `assertNever`.

**Verification:**
1. Runner unit tests (policy + outcome correctness)
2. Audit log entries recorded for all outcomes

---

### Phase 4: Orchestrator hook registry
**Goal:** Centralized registration with strict validation.

**Actions:**
- Implement `packages/orchestrator/src/hookRegistry/index.ts`:
  - `registerHook()` and `registerHooks()`
  - Validation at registration time: ID uniqueness, policy required, idempotency declaration, protocol version check
  - Event → hook list mapping
- Orchestrator is the only place hooks are wired and enabled.

**Verification:**
1. Invalid registrations rejected with clear errors
2. Registry audit logs and counts are correct

---

### Phase 5: Plugin hooks
**Goal:** Implement hooks in domain packages without state mutation.

**Actions:**
- Create packages like:
  - `packages/hooks-watcher`
  - `packages/hooks-quality`
  - `packages/hooks-safety`
- Expose `createHooks()` or `register(registry)` functions only.
- Plugins only import from `packages/protocol`.

**Verification:**
1. Plugins compile without orchestrator dependency
2. Registration is explicit and centralized in orchestrator

---

### Phase 6: Remove `packages/control-plane`
**Goal:** Eliminate legacy structures completely.

**Actions:**
- Delete `packages/control-plane` entirely.
- Remove from root/package workspace references.
- Fail builds until all imports are moved to `packages/protocol`.

**Verification:**
1. `bun run build` passes
2. No references to `control-plane` remain

---

## Success Criteria

- [ ] `packages/protocol` is the only source of core types and schemas
- [ ] All discriminated unions handled with `assertNever`
- [ ] Orchestrator owns hook runner + registry
- [ ] Plugins depend only on `packages/protocol`
- [ ] `packages/control-plane` removed
- [ ] Full build + tests pass

---

*Last updated: 2026-01-29*
