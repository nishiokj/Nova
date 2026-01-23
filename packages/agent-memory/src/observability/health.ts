/**
 * Health Checks
 *
 * Health check utilities for monitoring system components.
 */

import type {
  HealthChecker,
  HealthCheckResult,
  ComponentHealth,
  HealthStatus,
} from './types.js'

// ============ Health Checker Implementation ============

/**
 * Health checker configuration.
 */
export interface HealthCheckerConfig {
  /** Cache TTL in milliseconds */
  cacheTtlMs: number
  /** Timeout for individual checks in milliseconds */
  checkTimeoutMs: number
  /** Run checks concurrently */
  concurrent: boolean
  /** Application version */
  version?: string
}

/**
 * Default health checker configuration.
 */
export const DEFAULT_HEALTH_CHECKER_CONFIG: HealthCheckerConfig = {
  cacheTtlMs: 30000,
  checkTimeoutMs: 5000,
  concurrent: true,
}

/**
 * Health check function type.
 */
export type HealthCheckFn = () => Promise<ComponentHealth>

/**
 * Health checker implementation.
 */
export class SimpleHealthChecker implements HealthChecker {
  private readonly config: HealthCheckerConfig
  private readonly checks: Map<string, HealthCheckFn> = new Map()
  private cachedResult?: HealthCheckResult
  private cacheTime?: number
  private readonly startTime: number

  constructor(config: Partial<HealthCheckerConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_CHECKER_CONFIG, ...config }
    this.startTime = Date.now()
  }

  /**
   * Register a health check.
   */
  register(name: string, check: HealthCheckFn): void {
    this.checks.set(name, check)
  }

  /**
   * Run all health checks.
   */
  async check(): Promise<HealthCheckResult> {
    // Check cache
    if (this.cachedResult && this.cacheTime) {
      const age = Date.now() - this.cacheTime
      if (age < this.config.cacheTtlMs) {
        return this.cachedResult
      }
    }

    const components: Record<string, ComponentHealth> = {}

    if (this.config.concurrent) {
      // Run checks concurrently
      const entries = Array.from(this.checks.entries())
      const results = await Promise.all(
        entries.map(async ([name, checkFn]) => {
          const result = await this.runCheck(name, checkFn)
          return [name, result] as const
        })
      )
      for (const [name, result] of results) {
        components[name] = result
      }
    } else {
      // Run checks sequentially
      for (const [name, checkFn] of this.checks) {
        components[name] = await this.runCheck(name, checkFn)
      }
    }

    // Determine overall status
    const status = this.determineOverallStatus(components)

    const result: HealthCheckResult = {
      status,
      version: this.config.version,
      uptime: Date.now() - this.startTime,
      timestamp: new Date().toISOString(),
      components,
    }

    // Cache result
    this.cachedResult = result
    this.cacheTime = Date.now()

    return result
  }

  /**
   * Get cached health status.
   */
  getStatus(): HealthCheckResult | undefined {
    return this.cachedResult
  }

  /**
   * Run a single health check with timeout.
   */
  private async runCheck(name: string, checkFn: HealthCheckFn): Promise<ComponentHealth> {
    const start = performance.now()

    try {
      const result = await withTimeout(checkFn(), this.config.checkTimeoutMs)
      return {
        ...result,
        latencyMs: performance.now() - start,
        lastCheck: new Date().toISOString(),
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : String(error),
        latencyMs: performance.now() - start,
        lastCheck: new Date().toISOString(),
      }
    }
  }

  /**
   * Determine overall status from component statuses.
   */
  private determineOverallStatus(
    components: Record<string, ComponentHealth>
  ): HealthStatus {
    const statuses = Object.values(components).map(c => c.status)

    if (statuses.some(s => s === 'unhealthy')) {
      return 'unhealthy'
    }
    if (statuses.some(s => s === 'degraded')) {
      return 'degraded'
    }
    return 'healthy'
  }
}

// ============ Factory Functions ============

/**
 * Create a new health checker.
 */
export function createHealthChecker(
  config: Partial<HealthCheckerConfig> = {}
): SimpleHealthChecker {
  return new SimpleHealthChecker(config)
}

/**
 * Default health checker instance.
 */
export const defaultHealthChecker = createHealthChecker()

// ============ Pre-built Health Checks ============

/**
 * Create a database health check.
 */
export function createDatabaseHealthCheck(
  checkConnection: () => Promise<boolean>
): HealthCheckFn {
  return async (): Promise<ComponentHealth> => {
    const connected = await checkConnection()
    return {
      status: connected ? 'healthy' : 'unhealthy',
      message: connected ? 'Connected' : 'Connection failed',
      lastCheck: new Date().toISOString(),
    }
  }
}

/**
 * Create a memory health check.
 */
export function createMemoryHealthCheck(options: {
  maxHeapMb?: number
  warnThreshold?: number
} = {}): HealthCheckFn {
  const maxHeapMb = options.maxHeapMb ?? 1024
  const warnThreshold = options.warnThreshold ?? 0.8

  return async (): Promise<ComponentHealth> => {
    const used = process.memoryUsage()
    const heapUsedMb = used.heapUsed / 1024 / 1024
    const heapTotalMb = used.heapTotal / 1024 / 1024
    const usageRatio = heapUsedMb / maxHeapMb

    let status: HealthStatus = 'healthy'
    let message = `Heap: ${heapUsedMb.toFixed(1)}MB / ${heapTotalMb.toFixed(1)}MB`

    if (usageRatio > 0.95) {
      status = 'unhealthy'
      message = `High memory usage: ${(usageRatio * 100).toFixed(1)}%`
    } else if (usageRatio > warnThreshold) {
      status = 'degraded'
      message = `Elevated memory usage: ${(usageRatio * 100).toFixed(1)}%`
    }

    return {
      status,
      message,
      details: {
        heapUsedMb,
        heapTotalMb,
        externalMb: used.external / 1024 / 1024,
        rssMb: used.rss / 1024 / 1024,
      },
      lastCheck: new Date().toISOString(),
    }
  }
}

/**
 * Create an event loop lag health check.
 */
export function createEventLoopHealthCheck(options: {
  maxLagMs?: number
  warnLagMs?: number
} = {}): HealthCheckFn {
  const maxLagMs = options.maxLagMs ?? 100
  const warnLagMs = options.warnLagMs ?? 50

  return async (): Promise<ComponentHealth> => {
    const lag = await measureEventLoopLag()

    let status: HealthStatus = 'healthy'
    let message = `Event loop lag: ${lag.toFixed(1)}ms`

    if (lag > maxLagMs) {
      status = 'unhealthy'
      message = `Event loop blocked: ${lag.toFixed(1)}ms`
    } else if (lag > warnLagMs) {
      status = 'degraded'
      message = `Event loop lag elevated: ${lag.toFixed(1)}ms`
    }

    return {
      status,
      message,
      details: { lagMs: lag },
      lastCheck: new Date().toISOString(),
    }
  }
}

/**
 * Create an external service health check.
 */
export function createExternalServiceHealthCheck(
  name: string,
  pingFn: () => Promise<boolean>
): HealthCheckFn {
  return async (): Promise<ComponentHealth> => {
    try {
      const healthy = await pingFn()
      return {
        status: healthy ? 'healthy' : 'unhealthy',
        message: healthy ? `${name} is reachable` : `${name} is unreachable`,
        lastCheck: new Date().toISOString(),
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `${name} check failed: ${error instanceof Error ? error.message : String(error)}`,
        lastCheck: new Date().toISOString(),
      }
    }
  }
}

// ============ Helpers ============

/**
 * Run a function with timeout.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Health check timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

/**
 * Measure event loop lag.
 */
async function measureEventLoopLag(): Promise<number> {
  const start = performance.now()
  await new Promise(resolve => setImmediate(resolve))
  return performance.now() - start
}
