/**
 * Alerting System
 *
 * Alert management and notification hooks.
 */

import type { Alert, AlertHandler, AlertSeverity, Logger } from './types.js'
import { ulid } from 'ulid'

// ============ Alert Manager ============

/**
 * Alert manager configuration.
 */
export interface AlertManagerConfig {
  /** Handlers to send alerts to */
  handlers: AlertHandler[]
  /** Minimum severity to trigger alerts */
  minSeverity: AlertSeverity
  /** Deduplication window in milliseconds */
  dedupeWindowMs: number
  /** Logger for alert events */
  logger?: Logger
}

/**
 * Default alert manager configuration.
 */
export const DEFAULT_ALERT_MANAGER_CONFIG: AlertManagerConfig = {
  handlers: [],
  minSeverity: 'warning',
  dedupeWindowMs: 300000, // 5 minutes
}

/**
 * Severity priority (higher = more severe).
 */
const SEVERITY_PRIORITY: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
}

/**
 * Alert manager for handling and routing alerts.
 */
export class AlertManager {
  private readonly config: AlertManagerConfig
  private readonly activeAlerts: Map<string, Alert> = new Map()
  private readonly recentAlerts: Map<string, number> = new Map()

  constructor(config: Partial<AlertManagerConfig> = {}) {
    this.config = { ...DEFAULT_ALERT_MANAGER_CONFIG, ...config }
  }

  /**
   * Add a handler.
   */
  addHandler(handler: AlertHandler): void {
    this.config.handlers.push(handler)
  }

  /**
   * Send an alert.
   */
  async alert(
    severity: AlertSeverity,
    title: string,
    message: string,
    options: {
      source?: string
      context?: Record<string, unknown>
      dedupeKey?: string
    } = {}
  ): Promise<string | null> {
    // Check minimum severity
    if (SEVERITY_PRIORITY[severity] < SEVERITY_PRIORITY[this.config.minSeverity]) {
      return null
    }

    // Check deduplication
    const dedupeKey = options.dedupeKey ?? `${title}:${options.source ?? 'unknown'}`
    const lastSent = this.recentAlerts.get(dedupeKey)
    if (lastSent && Date.now() - lastSent < this.config.dedupeWindowMs) {
      return null // Skip duplicate
    }

    const alert: Alert = {
      id: ulid(),
      severity,
      title,
      message,
      source: options.source ?? 'agent-memory',
      timestamp: new Date().toISOString(),
      context: options.context,
      resolved: false,
    }

    // Track for deduplication
    this.recentAlerts.set(dedupeKey, Date.now())
    this.activeAlerts.set(alert.id, alert)

    // Clean up old dedupe entries
    this.cleanupDedupeCache()

    // Send to handlers
    await this.dispatch(alert)

    this.config.logger?.warn('Alert sent', {
      alertId: alert.id,
      severity,
      title,
    })

    return alert.id
  }

  /**
   * Resolve an alert.
   */
  async resolve(alertId: string): Promise<void> {
    const alert = this.activeAlerts.get(alertId)
    if (!alert || alert.resolved) return

    alert.resolved = true
    alert.resolvedAt = new Date().toISOString()

    // Notify handlers
    for (const handler of this.config.handlers) {
      try {
        await handler.resolve(alertId)
      } catch (error) {
        this.config.logger?.error('Failed to resolve alert', error as Error, {
          alertId,
          handler: handler.constructor.name,
        })
      }
    }

    this.config.logger?.info('Alert resolved', { alertId })
  }

  /**
   * Get active alerts.
   */
  getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values()).filter(a => !a.resolved)
  }

  /**
   * Get all alerts.
   */
  getAllAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values())
  }

  /**
   * Clear resolved alerts.
   */
  clearResolved(): void {
    for (const [id, alert] of this.activeAlerts) {
      if (alert.resolved) {
        this.activeAlerts.delete(id)
      }
    }
  }

  private async dispatch(alert: Alert): Promise<void> {
    for (const handler of this.config.handlers) {
      try {
        await handler.send(alert)
      } catch (error) {
        this.config.logger?.error('Failed to send alert', error as Error, {
          alertId: alert.id,
          handler: handler.constructor.name,
        })
      }
    }
  }

  private cleanupDedupeCache(): void {
    const cutoff = Date.now() - this.config.dedupeWindowMs * 2
    for (const [key, time] of this.recentAlerts) {
      if (time < cutoff) {
        this.recentAlerts.delete(key)
      }
    }
  }
}

// ============ Built-in Alert Handlers ============

/**
 * Console alert handler for development.
 */
export class ConsoleAlertHandler implements AlertHandler {
  async send(alert: Alert): Promise<void> {
    const prefix = {
      info: '[INFO]',
      warning: '[WARN]',
      critical: '[CRITICAL]',
    }[alert.severity]

    console.log(`${prefix} Alert: ${alert.title}`)
    console.log(`  Message: ${alert.message}`)
    console.log(`  Source: ${alert.source}`)
    console.log(`  Time: ${alert.timestamp}`)
    if (alert.context) {
      console.log(`  Context: ${JSON.stringify(alert.context)}`)
    }
  }

  async resolve(alertId: string): Promise<void> {
    console.log(`[RESOLVED] Alert ${alertId} has been resolved`)
  }
}

/**
 * In-memory alert handler for testing.
 */
export class InMemoryAlertHandler implements AlertHandler {
  readonly alerts: Alert[] = []
  readonly resolved: string[] = []

  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert)
  }

  async resolve(alertId: string): Promise<void> {
    this.resolved.push(alertId)
  }

  clear(): void {
    this.alerts.length = 0
    this.resolved.length = 0
  }
}

/**
 * Webhook alert handler.
 */
export class WebhookAlertHandler implements AlertHandler {
  constructor(
    private readonly webhookUrl: string,
    private readonly options: {
      headers?: Record<string, string>
      timeout?: number
    } = {}
  ) {}

  async send(alert: Alert): Promise<void> {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.options.headers,
      },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(this.options.timeout ?? 5000),
    })

    if (!response.ok) {
      throw new Error(`Webhook request failed: ${response.status}`)
    }
  }

  async resolve(alertId: string): Promise<void> {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.options.headers,
      },
      body: JSON.stringify({
        type: 'resolve',
        alertId,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(this.options.timeout ?? 5000),
    })

    if (!response.ok) {
      throw new Error(`Webhook resolve request failed: ${response.status}`)
    }
  }
}

/**
 * Callback alert handler for custom integrations.
 */
export class CallbackAlertHandler implements AlertHandler {
  constructor(
    private readonly onSend: (alert: Alert) => Promise<void>,
    private readonly onResolve?: (alertId: string) => Promise<void>
  ) {}

  async send(alert: Alert): Promise<void> {
    await this.onSend(alert)
  }

  async resolve(alertId: string): Promise<void> {
    if (this.onResolve) {
      await this.onResolve(alertId)
    }
  }
}

// ============ Factory Functions ============

/**
 * Create a new alert manager.
 */
export function createAlertManager(
  config: Partial<AlertManagerConfig> = {}
): AlertManager {
  return new AlertManager(config)
}

/**
 * Default alert manager instance.
 */
export const defaultAlertManager = createAlertManager()

// ============ Alert Helpers ============

/**
 * Create an alert from an error.
 */
export function alertFromError(
  manager: AlertManager,
  error: Error,
  options: {
    severity?: AlertSeverity
    source?: string
    context?: Record<string, unknown>
  } = {}
): Promise<string | null> {
  return manager.alert(
    options.severity ?? 'warning',
    error.name,
    error.message,
    {
      source: options.source,
      context: {
        ...options.context,
        stack: error.stack,
      },
    }
  )
}

/**
 * Create an alert for a health check failure.
 */
export function alertHealthFailure(
  manager: AlertManager,
  component: string,
  message: string,
  options: {
    severity?: AlertSeverity
    context?: Record<string, unknown>
  } = {}
): Promise<string | null> {
  return manager.alert(
    options.severity ?? 'critical',
    `Health check failed: ${component}`,
    message,
    {
      source: 'health-checker',
      context: options.context,
      dedupeKey: `health:${component}`,
    }
  )
}

/**
 * Create an alert for rate limiting.
 */
export function alertRateLimited(
  manager: AlertManager,
  service: string,
  retryAfter: number
): Promise<string | null> {
  return manager.alert(
    'warning',
    `Rate limited by ${service}`,
    `Requests are being rate limited. Retry after ${retryAfter}ms.`,
    {
      source: 'http-client',
      context: { service, retryAfter },
      dedupeKey: `ratelimit:${service}`,
    }
  )
}
