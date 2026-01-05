/**
 * LogSubscriber - Subscribes to EventBus and logs events.
 *
 * This decouples logging from components - they just emit events,
 * and this subscriber handles the logging concerns using the shared logger.
 */

import path from 'path';
import type { EventBusProtocol } from './event_bus.js';
import type { WizardEvent } from '../types/events.js';
import { createLogger, type Logger, type LogLevel } from '../shared/logger.js';

export interface LogSubscriberConfig {
  logPath: string;
  eventTypes?: string[];
  format?: 'pretty' | 'json';
}

export class LogSubscriber {
  private logger: Logger;
  private unsubscribe: (() => void) | null = null;
  private eventTypes: string[];

  constructor(eventBus: EventBusProtocol, config: LogSubscriberConfig) {
    this.eventTypes = config.eventTypes ?? [];
    this.logger = createLogger({
      backend: 'file',
      format: config.format ?? 'pretty',
      path: config.logPath,
    });

    this.unsubscribe = eventBus.subscribeAll((event) => this.handleEvent(event));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleEvent(event: WizardEvent<any>): void {
    if (this.eventTypes.length > 0 && !this.eventTypes.includes(event.type)) {
      return;
    }

    const level = this.inferLevel(event.type);
    const message = `[${event.type}]${event.stepNum !== undefined ? ` step=${event.stepNum}` : ''}`;

    this.logger[level](message, event.data ?? {});
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
