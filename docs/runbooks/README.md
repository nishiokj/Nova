# Deployable Runbooks

Phase 5 deployability runbooks for each independently deployable component.

- `docs/runbooks/graphd.md`
- `docs/runbooks/runtime-daemon.md`
- `docs/runbooks/agent-memory.md`
- `docs/runbooks/tui.md`

## Recommended Startup Order

1. `bun run start:graphd`
2. `bun run packages/infra/harness-daemon/src/index.ts`
3. UI clients (`tui`, `dashboard`, `dashboard-compact`)

## Post-Shakeup Verification

```bash
bun run typecheck:split-runtime
bun run test:split-runtime
```
