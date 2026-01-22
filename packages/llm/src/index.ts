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
} from 'types';

// Retry and resilience
export {
  type CircuitState,
  type CircuitBreakerState,
  type ResilienceConfig,
  type RateLimitType,
  type RateLimitInfo,
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
  RateLimitError,
  TimeoutError,
  withTimeout,
  type ResilientCallOptions,
  resilientCall,
} from './retry.js';

// Adapters
export {
  type AdapterLogger,
  type ProviderKeyService,
  consoleLogger,
  createAdapter,
  PartialStreamError,
} from './adapter.js';

// Response schemas for API validation
export {
  OpenAIErrorSchema,
  AnthropicErrorSchema,
  OpenAIChatCompletionSchema,
  AnthropicMessageSchema,
  parseApiErrorResponse,
  formatApiError,
  type OpenAIError,
  type AnthropicError,
  type OpenAIChatCompletion,
  type AnthropicMessage,
  type ParsedApiError,
} from './response_schemas.js';

// Provider registry for direct provider access (advanced)
export { getProvider } from './providers/registry.js';
export type {
  ResolvedRequestConfig,
  ProviderContext,
  LLMProviderAdapter,
} from './providers/types.js';
