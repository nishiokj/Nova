# comms-bus: TCP/JSONL → WebSocket Migration

## What changed

Replaced the hand-rolled TCP + JSONL (newline-delimited JSON) transport with WebSocket (`ws` package). WebSocket provides message-level framing natively, eliminating all manual buffer/split code.

## Files modified

### `package.json`
- Added `ws` (dependency) and `@types/ws` (devDependency)
- Added `exports` map with wildcard subpath for test resolution

### `bus_client.ts` (153 → 120 lines)

| Before (TCP/JSONL) | After (WebSocket) |
|---|---|
| `import net` | `import WebSocket from 'ws'` |
| `socket: net.Socket` | `ws: WebSocket` |
| `buffer = ''` field | Deleted |
| `handleData()` — buffer chunks, split on `\n` | Deleted |
| `handleLine(line)` — parse JSON from extracted line | `handleMessage(data)` — parse JSON from complete WS message |
| `socket.write(\`${json}\n\`)` | `ws.send(json)` |
| `socket.end()` + 500ms destroy timeout | `ws.close()` |
| `setNoDelay(true)`, `setEncoding('utf8')` | N/A for WebSocket |

### `bus_server.ts` (375 → 310 lines)

| Before (TCP/JSONL) | After (WebSocket) |
|---|---|
| `net.createServer()` | `http.createServer()` + `WebSocketServer({ noServer: true })` |
| `ConnectionState.socket: Socket` | `ConnectionState.ws: WebSocket` |
| `ConnectionState.buffer: string` | Deleted |
| `handleData()` — buffer chunks, split on `\n` | Deleted |
| `handleLine(conn, line)` | `handleMessage(conn, data)` |
| `socket.write(\`${json}\n\`)` | `ws.send(json)` |
| `socket.destroy()` | `ws.terminate()` |
| `server.close()` | `httpServer.closeAllConnections()` + `httpServer.close()` |

The HTTP server is managed explicitly (rather than letting `WebSocketServer` create one internally) so that `closeAllConnections()` can be called during shutdown — avoids a hang in bun where the internal HTTP server waits indefinitely for upgraded sockets to drain.

## What didn't change

- **Public API** — `BusClient` and `BusServer` expose identical methods with identical signatures. No consumer changes needed.
- **EventBus integration** — `subscribeToRun`, `subscribeToAllEvents`, channel routing, all untouched.
- **Profiler instrumentation** — same span names.
- **Test bodies** — zero logic changes in tests.

## Test results

- `bus.test.ts` — 2/2 pass (pub/sub broadcast + EventBus forwarding on `events:all`)
- `bridge_gateway.test.ts` — pre-existing failure (unrelated `harness-daemon` subpath export missing)
- `bridge_rpc_cutover.test.ts` — same pre-existing failure
