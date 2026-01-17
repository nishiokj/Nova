# Async Hooks (Internal)

Async hooks are internal, best-effort housekeeping handlers that run without LLM calls.
They are enqueued as work items by the agent and executed by the orchestrator with a timeout.

## When to use

Use async hooks for lightweight background work such as logging, persistence, metrics, or cleanup.
They should be fast, non-blocking, and safe to skip if they time out or fail.

## Create a new async hook

1. Pick an event type from `packages/agent/src/types.ts` under `InternalHookEvent`.
2. Create a handler in `packages/orchestrator/src/hooks/`:
   - Use the signature `async (event, context) => Promise<void>`.
   - Keep side effects minimal; errors are logged and do not block execution.
3. Register the handler in `packages/orchestrator/src/hooks/index.ts` by adding it to the
   appropriate event array in `HOOK_REGISTRY`.

## Add a new event type (if needed)

1. Add the new event shape to `InternalHookEvent` in `packages/agent/src/types.ts`.
2. Emit the event from the agent or orchestrator (see existing enqueue calls in `packages/agent/src/agent.ts`).
3. Register your handler in `packages/orchestrator/src/hooks/index.ts`.

## Testing

The repo includes a simple test hook:
- `packages/orchestrator/src/hooks/hook-test.ts`
- It logs on `turn_completed` events when `REX_TEST_HOOK=1` is set.

Set the env var and run any flow that completes a turn to verify the hook pipeline.

## Notes and limits

- Async hooks do not use the LLM and do not get tool access.
- They run with `hookTimeoutMs` (see `packages/orchestrator/src/orchestrator.ts`).
- Failures are logged and do not halt agent execution.
