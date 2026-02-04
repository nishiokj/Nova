# Refactor Targets

## Findings
- High: Session state is fragmented across multiple Maps in `packages/harness-daemon/src/harness/harness.ts`. This creates duplicated lifecycle logic and makes it easy to leak state. Implementation spec below.
- Medium: Type safety gaps and unsafe contracts (`any`, `as unknown as`, broad `Record<string, unknown>`) make refactors risky and hide data shape issues. Implementation spec below.
- High: `executeInner` in `packages/orchestrator/src/orchestrator.ts` is a monolithic control loop combining queueing, hook decisions, handoff parsing, cadence audits, and termination handling. Needs extraction into discrete components.
- High: `handlePublish` in `packages/harness-daemon/src/harness/bridge_gateway.ts` is a large switch with mixed validation and side effects across multiple domains. Replace with a command registry + validation.
- Medium: `HarnessLike` is overly broad with many optional methods, increasing coupling across layers. Split into focused interfaces.
- Medium: Model-selection handling is duplicated in `BridgeGateway` (init and send paths). Centralize into a single helper/service.
- Low: `callStopHook` has a large positional parameter list that is hard to extend safely. Replace with a single context object.

## Implementation Spec: Session State Consolidation (Surgical)

**Goal**
Unify per-session state into a single `SessionState` container and remove parallel Maps in `AgentHarness` without changing externally visible behavior.

**Non-Goals**
- No behavior changes to GraphD persistence, TTL eviction logic, or watcher behavior.
- No changes to public `AgentHarness` API shape.
- No protocol changes.

**Current Pain**
`AgentHarness` maintains multiple Maps (`sessionStores`, `decisionDatabases`, `watcherEngines`, `sessionWorkLogs`, `workItemLogs`, `workItemCreated`, `watcherContexts`, `watcherHookRegistries`) with partially duplicated cleanup and lifecycle updates.

**Proposed Approach**
- Use the existing `SessionState` model in `packages/harness-daemon/src/harness/session_state.ts` as the single source of session-scoped state.
- Replace all parallel Maps with `private sessions = new Map<string, SessionState>();` inside `AgentHarness`.
- Introduce small internal helpers to centralize session access and mutation:
  - `getSessionState(sessionKey): SessionState | null`
  - `getOrCreateSessionState(sessionKey, options): SessionState`
  - `closeSessionState(sessionKey): void`
- Move work item logging caches into the `SessionState` container (`workItemLogs`, `workItemsCreated`) and remove the `${sessionKey}:${workId}` composite key usage.

**Files in Scope**
- `packages/harness-daemon/src/harness/harness.ts`
- `packages/harness-daemon/src/harness/session_state.ts`

**Detailed Steps**
1. Add `private sessions = new Map<string, SessionState>();` to `AgentHarness` and remove the current per-session Maps.
2. Update `getOrCreateSessionStore` to use `getOrCreateSessionState` and return `state.store`.
3. Update all `this.sessionStores.get(sessionKey)` accesses to `this.sessions.get(sessionKey)` and adjust field access (e.g., `state.store`, `state.decisionDatabase`).
4. Replace `workItemLogs` and `workItemCreated` global Maps with `state.workItemLogs` and `state.workItemsCreated`.
5. Update `closeSession` to:
   - Persist/close `state.store`
   - Mark GraphD inactive (unchanged)
   - Clear `state` from `this.sessions`
6. Update `pruneSessionStores` to iterate `this.sessions` and use `state.lastAccessMs` + `state.store.getPausedState()` for eviction logic.
7. Ensure `SessionState.lastAccessMs` is touched consistently (reuse `touchSession` helper).
8. Verify `watcherContexts`, `watcherHookRegistries`, `decisionDatabases`, `watcherEngines`, and `sessionWorkLogs` are accessed through the `SessionState` fields.

**Acceptance Criteria**
- No Map fields remain in `AgentHarness` except `sessions`.
- `closeSession` and TTL eviction clear all per-session data without special-case loops.
- All current tests (if any) pass with no behavioral change.

**Risks / Mitigations**
- Risk: Missing a per-session map access causes a null dereference or memory leak.
- Mitigation: Add a temporary `assertSessionState` helper and use `rg` to ensure all previous map names are removed.

## Implementation Spec: Type Safety and Bad Contracts (Surgical)

**Goal**
Remove unsafe `any`/`unknown` casts and narrow contracts in high-traffic paths without rewriting APIs.

**Non-Goals**
- No protocol or payload shape changes.
- No rewrite of bridge command handling or hook execution semantics.

**Targets**
- `packages/harness-daemon/src/harness/harness.ts`
- `packages/harness-daemon/src/harness/bridge_gateway.ts`
- `packages/orchestrator/src/orchestrator.ts`

**Proposed Changes**
- Replace `trigger as any` in `runWatcherAgent` by typing `trigger?: WatcherTrigger` and importing `WatcherTrigger` from `decision-watcher`.
- Remove `as unknown` casts in `extractHandoffSpecCandidate` by passing `unknown` through the existing `extractHandoffSpecCandidate` signature (no cast required).
- Replace `result.modified as unknown as ToolResult` with a type guard `isToolResult(value: unknown): value is ToolResult` that validates shape before using it. If invalid, log and fall back to `allow` or ignore the modification.
- Update `AsyncEventQueue` to avoid `undefined as unknown as BridgeEvent` by using a `IteratorResult<BridgeEvent, void>` return type and a resolver signature that permits `value: undefined` on completion.
- Replace `daemon: any` in `BridgeGateway` with a narrow `DaemonLike` interface or remove the field entirely if unused.
- Add a minimal `parseBridgeCommand` guard that validates `{ type: string, data?: object }` before switch dispatch. Keep the `BridgeCommand` union for tooling, but ensure runtime checks are explicit.

**Detailed Steps**
1. Add `type WatcherTrigger` import and update `runWatcherAgent` signature and callers to use it.
2. Remove unnecessary `as unknown` in orchestrator handoff parsing and let the existing recursion handle `unknown` values.
3. Add `isToolResult` in `harness.ts` (near `createAgentHooks`) and use it for hook result modifications.
4. Adjust `AsyncEventQueue` to use `IteratorResult<BridgeEvent, void>` and update resolver types to remove unsafe casts.
5. Define `interface DaemonLike { ... }` only if `daemon` is actually used in this file; otherwise remove the field and constructor param.
6. Add a small runtime guard for `BridgeCommand` envelopes in `handlePublish` and fail fast with a clear error event when invalid.

**Acceptance Criteria**
- `rg -n "as unknown as"` and `rg -n "any"` in these files show only justified, documented cases.
- No changes in runtime behavior for valid inputs.
- Type errors reduced in these files without widening types.

**Risks / Mitigations**
- Risk: `isToolResult` is too strict and rejects legitimate hook output.
- Mitigation: Start with permissive checks (required fields only) and log when invalid.

## Implementation Spec: Orchestrator Execution Loop Extraction

**Goal**
Break `executeInner` in `packages/orchestrator/src/orchestrator.ts` into composable units that isolate queueing, hook decisions, cadence audits, and termination handling without changing behavior.

**Non-Goals**
- No changes to external `Orchestrator` API.
- No changes to payload shapes or hook semantics.
- No changes to scheduling/timing semantics.

**Current Pain**
`executeInner` is a monolithic control loop that interleaves queue creation, hook decisions, handoff parsing, cadence audits, and stop conditions. This makes it hard to test and risky to extend.

**Proposed Approach**
Introduce small, internal classes/functions in `orchestrator.ts` (or a nearby module) that encapsulate:
- `WorkQueue`: handles enqueue/dequeue, dedupe, and bookkeeping for work items.
- `DecisionEngine`: encapsulates hook decision evaluation and HandoffSpec parsing.
- `TerminationPolicy`: centralizes stop/abort/timeout checks.
- `CadenceAuditor`: handles cadence audit scheduling and evaluation.

**Files in Scope**
- `packages/orchestrator/src/orchestrator.ts`
- (optional) `packages/orchestrator/src/execution_loop.ts` if the file grows too large

**Detailed Steps**
1. Extract queue-related state and helpers into a `WorkQueue` structure:
   - Inputs: existing queue items, `queueRecords`, `activeWorkItemIds`.
   - API: `enqueue`, `dequeueNext`, `markActive`, `markComplete`, `hasPending`, `size`.
2. Extract handoff parsing and decision evaluation into `DecisionEngine`:
   - API: `evaluateHooks(context): DecisionOutcome`.
   - Includes the current `extractHandoffSpecCandidate` flow and any hook parsing.
3. Extract termination checks into `TerminationPolicy`:
   - API: `shouldStop(state): StopReason | null`.
   - Includes existing stop hook call, max iterations, time budget, or user abort checks.
4. Extract cadence audit scheduling into `CadenceAuditor`:
   - API: `shouldAudit(state): boolean`, `runAudit(state): AuditResult`.
5. Refactor `executeInner` into a coordinator that:
   - Initializes `WorkQueue` with current state.
   - Loops: dequeue, evaluate decision, enqueue new work, run audit, check termination.
6. Keep all existing logging, metrics, and events intact by forwarding through the new components.

**Acceptance Criteria**
- `executeInner` is reduced to orchestration logic and delegates to extracted helpers.
- Queue state mutations are only performed in `WorkQueue`.
- Behavior and log/event ordering are unchanged for existing flows.

**Risks / Mitigations**
- Risk: refactor changes subtle ordering of hooks or audits.
- Mitigation: preserve order by mirroring current sequence and add unit tests for loop ordering.

## Implementation Spec: Bridge Command Registry (Handle Publish)

**Goal**
Replace the large switch in `handlePublish` with a registry that validates command payloads and dispatches to focused handlers.

**Non-Goals**
- No changes to external bridge protocol or command payload schemas.
- No changes to side-effect behavior for valid commands.

**Current Pain**
`handlePublish` is a large switch with validation and side effects mixed together across domains, making it hard to extend and easy to break.

**Proposed Approach**
Introduce a `commandRegistry` mapping `BridgeCommandType` to `{ validate, handle }` pairs. Each handler is a small function that receives a typed payload and performs the current side effects.

**Files in Scope**
- `packages/harness-daemon/src/harness/bridge_gateway.ts`

**Detailed Steps**
1. Define a `CommandSpec<T>` type:
   - `validate(payload: unknown): payload is T`
   - `handle(payload: T, ctx: BridgeContext): Promise<void>`
2. Create a `commandRegistry: Record<BridgeCommandType, CommandSpec<any>>` that maps each command to its spec.
3. For each existing switch case:
   - Extract payload validation into a `validateX` guard.
   - Extract the side effects into `handleX`.
4. Replace the switch in `handlePublish` with:
   - Parse envelope, lookup spec, validate payload, invoke handler or emit error.
5. Keep existing error events and logging; use a shared `publishError` helper to avoid duplication.

**Acceptance Criteria**
- `handlePublish` is a small dispatcher with no switch.
- Each command has a local validator and handler in the same file.
- Behavior for valid inputs matches current behavior.

**Risks / Mitigations**
- Risk: Validators are too strict and reject legitimate commands.
- Mitigation: Start with permissive validators and tighten later; log validation failures with payload snippets.

## Spec Stubs (To Be Detailed Later)
- Split `HarnessLike` into smaller interfaces so `BridgeGateway` only depends on what it uses.
- Centralize model-selection handling to a single helper/service.
- Replace `callStopHook` positional parameters with a `StopHookContext` object.
