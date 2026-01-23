# Event Streaming Architecture Specification

## Overview

This document describes the current event streaming architecture from Agent to TUI, identifies architectural issues, and proposes an incremental refactoring path.

## Current Architecture

### Event Flow (TUI-bound events)

```
Agent.emit(event)                        // agent.ts
  ↓ (sync callback)
EventBus.publish(taggedEvent)            // event_bus.ts - pushes to pendingEvents
  ↓ (microtask)
EventBus.flush() → dispatchEvent()       // event_bus.ts - calls subscribeRun handlers
  ↓ (sync callback)
harness subscribeRun handler             // harness.ts:820 - UNNECESSARY FOR TUI
  ↓ (sync)
translateAgentEvent()                    // event_translator.ts - UNNECESSARY
  ↓ (sync)
AsyncEventQueue.push()                   // harness.ts - UNNECESSARY FOR TUI
  ↓ (async iteration)
BridgeGateway.streamRunEvents()          // bridge_gateway.ts:1672 - UNNECESSARY
  ↓ (async)
BusServer.publish(channel, event)        // bus_server.ts:77
  ↓ (TCP)
TUI receives
```

### The Problem

EventBus and BusServer are the **same abstraction** (pub/sub) split across two systems:

| EventBus | BusServer |
|----------|-----------|
| In-process pub/sub | Network pub/sub |
| `subscribeRun(runId, handler)` | `subscribe` message from client |
| `publish(event)` | `publish(channel, payload)` |

The middle layers exist only to bridge them:
- **harness subscribeRun handler**: Receives events from EventBus callback
- **translateAgentEvent()**: Converts AgentEvent → BridgeEvent format
- **AsyncEventQueue**: Converts callback-push → async iteration
- **BridgeGateway.streamRunEvents()**: Iterates queue and republishes to BusServer

This is pure indirection. BusServer could subscribe directly to EventBus.

### What Actually Needs the Current Flow

**GraphDSubscriber** and **LogSubscriber** subscribe directly to EventBus via `subscribeAll()` and receive events without any of this machinery. They work fine.

The convoluted path exists **only** for TUI event delivery.

### Key Components

| Component | File | Role |
|-----------|------|------|
| **EventBus** | `packages/comms-bus/src/event_bus.ts` | In-process pub/sub |
| **BusServer** | `packages/comms-bus/src/bus_server.ts` | TCP pub/sub server |
| **BridgeGateway** | `packages/harness-daemon/src/harness/bridge_gateway.ts` | Command routing (legitimate) + event forwarding (unnecessary) |
| **AsyncEventQueue** | `packages/harness-daemon/src/harness/harness.ts` | Callback→AsyncIterable adapter (unnecessary for TUI) |

### Event Types

| AgentEvent | BridgeEvent | Purpose |
|------------|-------------|---------|
| `agent_message` | `stream` | LLM response chunks |
| `agent_reasoning` | `stream` (with `is_reasoning: true`) | Model reasoning/thinking content |
| `tool_call` | `progress` | Tool start/complete status |
| `llm_call` | (filtered) | Internal, not forwarded |
| `permission_request` | `permission_request` | User permission prompts |

## Proposed Refactoring (Incremental)

### Phase 1: BusServer Subscribes to EventBus

**Goal:** Eliminate the harness→AsyncEventQueue→BridgeGateway→BusServer chain for event streaming.

**Change:** BusServer subscribes directly to EventBus for run events and forwards them over TCP.

#### Current Flow (to eliminate for TUI events)
```
EventBus → harness callback → translateAgentEvent → AsyncEventQueue → BridgeGateway.streamRunEvents → BusServer
```

#### New Flow
```
EventBus → BusServer (subscribed) → TCP → TUI
```

#### Implementation

**1. Add EventBus reference to BusServer**

```typescript
// bus_server.ts
export interface BusServerOptions {
  host: string;
  port: number;
  onPublish: BusPublishHandler;
  onConnect?: (connectionId: string) => void;
  onDisconnect?: (connectionId: string) => void;
  eventBus?: EventBusProtocol;  // NEW: optional EventBus for direct subscription
}

export class BusServer {
  private eventBus: EventBusProtocol | null = null;
  private runSubscriptions = new Map<string, () => void>();  // runId → unsubscribe

  constructor(options: BusServerOptions) {
    // ... existing
    this.eventBus = options.eventBus ?? null;
  }

  /**
   * Subscribe to a run's events and forward them to the channel.
   * Called when a client subscribes to a run channel.
   */
  private subscribeToRun(runId: string, channel: string): void {
    if (!this.eventBus || this.runSubscriptions.has(runId)) return;

    const unsubscribe = this.eventBus.subscribeRun(runId, (event) => {
      const bridgeEvent = translateAgentEvent(event);  // Translation happens here
      if (bridgeEvent) {
        this.publish(channel, bridgeEvent);
      }
    });

    this.runSubscriptions.set(runId, unsubscribe);
  }

  /**
   * Unsubscribe from a run's events.
   */
  private unsubscribeFromRun(runId: string): void {
    const unsubscribe = this.runSubscriptions.get(runId);
    if (unsubscribe) {
      unsubscribe();
      this.runSubscriptions.delete(runId);
    }
  }
}
```

**2. Handle run channel subscriptions in BusServer**

```typescript
// bus_server.ts - in handleLine()
case 'subscribe':
  connection.subscriptions.add(message.channel);

  // NEW: If subscribing to a run channel, subscribe to EventBus
  const runMatch = message.channel.match(/^run:(.+)$/);
  if (runMatch && this.eventBus) {
    this.subscribeToRun(runMatch[1], message.channel);
  }
  return;

case 'unsubscribe':
  connection.subscriptions.delete(message.channel);

  // NEW: If no connections left on this run channel, unsubscribe from EventBus
  const runMatch2 = message.channel.match(/^run:(.+)$/);
  if (runMatch2) {
    const stillSubscribed = [...this.connections.values()].some(
      c => c.subscriptions.has(message.channel)
    );
    if (!stillSubscribed) {
      this.unsubscribeFromRun(runMatch2[1]);
    }
  }
  return;
```

**3. Pass EventBus to BusServer in daemon**

```typescript
// daemon.ts
const busServer = new BusServer({
  host: config.bridge.host,
  port: config.bridge.port,
  onPublish: (connectionId, channel, payload) => gateway.handlePublish(connectionId, channel, payload),
  onConnect: (connectionId) => { /* ... */ },
  onDisconnect: (connectionId) => gateway.handleDisconnect(connectionId),
  eventBus: harness.getEventBus(),  // NEW
});
```

**4. Remove from harness.ts**

Remove the subscribeRun → AsyncEventQueue → events chain for TUI:

```typescript
// harness.ts - run() method
// REMOVE THIS BLOCK (lines ~820-825):
// const unsubscribe = this.eventBus.subscribeRun(runId, (event: AgentEvent): void => {
//   const bridgeEvent = translateAgentEvent(event);
//   if (bridgeEvent) {
//     eventQueue.push(bridgeEvent);
//   }
// });
```

**5. Remove from BridgeGateway**

Remove `streamRunEvents()` method entirely. It's no longer called.

```typescript
// bridge_gateway.ts
// REMOVE streamRunEvents() method (lines ~1665-1691)
```

**6. Update handleSendText**

No longer call `streamRunEvents`:

```typescript
// bridge_gateway.ts - handleSendText()
const handle = this.harness.run({ /* ... */ });

// REMOVE: this.streamRunEvents(clientRequestId, handle);

// Just await the result for response event
handle.result.then((result) => {
  // Emit final response event if needed
}).catch((error) => {
  // Emit error event
});
```

### Phase 1 Result

```
BEFORE:
Agent → EventBus → harness callback → translate → AsyncEventQueue → BridgeGateway.streamRunEvents → BusServer → TCP → TUI

AFTER:
Agent → EventBus → BusServer (subscribed) → TCP → TUI
```

**Removed:**
- harness subscribeRun callback for TUI forwarding
- BridgeGateway.streamRunEvents() method
- The AsyncEventQueue push/iteration path for TUI events

**Kept:**
- AsyncEventQueue class (harness may use it for other purposes)
- BridgeGateway (still routes commands)
- Event translation (moved to BusServer subscription handler)

### Phase 2: Move Event Translation

**Goal:** Unify event formats or move translation to a cleaner location.

**Options:**

1. **Agent emits BridgeEvent directly** - Simplest, but couples Agent to wire format
2. **Translation at EventBus boundary** - EventBus has a "transform" option for network delivery
3. **Keep translation in BusServer** - Current Phase 1 approach, acceptable

For now, Phase 1's approach (translation in BusServer's subscription handler) is acceptable. Revisit if formats diverge further.

### Phase 3: Consider Unifying EventBus and BusServer

**Long-term:** EventBus could have native network transport support, making BusServer redundant.

```typescript
// Hypothetical unified bus
const bus = new EventBus({
  network: { host: '127.0.0.1', port: 9120 }  // Enables TCP transport
});

bus.publish(event);  // Delivers to both in-process and network subscribers
```

This is a larger refactor. Phase 1 achieves the immediate goal without this.

## Summary

### What Changes

| Before | After |
|--------|-------|
| Harness subscribes to EventBus, pushes to AsyncEventQueue | BusServer subscribes to EventBus directly |
| BridgeGateway iterates AsyncEventQueue, republishes to BusServer | BusServer receives events directly |
| 6 hops for TUI event delivery | 3 hops for TUI event delivery |

### What Stays the Same

- AsyncEventQueue class (keep for now, may be used elsewhere)
- BridgeGateway command routing (init, send_text, skills_*, etc.)
- GraphDSubscriber and LogSubscriber (already subscribe directly to EventBus)
- Event translation logic (just moves to BusServer)

### Files to Modify

1. `packages/comms-bus/src/bus_server.ts` - Add EventBus subscription support
2. `packages/harness-daemon/src/harness/daemon.ts` - Pass EventBus to BusServer
3. `packages/harness-daemon/src/harness/harness.ts` - Remove subscribeRun→eventQueue chain
4. `packages/harness-daemon/src/harness/bridge_gateway.ts` - Remove streamRunEvents()

### New Event Flow

```
Agent.emit(event)                    // agent.ts
  ↓ (sync callback)
EventBus.publish(taggedEvent)        // event_bus.ts
  ↓ (microtask flush)
EventBus.dispatchEvent()             // event_bus.ts - calls subscribeRun handlers
  ↓ (sync callback)
BusServer subscription handler       // bus_server.ts - translates and publishes
  ↓ (TCP)
TUI receives                         // bridge_client.ts
```

**4 hops** instead of 10+.

## References

- `packages/comms-bus/src/event_bus.ts` - EventBus pub/sub
- `packages/comms-bus/src/bus_server.ts` - TCP pub/sub server (to modify)
- `packages/harness-daemon/src/harness/harness.ts` - Harness (remove event forwarding)
- `packages/harness-daemon/src/harness/bridge_gateway.ts` - Gateway (remove streamRunEvents)
- `packages/harness-daemon/src/harness/event_translator.ts` - Translation logic (to move)
