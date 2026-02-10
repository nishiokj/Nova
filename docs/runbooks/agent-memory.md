# Agent-Memory Runbook

## Start

```bash
cd packages/agent-memory
bun run daemon:only
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
