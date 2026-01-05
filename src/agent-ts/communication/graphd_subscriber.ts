/**
 * GraphDSubscriber - Subscribes to EventBus and persists events to GraphD.
 *
 * This enables real-time event persistence for the dashboard and analytics.
 *
 * CRITICAL: The dashboard expects events in `sessions.metadata_json.wizard_events[]`
 * NOT in the separate `session_events` table. This subscriber appends events to
 * the session metadata so the dashboard mapper can parse them.
 */

import type { EventBusProtocol } from './event_bus.js';
import type { WizardEvent } from '../types/events.js';
import type { GraphDManager } from '../graphd/index.js';

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
  private eventBatch: WizardEvent<unknown>[] = [];
  private eventCount = 0;

  constructor(
    eventBus: EventBusProtocol,
    graphd: GraphDManager,
    config: GraphDSubscriberConfig
  ) {
    this.graphd = graphd;
    this.config = {
      sessionKey: config.sessionKey,
      requestId: config.requestId ?? '',
      eventTypes: config.eventTypes ?? [], // empty = all
      batchMode: config.batchMode ?? false,
      batchSize: config.batchSize ?? 50,
    };

    // Subscribe to all events
    this.unsubscribe = eventBus.subscribeAll((event) => this.handleEvent(event));
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
  private handleEvent(event: WizardEvent<any>): void {
    // Filter by event type if configured
    if (this.config.eventTypes.length > 0 && !this.config.eventTypes.includes(event.type)) {
      return;
    }

    this.eventCount++;

    if (this.config.batchMode) {
      this.eventBatch.push(event);
      if (this.eventBatch.length >= this.config.batchSize) {
        this.flushBatch();
      }
    } else {
      this.persistEvent(event);
    }
  }

  /**
   * Persist a single event to GraphD.
   *
   * CRITICAL: Dashboard expects events in `sessions.metadata_json.wizard_events[]`
   * The mapper parses this array to build AgentRequest objects.
   *
   * Event format expected by dashboard (snake_case):
   * {
   *   type: 'goal_started' | 'step_started' | 'tool_call' | 'llm_call' | etc.,
   *   timestamp: number (unix seconds),
   *   step_num?: number,
   *   data: { ... event-specific fields in snake_case ... }
   * }
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private persistEvent(event: WizardEvent<any>): void {
    try {
      // Format event for dashboard consumption (snake_case keys)
      const formattedEvent = this.formatEventForDashboard(event);

      // Append to wizard_events array in session metadata
      // GraphDManager.updateSessionMetadata with merge=true appends to arrays
      this.graphd.sessionUpdateMetadata(this.config.sessionKey, {
        wizard_events: [formattedEvent],
      });
    } catch (error) {
      // Swallow errors to not disrupt the system
      console.error(`[GraphDSubscriber] Failed to persist event: ${error}`);
    }
  }

  /**
   * Format a WizardEvent for dashboard consumption.
   * Converts camelCase keys to snake_case and ensures proper timestamp format.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatEventForDashboard(event: WizardEvent<any>): Record<string, unknown> {
    // Timestamp is already unix seconds from createEvent()
    // Just ensure it's in seconds, not milliseconds
    const timestamp = event.timestamp > 1e12
      ? Math.floor(event.timestamp / 1000)
      : event.timestamp;

    // Convert event data keys from camelCase to snake_case
    const formattedData = this.camelToSnake(event.data ?? {});

    return {
      type: event.type,
      timestamp,
      step_num: event.stepNum,
      request_id: this.config.requestId || undefined,
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
      // Format all events for dashboard consumption
      const formattedEvents = this.eventBatch.map((event) =>
        this.formatEventForDashboard(event)
      );

      // Append all events to wizard_events array in session metadata
      this.graphd.sessionUpdateMetadata(this.config.sessionKey, {
        wizard_events: formattedEvents,
      });

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
    // Flush any remaining batched events
    if (this.config.batchMode && this.eventBatch.length > 0) {
      this.flushBatch();
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
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
