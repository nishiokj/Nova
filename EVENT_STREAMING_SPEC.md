# Event Streaming Architecture Specification

## Overview

This document describes the current event streaming architecture from Agent to TUI, identifies architectural issues, and proposes a simplified refactoring path.

## Current Architecture

### Event Flow (10 hops)

```
1. Agent.emit(event)                        // agent.ts:~770
   ↓ (sync callback)
2. EventBus.publish(taggedEvent)          // event_bus.ts:~38
   ↓ (sync, queued to pendingEvents)
3. EventBus.flush()                       // event_bus.ts:~58 (microtask scheduled)
   ↓ (sync)
4. subscribeRun handler executes            // event_bus.ts:~96
   ↓ (sync)
5. eventQueue.push(bridgeEvent)           // harness.ts:~607 (AsyncEventQueue)
   ↓ (sync - push to array)
6. eventQueue.next() resolves             // harness.ts:~656 (async)
   ↓ (async yield)
7. streamRunEvents() iterates            // bridge_gateway.ts:~722
   ↓ (async iteration)
8. BusClient.publish()                   // bridge_client.ts:~109 (TCP)
   ↓ (async - network)
9. TCP packet arrives                    // transport layer
   ↓ (async)
10. BridgeClient emits to TUI            // bridge_client.ts:~133
    ↓ (sync EventEmitter)
11. TUI handleStream()                  // tui/index.tsx:~680
    ↓ (sync Store update)
12. React re-render                     // async render cycle)
```

### Key Components

| Component | File | Purpose |
|-----------|------|----------|
| **Agent** | `packages/agent/src/agent.ts` | Emits events via `emit` callback |
| **EventBus** | `packages/comms-bus/src/event_bus.ts` | Pub/sub router, batches events with `queueMicrotask` |
| **AsyncEventQueue** | `packages/harness-daemon/src/harness/harness.ts` | Wraps events in AsyncIterable (redundant) |
| **BridgeGateway** | `packages/harness-daemon/src/harness/bridge_gateway.ts` | Routes commands and streams events to bus |
| **BusClient** | `packages/tui/bridge_client.ts` | TCP client, emits events to TUI |
| **TUI** | `packages/tui/index.tsx` | React UI, handles events and updates Store |

### Event Types

| AgentEvent | BridgeEvent | Purpose |
|------------|--------------|---------|
| `agent_message` | `stream` | LLM response chunks |
| `agent_reasoning` | `stream` (with `is_reasoning: true`) | Model reasoning/thinking content |
| `tool_call` | `progress` | Tool start/complete status |
| `llm_call` | null (filtered) | Internal, not forwarded |
| `artifact_discovered` | `progress` | Explorer artifacts found |
| `permission_request` | `permission_request` | User permission prompts |

## Synchronous vs Asynchronous Handling

### Agent Side (Synchronous)

```typescript
// agent.ts - streamWithResilience
onChunk: (chunk) => {
  if (hasStructuredOutput) return; // Skip raw JSON streaming
  this.emit(createEvent('agent_message', {
    agentType: this.config.type,
    message: chunk,
  }, workItem.workId));
}
```

**`this.emit()` is called SYNCHRONOUSLY** as each LLM chunk arrives.

### EventBus Side (Synchronous + Microtask Batching)

```typescript
// event_bus.ts - publish()
publish(event: AnyEvent): void {
  if (this.shutdownFlag) return;
  
  this.pendingEvents.push(event);
  this.scheduleFlush();  // Schedules flush in microtask
}
```

Events are pushed to `pendingEvents` array synchronously, then flushed via `queueMicrotask()`.

### Harness Side (Async Queue)

```typescript
// harness.ts - event subscription
const unsubscribe = this.eventBus.subscribeRun(runId, (event: AgentEvent): void => {
  const bridgeEvent = translateAgentEvent(event);
  if (bridgeEvent) {
    eventQueue.push(bridgeEvent);  // Synchronous push
  }
});
```

The `AsyncEventQueue` provides an `AsyncIterable<BridgeEvent>` interface:

```typescript
class AsyncEventQueue {
  private queue: BridgeEvent[] = [];
  private resolvers: Array<(value: IteratorResult<BridgeEvent>) => void> = [];
  
  push(event: BridgeEvent): void {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }
  
  async next(): Promise<IteratorResult<BridgeEvent>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}
```

### TUI Side (Async Event Handling)

```typescript
// tui/index.tsx - handleStream
const handleStream = (data?: StreamData) => {
  if (!data?.request_id || data.chunk === undefined) {
    return;
  }
  
  if (currentSnapshot.streamingRequestId !== data.request_id) {
    store.setStreaming(data.request_id, data.chunk);
  } else {
    store.appendStreaming(data.chunk);
  }
  
  store.setState("streaming");
  
  if (data.is_final) {
    const finalText = store.getSnapshot().streamingText;
    store.batch(() => {
      store.addMessage("agent", finalText, undefined, data.request_id);
      store.finalizeStreaming();
      store.clearProgress();
      store.setState("idle");
    });
  }
};
```

Events are handled asynchronously via `client.on("event")`, which updates the Store and triggers React re-renders.

## Architectural Issues

### 1. AsyncEventQueue is Redundant

**Problem:** AsyncEventQueue exists solely to provide `AsyncIterable<BridgeEvent>` interface. EventBus already has subscription mechanisms and could provide async iteration directly.

**Why it exists:** Historical technical debt. EventBus was designed as pure pub/sub without async iteration support when AsyncEventQueue was added.

**Impact:** Adds an unnecessary hop between EventBus and BridgeGateway.

### 2. BridgeGateway Adds Indirection Without Value

**Problem:** BridgeGateway sits between EventBus and BusClient, translating commands but providing no real isolation or abstraction benefit.

**Why it exists:** Incremental feature addition pattern. As commands were added, a "gateway" felt natural.

**Impact:** Extra layer of indirection. Commands could be routed directly by BusServer.

### 3. Event Translation is Unnecessary

**Problem:** Agent emits `AgentEvent`, which is translated to `BridgeEvent` via `event_translator.ts`. This adds:
- Translation code maintenance
- Type conversions (camelCase → snake_case)
- Cognitive overhead

**Why it exists:** Separation of concerns (agent internal vs wire format), but formats are nearly identical.

**Impact:** Added complexity without clear benefit. Could unify formats or have Agent emit BridgeEvent directly.

### 4. Too Many Hops

Current: **10 hops** from `Agent.emit()` to TUI display.

Proposed: **3 hops** - `Agent → EventBus → TUI`.

## Proposed Refactoring

### Phase 1: Remove AsyncEventQueue

Add async iteration support directly to EventBus:

```typescript
// event_bus.ts
export class EventBus implements EventBusProtocol {
  private runIterators = new Map<string, AsyncIterator<AnyEvent>>();
  
  /**
   * Subscribe to events for a specific run as AsyncIterable.
   * Eliminates need for AsyncEventQueue wrapper.
   */
  subscribeRunAsIterable(runId: string): AsyncIterable<AnyEvent> {
    const queue: AnyEvent[] = [];
    const resolvers: Array<(value: IteratorResult<AnyEvent>) => void> = [];
    
    const handler = (event: AnyEvent) => {
      if (resolvers.length > 0) {
        const resolve = resolvers.shift()!;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };
    
    const unsubscribe = this.subscribeRun(runId, handler);
    
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            return new Promise<IteratorResult<AnyEvent>>((resolve) => {
              resolvers.push(resolve);
            });
          },
          return: async () => {
            unsubscribe();
            resolvers.forEach(r => r({ value: undefined as any, done: true }));
            return { value: undefined as any, done: true };
          },
        };
      },
    };
  }
}
```

Update harness to use `subscribeRunAsIterable`:

```typescript
// harness.ts
const eventStream = this.eventBus.subscribeRunAsIterable(runId);

for await (const event of eventStream) {
  const bridgeEvent = translateAgentEvent(event);
  if (bridgeEvent) {
    eventQueue.push(bridgeEvent);  // Now just a direct push to BusServer
  }
}
```

### Phase 2: Simplify BridgeGateway

Move command routing into BusServer:

```typescript
// comms-bus - extend BusServer to handle commands
export class BusServer {
  private commandHandlers = new Map<string, CommandHandler>();
  
  registerCommand(type: string, handler: CommandHandler): void {
    this.commandHandlers.set(type, handler);
  }
  
  async handleCommand(command: BridgeCommand): Promise<BridgeEvent | null> {
    const handler = this.commandHandlers.get(command.type);
    if (handler) {
      return await handler(command);
    }
    return null;
  }
}
```

### Phase 3: Unify Event Formats

Option 1: Agent emits BridgeEvent directly
- Remove `event_translator.ts`
- Agent uses BridgeEvent format
- Simpler, but couples Agent to transport format

Option 2: Keep translation inline
- Move translation into Agent `emit` wrapper
- Remove separate translation layer
- Keeps Agent format pure

### Phase 4: Direct TUI Subscription

TUI could subscribe directly to EventBus via TCP (already done, just remove intermediate layers):

```typescript
// Simplified flow
Agent.emit() → EventBus → BusClient.publish() → TCP → TUI
```

## Refactored Architecture (3 hops)

```
1. Agent.emit(event)           // agent.ts
   ↓ (sync callback)
2. EventBus.publish(event)      // event_bus.ts
   ↓ (sync + microtask)
3. BusClient.publish()         // bridge_client.ts (TCP)
   ↓ (async - network)
4. TUI handleStream()         // tui/index.tsx
   ↓ (async render)
```

**Reduction:** 10 hops → 4 hops (or 3 if TUI subscribes directly to EventBus wire format)

## Summary Table

| Aspect | Current | Proposed | Improvement |
|---------|----------|-----------|-------------|
| **Total hops** | 10 | 3-4 | 60-70% reduction |
| **AsyncEventQueue** | Required | Removed | Eliminates indirection |
| **BridgeGateway** | Required | Simplified/Moved | Better separation |
| **Event formats** | AgentEvent + BridgeEvent | Unified (or inline translation) | Less maintenance |
| **Code complexity** | High | Low | ~500 LOC reduction |
| **Debugging** | Difficult (multiple layers) | Simple (clear flow) | Faster diagnosis |

## Next Steps

1. Add `subscribeRunAsIterable()` to EventBus
2. Remove `AsyncEventQueue` from harness
3. Simplify BridgeGateway or move command routing
4. Unify event formats
5. Update TUI to handle simplified event flow
6. Add tests for new async iteration
7. Remove deprecated code

## References

- `packages/agent/src/agent.ts` - Agent emit callback
- `packages/comms-bus/src/event_bus.ts` - EventBus pub/sub
- `packages/harness-daemon/src/harness/harness.ts` - AsyncEventQueue (to remove)
- `packages/harness-daemon/src/harness/bridge_gateway.ts` - BridgeGateway (to simplify)
- `packages/tui/bridge_client.ts` - BusClient TCP client
- `packages/tui/index.tsx` - TUI event handling
