# Control State Patch Spec

## Goal
Support watcher-driven **single agent/work-item stop** without collapsing the entire session, while preserving strict typing and exhaustive discriminated unions.

## Minimal Patch Spec

1. Add a work-item stop decision in cadence flow.
   - File: `packages/core/protocol/src/control/decisions.ts`
   - Extend `CadenceDecision` with:
     - `{ action: 'stop_work_item'; reason: string; escalationId?: string }`
   - Keep existing `stop` for explicit session-level stop semantics.

2. Keep schemas/prompts/gates in lockstep.
   - File: `packages/core/protocol/src/protocol/schemas.ts`
     - Add `stop_work_item` variant to `CadenceDecisionSchema`.
   - File: `packages/core/protocol/src/control/gates.ts`
     - Add `stop_work_item` to `VALID_DECISIONS_BY_EVENT.cadence_audit`.
   - File: `packages/core/protocol/src/protocol/prompts.ts`
     - Document `stop_work_item` in cadence decision prompt text.

3. Add explicit termination reason for agent-level stop.
   - File: `packages/core/protocol/src/domain/termination.ts`
   - Add `'watcher_work_item_stopped'`.
   - Update all exhaustive switches and `ALL_TERMINATION_REASONS`.
   - File: `packages/core/protocol/src/protocol/schemas.ts`
     - Add to `TerminationReasonSchema`.

4. Map cadence decision to agent loop termination scope.
   - File: `packages/core/orchestrator/src/orchestrator.ts`
     - In cadence hook mapping:
       - `stop_work_item` -> agent ends with `watcher_work_item_stopped`
       - `stop` -> existing session-level stop behavior
   - File: `packages/core/agent/src/agent.ts`
     - Set `result.terminationReason = 'watcher_work_item_stopped'` for stop-work-item path.

5. Treat work-item stop as non-terminal at orchestrator/session level.
   - File: `packages/core/orchestrator/src/orchestrator.ts`
   - In termination handling:
     - `watcher_work_item_stopped` should remove/retire that work item and continue loop.
     - Do not return terminal orchestrator result solely for this reason.
   - Emit an internal hook event when this occurs.

6. Emit an explicit internal hook for watcher agent stop.
   - File: `packages/core/agent/src/types.ts`
   - Add `InternalHookEvent` variant:
     - `{ type: 'watcher_agent_stopped'; sessionKey; workId; reason; escalationId?; agentType }`
   - File: `packages/core/orchestrator/src/hooks.ts`
     - Add `watcher_agent_stopped` to valid hook event list.

7. Support multiple paused agents/work-items in harness control state.
   - File: `packages/infra/harness-daemon/src/harness/session_store.ts`
   - Keep existing `paused_state` for PromptUser compatibility.
   - Add `paused_work_items` metadata collection keyed by `workId` (or `pauseId`), with status and timestamps.
   - Add methods:
     - `upsertPausedWorkItem(...)`
     - `listPausedWorkItems()`
     - `resolvePausedWorkItem(...)`
     - `cancelPausedWorkItem(...)`

8. Resolve escalation by targeted replay.
   - File: `packages/infra/harness-daemon/src/harness/harness.ts`
   - On `watcher_agent_stopped`:
     - append/update `paused_work_items`
     - append watcher note to work log
     - mark session blocked only when escalation is pending
   - On escalation resolution:
     - resolve escalation record
     - resolve matching paused work item
     - inject resolution guidance into context
     - recreate and enqueue target work item with replay context (objective + resolution + work-item log reference)

## Control-State Invariants

1. Scope invariant.
   - `watcher_work_item_stopped` is work-item scoped and must not directly terminate session.
   - Session-level stop requires explicit session-stop semantics.

2. Single-writer invariant.
   - Orchestrator mutates only execution-loop memory.
   - Harness is sole writer for durable session control metadata (`status`, `escalations`, `paused_state`, `paused_work_items`).

3. No hidden state invariant.
   - Any resumable control state must be persisted in GraphD metadata/context snapshot.
   - No in-process-only paused work-item state.

4. Idempotency invariant.
   - Repeated stop events for same `(sessionKey, workId, escalationId)` are upserts.
   - Re-resolving terminal escalation/paused item is no-op.

5. Exhaustive union invariant.
   - Every new discriminant must be handled in all `switch` blocks with `assertNever` coverage.
   - No default fallthrough for discriminated union branches.

6. Schema parity invariant.
   - Every new action/reason exists in:
     - Type unions
     - Zod schema
     - Prompt action docs
     - Decision gate valid-action lists
     - Runtime decision mappers

7. Loop liveness invariant.
   - Stopping one work item must not deadlock sibling work items.
   - Session terminal result only when no pending runnable work and no resumable paused work items remain.

8. Escalation-status invariant.
   - Session `blocked` is derived from pending escalations, not from generic termination reasons.

9. Replay determinism invariant.
   - Recreated work item must receive explicit replay payload:
     - prior objective
     - escalation resolution
     - reference to persisted work-item context log/summary

10. Backward-compatibility invariant.
    - Existing PromptUser pause flow (`paused_state`) remains functional while multi-agent pause (`paused_work_items`) is introduced.

