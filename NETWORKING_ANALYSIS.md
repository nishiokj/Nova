# Networking Architecture Analysis

## Current Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EVENT BUS (comms-bus)                              │
│                   TCP Port: 9555 | WebSocket Port: 9556                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐       ┌──────────────┐         ┌──────────────┐          │
│  │ TUI          │       │ WebSocket    │         │ BridgeGateway │          │
│  │ (BridgeClient)│──────►│ Bridge       │─────────►│ (Command     │          │
│  │              │ TCP   │ (WsBridge)  │  Events  │  Router)     │          │
│  └──────┬───────┘       └──────────────┘         └──────┬───────┘          │
│         │                                                 │                  │
│         │─────────────────────────────────────────────────│                  │
│         │                                                 │                  │
│         │ ┌─────────────────────────────────────────────┐ │                  │
│         │ │ Direct GraphD Queries (BYPASSES DAEMON)     │ │                  │
│         │ │ - fetchGraphdSessions()                     │ │                  │
│         │ │ - fetchUsageData()                          │ │                  │
│         │ └─────────────────────────────────────────────┘ │                  │
│         ▼                                                 ▼                  │
│  ┌──────────────────────┐                        ┌──────────────┐          │
│  │    GraphD           │                        │   Harness    │          │
│  │  (HTTP REST API)    │                        │  Orchestrator │          │
│  └──────────────────────┘                        └──────┬───────┘          │
│         ▲                                                │                  │
│         │                                                │                  │
│         │                                                ▼                  │
│         │                                         ┌──────────────┐          │
│         │◄───────────────────────────────────────│   EventBus    │          │
│         │                                         │   (internal)   │          │
│         │                                         └───────────────┘         │
│         │                                                                    │
└─────────┼────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CONTROL PLANE (HTTP REST API)                          │
│                          Port: ~9557 (daemon)                              │
│                                                                              │
│  ┌────────────────┐       ┌──────────────────────────────────┐             │
│  │ Control        │       │ Control Plane Routes (daemon)     │             │
│  │ Dashboard      │◄──────►│ - /control-plane/projects         │             │
│  │ (Web UI)      │ GET   │ - /control-plane/sessions          │             │
│  │                │ POST  │ - /control-plane/cockpit/*        │             │
│  │ Poll: 5s       │       │ - /control-plane/markdown/*       │             │
│  └────────────────┘       │ - /control-plane/browser/*        │             │
│                           │ - /control-plane/session/{key}/*  │             │
│                           └──────────────┬───────────────────┘             │
│                                          │                                   │
│                                          ▼                                   │
│                           ┌──────────────────────────────────┐             │
│                           │       GraphD (Session Data)      │             │
│                           └──────────────────────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Inventory

| Component | Purpose | Protocol | Port |
|-----------|---------|----------|------|
| **Event Bus** | Message distribution hub | TCP (JSONL), WebSocket (JSON) | 9555, 9556 |
| **BridgeGateway** | Routes TCP commands to Harness | TCP over Event Bus | 9555 |
| **WsBridge** | WebSocket gateway for browsers | WebSocket | 9556 |
| **Control Plane API** | HTTP REST for dashboard | REST JSON | ~9557 |
| **GraphD** | Session/message persistence | REST JSON | Configured |
| **TUI** | Terminal UI client | TCP to Event Bus + direct GraphD | 9555 + GraphD |
| **Control Dashboard** | Browser control UI | HTTP REST (polling 5s) | ~9557 |
| **Harness** | Agent orchestration | Internal EventBus | N/A |

## Data Path Analysis

### Control Dashboard (HTTP Polling) ✅ Correct
```
Control Dashboard → HTTP REST → Control Plane API → GraphD
```
- **Method**: GET requests every 5 seconds
- **Location**: `packages/dashboard-control/src/App.tsx:13,32`
- **Endpoints**: `/control-plane/cockpit/rollups/*`, `/control-plane/browser/state`
- **Issues**: Stale data between polls, repeated round-trips

### TUI (Hybrid - Correct + Incorrect) ⚠️
```
Path 1 (Correct):  TUI → TCP Bridge → EventBus → Harness
Path 2 (Incorrect): TUI ──────────────→ Direct GraphD HTTP
```
- **Path 1**: Live session events via TCP bus
- **Path 2**: Session listing (`fetchGraphdSessions`) and usage data (`fetchUsageData`) bypass daemon
- **Location**: `packages/tui/index.tsx:147,190`
- **Issue**: Creates duplicate data path, GraphD becomes bottleneck

## Key Findings

### 1. Control Dashboard Uses Correct Data Path

**User Correction**: The Control Dashboard correctly uses HTTP REST to the control plane API, not direct GraphD queries. The duplicate data path issue is isolated to the TUI only.

### 2. Bottlenecks Identified

| Location | Issue | Impact |
|----------|-------|--------|
| `dashboard-control/src/App.tsx:13` | 5-second HTTP polling (`POLL_INTERVAL_MS = 5000`) | Repeated round-trips, stale data between polls |
| `tui/index.tsx:147` | Direct GraphD sessions query (`fetchGraphdSessions`) | GraphD becomes bottleneck for TUI session listing |
| `tui/index.tsx:190` | Direct GraphD usage query (`fetchUsageData`) | Significant HTTP load on GraphD for aggregated metrics |
| `daemon.ts:150` | Global EventBus → WS broadcast (`subscribeGlobal`) | All events serialized for all clients, no filtering |
| `bus_ws_server.ts:96` | No connection filtering (`publish`) | Unnecessary JSON.stringify() for unsubscribed clients |
| All wire payloads | No compression | Bandwidth waste for diffs, traces, packets |

### 3. Protocol Spaghetti

```
TUI:          TCP (9555) only
Control Dash: HTTP REST (~9557) only
Browser:      WebSocket (9556) only
Harness:      Internal EventBus (in-memory)
```

**Problem:** Three different protocols for essentially the same data (session events).

### 4. Duplicate Control Paths

- `bridge_gateway.ts:248` - TCP commands → Harness actions (30+ command handlers)
- `control_plane_routes.ts:682` - HTTP REST → Harness actions

Both can trigger the same Harness operations. No unified interface.

### 5. WebSocket Broadcast Inefficiency

```typescript
// daemon.ts:150
eventBus.subscribeGlobal((event) => {
  this.wsBridge.publish(channel, event);  // All events to all clients
});
```

Every EventBus event is forwarded to all WebSocket clients, regardless of subscription.

```typescript
// bus_ws_server.ts:96
publish(channel: string, payload: unknown): void {
  this.connections.forEach(conn => {
    conn.send(JSON.stringify(payload));  // Serialize for EVERY connection
  });
}
```

## Recommendations (Priority Order)

### P0: Replace Control Dashboard Polling with WebSocket

**Current:**
```typescript
// packages/dashboard-control/src/App.tsx:13,32
const POLL_INTERVAL_MS = 5000;

usePolling(async () => {
  store.refreshAll();           // GET /control-plane/cockpit/rollups/*
  workspace.refreshTree();       // GET /control-plane/browser/state
  store.refreshBrowserState();
}, POLL_INTERVAL_MS);
```

**Proposed:**
```typescript
// Single WebSocket connection, real-time events
const ws = new WebSocket('ws://localhost:9556');
ws.subscribe('session:{sessionKey}');
ws.subscribe('global:updates');
ws.subscribe('browser:state');
```

**Benefits:**
- Eliminate 5-second polling delay
- Reduce HTTP overhead (multiple endpoints → single connection)
- Real-time updates for rollups, browser state
- Use existing WsBridge infrastructure

### P1: Remove TUI's Direct GraphD Queries

**Delete:**
```typescript
// packages/tui/index.tsx:147
async function fetchGraphdSessions(): Promise<GraphDSession[]> {
  // Direct GraphD HTTP query - DELETE THIS
}

// packages/tui/index.tsx:190
async function fetchUsageData(): Promise<{sessions, dayStats, providerStats}> {
  // Direct GraphD HTTP query - DELETE THIS
}
```

**Replace with:**
```typescript
// NEW: Route through Control Plane API
GET /control-plane/sessions?includeUsage=true
GET /control-plane/sessions/{key}/usage
```

**Benefits:**
- Single data path (Control Plane → GraphD)
- Control Plane can cache responses
- Reduce GraphD load
- Consistent data source for all UIs

### P2: Implement Event Filtering at WsBridge Level

**Current:**
```typescript
// bus_ws_server.ts:96
publish(channel: string, payload: unknown): void {
  this.connections.forEach(conn => {
    conn.send(JSON.stringify(payload));  // Serialize for EVERY connection
  });
}
```

**Proposed:**
```typescript
// Track per-client subscriptions
this.connections.set(wsId, {
  subscribedChannels: new Set(['session:abc', 'global:updates'])
});

// Only serialize for subscribed clients
const subscribers = connections.filter(c => c.channels.includes(channel));
subscribers.forEach(conn => conn.send(JSON.stringify(payload)));
```

**Benefits:**
- Reduce CPU for JSON.stringify()
- Lower network traffic
- Better scalability

### P3: Add Event Compression

```typescript
// Compress large payloads
import pako from 'pako';

if (payloadSize > THRESHOLD) {
  const compressed = pako.deflate(JSON.stringify(event));
  ws.send(compressed);
}
```

**Benefits:**
- 60-80% bandwidth reduction for diffs/traces
- Faster UI updates

### P4: Consider Unified Control Interface

Merge BridgeGateway and ControlPlane into a single interface:
- Commands come in via WebSocket (unified protocol)
- Router dispatches based on message type
- Single audit trail

## Action Items

1. **[ ]** Add WebSocket client to `dashboard-control`
2. **[ ]** Remove 5-second polling from `App.tsx`
3. **[ ]** Add session/usage endpoints to Control Plane API
4. **[ ]** Remove direct GraphD queries from TUI (`fetchGraphdSessions`, `fetchUsageData`)
5. **[ ]** Implement connection-level subscription filtering in WsBridge
6. **[ ]** Add compression for large payloads
7. **[ ]** Consider consolidating command routers

## Potential Bottlenecks to Monitor

| Location | Watch For |
|----------|-----------|
| `daemon.ts:150` | Event rate → WS serialization CPU |
| `control_plane_routes.ts:682` | Concurrent HTTP requests |
| `bus_ws_server.ts:96` | Connection churn + memory |
| GraphD | Session/message query latency |
| `event_bus.ts:44` | Event queue depth for streaming events |

## Next Steps

1. Start with P0: WebSocket for Control Dashboard
2. Test with existing WsBridge infrastructure
3. Measure polling vs WebSocket latency
4. Proceed to P1: Consolidate session data

## Implemented Minimal Refactor (February 6, 2026)

### Completed in code

- `WsBridgeServer` now supports direct `EventBus` `run:*` subscriptions.
  - Removed daemon-wide `subscribeGlobal` forwarding loop.
  - WebSocket events are now run-scoped, not global fan-out.
- Added control-plane aggregate endpoint:
  - `GET /control-plane/cockpit/rollups/snapshot`
  - Returns running/ready/done/escalations/metrics (+ optional commit/PR rollups) in one payload.
  - Added short TTL cache (`1.5s`) to absorb polling fan-out.
- Dashboard rollup polling now uses a single snapshot request instead of multiple rollup endpoints.
  - Repo-heavy rollups (commits/PRs) are throttled to a slower cadence.
  - Focus refresh now performs light updates frequently and heavy diff/test/trace refreshes on a slower cadence.
- Harness daemon startup decoupling:
  - `--no-ws` option added to disable WebSocket bridge for TCP-only deployments.
  - Dashboard/control-plane server can run API-only if static dashboard assets are not present (no hard dependency on `dashboard-control/dist`).

### Database startup ownership (current)

- GraphD (SQLite + HTTP):
  - Started in `packages/harness-daemon/src/harness/harness.ts` via `AgentHarness.start() -> GraphDManager.start()`.
  - Reuses existing GraphD instance when already healthy on configured host/port.
- EntityGraph (Postgres):
  - Initialized in `packages/harness-daemon/src/harness/harness.ts` when `entityGraph.enabled` and DB URL is present.
  - Non-fatal if unavailable.
- Agent-memory:
  - Separate daemon process (`packages/agent-memory/src/daemon/server.ts`), own persistence.
  - Harness uses `SyncClient` over HTTP (`MEMORY_DAEMON_URL`) rather than embedding DB lifecycle in harness-daemon.
