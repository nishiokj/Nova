# Agent-Memory Runbook

## Start

```bash
bun run --cwd packages/plugins/agent-memory daemon
```

`daemon` already bootstraps Postgres (or reuses existing), runs migrations, and starts the service.

Optional DB-only bootstrap (no daemon):

```bash
bun run --cwd packages/plugins/agent-memory db:start
```

Required env vars (minimum):

- `DATABASE_URL`
- `CREDENTIAL_ENCRYPTION_KEY` (32-byte hex)

## Health

```bash
curl -sf http://127.0.0.1:3001/api/health
```

Expected: JSON health payload.

## Stop

- If foreground: `Ctrl+C`
- If background:

```bash
lsof -ti :3001 | xargs kill
```
