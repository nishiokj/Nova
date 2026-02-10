# Dashboard-Control Runbook

## Start (dev)

```bash
bun run --cwd packages/dashboard-control dev
```

## Start (preview build)

```bash
bun run --cwd packages/dashboard-control build
bun run --cwd packages/dashboard-control preview
```

## Health

```bash
curl -sf http://127.0.0.1:4173
```

Expected: HTML document response.

CI deployability check uses build:

```bash
bun run --cwd packages/dashboard-control build
```

## Stop

- If foreground: `Ctrl+C`
