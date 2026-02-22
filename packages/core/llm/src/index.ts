/** LLM module barrel exports. */

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
  getProviderCircuitState,
  resetProviderCircuit,
  getCircuitStatus,
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
} from './policies.js';

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

// Tool vocabulary — provider-specific tool names for prompt parameterization
export type { ToolVocabulary } from './providers/tool_skins.js';
export { REX_VOCAB, CODEX_VOCAB, vocabForProvider } from './providers/tool_skins.js';

// Provider registry for direct provider access (advanced)
export { getProvider } from './providers/registry.js';
export type {
  ResolvedRequestConfig,
  ProviderContext,
  LLMProviderAdapter,
} from './providers/types.js';

// Codex OAuth authentication
export {
  getCodexTokenManager,
  CODEX_OAUTH_CONFIG,
  generatePKCE,
  buildAuthUrl,
  exchangeCodeForTokens,
  CodexTokenManager,
} from './auth/codex-auth.js';
export {
  runCodexOAuthFlow,
  isCodexAuthenticated,
  hasCodexCredentials,
  logoutCodex,
  type OAuthFlowCallbacks,
} from './auth/codex-oauth-flow.js';
export type {
  CodexTokens,
  PKCEChallenge,
  CodexOAuthConfig,
  TokenManager,
} from './auth/types.js';
