/**
 * Connector SDK
 *
 * Shared utilities and base classes for building connectors.
 *
 * @module connector/sdk
 */

// HTTP Client
export {
  // Configuration
  HttpClientConfigSchema,
  type HttpClientConfig,
  // Types
  type HttpMethod,
  type RequestOptions,
  type HttpResponse,
  type RateLimitHeaders,
  // Errors
  HttpError,
  TimeoutError,
  NetworkError,
  HttpRateLimitError,
  CircuitBreakerOpenError,
  // Rate Limiting
  TokenBucket,
  // Circuit Breaker
  CircuitBreaker,
  // Client
  ResilientHttpClient,
  type HttpClientHooks,
  // Factory
  createHttpClient,
  createLoggingHooks,
} from './http.js'

// Connector Types
export {
  // Capabilities
  type ConnectorCapabilities,
  ConnectorCapabilitiesSchema,
  // Auth Types
  type ConnectorAuthType,
  ConnectorAuthTypeSchema,
  type OAuthProviderRefConfig,
  OAuthProviderRefConfigSchema,
  type OAuth2Config,
  OAuth2ConfigSchema,
  type ApiKeyConfig,
  ApiKeyConfigSchema,
  type LocalAuthConfig,
  LocalAuthConfigSchema,
  type CredentialReferenceConfig,
  CredentialReferenceConfigSchema,
  type AuthConfig,
  AuthConfigSchema,
  // Auth Tokens
  type AuthTokens,
  AuthTokensSchema,
  // Account Discovery
  type AccountInfo,
  AccountInfoSchema,
  // Webhooks
  type WebhookEvent,
  WebhookEventSchema,
  type WebhookVerificationResult,
  type WebhookSubscribeOptions,
  type WebhookSubscription,
  // Context
  type ConnectorContext,
  // Interface
  type Connector,
  type ConnectorFactory,
  type ConnectorRegistration,
  // Estimates
  type SyncEstimate,
  type SyncEstimateEntry,
} from './types.js'

// Base Connector
export {
  // Error Logging
  type ErrorSeverity,
  type ConnectorErrorContext,
  type ConnectorLogger,
  defaultLogger,
  noopLogger,
  type BaseConnectorOptions,
  // Base Class
  BaseConnector,
  ConnectorRegistry,
  connectorRegistry,
} from './connector.js'
