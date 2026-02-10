# Deployable Runbooks

Phase 5 deployability runbooks for each independently deployable component.

- `docs/runbooks/graphd.md`
- `docs/runbooks/runtime-daemon.md`
- `docs/runbooks/control-plane.md`
- `docs/runbooks/agent-memory.md`
- `docs/runbooks/tui.md`
- `docs/runbooks/dashboard-control.md`

## Recommended Startup Order

1. `bun run start:graphd`
2. `bun run packages/harness-daemon/src/index.ts`
3. `bun run packages/control-plane/src/control-plane.ts`
4. UI clients (`tui` / `dashboard-control`)

## Compatibility Smoke Test

Run the inter-process smoke test:

```bash
bun run smoke:interprocess
```

This validates:

- bridge command round trip
- event streaming
- session operations
- permission and escalation route flow
