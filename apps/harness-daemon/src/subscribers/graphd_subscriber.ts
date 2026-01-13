/**
 * GraphDSubscriber - Subscribes to EventBus and persists events to GraphD.
 *
 * This enables real-time event persistence for the dashboard and analytics.
 *
 * CRITICAL: The dashboard expects events in `sessions.metadata_json.agent_events[]`
 * NOT in the separate `session_events` table. This subscriber appends events to
 * the session metadata so the dashboard mapper can parse them.
 */

import type { EventBusProtocol } from 'comms-bus';
import type { AgentEvent } from 'agent-core';
import type { GraphDManager } from 'graphd';

/**
 * Configuration for GraphDSubscriber.
 */
export interface GraphDSubscriberConfig {
  /** Session key for this subscriber */
  sessionKey: string;
  /** Request ID for correlating events */
  requestId?: string;
  /** Event types to persist (default: all) */
  eventTypes?: string[];
  /** Whether to batch events or persist immediately (default: false = immediate) */
  batchMode?: boolean;
  /** Batch size before flushing (only if batchMode is true) */
  batchSize?: number;
}

/**
 * GraphDSubscriber - Persists events to GraphD in real-time.
 */
export class GraphDSubscriber {
  private graphd: GraphDManager;
  private config: Required<GraphDSubscriberConfig>;
  private unsubscribe: (() => void) | null = null;
  private eventBatch: AgentEvent<unknown>[] = [];
  private pendingEvents: AgentEvent<unknown>[] = [];
  private flushScheduled = false;
  private eventCount = 0;
  private closed = false;

  constructor(
    eventBus: EventBusProtocol,
    graphd: GraphDManager,
    config: GraphDSubscriberConfig
  ) {
    this.graphd = graphd;
    this.config = {
      sessionKey: config.sessionKey,
      requestId: config.requestId ?? '',
      eventTypes: config.eventTypes ?? [],
      batchMode: config.batchMode ?? true,
      batchSize: config.batchSize ?? 50,
    };

    this.unsubscribe = eventBus.subscribeAll((event) => this.enqueueEvent(event));
  }

  /**
   * Update the request ID for new requests.
   */
  setRequestId(requestId: string): void {
    this.config.requestId = requestId;
  }

  /**
   * Handle an event from the EventBus.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private enqueueEvent(event: AgentEvent<any>): void {
    if (this.closed) return;
    if (this.config.eventTypes.length > 0 && !this.config.eventTypes.includes(event.type)) {
      return;
    }

    this.eventCount++;
    this.pendingEvents.push(event);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushPending());
    }
  }

  private flushPending(force = false): void {
    if (this.closed && !force) {
      this.pendingEvents = [];
      this.flushScheduled = false;
      return;
    }

    const batch = this.pendingEvents;
    this.pendingEvents = [];
    this.flushScheduled = false;

    if (this.config.batchMode) {
      for (const event of batch) {
        this.eventBatch.push(event);
        if (this.eventBatch.length >= this.config.batchSize) {
          this.flushBatch();
        }
      }
      if (force && this.eventBatch.length > 0) {
        this.flushBatch();
      }
    } else {
      for (const event of batch) {
        this.persistEvent(event);
      }
    }

    if (this.pendingEvents.length > 0 && !this.flushScheduled && !this.closed) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushPending());
    }
  }

  /**
   * Persist a single event to GraphD.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private persistEvent(event: AgentEvent<any>): void {
    try {
      const formattedEvent = this.formatEventForDashboard(event);

      const result = this.graphd.sessionUpdateMetadata(this.config.sessionKey, {
        agent_events: [formattedEvent],
      });
      if ((result as { success?: boolean; error?: string }).success === false) {
        console.error(`[GraphDSubscriber] Failed to persist event: ${String((result as { error?: string }).error ?? 'unknown_error')}`);
      } else {
        // Checkpoint to make writes visible to dashboard
        this.graphd.checkpoint();
      }
    } catch (error) {
      console.error(`[GraphDSubscriber] Failed to persist event: ${error}`);
    }
  }

  /**
   * Format an AgentEvent for dashboard consumption.
   * Converts camelCase keys to snake_case and ensures proper timestamp format.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatEventForDashboard(event: AgentEvent<any>): Record<string, unknown> {
    const timestamp = event.timestamp > 1e12
      ? Math.floor(event.timestamp / 1000)
      : event.timestamp;

    const formattedData = this.camelToSnake(event.data ?? {});

    return {
      type: event.type,
      timestamp,
      work_item_id: event.workItemId ?? null,
      request_id: event.requestId || this.config.requestId || undefined,
      run_id: event.runId ?? undefined,
      data: formattedData,
    };
  }

  /**
   * Convert object keys from camelCase to snake_case recursively.
   */
  private camelToSnake(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[snakeKey] = this.camelToSnake(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[snakeKey] = value.map((item) =>
          item && typeof item === 'object' ? this.camelToSnake(item as Record<string, unknown>) : item
        );
      } else {
        result[snakeKey] = value;
      }
    }
    return result;
  }

  /**
   * Flush the event batch to GraphD.
   */
  private flushBatch(): void {
    if (this.eventBatch.length === 0) return;

    try {
      const formattedEvents = this.eventBatch.map((event) =>
        this.formatEventForDashboard(event)
      );

      const result = this.graphd.sessionUpdateMetadata(this.config.sessionKey, {
        agent_events: formattedEvents,
      });
      if ((result as { success?: boolean; error?: string }).success === false) {
        console.error(`[GraphDSubscriber] Failed to flush batch: ${String((result as { error?: string }).error ?? 'unknown_error')}`);
      } else {
        // Checkpoint to make writes visible to dashboard
        this.graphd.checkpoint();
      }

      this.eventBatch = [];
    } catch (error) {
      console.error(`[GraphDSubscriber] Failed to flush batch: ${error}`);
    }
  }

  /**
   * Get the count of events processed.
   */
  getEventCount(): number {
    return this.eventCount;
  }

  /**
   * Flush any remaining events and close the subscriber.
   */
  close(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.closed = true;
    this.flushPending(true);
  }
}

/**
 * Create a GraphDSubscriber for a session.
 */
export function createGraphDSubscriber(
  eventBus: EventBusProtocol,
  graphd: GraphDManager,
  sessionKey: string,
  requestId?: string
): GraphDSubscriber {
  return new GraphDSubscriber(eventBus, graphd, {
    sessionKey,
    requestId,
  });
}
