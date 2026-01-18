/**
 * LLM Adapter implementations.
 *
 * Multi-provider adapter with per-request config.
 */

import type {
  LLMClientConfig,
  LLMAdapter,
  LLMResponse,
  RespondParams,
  StreamParams,
  LLMProvider,
  Message,
  ToolCall,
  TokenUsage,
  StopReason,
  LLMRequestConfig,
  FallbackConfig,
  ToolDefinition,
} from 'types';
import { getProviderBaseUrl, getProviderResponseFormat, isSupportedProvider } from 'types';
import {
  resilientCall,
  createCircuitState,
  type CircuitBreakerState,
  type ResilienceConfig,
  DEFAULT_RESILIENCE_CONFIG,
  RateLimitError,
  type RateLimitInfo,
  type RateLimitType,
  sleep,
} from './retry.js';
import { parseApiErrorResponse, formatApiError } from './response_schemas.js';

// ============================================
// LOGGER PROTOCOL
// ============================================

/**
 * Logger interface for adapter operations.
 */
export interface AdapterLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Default console logger.
 */
export const consoleLogger: AdapterLogger = {
  debug: (msg, meta) => console.debug(`[LLM] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[LLM] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[LLM] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[LLM] ${msg}`, meta ?? ''),
};

/**
 * Provider service interface for runtime API key resolution.
 * This allows the harness to provide dynamic key lookup without
 * the adapter needing to know about the storage mechanism.
 */
export interface ProviderKeyService {
  /** Get API key for a provider. Returns null if not configured. */
  getApiKey(provider: string): string | null;
  /** Check if an API key exists for a provider. */
  hasApiKey(provider: string): boolean;
}

/**
 * Parse API error response to extract detailed error information.
 * Uses Zod schemas for type-safe parsing.
 */
function parseApiError(
  provider: string,
  status: number,
  responseText: string
): Error {
  const parsed = parseApiErrorResponse(provider, status, responseText);
  return formatApiError(provider, status, parsed);
}

// ============================================
// RATE LIMIT PARSING
// ============================================

/**
 * Parse rate limit headers from a Response object.
 * Supports OpenAI, Anthropic, and OpenAI-compatible providers (Cerebras, Groq, etc.)
 */
function parseRateLimitHeaders(headers: Headers): Partial<RateLimitInfo> {
  const result: Partial<RateLimitInfo> = {};

  // retry-after header (standard, in seconds)
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      result.retryAfterMs = seconds * 1000;
    }
  }

  // x-ratelimit-reset-* headers (OpenAI/Anthropic/Cerebras)
  // These can be timestamps or durations
  const resetRequests = headers.get('x-ratelimit-reset-requests');
  const resetTokens = headers.get('x-ratelimit-reset-tokens');
  const resetMs = headers.get('x-ratelimit-reset-ms'); // Cerebras specific

  if (resetMs) {
    const ms = parseInt(resetMs, 10);
    if (!isNaN(ms)) {
      result.retryAfterMs = ms;
    }
  } else if (resetRequests || resetTokens) {
    // Parse duration strings like "1s", "500ms", "2m30s"
    const parseResetDuration = (val: string): number | undefined => {
      // Try parsing as duration (e.g., "1s", "500ms", "2m30s")
      const msMatch = val.match(/^(\d+)ms$/);
      if (msMatch) return parseInt(msMatch[1], 10);

      const sMatch = val.match(/^(\d+)s$/);
      if (sMatch) return parseInt(sMatch[1], 10) * 1000;

      const mMatch = val.match(/^(\d+)m$/);
      if (mMatch) return parseInt(mMatch[1], 10) * 60 * 1000;

      // Try parsing as seconds number
      const num = parseFloat(val);
      if (!isNaN(num) && num < 1000000) return num * 1000; // Assume seconds if small

      // Try parsing as timestamp
      const timestamp = Date.parse(val);
      if (!isNaN(timestamp)) {
        const waitMs = timestamp - Date.now();
        return waitMs > 0 ? waitMs : undefined;
      }
      return undefined;
    };

    const requestWait = resetRequests ? parseResetDuration(resetRequests) : undefined;
    const tokenWait = resetTokens ? parseResetDuration(resetTokens) : undefined;

    // Use the longer wait time
    if (requestWait !== undefined || tokenWait !== undefined) {
      result.retryAfterMs = Math.max(requestWait ?? 0, tokenWait ?? 0);
    }
  }

  // Remaining counts
  const remainingRequests = headers.get('x-ratelimit-remaining-requests');
  const remainingTokens = headers.get('x-ratelimit-remaining-tokens');
  if (remainingRequests !== null) {
    const remaining = parseInt(remainingRequests, 10);
    if (!isNaN(remaining)) {
      result.remaining = remaining;
      result.limitType = 'requests';
    }
  }
  if (remainingTokens !== null) {
    const remaining = parseInt(remainingTokens, 10);
    if (!isNaN(remaining) && (result.remaining === undefined || remaining < result.remaining)) {
      result.remaining = remaining;
      result.limitType = 'tokens';
    }
  }

  return result;
}

/**
 * Classify rate limit type from error message content.
 */
function classifyRateLimitType(errorMessage: string, retryAfterMs?: number): RateLimitType {
  const lower = errorMessage.toLowerCase();

  // Billing/payment issues
  if (
    lower.includes('billing') ||
    lower.includes('payment') ||
    lower.includes('insufficient') ||
    lower.includes('credit') ||
    lower.includes('subscription')
  ) {
    return 'billing';
  }

  // Quota exhaustion (daily/weekly/monthly limits)
  if (
    lower.includes('quota') ||
    lower.includes('daily') ||
    lower.includes('weekly') ||
    lower.includes('monthly') ||
    lower.includes('exceeded your') ||
    lower.includes('limit exceeded') && (lower.includes('day') || lower.includes('month'))
  ) {
    return 'quota';
  }

  // Short window rate limit (per-minute, per-second)
  if (
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('requests per') ||
    lower.includes('tokens per')
  ) {
    // If we have retry-after and it's short, it's a window limit
    if (retryAfterMs !== undefined && retryAfterMs <= 120000) {
      return 'window';
    }
    // Default to window for generic rate limits (most common case)
    return 'window';
  }

  return 'unknown';
}

/**
 * Create a RateLimitError from a 429 response.
 */
function createRateLimitError(
  provider: string,
  model: string,
  status: number,
  headers: Headers,
  responseText: string
): RateLimitError {
  const headerInfo = parseRateLimitHeaders(headers);

  // Parse the error message
  let errorMessage = responseText;
  try {
    const parsed = JSON.parse(responseText);
    errorMessage = parsed?.error?.message ?? parsed?.message ?? responseText;
  } catch {
    // Keep original text
  }

  const rateLimitType = classifyRateLimitType(errorMessage, headerInfo.retryAfterMs);

  const info: RateLimitInfo = {
    type: rateLimitType,
    retryAfterMs: headerInfo.retryAfterMs,
    limitType: headerInfo.limitType,
    remaining: headerInfo.remaining,
    message: errorMessage,
  };

  const displayWait = info.retryAfterMs
    ? ` (retry after ${Math.ceil(info.retryAfterMs / 1000)}s)`
    : '';

  return new RateLimitError(
    `${provider} rate limit [${rateLimitType}]: ${errorMessage}${displayWait}`,
    info,
    provider,
    model,
    status
  );
}

// ============================================
// PARTIAL STREAM ERROR
// ============================================

/**
 * Error thrown when a streaming request fails mid-stream.
 * Preserves partial content so callers can recover work done before the error.
 */
export class PartialStreamError extends Error {
  public readonly partialContent: string;
  public readonly partialToolCalls: ToolCall[];
  public readonly cause: Error;

  constructor(
    message: string,
    cause: Error,
    partialContent: string,
    partialToolCalls: ToolCall[] = []
  ) {
    super(`${message}: ${cause.message}`);
    this.name = 'PartialStreamError';
    this.cause = cause;
    this.partialContent = partialContent;
    this.partialToolCalls = partialToolCalls;
  }

  /**
   * Check if an error is a PartialStreamError with recoverable content.
   */
  static hasPartialContent(error: unknown): error is PartialStreamError {
    return error instanceof PartialStreamError && error.partialContent.length > 0;
  }
}

// ============================================
// DEFAULT BASE URLS
// ============================================

/**
 * Default base URLs for canonical providers.
 * These are fallbacks when no baseUrl is specified in config.
 * NOTE: openai-compat is intentionally excluded - providers using openai-compat
 * (cerebras, z.ai-coder, groq, etc.) MUST specify baseUrl in their config.
 */
const DEFAULT_PROVIDER_BASE_URLS: Partial<Record<LLMProvider, string>> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
};

// ============================================
// PROVIDER HELPERS
// ============================================

function isReasoningModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith('gpt-5') || lower.startsWith('o1') || lower.startsWith('o3');
}

function supportsSamplingParams(model: string): boolean {
  const lower = model.toLowerCase();
  return !lower.startsWith('gpt-5') && !lower.startsWith('o1') && !lower.startsWith('o3');
}

function supportsPromptCacheRetention(model: string): boolean {
  const lower = model.toLowerCase();
  return !lower.includes('nano');
}

function buildSchemaInstruction(schema: Record<string, unknown>): string {
  return `Return a single JSON object that matches this schema:\n${JSON.stringify(schema)}`;
}

// ============================================
// ROUTER ADAPTER
// ============================================

type ResolvedRequestConfig = {
  provider: LLMProvider;
  /** Original provider name from config (e.g., 'z.ai-coder', 'cerebras') for display in errors */
  displayProvider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: LLMRequestConfig['reasoning'];
};

class LLMRouterAdapter implements LLMAdapter {
  readonly provider?: LLMProvider;
  readonly model?: string;

  private apiKeys: Partial<Record<LLMProvider, string>>;
  private baseUrls: Partial<Record<LLMProvider, string>>;
  private circuitState: CircuitBreakerState;
  private resilienceConfig: ResilienceConfig;
  private logger: AdapterLogger;
  private fallbackConfig?: FallbackConfig;
  private providerKeyService?: ProviderKeyService;

  constructor(config: LLMClientConfig = {}, logger?: AdapterLogger, providerKeyService?: ProviderKeyService) {
    this.apiKeys = config.apiKeys ?? {};
    this.baseUrls = config.baseUrls ?? {};
    this.circuitState = createCircuitState();
    this.resilienceConfig = {
      ...DEFAULT_RESILIENCE_CONFIG,
      maxRetries: 2,
      initialBackoffMs: 1000,
    };
    this.logger = logger ?? consoleLogger;
    this.fallbackConfig = config.fallback;
    this.providerKeyService = providerKeyService;
  }

  /**
   * Set the provider key service for dynamic API key resolution.
   */
  setProviderKeyService(service: ProviderKeyService): void {
    this.providerKeyService = service;
    this.logger.info('Provider key service configured');
  }

  /**
   * Register a model mapping (kept for backwards compatibility).
   * No longer needed - provider should be specified in LLMRequestConfig.
   */
  registerModel(model: string, provider: LLMProvider, baseUrl?: string): void {
    this.logger.debug('registerModel called (no-op)', { model, provider, baseUrl });
  }

  /**
   * Update or add an API key for a provider at runtime.
   * Also resets the circuit breaker to allow immediate retries.
   */
  updateApiKey(provider: LLMProvider, apiKey: string): void {
    this.apiKeys[provider] = apiKey;
    // Reset circuit breaker to allow requests with new key
    this.circuitState = createCircuitState();
    this.logger.info('Updated API key and reset circuit breaker', { provider });
  }

  /**
   * Check if an API key exists for a provider.
   * Checks: 1) provider key service (dynamic), 2) stored keys (static)
   */
  hasApiKey(provider: LLMProvider): boolean {
    // First check the provider key service (dynamic lookup)
    if (this.providerKeyService?.hasApiKey(provider)) {
      return true;
    }
    // Fall back to stored keys
    return !!this.apiKeys[provider];
  }

  /**
   * Reset the circuit breaker state (e.g., after fixing configuration).
   */
  resetCircuitBreaker(): void {
    this.circuitState = createCircuitState();
    this.logger.info('Circuit breaker reset');
  }

  /**
   * Update the global fallback configuration at runtime.
   */
  updateFallback(fallback: FallbackConfig | undefined): void {
    this.fallbackConfig = fallback;
    this.logger.info('Updated fallback configuration', {
      fallback: fallback ? { provider: fallback.provider, model: fallback.model } : 'disabled',
    });
  }

  private resolveRequestConfig(llm: LLMRequestConfig): ResolvedRequestConfig {
    if (!llm?.model) {
      throw new Error('LLM request missing model');
    }

    if (!llm.provider) {
      throw new Error(`Provider must be specified for model '${llm.model}'`);
    }

    const provider = llm.provider;
    // displayProvider is the user-facing name (e.g., 'z.ai-coder') for error messages
    // Falls back to canonical provider if not specified
    const displayProvider = (llm as { displayProvider?: string }).displayProvider ?? provider;

    let baseUrl = llm.baseUrl;
    if (!baseUrl && provider === 'openai-compat' && displayProvider !== 'openai-compat') {
      if (isSupportedProvider(displayProvider)) {
        baseUrl = getProviderBaseUrl(displayProvider);
      }
    }
    // Resolve base URL: per-request > provider registry (openai-compat) > client config > default
    baseUrl = baseUrl ?? this.baseUrls[provider] ?? DEFAULT_PROVIDER_BASE_URLS[provider];

    // Validate baseUrl is present
    if (!baseUrl) {
      if (provider === 'openai-compat') {
        throw new Error(
          `Provider '${displayProvider}' requires baseUrl to be specified. ` +
          `openai-compat is an adapter type, not a provider - each provider needs its own URL.`
        );
      }
      throw new Error(`Base URL not configured for provider '${displayProvider}'`);
    }

    // API key resolution priority:
    // 1. Per-request apiKey (explicit)
    // 2. Provider key service (dynamic - from GraphD/config)
    // 3. Stored apiKeys (static - from constructor)
    let apiKey = llm.apiKey;
    let keySource = 'per-request';

    if (!apiKey && this.providerKeyService) {
      apiKey = this.providerKeyService.getApiKey(displayProvider) ?? null;
      if (apiKey) keySource = 'provider-service';
    }

    if (!apiKey) {
      apiKey = this.apiKeys[provider] ?? null;
      if (apiKey) keySource = 'stored';
    }

    // Debug logging for API key resolution
    const keyPreview = apiKey ? `${apiKey.slice(0, 8)}...` : 'MISSING';
    this.logger.debug('Resolving request config', {
      model: llm.model,
      provider,
      displayProvider,
      baseUrl,
      keySource,
      keyPreview,
      hasProviderService: !!this.providerKeyService,
      hasStoredKey: !!this.apiKeys[provider],
    });

    if (!apiKey) {
      throw new Error(`API key not configured for provider '${displayProvider}'. Use /providers to add your API key.`);
    }

    return {
      provider,
      displayProvider,
      model: llm.model,
      apiKey,
      baseUrl,
      maxTokens: llm.maxTokens,
      temperature: llm.temperature,
      reasoning: llm.reasoning,
    };
  }

  private async withResilience<T>(
    provider: LLMProvider,
    model: string,
    fn: () => Promise<T>
  ): Promise<T> {
    return resilientCall(fn, {
      config: this.resilienceConfig,
      circuitState: this.circuitState,
      circuitKey: `${provider}:${model}`,
      onRetry: (attempt, error, delayMs) => {
        this.logger.warn('LLM call failed, retrying', {
          provider,
          model,
          attempt,
          delayMs,
          error: error.message,
        });
      },
    });
  }

  async respond(params: RespondParams): Promise<LLMResponse> {
    const resolved = this.resolveRequestConfig(params.llm);

    try {
      return await this.withResilience(resolved.provider, resolved.model, async () => {
        switch (resolved.provider) {
          case 'openai':
            return this.respondOpenAI(params, resolved);
          case 'anthropic':
            return this.respondAnthropic(params, resolved);
          case 'openai-compat':
            return this.respondOpenAICompat(params, resolved);
          default:
            throw new Error(`Unsupported provider: ${resolved.provider}`);
        }
      });
    } catch (error) {
      // Handle RateLimitError specially - wait and retry for short windows
      if (RateLimitError.isRateLimitError(error) && error.isWorthWaiting()) {
        const waitMs = error.info.retryAfterMs ?? 30000;
        this.logger.warn('Rate limit hit (short window), waiting to retry', {
          provider: error.provider,
          model: error.model,
          type: error.info.type,
          waitMs,
        });
        await sleep(waitMs);
        // Retry once after waiting
        try {
          return await this.withResilience(resolved.provider, resolved.model, async () => {
            switch (resolved.provider) {
              case 'openai':
                return this.respondOpenAI(params, resolved);
              case 'anthropic':
                return this.respondAnthropic(params, resolved);
              case 'openai-compat':
                return this.respondOpenAICompat(params, resolved);
              default:
                throw new Error(`Unsupported provider: ${resolved.provider}`);
            }
          });
        } catch (retryError) {
          // If retry also fails, continue to fallback logic below
          this.logger.warn('Retry after rate limit wait also failed', {
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
          // Re-throw the original rate limit error if no fallback
          const fallback = params.llm.fallback ?? this.fallbackConfig;
          if (!fallback) throw error;
        }
      }

      // Check for fallback config (per-request takes precedence over global)
      const fallback = params.llm.fallback ?? this.fallbackConfig;
      if (fallback) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn('Primary model failed, falling back to backup', {
          primary: { provider: resolved.provider, model: resolved.model },
          fallback: { provider: fallback.provider, model: fallback.model },
          error: errorMsg,
        });

        // SIMPLE FALLBACK: Just swap the model/credentials, keep same API method
        // Build a new resolved config with fallback credentials but SAME provider type
        // This ensures we use the same API (e.g., Chat Completions) for both primary and fallback
        const fallbackResolved: ResolvedRequestConfig = {
          ...resolved,
          model: fallback.model,
          apiKey: fallback.apiKey ?? resolved.apiKey,
          baseUrl: fallback.baseUrl ?? resolved.baseUrl,
          // Keep the SAME provider - use the same API method
        };

        this.logger.debug('Fallback: retrying with new model', {
          originalModel: resolved.model,
          fallbackModel: fallbackResolved.model,
          provider: resolved.provider,
          hasApiKey: !!fallbackResolved.apiKey,
        });

        // Call the SAME method that failed, just with different model/credentials
        let response: LLMResponse;
        switch (resolved.provider) {
          case 'openai':
            response = await this.respondOpenAI(params, fallbackResolved);
            break;
          case 'anthropic':
            response = await this.respondAnthropic(params, fallbackResolved);
            break;
          case 'openai-compat':
            response = await this.respondOpenAICompat(params, fallbackResolved);
            break;
          default:
            throw new Error(`Unsupported provider: ${resolved.provider}`);
        }

        return { ...response, usedFallback: true };
      }

      throw error;
    }
  }

  async *stream(params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const resolved = this.resolveRequestConfig(params.llm);

    try {
      let generator: AsyncGenerator<string, LLMResponse>;
      switch (resolved.provider) {
        case 'openai':
          generator = this.streamOpenAI(params, resolved);
          break;
        case 'anthropic':
          generator = this.streamAnthropic(params, resolved);
          break;
        case 'openai-compat':
          generator = this.streamOpenAICompat(params, resolved);
          break;
        default:
          throw new Error(`Unsupported provider: ${resolved.provider}`);
      }

      // Delegate to the provider generator
      return yield* generator;
    } catch (error) {
      // Handle RateLimitError specially - wait and retry for short windows
      if (RateLimitError.isRateLimitError(error) && error.isWorthWaiting()) {
        const waitMs = error.info.retryAfterMs ?? 30000;
        this.logger.warn('Stream rate limit hit (short window), waiting to retry', {
          provider: error.provider,
          model: error.model,
          type: error.info.type,
          waitMs,
        });
        await sleep(waitMs);
        // Retry once after waiting
        try {
          let retryGenerator: AsyncGenerator<string, LLMResponse>;
          switch (resolved.provider) {
            case 'openai':
              retryGenerator = this.streamOpenAI(params, resolved);
              break;
            case 'anthropic':
              retryGenerator = this.streamAnthropic(params, resolved);
              break;
            case 'openai-compat':
              retryGenerator = this.streamOpenAICompat(params, resolved);
              break;
            default:
              throw new Error(`Unsupported provider: ${resolved.provider}`);
          }
          return yield* retryGenerator;
        } catch (retryError) {
          // If retry also fails, continue to fallback logic below
          this.logger.warn('Stream retry after rate limit wait also failed', {
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
          // Re-throw the original rate limit error if no fallback
          const fallback = params.llm.fallback ?? this.fallbackConfig;
          if (!fallback) throw error;
        }
      }

      // Check for fallback config (per-request takes precedence over global)
      const fallback = params.llm.fallback ?? this.fallbackConfig;
      if (fallback) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn('Primary model stream failed, falling back to backup', {
          primary: { provider: resolved.provider, model: resolved.model },
          fallback: { provider: fallback.provider, model: fallback.model },
          error: errorMsg,
        });

        // SIMPLE FALLBACK: Just swap the model/credentials, keep same API method
        const fallbackResolved: ResolvedRequestConfig = {
          ...resolved,
          model: fallback.model,
          apiKey: fallback.apiKey ?? resolved.apiKey,
          baseUrl: fallback.baseUrl ?? resolved.baseUrl,
        };

        this.logger.debug('Stream fallback: retrying with new model', {
          originalModel: resolved.model,
          fallbackModel: fallbackResolved.model,
          provider: resolved.provider,
        });

        // Call the SAME method that failed, just with different model/credentials
        let fallbackGenerator: AsyncGenerator<string, LLMResponse>;
        switch (resolved.provider) {
          case 'openai':
            fallbackGenerator = this.streamOpenAI(params, fallbackResolved);
            break;
          case 'anthropic':
            fallbackGenerator = this.streamAnthropic(params, fallbackResolved);
            break;
          case 'openai-compat':
            fallbackGenerator = this.streamOpenAICompat(params, fallbackResolved);
            break;
          default:
            throw new Error(`Unsupported provider: ${resolved.provider}`);
        }

        const response = yield* fallbackGenerator;
        return { ...response, usedFallback: true };
      }

      throw error;
    }
  }

  // ============================================
  // ANTHROPIC
  // ============================================

  private formatAnthropicTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: t.parameters.properties,
        required: t.parameters.required,
        additionalProperties: t.parameters.additionalProperties,
      },
    }));
  }

  private formatAnthropicMessages(
    messages: Message[]
  ): Array<{ role: string; content: string | unknown[] }> {
    return messages
      .filter((m) => m && m.role !== 'system' && m.content != null)
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter(block => block != null).map((block) => {
                  if (block.type === 'text') {
                    return { type: 'text', text: block.text };
                  }
                  if (block.type === 'tool_use') {
                    return {
                      type: 'tool_use',
                      id: block.id,
                      name: block.name,
                      input: block.input,
                    };
                  }
                  if (block.type === 'tool_result') {
                    return {
                      type: 'tool_result',
                      tool_use_id: block.toolUseId,
                      content: block.content,
                      is_error: block.isError,
                    };
                  }
                  return block;
                })
              : [], // Fallback to empty array for non-string, non-array content
      }));
  }

  private async respondAnthropic(
    params: RespondParams,
    resolved: ResolvedRequestConfig
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const systemMessage = params.messages.find((m) => m.role === 'system');
    const systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: resolved.model,
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
      messages: this.formatAnthropicMessages(params.messages),
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatAnthropicTools(params.tools);
    }

    const response = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': resolved.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error('Anthropic API request failed', {
        method: 'respond',
        endpoint: '/v1/messages',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      // Throw RateLimitError for 429s with parsed header info
      if (response.status === 429) {
        throw createRateLimitError('Anthropic', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('Anthropic', response.status, errorText);
    }

    const data = (await response.json()) as {
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
      };
      model: string;
    };

    const textBlocks = data.content.filter((c) => c.type === 'text');
    const content = textBlocks.map((c) => c.text ?? '').join('');

    const toolUseBlocks = data.content.filter((c) => c.type === 'tool_use');
    const toolCalls: ToolCall[] = toolUseBlocks.map((c) => ({
      id: c.id ?? '',
      name: c.name ?? '',
      arguments: (c.input as Record<string, unknown>) ?? {},
    }));

    const stopReasonMap: Record<string, StopReason> = {
      end_turn: 'end_turn',
      max_tokens: 'max_tokens',
      stop_sequence: 'stop_sequence',
      tool_use: 'tool_use',
    };
    const stopReason: StopReason =
      stopReasonMap[data.stop_reason] ?? 'end_turn';

    const usage: TokenUsage = {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: data.usage.input_tokens + data.usage.output_tokens,
    };

    return {
      content,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: data.model,
      durationMs: Date.now() - startTime,
    };
  }

  private async *streamAnthropic(
    params: StreamParams,
    resolved: ResolvedRequestConfig
  ): AsyncGenerator<string, LLMResponse> {
    const startTime = Date.now();

    const systemMessage = params.messages.find((m) => m.role === 'system');
    const systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: resolved.model,
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
      messages: this.formatAnthropicMessages(params.messages),
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatAnthropicTools(params.tools);
    }

    const response = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': resolved.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      this.logger.error('Anthropic API stream request failed', {
        method: 'stream',
        endpoint: '/v1/messages',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      // Throw RateLimitError for 429s with parsed header info
      if (response.status === 429) {
        throw createRateLimitError('Anthropic', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('Anthropic', response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';
    let stopReason: StopReason = 'end_turn';
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const toolCalls: ToolCall[] = [];
    let model = resolved.model;
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as {
              type: string;
              delta?: { type: string; text?: string };
              message?: { model: string };
              usage?: { input_tokens: number; output_tokens: number };
            };

            if (
              event.type === 'content_block_delta' &&
              event.delta?.type === 'text_delta'
            ) {
              const text = event.delta.text ?? '';
              fullContent += text;
              params.onChunk?.(text);
              yield text;
            }

            if (event.type === 'message_start' && event.message?.model) {
              model = event.message.model;
            }

            if (event.type === 'message_delta' && event.usage) {
              usage = {
                promptTokens: event.usage.input_tokens,
                completionTokens: event.usage.output_tokens,
                totalTokens:
                  event.usage.input_tokens + event.usage.output_tokens,
              };
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      durationMs: Date.now() - startTime,
    };
  }

  // ============================================
  // OPENAI
  // ============================================

  private formatOpenAITools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.parameters.properties,
        required: t.parameters.required,
        additionalProperties: t.parameters.additionalProperties,
      },
      strict: t.strict ?? false,
    }));
  }

  private normalizeInput(messages: Message[]): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];
    const isValidToolName = (name: unknown): name is string =>
      typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name);

    for (const msg of messages) {
      // Skip undefined/null messages
      if (!msg) continue;

      const item = msg as unknown as Record<string, unknown>;
      const callId = (item.call_id ?? item.id ?? item.callId) as string;

      if (item.type === 'function_call') {
        if (!isValidToolName(item.name)) {
          this.logger.warn('Skipping function_call with invalid name', {
            name: item.name,
            callId,
          });
          continue;
        }
        input.push({
          type: 'function_call',
          call_id: callId,
          name: item.name,
          arguments: item.arguments,
        });
        continue;
      }

      if (item.type === 'function_call_output') {
        const outputCallId = (item.call_id ?? item.callId) as string;
        input.push({
          type: 'function_call_output',
          call_id: outputCallId,
          output: item.output,
        });
        continue;
      }

      // Skip messages with no content
      if (msg.content === undefined || msg.content === null) {
        continue;
      }

      if (typeof msg.content === 'string') {
        input.push({
          role: msg.role,
          content: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        input.push({
          role: msg.role,
          content: msg.content.filter(block => block != null).map((block) => {
            if (block.type === 'text') {
              return { type: 'text', text: block.text };
            }
            if (block.type === 'tool_use') {
              return {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input,
              };
            }
            if (block.type === 'tool_result') {
              return {
                type: 'tool_result',
                tool_use_id: block.toolUseId,
                content: block.content,
                is_error: block.isError,
              };
            }
            return block;
          }),
        });
      }
    }

    return input;
  }

  private parseOutputText(response: Record<string, unknown>): string {
    const direct = response.output_text as string | undefined;
    if (direct) {
      return direct;
    }

    const output = response.output as Array<Record<string, unknown>> | undefined;
    if (!output) return '';

    let content = '';
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;

      const itemType = item.type as string | undefined;

      if (itemType === 'message') {
        const contentBlocks = item.content as Array<Record<string, unknown>> | string | undefined;
        if (typeof contentBlocks === 'string') {
          content += contentBlocks;
          continue;
        }
        if (!Array.isArray(contentBlocks)) continue;

        for (const block of contentBlocks) {
          const blockType = block.type as string | undefined;
          if (blockType === 'output_text' || blockType === 'text') {
            content += (block.text as string) ?? '';
          } else if (blockType === 'output_json' || blockType === 'json') {
            const jsonPayload = (block.json as Record<string, unknown> | undefined)
              ?? (block.output as Record<string, unknown> | undefined);
            if (jsonPayload) {
              content += JSON.stringify(jsonPayload);
            }
          } else if (blockType === 'refusal') {
            content += (block.refusal as string) ?? '';
          }
        }
        continue;
      }

      if (itemType === 'output_text' || itemType === 'text') {
        content += (item.text as string) ?? '';
        continue;
      }

      if (itemType === 'output_json' || itemType === 'json') {
        const jsonPayload = (item.json as Record<string, unknown> | undefined)
          ?? (item.output as Record<string, unknown> | undefined);
        if (jsonPayload) {
          content += JSON.stringify(jsonPayload);
        }
        continue;
      }

      if (itemType === 'refusal') {
        content += (item.refusal as string) ?? '';
      }
    }

    return content;
  }

  private parseToolCalls(response: Record<string, unknown>): ToolCall[] {
    const output = response.output as Array<Record<string, unknown>> | undefined;
    if (!output) return [];

    const toolCalls: ToolCall[] = [];
    const isValidToolName = (name: unknown): name is string =>
      typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name);

    for (const item of output) {
      // Handle function_call items directly in output array (OpenAI Responses API format)
      if (item.type === 'function_call') {
        const callId = (item.call_id ?? item.id) as string;
        const name = item.name as string;
        if (!isValidToolName(name)) {
          continue;
        }
        const argsJson = item.arguments as string;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsJson);
        } catch {
          args = {};
        }
        toolCalls.push({ id: callId, name, arguments: args });
        continue;
      }

      // Handle nested tool_call blocks inside message items (legacy format)
      if (item.type !== 'message') continue;
      const contentBlocks = item.content as Array<Record<string, unknown>> | undefined;
      if (!contentBlocks) continue;

      for (const block of contentBlocks) {
        if (block.type !== 'tool_call') continue;

        const callId = block.id as string;
        const name = block.name as string;
        if (!isValidToolName(name)) {
          continue;
        }
        const argsJson = block.arguments as string;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsJson);
        } catch {
          args = {};
        }

        toolCalls.push({
          id: callId,
          name,
          arguments: args,
        });
      }
    }

    return toolCalls;
  }

  private async respondOpenAI(
    params: RespondParams,
    resolved: ResolvedRequestConfig
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    // Extract system message as instructions
    const systemMessage = params.messages.find((m) => m.role === 'system');
    const instructions =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: resolved.model,
      background: true,
    };

    if (instructions) {
      body.instructions = instructions;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatOpenAITools(params.tools);
    }
    if (params.toolChoice) {
      body.tool_choice = params.toolChoice;
    } else if (params.tools && params.tools.length > 0) {
      body.tool_choice = 'auto';
    }

    if (params.responseSchema) {
      this.logger.debug('Response schema being sent', {
        name: params.responseSchema.name,
        schemaSize: JSON.stringify(params.responseSchema.schema).length,
        schema: params.responseSchema.schema,
      });
      body.text = {
        format: {
          type: 'json_schema',
          name: params.responseSchema.name,
          schema: params.responseSchema.schema,
          strict: params.responseSchema.strict ?? true,
        },
      };
    }

    if (params.promptCacheKey) {
      body.prompt_cache_key = params.promptCacheKey;
    }

    if (params.promptCacheRetention && supportsPromptCacheRetention(resolved.model)) {
      body.prompt_cache_retention = params.promptCacheRetention;
    }

    if (params.previousResponseId) {
      body.previous_response_id = params.previousResponseId;
    }

    if (supportsSamplingParams(resolved.model)) {
      if (params.temperature ?? resolved.temperature) {
        body.temperature = params.temperature ?? resolved.temperature;
      }
    }

    const reasoningEffort = resolved.reasoning?.effort;
    if (reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== 'standard') {
      body.reasoning = { effort: reasoningEffort };
    }

    body.max_output_tokens = params.maxTokens ?? resolved.maxTokens ?? 4096;

    if (params.maxToolCalls !== undefined) {
      body.max_tool_calls = params.maxToolCalls;
    }
    if (params.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = params.parallelToolCalls;
    }

    body.input = this.normalizeInput(params.messages);
    const inputArray = body.input as Array<Record<string, unknown>>;
    if (!inputArray || inputArray.length === 0) {
      this.logger.error('OpenAI request has no input items', {
        method: 'respond',
        endpoint: '/v1/responses',
        totalMessages: params.messages.length,
        messageRoles: params.messages.map(m => m.role),
      });
      throw new Error(
        `OpenAI Responses API requires input: got ${params.messages.length} messages ` +
        `but normalized to 0 input items. Roles: [${params.messages.map(m => m.role).join(', ')}]`
      );
    }

    this.logger.debug('OpenAI API request', {
      method: 'respond',
      endpoint: '/v1/responses',
      model: resolved.model,
      maxOutputTokens: body.max_output_tokens,
      hasInstructions: !!body.instructions,
      hasReasoning: !!body.reasoning,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      inputLength: inputArray.length,
      messageCount: params.messages.length,
    });

    const response = await fetch(`${resolved.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error('OpenAI API request failed', {
        method: 'respond',
        endpoint: '/v1/responses',
        status: response.status,
        model: resolved.model,
        inputLength: Array.isArray(body.input) ? body.input.length : 0,
        errorPreview: errorText.slice(0, 200),
      });
      // Throw RateLimitError for 429s with parsed header info
      if (response.status === 429) {
        throw createRateLimitError('OpenAI', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('OpenAI', response.status, errorText);
    }

    let data = (await response.json()) as Record<string, unknown>;

    const status = data.status as string;
    const responseId = data.id as string | undefined;

    this.logger.debug('OpenAI initial response', {
      status,
      responseId,
      model: resolved.model,
    });

    this.logger.debug('OpenAI full response', {
      data: JSON.stringify(data, null, 2),
    });

    if (status === 'queued' || status === 'in_progress') {
      if (!responseId) {
        this.logger.error('OpenAI background response missing id', {
          method: 'respond',
          endpoint: '/v1/responses',
          status,
        });
        throw new Error('OpenAI Responses API: background response missing id');
      }
      data = await this.pollForCompletion(resolved, responseId);
    } else if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
      const error = data.error as Record<string, unknown> | undefined;
      const errorMessage = error?.message ?? `Response ${status}`;
      const errorCode = error?.code ?? 'unknown';
      this.logger.error(`OpenAI immediate ${status}`, {
        method: 'respond',
        endpoint: '/v1/responses',
        errorCode,
        errorMessage,
        responseId: data.id,
      });
      throw new Error(`OpenAI Responses API ${status} [${errorCode}]: ${errorMessage}`);
    }

    const outputText = this.parseOutputText(data);
    const toolCalls = this.parseToolCalls(data);

    const finalStatus = (data.status as string) ?? 'completed';
    const stopReasonMap: Record<string, StopReason> = {
      completed: 'end_turn',
      failed: 'end_turn',
      cancelled: 'end_turn',
    };
    const stopReason: StopReason = toolCalls.length > 0
      ? 'tool_use'
      : (stopReasonMap[finalStatus] ?? 'end_turn');

    const usageData = data.usage as Record<string, number> | undefined;
    const usage: TokenUsage = usageData
      ? {
          promptTokens: usageData.input_tokens ?? 0,
          completionTokens: usageData.output_tokens ?? 0,
          totalTokens: usageData.total_tokens ?? 0,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    return {
      content: outputText,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: (data.model as string) ?? resolved.model,
      durationMs: Date.now() - startTime,
      responseId: data.id as string | undefined,
    };
  }

  private async pollForCompletion(
    resolved: ResolvedRequestConfig,
    responseId: string,
    maxWaitMs: number = 300000,
    pollIntervalMs: number = 2000
  ): Promise<Record<string, unknown>> {
    const startTime = Date.now();
    let pollCount = 0;

    this.logger.debug('Starting background poll', {
      responseId,
      model: resolved.model,
      maxOutputTokens: resolved.maxTokens,
      maxWaitMs,
      pollIntervalMs,
    });

    while (Date.now() - startTime < maxWaitMs) {
      pollCount++;
      const response = await fetch(`${resolved.baseUrl}/v1/responses/${responseId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${resolved.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('OpenAI poll request failed', {
          method: 'pollForCompletion',
          endpoint: `/v1/responses/${responseId}`,
          status: response.status,
          responseId,
          errorPreview: errorText.slice(0, 200),
        });
        // Throw RateLimitError for 429s with parsed header info
        if (response.status === 429) {
          throw createRateLimitError('OpenAI', resolved.model, response.status, response.headers, errorText);
        }
        throw parseApiError('OpenAI', response.status, errorText);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const status = data.status as string;

      const incompleteDetails = data.incomplete_details as Record<string, unknown> | undefined;

      this.logger.debug('Poll status', {
        responseId,
        pollCount,
        status,
        elapsedMs: Date.now() - startTime,
        incompleteDetails,
      });

      if (status === 'completed') {
        this.logger.debug('Poll completed', { responseId, pollCount });
        this.logger.debug('OpenAI poll result full response', {
          data: JSON.stringify(data, null, 2),
        });
        return data;
      }

      if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
        const error = data.error as Record<string, unknown> | undefined;
        const errorMessage = error?.message ?? `Response ${status}`;
        const errorCode = error?.code ?? 'unknown';
        this.logger.error(`OpenAI response ${status}`, {
          method: 'pollForCompletion',
          endpoint: `/v1/responses/${responseId}`,
          responseId,
          model: resolved.model,
          maxOutputTokens: resolved.maxTokens,
          incompleteDetails,
          errorCode,
          errorMessage,
        });
        throw new Error(`OpenAI Responses API ${status} [${errorCode}]: ${errorMessage} (model=${resolved.model}, maxOutputTokens=${resolved.maxTokens})`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    this.logger.error('OpenAI response timeout', {
      method: 'pollForCompletion',
      endpoint: `/v1/responses/${responseId}`,
      responseId,
      maxWaitMs,
    });
    throw new Error(`OpenAI Responses API timeout: response ${responseId} did not complete within ${maxWaitMs}ms`);
  }

  private async *streamOpenAI(
    params: StreamParams,
    resolved: ResolvedRequestConfig
  ): AsyncGenerator<string, LLMResponse> {
    const startTime = Date.now();

    const systemMessage = params.messages.find((m) => m.role === 'system');
    const instructions =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: resolved.model,
      stream: true,
      background: true,
    };

    if (instructions) {
      body.instructions = instructions;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatOpenAITools(params.tools);
    }
    if (params.toolChoice) {
      body.tool_choice = params.toolChoice;
    } else if (params.tools && params.tools.length > 0) {
      body.tool_choice = 'auto';
    }

    if (params.responseSchema) {
      body.text = {
        format: {
          type: 'json_schema',
          name: params.responseSchema.name,
          schema: params.responseSchema.schema,
          strict: params.responseSchema.strict ?? true,
        },
      };
    }

    if (params.promptCacheKey) {
      body.prompt_cache_key = params.promptCacheKey;
    }
    if (params.promptCacheRetention && supportsPromptCacheRetention(resolved.model)) {
      body.prompt_cache_retention = params.promptCacheRetention;
    }

    if (params.previousResponseId) {
      body.previous_response_id = params.previousResponseId;
    }

    if (supportsSamplingParams(resolved.model)) {
      if (params.temperature ?? resolved.temperature) {
        body.temperature = params.temperature ?? resolved.temperature;
      }
    }

    const reasoningEffort = resolved.reasoning?.effort;
    if (reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== 'standard') {
      body.reasoning = { effort: reasoningEffort };
    }

    body.max_output_tokens = params.maxTokens ?? resolved.maxTokens ?? 4096;

    if (params.maxToolCalls !== undefined) {
      body.max_tool_calls = params.maxToolCalls;
    }
    if (params.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = params.parallelToolCalls;
    }

    body.input = this.normalizeInput(params.messages);

    const response = await fetch(`${resolved.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      this.logger.error('OpenAI API stream request failed', {
        method: 'stream',
        endpoint: '/v1/responses',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      // Throw RateLimitError for 429s with parsed header info
      if (response.status === 429) {
        throw createRateLimitError('OpenAI', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('OpenAI', response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';
    let stopReason: StopReason = 'end_turn';
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const toolCalls: ToolCall[] = [];
    let model = resolved.model;
    let responseId: string | undefined;
    let sawTextDelta = false;
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (!data) continue;
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as Record<string, unknown>;

            if (event.type === 'response.created') {
              responseId = event.id as string | undefined;
            }

            if (event.type === 'response.output_text.delta') {
              const delta = event.delta as string;
              if (delta) {
                sawTextDelta = true;
                fullContent += delta;
                params.onChunk?.(delta);
                yield delta;
              }
            }

            if (event.type === 'response.output_text.done') {
              const text = event.text as string;
              if (text && !sawTextDelta) {
                fullContent += text;
                params.onChunk?.(text);
                yield text;
              }
            }

            if (event.type === 'response.completed') {
              const responseObj = event.response as Record<string, unknown> | undefined;
              if (responseObj) {
                const parsedText = this.parseOutputText(responseObj);
                if (parsedText && fullContent.length === 0) {
                  fullContent += parsedText;
                }
                const parsedCalls = this.parseToolCalls(responseObj);
                if (parsedCalls.length > 0) {
                  toolCalls.length = 0;
                  toolCalls.push(...parsedCalls.filter((call) => !!call.name));
                }
                const usageData = responseObj.usage as Record<string, number> | undefined;
                if (usageData) {
                  usage = {
                    promptTokens: usageData.input_tokens ?? 0,
                    completionTokens: usageData.output_tokens ?? 0,
                    totalTokens: usageData.total_tokens ?? 0,
                  };
                }
                model = (responseObj.model as string) ?? model;
              }
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    }

    return {
      content: fullContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      durationMs: Date.now() - startTime,
      responseId,
    };
  }

  // ============================================
  // OPENAI-COMPAT (Chat Completions API)
  // ============================================

  private formatOpenAICompatTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: t.parameters.properties,
          required: t.parameters.required,
        },
      },
    }));
  }

  private formatOpenAICompatMessages(
    messages: Message[],
    systemPrompt?: string
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    // Add system message if provided
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    // Collect function_call items to batch them into assistant messages with tool_calls
    const functionCalls: Array<{ callId: string; name: string; argumentsStr: string }> = [];

    for (const msg of messages) {
      // Skip undefined/null messages and system messages
      if (!msg || msg.role === 'system') continue;

      const item = msg as unknown as Record<string, unknown>;

      // Handle function_call items (from agent's tool call processing)
      if (item.type === 'function_call') {
        const callId = (item.call_id ?? item.callId) as string;
        const name = item.name as string;
        // arguments may be already stringified by getItemsForLLM() or may be an object
        const args = item.arguments;
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
        functionCalls.push({ callId, name, argumentsStr: argsStr });
        continue;
      }

      // Handle function_call_output items (tool results from agent processing)
      if (item.type === 'function_call_output') {
        // First, flush any pending function calls as an assistant message
        if (functionCalls.length > 0) {
          result.push({
            role: 'assistant',
            content: '',  // Some providers don't accept null
            tool_calls: functionCalls.map((fc) => ({
              id: fc.callId,
              type: 'function',
              function: {
                name: fc.name,
                arguments: fc.argumentsStr,
              },
            })),
          });
          functionCalls.length = 0;
        }

        // Then add the tool result
        const callId = (item.call_id ?? item.callId) as string;
        const output = item.output as string;
        result.push({
          role: 'tool',
          tool_call_id: callId,
          content: output,
        });
        continue;
      }

      // Handle string content
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      // Handle undefined/null content - skip or use empty string
      if (!msg.content) {
        continue;
      }

      // Handle content blocks (must be an array at this point)
      if (!Array.isArray(msg.content)) {
        continue;
      }

      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];

      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          // Assistant message with tool calls
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === 'tool_result') {
          // Tool result becomes a separate 'tool' role message
          result.push({
            role: 'tool',
            tool_call_id: block.toolUseId,
            content: block.content,
          });
        }
      }

      // If we have tool calls, this is an assistant message with tool_calls
      if (toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: textParts.join('\n') || '',  // Some providers don't accept null
          tool_calls: toolCalls,
        });
      } else if (textParts.length > 0) {
        result.push({
          role: msg.role,
          content: textParts.join('\n'),
        });
      }
    }

    // Flush any remaining function calls (shouldn't happen in normal flow, but be safe)
    if (functionCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: '',  // Some providers don't accept null
        tool_calls: functionCalls.map((fc) => ({
          id: fc.callId,
          type: 'function',
          function: {
            name: fc.name,
            arguments: fc.argumentsStr,
          },
        })),
      });
    }

    return result;
  }

  private async respondOpenAICompat(
    params: RespondParams,
    resolved: ResolvedRequestConfig
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    const systemMessage = params.messages.find((m) => m.role === 'system');
    let systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);
    const responseFormat = params.responseSchema
      ? getProviderResponseFormat(resolved.displayProvider)
      : null;
    if (params.responseSchema && responseFormat === 'json_object') {
      const schemaHint = buildSchemaInstruction(params.responseSchema.schema);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaHint}` : schemaHint;
    }

    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: this.formatOpenAICompatMessages(params.messages, systemPrompt),
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
    };

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatOpenAICompatTools(params.tools);
    }
    if (params.toolChoice) {
      body.tool_choice = params.toolChoice;
    } else if (params.tools && params.tools.length > 0) {
      body.tool_choice = 'auto';
    }

    // Add structured output support for providers that support it (Cerebras, Groq, Together, etc.)
    if (params.responseSchema) {
      if (responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' };
      } else {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: params.responseSchema.name,
            schema: params.responseSchema.schema,
            strict: params.responseSchema.strict ?? true,
          },
        };
      }
    }

    const formattedMessages = body.messages as Array<Record<string, unknown>>;
    const messageTypes = formattedMessages.map(m => {
      if (m.role === 'tool') return 'tool';
      if (m.role === 'assistant' && m.tool_calls) return 'assistant+tools';
      return m.role;
    });

    this.logger.debug('OpenAI-compat API request', {
      method: 'respond',
      endpoint: '/chat/completions',
      model: resolved.model,
      maxTokens: body.max_tokens,
      messageCount: formattedMessages.length,
      messageTypes: messageTypes.join(', '),
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      hasResponseFormat: !!body.response_format,
      responseFormat: responseFormat ?? undefined,
      responseSchemaName: params.responseSchema?.name,
    });

    // Debug: log full message structure when there are tool-related messages
    if (messageTypes.includes('tool') || messageTypes.includes('assistant+tools')) {
      this.logger.debug('OpenAI-compat messages with tools', {
        messages: JSON.stringify(formattedMessages.slice(-6), null, 2),  // Last 6 messages
      });
    }

    const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const providerInfo = `${resolved.displayProvider} (${resolved.baseUrl})`;
      this.logger.error(`${resolved.displayProvider} API request failed`, {
        method: 'respond',
        endpoint: '/chat/completions',
        status: response.status,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        errorPreview: errorText.slice(0, 200),
      });
      // Throw RateLimitError for 429s with parsed header info
      if (response.status === 429) {
        throw createRateLimitError(providerInfo, resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError(providerInfo, response.status, errorText);
    }

    const data = (await response.json()) as {
      id: string;
      object: string;
      created: number;
      model: string;
      choices: Array<{
        index: number;
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const choice = data.choices[0];
    const content = this.normalizeOpenAICompatContent(choice?.message?.content);

    this.logger.debug('OpenAI-compat response received', {
      model: resolved.model,
      finishReason: choice?.finish_reason,
      hasContent: !!content,
      contentLength: content?.length ?? 0,
      contentPreview: content?.slice(0, 200),
      hasToolCalls: !!choice?.message?.tool_calls,
      toolCallCount: choice?.message?.tool_calls?.length ?? 0,
    });

    const toolCalls: ToolCall[] = [];
    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        });
      }
    }

    const stopReasonMap: Record<string, StopReason> = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'end_turn',
    };
    const stopReason: StopReason =
      stopReasonMap[choice?.finish_reason ?? 'stop'] ?? 'end_turn';

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };

    return {
      content,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: data.model ?? resolved.model,
      durationMs: Date.now() - startTime,
    };
  }

  private normalizeOpenAICompatContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!content) return '';
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (typeof block === 'string') {
          parts.push(block);
          continue;
        }
        if (block && typeof block === 'object') {
          const record = block as Record<string, unknown>;
          if (typeof record.text === 'string') {
            parts.push(record.text);
            continue;
          }
          if (typeof record.content === 'string') {
            parts.push(record.content);
            continue;
          }
          try {
            parts.push(JSON.stringify(block));
          } catch {
            // Ignore non-serializable blocks.
          }
        }
      }
      return parts.join('\n');
    }
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }

  private async *streamOpenAICompat(
    params: StreamParams,
    resolved: ResolvedRequestConfig
  ): AsyncGenerator<string, LLMResponse> {
    const startTime = Date.now();

    const systemMessage = params.messages.find((m) => m.role === 'system');
    let systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);
    const responseFormat = params.responseSchema
      ? getProviderResponseFormat(resolved.displayProvider)
      : null;
    if (params.responseSchema && responseFormat === 'json_object') {
      const schemaHint = buildSchemaInstruction(params.responseSchema.schema);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaHint}` : schemaHint;
    }

    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: this.formatOpenAICompatMessages(params.messages, systemPrompt),
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
      stream: true,
    };

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatOpenAICompatTools(params.tools);
    }
    if (params.toolChoice) {
      body.tool_choice = params.toolChoice;
    } else if (params.tools && params.tools.length > 0) {
      body.tool_choice = 'auto';
    }

    // Add structured output support for providers that support it
    if (params.responseSchema) {
      if (responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' };
      } else {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: params.responseSchema.name,
            schema: params.responseSchema.schema,
            strict: params.responseSchema.strict ?? true,
          },
        };
      }
    }

    const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      const providerInfo = `${resolved.displayProvider} (${resolved.baseUrl})`;
      this.logger.error(`${resolved.displayProvider} API stream request failed`, {
        method: 'stream',
        endpoint: '/chat/completions',
        status: response.status,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        errorPreview: errorText.slice(0, 200),
      });
      // Throw RateLimitError for 429s with parsed header info
      if (response.status === 429) {
        throw createRateLimitError(providerInfo, resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError(providerInfo, response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';
    let stopReason: StopReason = 'end_turn';
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const toolCalls: ToolCall[] = [];
    const toolCallBuilders: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let model = resolved.model;
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as {
              id?: string;
              object?: string;
              model?: string;
              choices?: Array<{
                index: number;
                delta: {
                  role?: string;
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: string;
                    function?: {
                      name?: string;
                      arguments?: string;
                    };
                  }>;
                };
                finish_reason?: string;
              }>;
              usage?: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
              };
            };

            if (event.model) {
              model = event.model;
            }

            const choice = event.choices?.[0];
            if (choice) {
              // Handle content delta
              if (choice.delta?.content) {
                fullContent += choice.delta.content;
                params.onChunk?.(choice.delta.content);
                yield choice.delta.content;
              }

              // Handle tool calls delta
              if (choice.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  if (!toolCallBuilders.has(tc.index)) {
                    toolCallBuilders.set(tc.index, {
                      id: tc.id ?? '',
                      name: tc.function?.name ?? '',
                      arguments: '',
                    });
                  }
                  const builder = toolCallBuilders.get(tc.index)!;
                  if (tc.id) builder.id = tc.id;
                  if (tc.function?.name) builder.name = tc.function.name;
                  if (tc.function?.arguments) builder.arguments += tc.function.arguments;
                }
              }

              // Handle finish reason
              if (choice.finish_reason) {
                const stopReasonMap: Record<string, StopReason> = {
                  stop: 'end_turn',
                  length: 'max_tokens',
                  tool_calls: 'tool_use',
                  content_filter: 'end_turn',
                };
                stopReason = stopReasonMap[choice.finish_reason] ?? 'end_turn';
              }
            }

            // Handle usage (some providers send this at the end)
            if (event.usage) {
              usage = {
                promptTokens: event.usage.prompt_tokens ?? 0,
                completionTokens: event.usage.completion_tokens ?? 0,
                totalTokens: event.usage.total_tokens ?? 0,
              };
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (streamError) {
      // Mid-stream error (rate limit, connection drop, etc.)
      // Preserve partial work in a PartialStreamError
      const partialToolCalls: ToolCall[] = [];
      for (const builder of toolCallBuilders.values()) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(builder.arguments);
        } catch {
          args = {};
        }
        partialToolCalls.push({
          id: builder.id,
          name: builder.name,
          arguments: args,
        });
      }

      const cause = streamError instanceof Error ? streamError : new Error(String(streamError));
      this.logger.warn('Stream interrupted mid-response', {
        method: 'stream',
        model: resolved.model,
        partialContentLength: fullContent.length,
        partialToolCalls: partialToolCalls.length,
        error: cause.message,
      });

      throw new PartialStreamError(
        'Stream interrupted',
        cause,
        fullContent,
        partialToolCalls
      );
    } finally {
      reader.releaseLock();
    }

    // Convert tool call builders to final tool calls
    for (const builder of toolCallBuilders.values()) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(builder.arguments);
      } catch {
        args = {};
      }
      toolCalls.push({
        id: builder.id,
        name: builder.name,
        arguments: args,
      });
    }

    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    }

    return {
      content: fullContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      durationMs: Date.now() - startTime,
    };
  }
}

// ============================================
// FACTORY
// ============================================

/**
 * Create an LLM adapter based on configuration.
 */
export function createAdapter(
  config: LLMClientConfig = {},
  logger?: AdapterLogger,
  providerKeyService?: ProviderKeyService
): LLMAdapter {
  return new LLMRouterAdapter(config, logger, providerKeyService);
}
