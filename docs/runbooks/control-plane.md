# Control-Plane Runbook

## Start

```bash
EVENT_BUS_HOST=127.0.0.1 EVENT_BUS_PORT=9555 \
bun run packages/infra/control-plane/src/control-plane.ts --host 127.0.0.1 --port 9557 --bus-host 127.0.0.1 --bus-port 9555
```

Important: control-plane is GraphD client-only. Start GraphD first.

## Health

```bash
curl -sf "http://127.0.0.1:9557/control-plane/sessions?limit=1"
```

Expected: JSON response with a `sessions` array.

SSE stream check:

```bash
curl -N "http://127.0.0.1:9557/control-plane/cockpit/events/stream"
```

Expected first frame includes `{"type":"connected"}`.

## Stop

- If foreground: `Ctrl+C`
- If background:

```bash
lsof -ti :9557 | xargs kill
```
