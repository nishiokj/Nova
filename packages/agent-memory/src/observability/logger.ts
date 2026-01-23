/**
 * Structured Logger
 *
 * A lightweight structured logger with JSON output support.
 */

import type { Logger, LogLevel, LogEntry } from './types.js'
import { LOG_LEVEL_PRIORITY } from './types.js'
import type { AgentMemoryError } from '../errors/types.js'
import { isAgentMemoryError } from '../errors/types.js'

// Re-export for convenience
export { LOG_LEVEL_PRIORITY }

// ============ Logger Configuration ============

/**
 * Logger configuration.
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  level: LogLevel
  /** Logger name/category */
  name: string
  /** Output format */
  format: 'json' | 'pretty'
  /** Include timestamp */
  timestamp: boolean
  /** Base context added to all logs */
  context?: Record<string, unknown>
  /** Custom output function */
  output?: (entry: LogEntry) => void
}

/**
 * Default logger configuration.
 */
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  level: 'info',
  name: 'agent-memory',
  format: 'json',
  timestamp: true,
}

// ============ Logger Implementation ============

/**
 * Structured logger implementation.
 */
export class StructuredLogger implements Logger {
  private readonly config: LoggerConfig
  private readonly baseContext: Record<string, unknown>
  private spanId?: string
  private traceId?: string

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_LOGGER_CONFIG, ...config }
    this.baseContext = config.context ?? {}
  }

  /**
   * Set trace context for correlation.
   */
  setTraceContext(traceId: string, spanId: string): void {
    this.traceId = traceId
    this.spanId = spanId
  }

  /**
   * Clear trace context.
   */
  clearTraceContext(): void {
    this.traceId = undefined
    this.spanId = undefined
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, undefined, context)
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, undefined, context)
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, undefined, context)
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log('error', message, error, context)
  }

  fatal(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log('fatal', message, error, context)
  }

  /**
   * Create a child logger with additional context.
   */
  child(context: Record<string, unknown>): Logger {
    const childLogger = new StructuredLogger({
      ...this.config,
      context: { ...this.baseContext, ...context },
    })
    if (this.traceId && this.spanId) {
      childLogger.setTraceContext(this.traceId, this.spanId)
    }
    return childLogger
  }

  private log(
    level: LogLevel,
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    // Check if we should log at this level
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.level]) {
      return
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      logger: this.config.name,
      context: { ...this.baseContext, ...context },
      spanId: this.spanId,
      traceId: this.traceId,
    }

    if (error) {
      entry.error = this.serializeError(error)
    }

    if (this.config.output) {
      this.config.output(entry)
    } else {
      this.output(entry)
    }
  }

  private serializeError(error: Error): LogEntry['error'] {
    const serialized: LogEntry['error'] = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }

    if (isAgentMemoryError(error)) {
      serialized.code = error.code
    }

    return serialized
  }

  private output(entry: LogEntry): void {
    if (this.config.format === 'json') {
      this.outputJson(entry)
    } else {
      this.outputPretty(entry)
    }
  }

  private outputJson(entry: LogEntry): void {
    const output = JSON.stringify(entry)
    this.write(entry.level, output)
  }

  private outputPretty(entry: LogEntry): void {
    const parts: string[] = []

    // Timestamp
    if (this.config.timestamp) {
      parts.push(`[${entry.timestamp}]`)
    }

    // Level
    parts.push(`[${entry.level.toUpperCase().padEnd(5)}]`)

    // Logger name
    parts.push(`[${entry.logger}]`)

    // Message
    parts.push(entry.message)

    // Context
    if (entry.context && Object.keys(entry.context).length > 0) {
      parts.push(JSON.stringify(entry.context))
    }

    // Error
    if (entry.error) {
      parts.push(`\n  Error: ${entry.error.name}: ${entry.error.message}`)
      if (entry.error.stack) {
        parts.push(`\n${entry.error.stack}`)
      }
    }

    this.write(entry.level, parts.join(' '))
  }

  private write(level: LogLevel, output: string): void {
    switch (level) {
      case 'debug':
        console.debug(output)
        break
      case 'info':
        console.info(output)
        break
      case 'warn':
        console.warn(output)
        break
      case 'error':
      case 'fatal':
        console.error(output)
        break
    }
  }
}

// ============ Factory Functions ============

/**
 * Create a new logger.
 */
export function createLogger(config: Partial<LoggerConfig> = {}): StructuredLogger {
  return new StructuredLogger(config)
}

/**
 * Create a logger from environment variables.
 */
export function createLoggerFromEnv(): StructuredLogger {
  const level = (process.env.LOG_LEVEL ?? 'info') as LogLevel
  const format = (process.env.LOG_FORMAT ?? 'json') as 'json' | 'pretty'
  const name = process.env.LOG_NAME ?? 'agent-memory'

  return createLogger({ level, format, name })
}

/**
 * No-op logger that discards all output.
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
}

/**
 * Default logger instance.
 */
export const defaultLogger = createLogger()

// ============ Log Helpers ============

/**
 * Log timing for an operation.
 */
export function logTiming<T>(
  logger: Logger,
  operation: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const start = performance.now()
  const result = fn()

  if (result instanceof Promise) {
    return result.then(
      (value) => {
        const duration = performance.now() - start
        logger.debug(`${operation} completed`, { durationMs: duration })
        return value
      },
      (error) => {
        const duration = performance.now() - start
        logger.error(`${operation} failed`, error as Error, { durationMs: duration })
        throw error
      }
    )
  }

  const duration = performance.now() - start
  logger.debug(`${operation} completed`, { durationMs: duration })
  return Promise.resolve(result)
}

/**
 * Create a scoped logger for a component.
 */
export function scopedLogger(
  logger: Logger,
  component: string,
  context?: Record<string, unknown>
): Logger {
  return logger.child({ component, ...context })
}
