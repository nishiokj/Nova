/**
 * EventBus - Central pub/sub event router.
 *
 * Supports:
 * - Per-run subscriptions via subscribeRun(runId, handler)
 * - Microtask-queued async fan-out
 * - requestId tagging
 */

import { EventEmitter } from 'events';
import type { AgentEvent, AgentEventType } from 'types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = AgentEvent<any>;

/**
 * EventBus protocol interface.
 */
export interface EventBusProtocol {
  publish(event: AnyEvent): void;
  subscribe(type: AgentEventType, handler: (event: AnyEvent) => void): () => void;
  subscribeAll(handler: (event: AnyEvent) => void): () => void;
  /** Subscribe to events for a specific run */
  subscribeRun(runId: string, handler: (event: AnyEvent) => void): () => void;
  /** Subscribe to all events globally */
  subscribeGlobal(handler: (event: AnyEvent) => void): () => void;
  shutdown(): void;
  isShutdown(): boolean;
}

/**
 * EventBus implementation.
 */
export class EventBus implements EventBusProtocol {
  private emitter = new EventEmitter();
  private runHandlers = new Map<string, Set<(event: AnyEvent) => void>>();
  private globalHandlers = new Set<(event: AnyEvent) => void>();
  private shutdownFlag = false;
  private readonly ALL_EVENTS = '__all__';

  private pendingEvents: Array<AnyEvent> = [];
  private flushScheduled = false;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(event: AnyEvent): void {
    if (this.shutdownFlag) return;

    this.pendingEvents.push(event);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    if (this.shutdownFlag) {
      this.pendingEvents = [];
      this.flushScheduled = false;
      return;
    }

    const batch = this.pendingEvents;
    this.pendingEvents = [];
    this.flushScheduled = false;

    for (const event of batch) {
      this.dispatchEvent(event);
    }

    if (this.pendingEvents.length > 0 && !this.flushScheduled) {
      this.scheduleFlush();
    }
  }

  private dispatchEvent(event: AnyEvent): void {
    // Snapshot handlers at dispatch time so subscription changes affect the next event,
    // and we avoid allocating arrays at publish-time.
    const runId = (event as any).runId ?? event.requestId;
    const runHandlers = runId ? this.runHandlers.get(runId) : undefined;

    try {
      this.emitter.emit(event.type, event);
      this.emitter.emit(this.ALL_EVENTS, event);
    } catch (err) {
      console.error('[EventBus] Handler error:', err);
    }

    if (runHandlers && runHandlers.size) {
      for (const handler of runHandlers) {
        try {
          handler(event);
        } catch (err) {
          console.error('[EventBus] Handler error:', err);
        }
      }
    }

    if (this.globalHandlers.size) {
      for (const handler of this.globalHandlers) {
        try {
          handler(event);
        } catch (err) {
          console.error('[EventBus] Handler error:', err);
        }
      }
    }
  }

  subscribe(type: AgentEventType, handler: (event: AnyEvent) => void): () => void {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }

  subscribeAll(handler: (event: AnyEvent) => void): () => void {
    this.emitter.on(this.ALL_EVENTS, handler);
    return () => this.emitter.off(this.ALL_EVENTS, handler);
  }

  subscribeRun(runId: string, handler: (event: AnyEvent) => void): () => void {
    if (!this.runHandlers.has(runId)) {
      this.runHandlers.set(runId, new Set());
    }
    this.runHandlers.get(runId)!.add(handler);
    return () => {
      this.runHandlers.get(runId)?.delete(handler);
      if (this.runHandlers.get(runId)?.size === 0) {
        this.runHandlers.delete(runId);
      }
    };
  }

  subscribeGlobal(handler: (event: AnyEvent) => void): () => void {
    this.globalHandlers.add(handler);
    return () => this.globalHandlers.delete(handler);
  }

  shutdown(): void {
    if (this.shutdownFlag) return;
    this.shutdownFlag = true;
    this.pendingEvents = [];
    this.flushScheduled = false;
    this.emitter.removeAllListeners();
    this.runHandlers.clear();
    this.globalHandlers.clear();
  }

  isShutdown(): boolean {
    return this.shutdownFlag;
  }
}

/**
 * Create an EventEmitCallback that tags events and publishes to EventBus.
 */
export function createEventEmitCallback(
  eventBus: EventBusProtocol,
  requestId: string,
  runId?: string
): (event: AnyEvent) => void {
  return (event: AnyEvent) => {
    const taggedEvent = {
      ...event,
      requestId,
      runId: runId ?? requestId,
      timestamp: event.timestamp ?? Date.now() / 1000,
    };
    eventBus.publish(taggedEvent);
  };
}
