/**
 * EventBus - Central pub/sub event router for the agent system.
 *
 * Implements the EventBusProtocol from typescript_refactor2.md.
 * All components emit events through the bus, and multiple subscribers
 * (TUI, logger, dashboard, tests) can consume them independently.
 */

import { EventEmitter } from 'events';
import type { WizardEvent, WizardEventType } from '../types/events.js';

// Use a more permissive type for events with any data shape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWizardEvent = WizardEvent<any>;

/**
 * EventBus protocol interface.
 * Components depend on this interface, not the concrete implementation.
 */
export interface EventBusProtocol {
  /**
   * Publish an event to all subscribers.
   */
  publish(event: AnyWizardEvent): void;

  /**
   * Subscribe to events of a specific type.
   * Returns an unsubscribe function.
   */
  subscribe(
    type: WizardEventType,
    handler: (event: AnyWizardEvent) => void
  ): () => void;

  /**
   * Subscribe to all events regardless of type.
   * Returns an unsubscribe function.
   */
  subscribeAll(handler: (event: AnyWizardEvent) => void): () => void;

  /**
   * Shutdown the event bus. Emits a shutdown event and stops accepting new events.
   */
  shutdown(): void;

  /**
   * Check if the event bus has been shut down.
   */
  isShutdown(): boolean;
}

/**
 * Filter predicate for event subscriptions.
 */
export type EventFilter = (event: WizardEvent) => boolean;

/**
 * EventBus implementation using Node's EventEmitter.
 */
export class EventBus implements EventBusProtocol {
  private emitter = new EventEmitter();
  private shutdownFlag = false;
  private readonly ALL_EVENTS = '__all__';

  constructor() {
    // Increase max listeners to accommodate multiple subscribers
    this.emitter.setMaxListeners(50);
  }

  publish(event: AnyWizardEvent): void {
    if (this.shutdownFlag) return;

    // Emit to type-specific subscribers
    this.emitter.emit(event.type, event);

    // Emit to catch-all subscribers
    this.emitter.emit(this.ALL_EVENTS, event);
  }

  subscribe(
    type: WizardEventType,
    handler: (event: AnyWizardEvent) => void
  ): () => void {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }

  subscribeAll(handler: (event: AnyWizardEvent) => void): () => void {
    this.emitter.on(this.ALL_EVENTS, handler);
    return () => this.emitter.off(this.ALL_EVENTS, handler);
  }

  shutdown(): void {
    if (this.shutdownFlag) return;
    this.shutdownFlag = true;

    // Emit shutdown event before stopping
    const shutdownEvent: AnyWizardEvent = {
      type: 'goal_aborted',
      timestamp: Date.now() / 1000,
      data: {
        goal: '',
        reason: 'shutdown',
        stepsCompleted: 0,
      },
    };
    this.emitter.emit(this.ALL_EVENTS, shutdownEvent);
    this.emitter.removeAllListeners();
  }

  isShutdown(): boolean {
    return this.shutdownFlag;
  }
}

/**
 * Create an async iterator that yields events for a specific request.
 * Filters events by requestId in the event data.
 */
export function createRequestEventStream(
  bus: EventBusProtocol,
  requestId: string
): AsyncIterableIterator<AnyWizardEvent> {
  const queue: AnyWizardEvent[] = [];
  const waiters: Array<(result: IteratorResult<AnyWizardEvent>) => void> = [];
  let done = false;

  const unsubscribe = bus.subscribeAll((event) => {
    // Filter by requestId if present in event data
    const eventRequestId = (event.data as Record<string, unknown>)?.requestId;
    if (eventRequestId && eventRequestId !== requestId) {
      return;
    }

    if (waiters.length > 0) {
      const resolve = waiters.shift()!;
      resolve({ value: event, done: false });
    } else {
      queue.push(event);
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return this;
    },

    async next(): Promise<IteratorResult<AnyWizardEvent>> {
      if (queue.length > 0) {
        return { value: queue.shift()!, done: false };
      }

      if (done) {
        return { value: undefined as unknown as AnyWizardEvent, done: true };
      }

      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },

    async return(): Promise<IteratorResult<AnyWizardEvent>> {
      done = true;
      unsubscribe();
      // Resolve any pending waiters
      for (const resolve of waiters) {
        resolve({ value: undefined as unknown as AnyWizardEvent, done: true });
      }
      waiters.length = 0;
      return { value: undefined as unknown as AnyWizardEvent, done: true };
    },
  };
}

/**
 * Marks the end of a request's event stream.
 */
export function completeRequestStream(
  iterator: AsyncIterableIterator<AnyWizardEvent>
): void {
  if ('return' in iterator && typeof iterator.return === 'function') {
    iterator.return();
  }
}
