/**
 * Commands - Side Effect Descriptions
 *
 * Commands describe IO operations without executing them.
 * The executor is responsible for running commands.
 */

// ============================================
// COMMAND UNION
// ============================================

/**
 * A command describing a side effect to execute.
 */
export type Command =
  | LogCommand
  | NotifyCommand
  | PersistCommand
  | TelemetryCommand;

// ============================================
// COMMAND DEFINITIONS
// ============================================

/**
 * Log a message.
 */
export interface LogCommand {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Send a notification.
 */
export interface NotifyCommand {
  type: 'notify';
  channel: 'user' | 'ops' | 'webhook';
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'high';
}

/**
 * Persist data to storage.
 */
export interface PersistCommand {
  type: 'persist';
  target: 'audit_log' | 'decision_log' | 'work_log';
  data: Record<string, unknown>;
}

/**
 * Emit telemetry.
 */
export interface TelemetryCommand {
  type: 'telemetry';
  event: string;
  metrics: Record<string, number>;
  dimensions: Record<string, string>;
}

// ============================================
// COMMAND FACTORIES
// ============================================

/**
 * Create a log command.
 */
export function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
): LogCommand {
  return { type: 'log', level, message, data };
}

/**
 * Create a notify command.
 */
export function notify(
  channel: 'user' | 'ops' | 'webhook',
  title: string,
  body: string,
  priority: 'low' | 'normal' | 'high' = 'normal'
): NotifyCommand {
  return { type: 'notify', channel, title, body, priority };
}

/**
 * Create a persist command.
 */
export function persist(
  target: 'audit_log' | 'decision_log' | 'work_log',
  data: Record<string, unknown>
): PersistCommand {
  return { type: 'persist', target, data };
}

/**
 * Create a telemetry command.
 */
export function telemetry(
  event: string,
  metrics: Record<string, number>,
  dimensions: Record<string, string>
): TelemetryCommand {
  return { type: 'telemetry', event, metrics, dimensions };
}
