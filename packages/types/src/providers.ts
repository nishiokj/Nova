/**
 * Central provider registry - single source of truth for all LLM providers.
 *
 * This file defines all supported providers, their configurations, and helper
 * functions for working with providers. All other files should import from here.
 */

// ============================================
// TYPES
// ============================================

/**
 * Canonical LLM provider types (what the adapter routes to).
 * These are the actual SDK/API implementations.
 */
export type LLMProvider = 'anthropic' | 'openai' | 'openai-compat';

/**
 * All supported provider names that can appear in configuration.
 * Includes both canonical providers and named providers that route to openai-compat.
 */
export type SupportedProvider =
  | 'anthropic'
  | 'openai'
  | 'openai-compat'
  | 'cerebras'
  | 'groq'
  | 'gemini'
  | 'z.ai-coder'
  | 'lmstudio'
  | 'replicate';

/**
 * Provider definition containing all metadata about a provider.
 */
export interface ProviderDefinition {
  /** Unique provider identifier (used in config) */
  id: SupportedProvider;
  /** Human-readable display name */
  displayName: string;
  /** The canonical provider to route to (adapter implementation) */
  canonicalProvider: LLMProvider;
  /** Base URL for API calls (optional for canonical providers with SDK defaults) */
  baseUrl?: string;
  /** Known models for this provider (optional) */
  models?: ProviderModelDefinition[];
  /** Structured output response format for openai-compat providers */
  responseFormat?: ProviderResponseFormat;
  /** Environment variable name for API key */
  envVar?: string;
  /** Whether this provider requires authentication (defaults to true) */
  authRequired?: boolean;
  /** Endpoint for testing API key validity */
  testEndpoint?: string;
  /** HTTP method for test endpoint (defaults to GET) */
  testMethod?: 'GET' | 'POST';
  /** Test request body (for POST requests) */
  testBody?: Record<string, unknown>;
  /** Test request headers (additional to Authorization) */
  testHeaders?: Record<string, string>;
  /** URL to provider's API billing/usage dashboard */
  dashboardUrl?: string;
}

/**
 * Reasoning level options for models that support reasoning.
 * If undefined, the model does not support reasoning.
 * If defined, specifies available reasoning levels.
 */
export type ReasoningOptions = string[];

/**
 * Role-based model selection for provider-first configs.
 */
export type ModelRole = 'fast' | 'standard' | 'powerful' | 'reasoning';

/**
 * Model definition for a provider.
 * Uses the same shape as config models entries (snake_case).
 */
export interface ProviderModelDefinition {
  id: string;
  name: string;
  description?: string;
  max_tokens?: number;
  /**
   * Context window size in tokens.
   * This is the maximum number of tokens the model can process in a single request.
   */
  context_window?: number;
  /**
   * Available reasoning levels for this model.
   * - undefined: model does not support reasoning
   * - ['on', 'off']: simple on/off reasoning (e.g., Claude extended thinking, GLM thinking)
   * - ['low', 'medium', 'high']: OpenAI-style reasoning effort levels
   */
  reasoning?: ReasoningOptions;
}

/**
 * Model definition with provider id included.
 */
export interface ProviderModelEntry extends ProviderModelDefinition {
  provider: SupportedProvider;
}

export type ProviderResponseFormat = 'json_schema' | 'json_object' | 'none';

/**
 * Provider defaults for each model role.
 * Keys are SupportedProvider ids; values are optional per-role model ids.
 * Used by resolveModelForRole() to find an appropriate model when agents
 * specify only a role (fast, standard, powerful, reasoning).
 */
export const PROVIDER_MODEL_DEFAULTS: Partial<
  Record<SupportedProvider, Partial<Record<ModelRole, string>>>
> = {
  anthropic: {
    fast: 'claude-sonnet-4.5',
    standard: 'claude-sonnet-4.5',
    powerful: 'claude-opus-4.5',
    reasoning: 'claude-opus-4.5',
  },
  openai: {
    fast: 'gpt-5-nano',
    standard: 'gpt-5-mini',
    powerful: 'gpt-5.2',
    reasoning: 'gpt-5.2-codex',
  },
  cerebras: {
    fast: 'llama-3.3-70b',
    standard: 'llama-3.3-70b',
  },
  groq: {
    fast: 'llama-3.3-70b-versatile',
    standard: 'llama-3.3-70b-versatile',
  },
  gemini: {
    fast: 'gemini-3.0-flash',
    standard: 'gemini-3.0-flash',
    powerful: 'gemini-3.0-pro',
  },
  'z.ai-coder': {
    fast: 'glm-4.7',
    standard: 'glm-4.7',
  },
};

// ============================================
// PROVIDER REGISTRY
// ============================================

/**
 * Central registry of all supported providers.
 * This is the SINGLE SOURCE OF TRUTH for provider configuration.
 */
export const PROVIDER_REGISTRY: Record<SupportedProvider, ProviderDefinition> = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic (Claude)',
    canonicalProvider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context_window: 200_000, reasoning: ['on', 'off'] },
      { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', context_window: 200_000, reasoning: ['on', 'off'] },
    ],
    envVar: 'ANTHROPIC_API_KEY',
    testEndpoint: 'https://api.anthropic.com/v1/messages',
    testMethod: 'POST',
    testHeaders: { 'anthropic-version': '2023-06-01' },
    testBody: {
      model: 'claude-3-haiku-20240307',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    },
    dashboardUrl: 'https://console.anthropic.com/settings/billing',
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    canonicalProvider: 'openai',
    baseUrl: 'https://api.openai.com',
    models: [
      { id: 'gpt-5.2', name: 'gpt-5.2', context_window: 256_000, reasoning: ['low', 'medium', 'high'] },
      { id: 'gpt-5-mini', name: 'gpt-5-mini', context_window: 128_000, reasoning: ['low', 'medium', 'high'] },
      { id: 'gpt-5-nano', name: 'gpt-5-nano', context_window: 128_000 },
      { id: 'gpt-5.2-codex', name: 'gpt-5.2-codex', context_window: 256_000, reasoning: ['low', 'medium', 'high'] },
    ],
    envVar: 'OPENAI_API_KEY',
    testEndpoint: 'https://api.openai.com/v1/models',
    dashboardUrl: 'https://platform.openai.com/settings/organization/billing/overview',
  },
  'openai-compat': {
    id: 'openai-compat',
    displayName: 'OpenAI Compatible',
    canonicalProvider: 'openai-compat',
    baseUrl: 'https://api.openai.com',
    envVar: 'OPENAI_COMPAT_API_KEY',
    testEndpoint: 'https://api.openai.com/v1/models',
  },
  cerebras: {
    id: 'cerebras',
    displayName: 'Cerebras',
    canonicalProvider: 'openai-compat',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', context_window: 128_000, description: 'Fast inference on Cerebras' },
    ],
    envVar: 'CEREBRAS_API_KEY',
    testEndpoint: 'https://api.cerebras.ai/v1/models',
    dashboardUrl: 'https://cloud.cerebras.ai/',
  },
  groq: {
    id: 'groq',
    displayName: 'Groq',
    canonicalProvider: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      {
        id: 'llama-3.3-70b-versatile',
        name: 'Llama 3.3 70B',
        context_window: 128_000,
        description: 'Ultra-fast inference on Groq',
      },
    ],
    envVar: 'GROQ_API_KEY',
    testEndpoint: 'https://api.groq.com/openai/v1/models',
    dashboardUrl: 'https://console.groq.com/settings/billing',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini',
    canonicalProvider: 'openai-compat',
    models: [
      { id: 'gemini-3.0-flash', name: 'Gemini 3.0 Flash', context_window: 1_000_000, description: 'Fast Gemini model' },
      { id: 'gemini-3.0-pro', name: 'Gemini 3.0 Pro', context_window: 2_000_000 },
    ],
    envVar: 'GOOGLE_API_KEY',
    // Gemini uses query param auth, not header
    testEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    dashboardUrl: 'https://aistudio.google.com/app/apikey',
  },
  'z.ai-coder': {
    id: 'z.ai-coder',
    displayName: 'Z.AI Coder',
    canonicalProvider: 'openai-compat',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    responseFormat: 'json_object',
    models: [
      {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        context_window: 128_000,
        description: 'Z.AI coding model with interleaved thinking',
        reasoning: ['on', 'off'],
      },
      {  
        id: 'glm-4.7-flashx',
        name: 'GLM-4.7-FlashX',
        context_window: 128_000,
        description: 'Fast Z.AI coding model with interleaved thinking',
        reasoning: ['on', 'off'],
      },
    ],
    envVar: 'ZAI_CODER_API_KEY',
    testEndpoint: 'https://api.z.ai/api/coding/paas/v4/models',
    dashboardUrl: 'https://open.bigmodel.cn/finance-center/bill/recharge-details',
  },
  lmstudio: {
    id: 'lmstudio',
    displayName: 'LM Studio',
    canonicalProvider: 'openai-compat',
    baseUrl: 'http://localhost:1234/v1',
    responseFormat: 'none',
    models: [
      {
        id: 'zai-org/glm-4.7-flash',
        name: 'GLM-4.7 Flash',
        context_window: 32000,
        reasoning: ['on', 'off'],
      },
    ],
    authRequired: false,
    testEndpoint: 'http://localhost:1234/v1/models',
  },
  replicate: {
    id: 'replicate',
    displayName: 'Replicate',
    canonicalProvider: 'openai-compat',
    baseUrl: 'https://api.replicate.com/v1',
    envVar: 'REPLICATE_API_TOKEN',
    testEndpoint: 'https://api.replicate.com/v1/models',
    dashboardUrl: 'https://replicate.com/account/api-tokens',
  },
};

/**
 * Set of providers that route to openai-compat adapter.
 * Derived from PROVIDER_REGISTRY for backwards compatibility.
 */
export const OPENAI_COMPAT_PROVIDERS = new Set<string>(
  Object.values(PROVIDER_REGISTRY)
    .filter((p) => p.canonicalProvider === 'openai-compat')
    .map((p) => p.id)
);

/**
 * List of all supported provider IDs.
 */
export const SUPPORTED_PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY) as SupportedProvider[];

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Check if a provider string is a supported provider.
 */
export function isSupportedProvider(provider: string): provider is SupportedProvider {
  return provider in PROVIDER_REGISTRY;
}

/**
 * Check if a provider routes to the openai-compat adapter.
 */
export function isOpenAICompatProvider(provider: string): boolean {
  return OPENAI_COMPAT_PROVIDERS.has(provider);
}

/**
 * Get the canonical provider (adapter) for a given provider.
 * Returns 'openai-compat' for unknown providers.
 */
export function getCanonicalProvider(provider: string): LLMProvider {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider].canonicalProvider;
  }
  return 'openai-compat';
}

/**
 * Get the base URL for a provider.
 * Returns undefined if no base URL is configured.
 */
export function getProviderBaseUrl(provider: string): string | undefined {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider].baseUrl;
  }
  return undefined;
}

/**
 * Get the environment variable name for a provider's API key.
 * Falls back to ${PROVIDER}_API_KEY for unknown providers.
 */
export function getProviderEnvVar(provider: string): string {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider].envVar ?? `${provider.toUpperCase()}_API_KEY`;
  }
  return `${provider.toUpperCase()}_API_KEY`;
}

/**
 * Get the display name for a provider.
 * Falls back to the provider ID if not found.
 */
export function getProviderDisplayName(provider: string): string {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider].displayName;
  }
  return provider;
}

/**
 * Get the test endpoint for a provider.
 * Returns undefined if no test endpoint is configured.
 */
export function getProviderTestEndpoint(provider: string): string | undefined {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider].testEndpoint;
  }
  return undefined;
}

/**
 * Get the billing/usage dashboard URL for a provider.
 * Returns undefined if no dashboard URL is configured.
 */
export function getProviderDashboardUrl(provider: string): string | undefined {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider].dashboardUrl;
  }
  return undefined;
}

/**
 * Get the response format for a provider (defaults to json_schema).
 */
export function getProviderResponseFormat(provider: string): ProviderResponseFormat {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider].responseFormat ?? 'json_schema';
  }
  return 'json_schema';
}

/**
 * Check if a provider requires authentication.
 * Defaults to true for unknown providers.
 */
export function providerRequiresAuth(provider: string): boolean {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider].authRequired !== false;
  }
  return true;
}

/**
 * Get the full provider definition for a provider.
 * Returns undefined for unknown providers.
 */
export function getProviderDefinition(provider: string): ProviderDefinition | undefined {
  if (isSupportedProvider(provider)) {
    return PROVIDER_REGISTRY[provider];
  }
  return undefined;
}

/**
 * Get all provider definitions as an array.
 * Useful for iterating over providers in UI components.
 */
export function getAllProviders(): ProviderDefinition[] {
  return Object.values(PROVIDER_REGISTRY);
}

/**
 * Get provider definitions for a specific canonical provider.
 * Useful for finding all providers that use a specific adapter.
 */
export function getProvidersByCanonical(canonical: LLMProvider): ProviderDefinition[] {
  return Object.values(PROVIDER_REGISTRY).filter((p) => p.canonicalProvider === canonical);
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Get all models across providers.
 */
export function getAllModels(): ProviderModelEntry[] {
  const models: ProviderModelEntry[] = [];
  for (const [provider, definition] of Object.entries(PROVIDER_REGISTRY)) {
    const entries = definition.models ?? [];
    for (const model of entries) {
      models.push({ ...model, provider: provider as SupportedProvider });
    }
  }
  return models;
}

/**
 * Get models for a specific provider.
 */
export function getProviderModels(provider: SupportedProvider): ProviderModelDefinition[] {
  return PROVIDER_REGISTRY[provider]?.models ?? [];
}

/**
 * Get provider for a given model id (case-insensitive).
 */
export function getProviderForModel(modelId: string): SupportedProvider | undefined {
  const normalized = normalizeModelId(modelId);
  for (const [provider, definition] of Object.entries(PROVIDER_REGISTRY)) {
    const entries = definition.models ?? [];
    for (const model of entries) {
      if (normalizeModelId(model.id) === normalized) {
        return provider as SupportedProvider;
      }
    }
  }
  return undefined;
}

/**
 * Get the full model entry including provider (case-insensitive).
 */
export function getModelDefinition(modelId: string): ProviderModelEntry | undefined {
  const normalized = normalizeModelId(modelId);
  for (const [provider, definition] of Object.entries(PROVIDER_REGISTRY)) {
    const entries = definition.models ?? [];
    for (const model of entries) {
      if (normalizeModelId(model.id) === normalized) {
        return { ...model, provider: provider as SupportedProvider };
      }
    }
  }
  return undefined;
}

/**
 * Get reasoning options for a model.
 * Returns undefined if the model doesn't support reasoning.
 */
export function getModelReasoningOptions(modelId: string): ReasoningOptions | undefined {
  const model = getModelDefinition(modelId);
  return model?.reasoning;
}

/**
 * Check if a model supports reasoning.
 */
export function modelSupportsReasoning(modelId: string): boolean {
  const options = getModelReasoningOptions(modelId);
  return options !== undefined && options.length > 0;
}

/** Default context window size when model doesn't specify one */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Get the context window size for a model.
 * Falls back to DEFAULT_CONTEXT_WINDOW if not specified.
 */
export function getModelContextWindow(modelId: string): number {
  const model = getModelDefinition(modelId);
  return model?.context_window ?? DEFAULT_CONTEXT_WINDOW;
}
