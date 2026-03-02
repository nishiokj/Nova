# comms-bus WebSocket Backpressure Implementation Spec

## Objective

Protect process memory and latency under slow/lagging WebSocket clients while preserving correctness for critical control messages.

## Scope

Implement server-side outbound backpressure control in `BusServer` for all client connections.

## Non-goals

- No protocol version bump.
- No client-side backpressure changes in `BusClient` in phase 1.
- No durable replay/resume of dropped stream data.

## Current Risk

`BusServer.send()` writes directly to `ws.send()` without any pressure checks. A slow client can accumulate unbounded socket buffer growth and increase memory usage for the entire process.

## Functional Requirements

1. `readyState` guard:
- Only send when `ws.readyState === WebSocket.OPEN`.
- If not open, treat connection as closed and clean up.

2. Watermark policy:
- `softLimitBytes = 1_048_576` (1 MB).
- `hardLimitBytes = 8_388_608` (8 MB).
- Under soft limit: normal behavior.
- Between soft and hard: throttle/degrade lossy streams.
- Above hard limit: terminate lagging connection.

3. Message priority classes:
- `lossless`: protocol-critical messages (`error`, RPC/control responses, non-streaming control events).
- `lossy`: high-rate stream fanout (`agent_message`, `agent_reasoning`, `events:all` stream payloads).

4. Degradation policy:
- While above soft limit, coalesce lossy messages by `(channel, streamKey)` and keep only the latest.
- Keep lossless messages ordered and undropped.
- If queue cap exceeded after lossy coalescing, terminate connection.

5. Bounded queue:
- Per-connection queue limits:
  - `maxQueuedMessages = 500`
  - `maxQueuedBytes = 2_097_152` (2 MB serialized payload estimate)
- Exceeding either limit after coalescing triggers disconnect.

6. Staleness cutoff for lossy messages:
- Drop lossy messages older than `lossyTtlMs = 2000`.

7. Observability:
- Counters per server instance:
  - `sentCount`
  - `droppedLossyCount`
  - `coalescedLossyCount`
  - `overflowDisconnectCount`
  - `notOpenDropCount`
- Gauges:
  - `maxBufferedAmountSeen`
  - `maxQueueDepthSeen`
- Emit profiler spans for enqueue/dequeue/drop/terminate branches.

## Proposed Design

### Connection State Extension

Extend `ConnectionState` in `bus_server.ts` with:

- `outboundQueue: QueuedMessage[]`
- `queuedBytes: number`
- `flushScheduled: boolean`
- `lossyIndex: Map<string, number>` (maps coalesce key to queue index)
- `stats` (optional per-connection counters for diagnostics)

### Queued Message Model

```ts
type Priority = 'lossless' | 'lossy';

interface QueuedMessage {
  serialized: string;
  bytes: number;
  channel?: string;
  priority: Priority;
  createdAtMs: number;
  coalesceKey?: string;
}
```

### Send Path Changes

Replace direct `connection.ws.send(serialized)` with:

1. `enqueue(connection, message, metadata)`:
- classify priority.
- apply readyState/hard-limit checks.
- apply lossy coalescing under pressure.
- enforce queue bounds.

2. `scheduleFlush(connection)`:
- one microtask at a time per connection.

3. `flushQueue(connection)`:
- while queue not empty and socket open:
  - check `bufferedAmount`; apply soft/hard policies.
  - drop expired lossy messages.
  - send next allowed message.
- clear `flushScheduled` when done.

### Classification Rules (phase 1)

- Any bus message with `type: 'error'` is `lossless`.
- `event` on channels containing stream events (`events:all` payload type `agent_message` / `agent_reasoning`) is `lossy`.
- `event` on run/session control channels remains `lossless` unless explicitly marked stream payload.

## Failure Policy

Terminate connection when:

- `ws.bufferedAmount > hardLimitBytes`
- queue size/bytes remain above bounds after lossy coalescing/drop
- socket is not open when attempting flush and queue still exists

Termination behavior:

- call `ws.terminate()`
- rely on existing `close` path for cleanup/unsubscribe
- increment `overflowDisconnectCount`

## Testing Plan

Add and pass the following test suites.

1. Unit/mutation tests (`tests/comms-bus`):
- hard-limit disconnect when buffered amount exceeds threshold.
- soft-limit coalescing drops older lossy events, keeps latest.
- lossless messages are never dropped by lossy coalescing.
- queue bound overflow disconnects after lossy compaction attempt.
- stale lossy messages dropped by TTL.
- ordering invariants for lossless queue.

2. Integration tests (`tests/integration`):
- slow-consumer simulation with sustained stream publish:
  - process remains bounded (assert disconnect and counters, not OOM).
- mixed traffic:
  - control/error events delivered while lossy stream is degraded.
- multi-client fairness:
  - lagging client disconnect does not impact healthy clients.

3. Regression linkage:
- existing leak/lifecycle and bridge cutover suites must continue passing.

## Rollout Plan

1. Phase 1: Infrastructure
- Add queue structures, counters, and flush loop with no drops (feature flag off by default).

2. Phase 2: Policy Enablement
- Enable soft/hard watermark logic + lossy coalescing + overflow disconnect.
- Add profiler/counter reporting.

3. Phase 3: Harden + Tune
- Tune thresholds from test telemetry.
- Document operational defaults and override strategy.

## Configuration Surface

Add optional `BusServerOptions.backpressure`:

```ts
interface BackpressureOptions {
  enabled?: boolean; // default true
  softLimitBytes?: number;
  hardLimitBytes?: number;
  maxQueuedMessages?: number;
  maxQueuedBytes?: number;
  lossyTtlMs?: number;
}
```

Defaults should match this spec to avoid caller changes.

## Acceptance Criteria

1. New tests pass and existing comms/bridge suites remain green.
2. Under synthetic slow-consumer load, lagging client is disconnected before unbounded memory growth.
3. Critical control/error messages remain deliverable for healthy clients while lossy stream traffic degrades first.
4. Metrics/counters expose dropped/coalesced/disconnected outcomes for observability.

