/**
 * LogSubscriber - Subscribes to EventBus and logs events.
 *
 * This decouples logging from components - they just emit events,
 * and this subscriber handles the logging concerns using the shared logger.
 */

import path from 'path';
import type { EventBusProtocol } from 'comms-bus';
import type { AgentEvent } from 'agent-core';
import { createLogger, type Logger, type LogLevel } from 'agent-core/shared';

export interface LogSubscriberConfig {
  logPath: string;
  eventTypes?: string[];
  format?: 'pretty' | 'json';
}

export class LogSubscriber {
  private logger: Logger;
  private unsubscribe: (() => void) | null = null;
  private eventTypes: string[];
  private pendingEvents: Array<AgentEvent<unknown>> = [];
  private flushScheduled = false;
  private closed = false;

  constructor(eventBus: EventBusProtocol, config: LogSubscriberConfig) {
    this.eventTypes = config.eventTypes ?? [];
    this.logger = createLogger({
      backend: 'file',
      format: config.format ?? 'pretty',
      path: config.logPath,
    });

    this.unsubscribe = eventBus.subscribeAll((event) => this.enqueueEvent(event));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private enqueueEvent(event: AgentEvent<any>): void {
    if (this.closed) return;
    if (this.eventTypes.length > 0 && !this.eventTypes.includes(event.type)) {
      return;
    }

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

    for (const event of batch) {
      this.logEvent(event);
    }

    if (this.pendingEvents.length > 0 && !this.flushScheduled && !this.closed) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushPending());
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private logEvent(event: AgentEvent<any>): void {
    const level = this.inferLevel(event.type);
    const suffix = event.workItemId ? ` workItem=${event.workItemId}` : '';
    const message = `[${event.type}]${suffix}`;

    this.logger[level](message, { requestId: event.requestId, ...(event.data ?? {}) });
  }

  private inferLevel(eventType: string): LogLevel {
    if (eventType.includes('error') || eventType.includes('failed')) {
      return 'error';
    }
    if (eventType.includes('warning') || eventType.includes('issue')) {
      return 'warn';
    }
    if (eventType.includes('started') || eventType.includes('completed')) {
      return 'info';
    }
    return 'debug';
  }

  close(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.closed = true;
    this.flushPending(true);
    this.logger.close();
  }
}

export function createLogSubscriber(
  eventBus: EventBusProtocol,
  logDir: string,
  filename = 'agent_events.log'
): LogSubscriber {
  return new LogSubscriber(eventBus, {
    logPath: path.join(logDir, filename),
  });
}
