/**
 * LLM Adapter Layer - Barrel Export
 *
 * Provides LLM adapters for Anthropic and OpenAI.
 */

// Re-export LLMAdapter type from types for convenience
export type {
  LLMAdapter,
  LLMRequestConfig,
  LLMClientConfig,
  LLMResponse,
  LLMProvider,
  Message,
} from '../types/llm.js';

// Retry and resilience
export {
  type CircuitState,
  type CircuitBreakerState,
  type ResilienceConfig,
  createCircuitState,
  DEFAULT_RESILIENCE_CONFIG,
  calculateBackoff,
  sleep,
  isRetryableError,
  shouldAllowRequest,
  recordSuccess,
  recordFailure,
  CircuitOpenError,
  RetriesExhaustedError,
  type ResilientCallOptions,
  resilientCall,
} from './retry.js';

// Adapters
export {
  type AdapterLogger,
  consoleLogger,
  createAdapter,
} from './adapter.js';
