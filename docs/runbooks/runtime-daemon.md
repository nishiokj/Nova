# Runtime Daemon Runbook

## Start

```bash
EVENT_BUS_HOST=127.0.0.1 EVENT_BUS_PORT=9555 \
bun run packages/harness-daemon/src/index.ts --host 127.0.0.1 --port 9555 --ws-port 9556 --idle-timeout 0
```

Important: daemon is GraphD client-only. Start GraphD first.

## Health

Port check:

```bash
lsof -iTCP:9555 -sTCP:LISTEN
```

Bridge command round trip:

```bash
bun -e 'import { HarnessClient } from "harness-client"; const c=new HarnessClient({host:"127.0.0.1",port:9555,requestTimeout:5000,maxReconnectAttempts:0}); await c.connect(); console.log(await c.request("control_plane_memory_info", {})); c.close();'
```

Expected: `{ success: true, ... }`.

## Stop

- If foreground: `Ctrl+C`
- If background:

```bash
lsof -ti :9555 | xargs kill
```
