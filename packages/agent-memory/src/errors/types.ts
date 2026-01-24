/**
 * Error Types
 *
 * Unified error taxonomy for the agent-memory system.
 * Provides a consistent error interface across all modules.
 */

import { z } from 'zod'

// ============ Error Codes ============

/**
 * Error categories for classification.
 */
export const ErrorCategory = {
  AUTH: 'auth',
  NETWORK: 'network',
  VALIDATION: 'validation',
  DATABASE: 'database',
  SYNC: 'sync',
  CONNECTOR: 'connector',
  QUEUE: 'queue',
  RESOLUTION: 'resolution',
  INTERNAL: 'internal',
} as const

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory]

/**
 * Standard error codes.
 */
export const ErrorCode = {
  // Auth errors
  AUTH_INVALID: 'AUTH_INVALID',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  AUTH_REFRESH_FAILED: 'AUTH_REFRESH_FAILED',
  AUTH_INSUFFICIENT_SCOPE: 'AUTH_INSUFFICIENT_SCOPE',

  // Network errors
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  NETWORK_CONNECTION: 'NETWORK_CONNECTION',
  NETWORK_DNS: 'NETWORK_DNS',
  NETWORK_TLS: 'NETWORK_TLS',

  // HTTP errors
  HTTP_CLIENT_ERROR: 'HTTP_CLIENT_ERROR',
  HTTP_SERVER_ERROR: 'HTTP_SERVER_ERROR',
  HTTP_RATE_LIMITED: 'HTTP_RATE_LIMITED',
  HTTP_CIRCUIT_OPEN: 'HTTP_CIRCUIT_OPEN',

  // Validation errors
  VALIDATION_SCHEMA: 'VALIDATION_SCHEMA',
  VALIDATION_INPUT: 'VALIDATION_INPUT',
  VALIDATION_OUTPUT: 'VALIDATION_OUTPUT',
  VALIDATION_CONSTRAINT: 'VALIDATION_CONSTRAINT',

  // Database errors
  DATABASE_CONNECTION: 'DATABASE_CONNECTION',
  DATABASE_QUERY: 'DATABASE_QUERY',
  DATABASE_CONSTRAINT: 'DATABASE_CONSTRAINT',
  DATABASE_TRANSACTION: 'DATABASE_TRANSACTION',
  DATABASE_MIGRATION: 'DATABASE_MIGRATION',

  // Sync errors
  SYNC_COLLECT: 'SYNC_COLLECT',
  SYNC_PROCESS: 'SYNC_PROCESS',
  SYNC_CURSOR: 'SYNC_CURSOR',
  SYNC_INTERRUPTED: 'SYNC_INTERRUPTED',

  // Connector errors
  CONNECTOR_NOT_FOUND: 'CONNECTOR_NOT_FOUND',
  CONNECTOR_INIT: 'CONNECTOR_INIT',
  CONNECTOR_API: 'CONNECTOR_API',
  CONNECTOR_WEBHOOK: 'CONNECTOR_WEBHOOK',

  // Queue errors
  QUEUE_FULL: 'QUEUE_FULL',
  QUEUE_TIMEOUT: 'QUEUE_TIMEOUT',
  QUEUE_HANDLER: 'QUEUE_HANDLER',
  QUEUE_DEAD_LETTER: 'QUEUE_DEAD_LETTER',

  // Resolution errors
  RESOLUTION_CONFLICT: 'RESOLUTION_CONFLICT',
  RESOLUTION_CYCLE: 'RESOLUTION_CYCLE',
  RESOLUTION_INVALID: 'RESOLUTION_INVALID',

  // Internal errors
  INTERNAL_UNKNOWN: 'INTERNAL_UNKNOWN',
  INTERNAL_ASSERTION: 'INTERNAL_ASSERTION',
  INTERNAL_NOT_IMPLEMENTED: 'INTERNAL_NOT_IMPLEMENTED',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * Zod schemas for error types.
 */
export const ErrorCategorySchema = z.enum([
  'auth',
  'network',
  'validation',
  'database',
  'sync',
  'connector',
  'queue',
  'resolution',
  'internal',
])

export const ErrorCodeSchema = z.enum([
  'AUTH_INVALID',
  'AUTH_EXPIRED',
  'AUTH_REFRESH_FAILED',
  'AUTH_INSUFFICIENT_SCOPE',
  'NETWORK_TIMEOUT',
  'NETWORK_CONNECTION',
  'NETWORK_DNS',
  'NETWORK_TLS',
  'HTTP_CLIENT_ERROR',
  'HTTP_SERVER_ERROR',
  'HTTP_RATE_LIMITED',
  'HTTP_CIRCUIT_OPEN',
  'VALIDATION_SCHEMA',
  'VALIDATION_INPUT',
  'VALIDATION_OUTPUT',
  'VALIDATION_CONSTRAINT',
  'DATABASE_CONNECTION',
  'DATABASE_QUERY',
  'DATABASE_CONSTRAINT',
  'DATABASE_TRANSACTION',
  'DATABASE_MIGRATION',
  'SYNC_COLLECT',
  'SYNC_PROCESS',
  'SYNC_CURSOR',
  'SYNC_INTERRUPTED',
  'CONNECTOR_NOT_FOUND',
  'CONNECTOR_INIT',
  'CONNECTOR_API',
  'CONNECTOR_WEBHOOK',
  'QUEUE_FULL',
  'QUEUE_TIMEOUT',
  'QUEUE_HANDLER',
  'QUEUE_DEAD_LETTER',
  'RESOLUTION_CONFLICT',
  'RESOLUTION_CYCLE',
  'RESOLUTION_INVALID',
  'INTERNAL_UNKNOWN',
  'INTERNAL_ASSERTION',
  'INTERNAL_NOT_IMPLEMENTED',
])

/**
 * Severity levels for errors.
 */
export type ErrorSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export const ErrorSeveritySchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal'])

// ============ Error Context ============

/**
 * Context attached to errors for debugging.
 */
export interface ErrorContext {
  /** Operation that was being performed */
  operation?: string
  /** Entity type involved */
  entityType?: string
  /** Entity ID involved */
  entityId?: string
  /** Connector type */
  connector?: string
  /** Account ID */
  accountId?: string
  /** Job ID */
  jobId?: string
  /** Request ID for tracing */
  requestId?: string
  /** Additional metadata */
  [key: string]: unknown
}

/**
 * Serialized error for storage/transmission.
 */
export interface SerializedError {
  name: string
  message: string
  code: ErrorCode
  category: ErrorCategory
  severity: ErrorSeverity
  retryable: boolean
  context: ErrorContext
  stack?: string
  cause?: SerializedError
  timestamp: string
}

export const SerializedErrorSchema: z.ZodType<SerializedError> = z.object({
  name: z.string(),
  message: z.string(),
  code: ErrorCodeSchema,
  category: ErrorCategorySchema,
  severity: ErrorSeveritySchema,
  retryable: z.boolean(),
  context: z.record(z.unknown()),
  stack: z.string().optional(),
  cause: z.lazy(() => SerializedErrorSchema).optional(),
  timestamp: z.string().datetime(),
})

// ============ Base Error Class ============

/**
 * Base class for all agent-memory errors.
 * Provides consistent error structure across the system.
 */
export class AgentMemoryError extends Error {
  readonly code: ErrorCode
  readonly category: ErrorCategory
  readonly severity: ErrorSeverity
  readonly retryable: boolean
  readonly context: ErrorContext
  readonly timestamp: Date

  constructor(
    message: string,
    code: ErrorCode,
    options: {
      category?: ErrorCategory
      severity?: ErrorSeverity
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'AgentMemoryError'
    this.code = code
    this.category = options.category ?? inferCategory(code)
    this.severity = options.severity ?? 'error'
    this.retryable = options.retryable ?? false
    this.context = options.context ?? {}
    this.timestamp = new Date()
  }

  /**
   * Add context to the error.
   */
  withContext(context: ErrorContext): this {
    Object.assign(this.context, context)
    return this
  }

  /**
   * Serialize the error for storage/transmission.
   */
  toJSON(): SerializedError {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      retryable: this.retryable,
      context: this.context,
      stack: this.stack,
      cause: this.cause instanceof AgentMemoryError ? this.cause.toJSON() : undefined,
      timestamp: this.timestamp.toISOString(),
    }
  }

  /**
   * Create a human-readable string representation.
   */
  toString(): string {
    const parts = [
      `[${this.code}]`,
      this.message,
      this.retryable ? '(retryable)' : '(non-retryable)',
    ]
    if (Object.keys(this.context).length > 0) {
      parts.push(`context: ${JSON.stringify(this.context)}`)
    }
    return parts.join(' ')
  }
}

// ============ Specialized Error Classes ============

/**
 * Authentication/authorization errors.
 */
export class AuthenticationError extends AgentMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.AUTH_INVALID,
    options: {
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, code, {
      category: ErrorCategory.AUTH,
      severity: 'error',
      retryable: options.retryable ?? false,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'AuthenticationError'
  }
}

/**
 * Auth error - simplified alias for AuthenticationError.
 * Used by the auth provider for consistency.
 */
export class AuthError extends AuthenticationError {
  constructor(
    message: string,
    options: {
      code?: ErrorCode
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, options.code ?? ErrorCode.AUTH_INVALID, {
      retryable: options.retryable,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'AuthError'
  }
}

/**
 * Token expired error - special case of auth error.
 */
export class TokenExpiredError extends AuthenticationError {
  constructor(
    message: string = 'Authentication token has expired',
    options: {
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, ErrorCode.AUTH_EXPIRED, {
      retryable: true, // Can retry after token refresh
      context: options.context,
      cause: options.cause,
    })
    this.name = 'TokenExpiredError'
  }
}

/**
 * Network-related errors.
 */
export class NetworkError extends AgentMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.NETWORK_CONNECTION,
    options: {
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, code, {
      category: ErrorCategory.NETWORK,
      severity: 'warn',
      retryable: options.retryable ?? true,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'NetworkError'
  }
}

/**
 * Timeout error.
 */
export class TimeoutError extends NetworkError {
  constructor(
    message: string = 'Operation timed out',
    options: {
      timeoutMs?: number
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, ErrorCode.NETWORK_TIMEOUT, {
      retryable: true,
      context: { ...options.context, timeoutMs: options.timeoutMs },
      cause: options.cause,
    })
    this.name = 'TimeoutError'
  }
}

/**
 * Rate limit error.
 */
export class RateLimitError extends NetworkError {
  readonly retryAfter: number

  constructor(
    message: string = 'Rate limit exceeded',
    options: {
      retryAfter?: number
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, ErrorCode.HTTP_RATE_LIMITED, {
      retryable: true,
      context: { ...options.context, retryAfter: options.retryAfter },
      cause: options.cause,
    })
    this.name = 'RateLimitError'
    this.retryAfter = options.retryAfter ?? 60000
  }
}

/**
 * Validation errors.
 */
export class ValidationError extends AgentMemoryError {
  readonly zodError?: z.ZodError
  readonly violations: Array<{ path: string; message: string }>

  constructor(
    message: string,
    options: {
      code?: ErrorCode
      zodError?: z.ZodError
      violations?: Array<{ path: string; message: string }>
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, options.code ?? ErrorCode.VALIDATION_SCHEMA, {
      category: ErrorCategory.VALIDATION,
      severity: 'warn',
      retryable: false,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'ValidationError'
    this.zodError = options.zodError
    this.violations = options.violations ?? extractViolations(options.zodError)
  }
}

/**
 * Database errors.
 */
export class DatabaseError extends AgentMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.DATABASE_QUERY,
    options: {
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, code, {
      category: ErrorCategory.DATABASE,
      severity: 'error',
      retryable: options.retryable ?? false,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'DatabaseError'
  }
}

/**
 * Sync errors.
 */
export class SyncError extends AgentMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.SYNC_PROCESS,
    options: {
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, code, {
      category: ErrorCategory.SYNC,
      severity: 'error',
      retryable: options.retryable ?? true,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'SyncError'
  }
}

/**
 * Connector errors.
 */
export class ConnectorError extends AgentMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.CONNECTOR_API,
    options: {
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, code, {
      category: ErrorCategory.CONNECTOR,
      severity: 'error',
      retryable: options.retryable ?? true,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'ConnectorError'
  }
}

/**
 * Queue errors.
 */
export class QueueError extends AgentMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.QUEUE_HANDLER,
    options: {
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, code, {
      category: ErrorCategory.QUEUE,
      severity: 'error',
      retryable: options.retryable ?? true,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'QueueError'
  }
}

/**
 * Entity resolution errors.
 */
export class ResolutionError extends AgentMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.RESOLUTION_INVALID,
    options: {
      retryable?: boolean
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, code, {
      category: ErrorCategory.RESOLUTION,
      severity: 'error',
      retryable: options.retryable ?? false,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'ResolutionError'
  }
}

/**
 * Internal errors (bugs, assertions).
 */
export class InternalError extends AgentMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.INTERNAL_UNKNOWN,
    options: {
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, code, {
      category: ErrorCategory.INTERNAL,
      severity: 'fatal',
      retryable: false,
      context: options.context,
      cause: options.cause,
    })
    this.name = 'InternalError'
  }
}

/**
 * Assertion error - internal invariant violation.
 */
export class AssertionError extends InternalError {
  constructor(
    message: string,
    options: {
      context?: ErrorContext
      cause?: Error
    } = {}
  ) {
    super(message, ErrorCode.INTERNAL_ASSERTION, options)
    this.name = 'AssertionError'
  }
}

/**
 * Not implemented error.
 */
export class NotImplementedError extends InternalError {
  constructor(
    message: string = 'Not implemented',
    options: {
      context?: ErrorContext
    } = {}
  ) {
    super(message, ErrorCode.INTERNAL_NOT_IMPLEMENTED, options)
    this.name = 'NotImplementedError'
  }
}

// ============ Helper Functions ============

/**
 * Infer category from error code.
 */
function inferCategory(code: ErrorCode): ErrorCategory {
  if (code.startsWith('AUTH_')) return ErrorCategory.AUTH
  if (code.startsWith('NETWORK_') || code.startsWith('HTTP_')) return ErrorCategory.NETWORK
  if (code.startsWith('VALIDATION_')) return ErrorCategory.VALIDATION
  if (code.startsWith('DATABASE_')) return ErrorCategory.DATABASE
  if (code.startsWith('SYNC_')) return ErrorCategory.SYNC
  if (code.startsWith('CONNECTOR_')) return ErrorCategory.CONNECTOR
  if (code.startsWith('QUEUE_')) return ErrorCategory.QUEUE
  if (code.startsWith('RESOLUTION_')) return ErrorCategory.RESOLUTION
  return ErrorCategory.INTERNAL
}

/**
 * Extract violations from a Zod error.
 */
function extractViolations(zodError?: z.ZodError): Array<{ path: string; message: string }> {
  if (!zodError) return []
  return zodError.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

// ============ Type Guards ============

/**
 * Check if an error is an AgentMemoryError.
 */
export function isAgentMemoryError(error: unknown): error is AgentMemoryError {
  return error instanceof AgentMemoryError
}

/**
 * Check if an error is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof AgentMemoryError) {
    return error.retryable
  }
  // Default: treat unknown errors as non-retryable
  return false
}

/**
 * Check if an error indicates rate limiting.
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError
}

/**
 * Check if an error indicates auth failure.
 */
export function isAuthError(error: unknown): error is AuthenticationError {
  return error instanceof AuthenticationError
}

/**
 * Check if an error indicates validation failure.
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError
}

// ============ Error Wrapping ============

/**
 * Wrap any error in an AgentMemoryError.
 */
export function wrapError(
  error: unknown,
  message?: string,
  context?: ErrorContext
): AgentMemoryError {
  if (error instanceof AgentMemoryError) {
    if (context) error.withContext(context)
    return error
  }

  const originalError = error instanceof Error ? error : new Error(String(error))
  const wrappedMessage = message ?? originalError.message

  return new AgentMemoryError(wrappedMessage, ErrorCode.INTERNAL_UNKNOWN, {
    category: ErrorCategory.INTERNAL,
    severity: 'error',
    retryable: false,
    context,
    cause: originalError,
  })
}

/**
 * Create an error from a serialized representation.
 */
export function deserializeError(data: SerializedError): AgentMemoryError {
  const error = new AgentMemoryError(data.message, data.code, {
    category: data.category,
    severity: data.severity,
    retryable: data.retryable,
    context: data.context,
  })
  if (data.stack) {
    error.stack = data.stack
  }
  return error
}
