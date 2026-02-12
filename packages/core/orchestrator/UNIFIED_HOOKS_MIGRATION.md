# Unified Hooks Migration (No Legacy Adapters)

## Goal
Replace all current hook systems with one registration and execution model, then delete:
- `packages/infra/harness-daemon/src/harness/legacy_hooks.ts`
- `packages/infra/harness-daemon/src/harness/hook_executor.ts`
- old orchestrator-only `hookRegistry`/`hookRunner` wiring once migrated

This plan intentionally does **not** keep compatibility adapters.

## New Model
Single registration surface:
- register by event name
- event contract decides whether callback is `decision` or `effect`
- ownership scope (`orchestrator`/`agent`/`harness`) is metadata used for validation and routing
- registration is session-scoped by default (same hook id can be reused across sessions)

Decision vs effect:
- `decision`: can return decisions and `StatePatch[]`; strict policy/idempotency/criticality
- `effect`: side effects and optional lifecycle gating (`allow/block/modify`) but no state patching

## Drafted Building Blocks
Implemented in `packages/core/orchestrator/src/unifiedHooks`:
- `catalog.ts`: canonical event catalog, mode classification, allowed scopes
- `contracts.ts`: strict callback payload/outcome contracts and registration types
- `registry.ts`: unified registry with mode/scope validation
- `runner.ts`: execution semantics for decision/effect hooks

## Event Mapping for Cutover
### Control-plane decision events (existing protocol)
- `goal_state_reached`
- `bounds_exceeded`
- `user_input_required`
- `cadence_audit`
- `agent_error`
- `handoff_requested`
- `work_item_completed`
- `user_stopped`
- `transient_error`
- `escalation_resolved`

### Internal/event-bus effects (from legacy internal hooks)
- `workitem_created`
- `turn_completed`
- `tool_batch_completed`
- `context_threshold`
- `artifacts_discovered`
- `files_modified`
- `agent_message`
- `tool_call_completed`
- `agent_completed`
- `memory_injected`
- `git_commit`
- `escalation_raised`
- `escalation_resolved`
- `observer_agent_stopped`
- `session_status_changed`

### Lifecycle effects (from hook executor)
- `pre_tool_use`
- `post_tool_use`
- `post_git_commit`
- `user_prompt_submit`
- `session_start`
- `session_stop`
- `notification`

## Cutover Plan
1. Register all new hooks through `createUnifiedHookRegistry()` only.
2. Move orchestrator decision hook execution to `runUnifiedDecisionHooks`.
3. Move tool/user/session lifecycle hooks to `runUnifiedEffectHooks`.
4. Convert file-backed hook definitions to unified registrations at load time.
5. Delete all old hook entry points and callers.

## Deletion Gates (must all be true)
1. No imports of `legacy_hooks.ts` remain.
2. No imports of `hook_executor.ts` remain.
3. No runtime usage of orchestrator `executeLegacyHook` path remains.
4. No writes to old hook config schema keys that cannot be represented in unified events.
5. Tests cover:
- decision ordering, retries, critical failures, and patch collection
- effect ordering, block/modify behavior for lifecycle events
- scope validation failures at registration time

## Non-Goals
- Keeping old hook JSON shape unchanged.
- Transitional adapters for old callback signatures.
- Dual-run old and new engines for long periods.

## Risks
- Lifecycle hook semantics are currently distributed across harness and agent; cutover must preserve existing behavior.
- Some effect hooks currently rely on implicit fail-open behavior; policy defaults must remain safe.
- Existing tests are heavily oriented around old orchestrator registry; they need migration to unified registry coverage.
