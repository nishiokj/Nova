# GraphD Runbook

## Start

```bash
bun run start:graphd
```

Optional custom args:

```bash
bun run packages/infra/graphd/src/graphd.ts --host 127.0.0.1 --port 9444 --db-path ~/.graphd/graphd.db
```

## Health

```bash
curl -sf http://127.0.0.1:9444/health
```

Expected: JSON with `"status":"ok"`.

## Stop

- If foreground: `Ctrl+C`
- If background:

```bash
lsof -ti :9444 | xargs kill
```
