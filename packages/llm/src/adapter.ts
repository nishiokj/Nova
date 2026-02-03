/**
 * LLM Adapter - Stateless router that delegates to provider modules.
 *
 * This adapter:
 * - Resolves request config (provider, model, API key, base URL)
 * - Delegates to the appropriate provider module
 * - Returns errors directly (no retry, no fallback, no circuit breaker)
 *
 * Resilience logic (retry, fallback, circuit breaker) belongs at the
 * agent/orchestrator level where there's context to make good decisions.
 */

import type {
  LLMClientConfig,
  LLMAdapter,
  LLMResponse,
  RespondParams,
  StreamParams,
  LLMProvider,
  LLMRequestConfig,
} from 'types';
import { getProviderBaseUrl, isSupportedProvider, providerRequiresAuth, toGatewayModel } from 'types';
import { profiler } from 'shared';
import { getProvider } from './providers/registry.js';
import type { ResolvedRequestConfig, ProviderContext, AdapterLogger } from './providers/types.js';
import { PartialStreamError } from './providers/types.js';

// Re-export types and classes for external use
export type { AdapterLogger };
export { PartialStreamError };

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
 * Default base URLs for canonical providers.
 * These are fallbacks when no baseUrl is specified in config.
 * NOTE: openai-compat is intentionally excluded - providers using openai-compat
 * (cerebras, z.ai-coder, groq, etc.) MUST specify baseUrl in their config.
 */
const DEFAULT_PROVIDER_BASE_URLS: Partial<Record<LLMProvider, string>> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  'vercel-gateway': 'https://ai-gateway.vercel.sh/v1',
};

/**
 * Stateless LLM Router Adapter.
 *
 * Resolves configuration and delegates to provider modules.
 * Does NOT implement retry, fallback, or circuit breaker - those
 * belong at the orchestrator level where there's context to make
 * good decisions about error handling.
 */
class LLMRouterAdapter implements LLMAdapter {
  readonly provider?: LLMProvider;
  readonly model?: string;

  private apiKeys: Partial<Record<LLMProvider, string>>;
  private baseUrls: Partial<Record<LLMProvider, string>>;
  private logger: AdapterLogger;
  private providerKeyService?: ProviderKeyService;

  constructor(
    config: LLMClientConfig = {},
    logger?: AdapterLogger,
    providerKeyService?: ProviderKeyService
  ) {
    this.apiKeys = config.apiKeys ?? {};
    this.baseUrls = config.baseUrls ?? {};
    this.logger = logger ?? consoleLogger;
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
   * Update or add an API key for a provider at runtime.
   */
  updateApiKey(provider: LLMProvider, apiKey: string): void {
    this.apiKeys[provider] = apiKey;
    this.logger.info('Updated API key', { provider });
  }

  /**
   * Check if an API key exists for a provider.
   * Checks: 1) provider key service (dynamic), 2) stored keys (static)
   */
  hasApiKey(provider: LLMProvider): boolean {
    if (this.providerKeyService?.hasApiKey(provider)) {
      return true;
    }
    return !!this.apiKeys[provider];
  }

  /**
   * Resolve request configuration from LLMRequestConfig.
   * Returns all information needed to make a request to a provider.
   */
  private resolveRequestConfig(llm: LLMRequestConfig): ResolvedRequestConfig {
    if (!llm?.model) {
      throw new Error('LLM request missing model');
    }

    let provider = llm.provider;
    if (!provider && llm.model.includes('/')) {
      provider = 'vercel-gateway';
    }

    if (!provider) {
      throw new Error(`Provider must be specified for model '${llm.model}'`);
    }

    // displayProvider is the user-facing name (e.g., 'z.ai-coder') for error messages
    // Falls back to canonical provider if not specified
    const displayProvider = (llm as { displayProvider?: string }).displayProvider ?? provider;
    const keyProvider = provider === 'openai-compat' ? displayProvider : provider;

    let model = llm.model;
    if (provider === 'vercel-gateway' && !model.includes('/')) {
      const gatewayHint =
        displayProvider !== 'vercel-gateway' && displayProvider !== 'openai-compat'
          ? displayProvider
          : undefined;
      model = toGatewayModel(model, gatewayHint);
    }

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
    // 2. Provider key service (dynamic - from GraphD/config at runtime)
    // 3. Stored apiKeys (static - from constructor)
    let apiKey = llm.apiKey;
    let keySource = 'per-request';

    if (!apiKey && this.providerKeyService) {
      apiKey = this.providerKeyService.getApiKey(keyProvider) ?? undefined;
      if (apiKey) keySource = 'provider-service';
    }

    if (!apiKey) {
      apiKey = this.apiKeys[provider];
      if (apiKey) keySource = 'stored';
    }

    // Debug logging for API key resolution
    const keyPreview = apiKey ? `${apiKey.slice(0, 8)}...` : 'MISSING';
    this.logger.debug('Resolving request config', {
      model,
      provider,
      displayProvider,
      keyProvider,
      baseUrl,
      keySource,
      keyPreview,
      hasProviderService: !!this.providerKeyService,
      hasStoredKey: !!this.apiKeys[provider],
    });

    if (!apiKey && providerRequiresAuth(keyProvider)) {
      throw new Error(
        `API key not configured for provider '${keyProvider}'. Use /providers to add your API key.`
      );
    }

    return {
      provider,
      displayProvider,
      model,
      apiKey,
      baseUrl,
      maxTokens: llm.maxTokens,
      temperature: llm.temperature,
      reasoning: llm.reasoning,
    };
  }

  /**
   * Send a non-streaming request.
   * Delegates directly to the provider - no retry or fallback.
   */
  async respond(params: RespondParams): Promise<LLMResponse> {
    const resolved = this.resolveRequestConfig(params.llm);
    const provider = getProvider(resolved.provider);
    const context: ProviderContext = {
      config: resolved,
      logger: this.logger,
      startTime: Date.now(),
    };
    const asyncId = profiler.asyncBegin(`llm:${resolved.provider}:${resolved.model}`, 'llm');
    try {
      const response = await provider.respond(context, params);
      profiler.asyncEnd(`llm:${resolved.provider}:${resolved.model}`, asyncId, 'llm', {
        promptTokens: response.usage?.promptTokens,
        completionTokens: response.usage?.completionTokens,
      });
      return response;
    } catch (error) {
      profiler.asyncEnd(`llm:${resolved.provider}:${resolved.model}`, asyncId, 'llm', { error: true });
      throw error;
    }
  }

  /**
   * Send a streaming request.
   * Delegates directly to the provider - no retry or fallback.
   */
  async *stream(params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const resolved = this.resolveRequestConfig(params.llm);
    const provider = getProvider(resolved.provider);
    const context: ProviderContext = {
      config: resolved,
      logger: this.logger,
      startTime: Date.now(),
    };
    const asyncId = profiler.asyncBegin(`llm:stream:${resolved.provider}:${resolved.model}`, 'llm');
    try {
      const response = yield* provider.stream(context, params);
      profiler.asyncEnd(`llm:stream:${resolved.provider}:${resolved.model}`, asyncId, 'llm', {
        promptTokens: response.usage?.promptTokens,
        completionTokens: response.usage?.completionTokens,
      });
      return response;
    } catch (error) {
      profiler.asyncEnd(`llm:stream:${resolved.provider}:${resolved.model}`, asyncId, 'llm', { error: true });
      throw error;
    }
  }
}

/**
 * Create an LLM adapter.
 */
export function createAdapter(
  config: LLMClientConfig = {},
  logger?: AdapterLogger,
  providerKeyService?: ProviderKeyService
): LLMAdapter {
  return new LLMRouterAdapter(config, logger, providerKeyService);
}
