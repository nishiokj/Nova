# Plan: Subscribing to Internal Events

## Current Event Architecture

The codebase already has three event patterns:

### 1. **Direct Handler Registration** (SyncEngine & Scheduler)
```typescript
// SyncEngine (engine.ts:179)
private eventHandlers: Array<(event: SyncEvent) => void> = []

onEvent(handler: (event: SyncEvent) => void): this {
  this.eventHandlers.push(handler)
  return this
}

private emit(event: SyncEvent): void {
  for (const handler of this.eventHandlers) {
    try { handler(event) } catch {}
  }
}
```

**Event Types Emitted:**
- **SyncEngine**: `SyncEvent` (from `sync/types.ts`)
- **Scheduler**: `SchedulerEvent` - includes `scheduler:started`, `scheduler:stopped`, `scheduler:tick`, `scheduler:task_executed`, `scheduler:task_error`, `scheduler:webhook_subscribed`, etc.
- **Derived Tasks**: `scheduler:derived_task_executed`, `scheduler:derived_task_error`, etc.

### 2. **Connector Event Bubbling**
```typescript
// SyncEngine wires sub-component events
this.collector.onEvent((event) => this.emit(event))
this.processor.onEvent((event) => this.emit(event))
```

### 3. **Comms-Bus** (External IPC)
```typescript
// Existing TCP-based JSONL pub/sub system
busClient.subscribe(channel)
busClient.on('event', (payload, channel) => {})
```

---

## Proposed Approaches

### **Option A: Extend Existing `onEvent()` Pattern** (Recommended)

**Pros:**
- Zero new dependencies
- Maintains backward compatibility
- Simple and predictable
- Already proven in production

**Implementation:**

```typescript
// Add to SyncEngine
interface EventSubscription {
  eventType?: string | string[]  // Filter by type
  handler: (event: SyncEvent) => void
  once?: boolean
}

private eventSubscriptions: EventSubscription[] = []

onEvent(
  eventType: string | string[] | ((event: SyncEvent) => boolean),
  handler: (event: SyncEvent) => void,
  options?: { once?: boolean }
): () => void {
  // Returns unsubscribe function
}

// Add to SyncDaemon
onEngineEvent(callback: (event: SyncEvent) => void): () => void {
  return this.engine.onEvent(callback)
}

onSchedulerEvent(callback: (event: SchedulerEvent) => void): () => void {
  return this.scheduler.onEvent(callback)
}

onAllEvents(callback: (source: 'engine' | 'scheduler', event: SyncEvent | SchedulerEvent) => void): () => void {
  // Unified handler
}
```

**CLI Usage Example:**
```typescript
// scripts/sync-api-cli.ts
const client = new SyncClient(SYNC_DAEMON_URL)

// Add new command: events watch
async function cmdEventsWatch(filters?: string[]) {
  const stream = await client.events.subscribe({
    types: filters, // e.g., ['scheduler:task_executed', 'sync:*']
  })

  for await (const event of stream) {
    console.log(JSON.stringify(event, null, 2))
  }
}
```

---

### **Option B: Integrate Comms-Bus Internally**

**Pros:**
- Reuses existing `BusClient` infrastructure
- Channel-based filtering already built-in
- Can expose events externally via same API

**Implementation:**

```typescript
// Add internal bus to SyncDaemon
export class SyncDaemon {
  private internalBus: EventEmitter = new EventEmitter()

  // Bridge SyncEngine events to internal bus
  constructor(...) {
    this.engine.onEvent((event) => {
      this.internalBus.emit('engine:*', event)
      this.internalBus.emit(`engine:${event.type}`, event)
    })

    this.scheduler.onEvent((event) => {
      this.internalBus.emit('scheduler:*', event)
      this.internalBus.emit(`scheduler:${event.type}`, event)
    })
  }

  // Subscribe to internal events
  subscribe(pattern: string, handler: (event: any) => void): () => void {
    this.internalBus.on(pattern, handler)
    return () => this.internalBus.off(pattern, handler)
  }
}
```

**HTTP API Addition:**
```typescript
// Add to routes/index.ts or new routes/events.ts
server.get('/events/stream', async (req) => {
  const filters = req.query.types?.split(',') as string[]

  // SSE stream
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = daemon.subscribe(pattern, (event) => {
        controller.enqueue(`data: ${JSON.stringify(event)}\n\n`)
      })

      req.on('close', unsubscribe)
    }
  })

  return {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: stream
  }
})
```

---

### **Option C: Hybrid Approach** (Most Flexible)

Combine both:
- Use **Option A** for internal in-process subscriptions (CLI, tests)
- Use **Option B** for HTTP API and external consumers

```typescript
// SyncDaemon supports both
export class SyncDaemon {
  // Option A-style direct callbacks
  onSchedulerEvent(callback): () => void { ... }

  // Option B-style internal bus
  subscribe(channel: string, handler): () => void { ... }

  // Expose via HTTP SSE
  private setupEventRoutes(server: HttpServer) {
    server.get('/api/events/stream', (req) => {
      // SSE endpoint using internal bus
    })
  }
}
```

---

## Recommended Implementation Path

### Phase 1: Minimal Viable (Option A)
1. Add filtered `onEvent()` to `SyncEngine` and `Scheduler`
2. Add convenience methods to `SyncDaemon`:
   - `onEngineEvent(callback)`
   - `onSchedulerEvent(callback)`
3. Add SSE endpoint to HTTP routes: `GET /api/events/stream`
4. Update CLI with `events watch` command

### Phase 2: Internal Bus (Option B)
1. Add `internalBus` EventEmitter to `SyncDaemon`
2. Bridge engine and scheduler events to bus
3. Implement channel-based subscriptions
4. Add wildcard support (`scheduler:*`, `*:task_executed`)

### Phase 3: Advanced Features
1. Event replay for recent events
2. Event history persistence
3. Dead letter queue for failed handlers
4. Circuit breaker for high-volume events

---

## Example: Event Subscription Patterns

```typescript
// Watch all sync job completions
daemon.onEngineEvent((event) => {
  if (event.type === 'job:completed') {
    console.log(`Job ${event.jobId} finished`)
  }
})

// Watch all scheduler events using pattern
daemon.subscribe('scheduler:task_executed', (event) => {
  console.log(`Task ${event.task.id} executed`)
})

// Wildcard subscription
daemon.subscribe('scheduler:*', (event) => {
  console.log('Scheduler event:', event.type)
})

// CLI usage
bun run scripts/sync-api-cli.ts events watch scheduler:task_executed

// Or via SSE endpoint
curl http://localhost:3001/api/events/stream?types=scheduler:task_executed
```

---

## Files to Modify

| File | Changes |
|------|----------|
| `packages/agent-memory/src/sync/engine.ts` | Add filtered `onEvent()` |
| `packages/agent-memory/src/sync/scheduler.ts` | Add filtered `onEvent()` |
| `packages/agent-memory/src/daemon/index.ts` | Add event subscription methods, setup internal bus |
| `packages/agent-memory/src/daemon/routes/events.ts` | **New file** - SSE endpoint |
| `packages/agent-memory/src/daemon/routes/index.ts` | Register event routes |
| `scripts/sync-api-cli.ts` | Add `events` commands (watch, list, replay) |
| `packages/agent-memory/src/client/index.ts` | Add event subscription API |

---

## Decision Questions

1. **Granularity:** Do we need per-task event filtering (e.g., `scheduler:task_executed:task_id`), or is top-level filtering sufficient?

2. **Persistence:** Should events be persisted for replay, or are they ephemeral fire-and-forget?

3. **Throughput:** What's the expected event volume? If >1000/sec, we may need backpressure handling.

4. **Authentication:** Should the SSE endpoint require authentication, or be open for monitoring?
