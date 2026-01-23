/**
 * Error Handling Module
 *
 * Unified error taxonomy and recovery utilities for agent-memory.
 */

// Types and error classes
export {
  // Constants
  ErrorCategory,
  ErrorCode,
  // Schemas
  ErrorCategorySchema,
  ErrorCodeSchema,
  ErrorSeveritySchema,
  SerializedErrorSchema,
  // Types
  type ErrorSeverity,
  type ErrorContext,
  type SerializedError,
  // Base error class
  AgentMemoryError,
  // Specialized error classes
  AuthenticationError,
  TokenExpiredError,
  NetworkError,
  TimeoutError,
  RateLimitError,
  ValidationError,
  DatabaseError,
  SyncError,
  ConnectorError,
  QueueError,
  ResolutionError,
  InternalError,
  AssertionError,
  NotImplementedError,
  // Type guards
  isAgentMemoryError,
  isRetryableError,
  isRateLimitError,
  isAuthError,
  isValidationError,
  // Utilities
  wrapError,
  deserializeError,
} from './types.js'

// Recovery strategies
export {
  // Configuration
  type RetryConfig,
  type CircuitBreakerConfig,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  // Backoff
  exponentialBackoff,
  rateLimitAwareDelay,
  // Retry execution
  type RetryResult,
  withRetry,
  retryOrThrow,
  // Timeout handling
  withTimeout,
  withTimeoutAndRetry,
  // Circuit breaker
  type CircuitState,
  CircuitBreaker,
  // Batch processing
  type BatchResult,
  processBatch,
} from './recovery.js'
