# RPC Migration North Star: Full Cutover

## Decision

This migration is a **single major cutover**.

- No mixed-protocol support.
- No compatibility layer for legacy request/response bridge commands.
- Final state must have one request/response protocol: typed RPC.

## Why

The current bridge protocol has excessive boilerplate, weak correlation semantics, and response parsing by ad-hoc metadata kind strings. The target state is a strict protocol boundary with compile-time method typing and runtime invariants.

## Target Protocol (Final State)

`bridge_command` carries two shapes only:

```ts
// streaming commands (unchanged)
{ type: 'init' | 'send_text' | 'send_media' | 'user_prompt_response' | 'permission_response', data?: Record<string, unknown> }

// rpc request/response
{ rpc: 1, method: string, id: string, params?: unknown }
{ rpc: 1, id: string, result: unknown }
{ rpc: 1, id: string, error: { code: number, message: string } }
```

## File-Level North Star

### New Files (must exist)

- `packages/infra/harness-client/src/rpc_types.ts`
- `packages/infra/harness-client/src/rpc_client.ts`
- `packages/infra/harness-daemon/src/harness/rpc_dispatcher.ts`
- `packages/infra/harness-daemon/src/harness/rpc_handlers.ts`
- `packages/infra/harness-daemon/src/harness/rpc_method_handlers.ts`

### Existing Files (must remain, but be simplified)

- `packages/infra/harness-daemon/src/harness/bridge_gateway.ts`
- `packages/infra/harness-client/src/index.ts`
- `packages/apps/tui/bridge_client.ts`
- `packages/apps/tui/index.tsx`
- `packages/infra/harness-client/src/types.ts`
- `packages/apps/tui/types.ts`

### Code That Must Be Deleted

From `packages/infra/harness-daemon/src/harness/bridge_gateway.ts`:

- `createCommandRegistry`
- `parseBridgeCommand`
- `sendAuthResponse`
- `sendSkillsResponse`
- `sendHooksResponse`
- all migrated request/response handlers currently in gateway (`handleSkills*`, `handleHooks*`, `handleAuth*`, `handleProviders*`, `handleSession*`, `handleUsageSummary`, `handleCompactContext`, `handleSetModel`, `handleGetModel`, `handleSetDangerousMode`, `handleAsyncStatus`, `handleControlPlane*`, `handleModelsDelete`, `handleGetConfig`, `handleGetStatus`, `handleGetModels`, `handleDeferredResponse`, `handleVoiceUnsupported`)

From `packages/infra/harness-client/src/index.ts`:

- `sendAuthCommand`
- `pendingRequests` map used by metadata kind correlation
- all per-command wrapper methods that only proxy request/response commands

From `packages/apps/tui/bridge_client.ts`:

- all legacy delegation methods (`authStart`, `providersSave`, `sessionFork`, etc.)

From `packages/apps/tui/index.tsx`:

- response handling branches that key off `event.data.metadata.kind` for migrated request/response operations

From shared types:

- `BridgeCommandDataMap` entries for migrated request/response commands
- legacy command string variants for migrated request/response commands in `BridgeCommandType`

## Final Routing Responsibilities

### BridgeGateway keeps only

- connection lifecycle and ownership state
- `init`, `send_text`, `send_media`, `user_prompt_response`, `permission_response`
- run-channel/session-channel streaming
- generic direct event/error emit helpers
- RPC request detection and dispatch handoff

### RpcDispatcher + rpc handlers own

- all unary request/response operations
- RPC error code mapping
- input validation and normalized error surfaces
- side-effect event emission through `ctx.emit`

## Invariants (Must Hold)

1. **No metadata-kind RPC routing:** migrated unary operations never rely on `response.metadata.kind`.
2. **Correlation by RPC id only:** response matching is exclusively by `id`.
3. **At-most-once resolution:** each RPC request resolves or rejects exactly once.
4. **Timeout cleanup:** timed-out RPC requests are removed from pending maps.
5. **No pending leaks on disconnect:** disconnect rejects and clears all inflight RPC calls.
6. **Legacy unary commands rejected:** sending migrated legacy command names returns explicit error.
7. **Streaming behavior unchanged:** run-channel/session-channel semantics and event types are preserved.
8. **Session ownership unchanged:** `init` exclusivity and ownership enforcement remain intact.
9. **Model side effects preserved:** `model.set`/`model.delete` still emit `model_changed`; key-missing path still emits `provider_key_required`.
10. **Async cancel side effects preserved:** async cancel still emits completion signal on session channel.
11. **Control-plane semantics preserved:** pause/resume/cancel mapping and request metadata behavior unchanged.
12. **Bridge event validation remains strict:** malformed inbound events still fail fast.
13. **RPC error shape stable:** `{ code, message }` is always present for RPC failures.
14. **No duplicate business handlers:** each migrated operation has a single handler implementation in `rpc_handlers.ts`.
15. **Type map completeness:** every migrated RPC method exists in `Procedures` with input/output typing.

## Testing North Star

## Unit Tests (mandatory)

Add/update tests for:

- `tests/harness-daemon/harness/rpc_dispatcher.test.ts`
- `tests/harness-daemon/harness/rpc_handlers.test.ts`
- `tests/harness-daemon/harness/bridge_gateway.test.ts` (retain streaming tests, add legacy-unary rejection tests)
- `tests/harness-client/rpc_client.test.ts`
- `tests/apps/tui/bridge_client.rpc.test.ts`

Must cover:

- rpc request parse/dispatch success
- unknown method -> deterministic rpc error
- handler-thrown errors -> rpc error mapping
- client timeout + disconnect cleanup
- id collision safety under concurrent same-method requests
- side-effect event emission ordering for model and async flows

## Integration Tests (mandatory)

Add/update end-to-end bus tests:

- `tests/integration/bridge_rpc_cutover.test.ts`

Scenarios:

1. `init` then streaming `send_text` still works.
2. unary method via RPC returns typed result.
3. two concurrent same-method RPC calls resolve to correct request ids.
4. migrated legacy command name returns explicit error (proves cutover is real).
5. model set/delete emit expected events plus RPC response.
6. async cancel emits RPC success and async completion event.
7. control-plane stop pause/resume/cancel semantics remain unchanged.

## Mutation Tests (mandatory)

Add:

- `tests/harness-daemon/harness/rpc_dispatcher.mutation.test.ts`
- `tests/harness-client/rpc_client.mutation.test.ts`

Mutation targets:

- remove id equality checks in resolver
- skip pending cleanup on timeout/disconnect
- flip success/error branch in dispatcher
- drop `ctx.emit` side effects
- swallow unknown-method errors
- alter timeout boundaries/off-by-one behavior

Acceptance bar:

- `rpc_dispatcher.mutation.test.ts`: kill >= 90% targeted mutants
- `rpc_client.mutation.test.ts`: kill >= 90% targeted mutants

## Coverage Gates

For touched RPC modules (`rpc_types.ts`, `rpc_client.ts`, `rpc_dispatcher.ts`, `rpc_handlers.ts`):

- statements >= 95%
- branches >= 90%
- functions >= 95%

For `bridge_gateway.ts` post-cutover critical paths (streaming + init + rpc handoff):

- branches >= 85%

## Cutover Execution Plan

1. Land foundation files (`rpc_types`, `rpc_client`, `rpc_dispatcher`, `rpc_handlers`) with tests.
2. Move all unary handlers to `rpc_handlers.ts`.
3. Update TUI call sites to use `client.rpc.call()` for migrated operations.
4. Delete all legacy unary command plumbing and metadata-kind response parsing.
5. Run full build + tests + mutation suites.
6. Block merge unless every invariant and test gate above passes.

## Done Definition

Migration is complete only when all are true:

- zero legacy unary request/response command handlers remain
- all unary operations are reachable only via RPC
- deleted-code list is satisfied
- invariants are enforced by tests
- integration tests pass for streaming + RPC coexistence
- mutation and coverage gates pass
