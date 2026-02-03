# Vercel AI Gateway Migration Plan

## Executive Summary

Migrate from direct provider adapters to Vercel AI Gateway, gaining unified billing, automatic fallbacks, and simplified key management while preserving the option for direct provider access.

---

## Current Architecture

### Provider Hierarchy
```
LLMRouterAdapter (packages/llm/src/adapter.ts)
    ├── anthropic.ts    → Anthropic Messages API
    ├── openai.ts       → OpenAI Responses API
    └── openai-compat.ts → OpenAI Chat Completions (cerebras, groq, z.ai, etc.)
```

### Key Resolution Flow
```
LLMRequestConfig.apiKey (per-request)
    → ProviderKeyService.getApiKey() (dynamic, from GraphD)
    → LLMRouterAdapter.apiKeys[provider] (static, from constructor)
```

### Base URL Resolution Flow
```
LLMRequestConfig.baseUrl (per-request)
    → PROVIDER_REGISTRY[displayProvider].baseUrl (for openai-compat)
    → LLMRouterAdapter.baseUrls[provider] (static config)
    → DEFAULT_PROVIDER_BASE_URLS[provider] (hardcoded defaults)
```

### Current Provider Registry (packages/types/src/providers.ts)
- **Canonical providers:** `anthropic`, `openai`, `openai-compat`
- **Named providers:** `cerebras`, `groq`, `gemini`, `z.ai-coder`, `lmstudio`, `replicate`, `claude`, `jimmy`
- Each named provider specifies `canonicalProvider` to route to adapter implementation

---

## Vercel AI Gateway Overview

### Endpoints
| API Type | Base URL | Model Format |
|----------|----------|--------------|
| OpenAI-Compatible | `https://ai-gateway.vercel.sh/v1` | `provider/model` |
| Anthropic-Compatible | `https://ai-gateway.vercel.sh` | `provider/model` |
| OpenResponses | `https://ai-gateway.vercel.sh/v1/responses` | `provider/model` |

### Authentication
- Header: `Authorization: Bearer $AI_GATEWAY_API_KEY`
- Anthropic-compat also accepts: `x-api-key: $AI_GATEWAY_API_KEY`
- Environment variable: `AI_GATEWAY_API_KEY`

### Model Naming Convention
```
{provider-slug}/{model-id}
```
Examples:
- `anthropic/claude-sonnet-4.5`
- `openai/gpt-5.2`
- `cerebras/llama-3.3-70b`
- `xai/grok-4`

### Available Provider Slugs (partial list)
`anthropic`, `openai`, `cerebras`, `groq`, `google`, `deepseek`, `mistral`, `xai`, `bedrock`, `vertex`, `cohere`, `perplexity`, `togetherai`, `fireworks`, `deepinfra`

### Key Features
1. **Unified billing** - Single invoice across all providers
2. **Automatic fallbacks** - Provider outage → automatic reroute
3. **BYOK support** - Bring your own keys with zero markup
4. **Observability** - Built-in tracing and usage monitoring
5. **Provider options** - Programmatic routing and fallback configuration

---

## Migration Strategy

### Approach: Add Gateway as New Canonical Provider

Rather than replacing existing adapters, add `vercel-gateway` as a new canonical provider that proxies all requests through Vercel's AI Gateway. This allows:
- Gradual migration (can use both direct and gateway paths)
- Fallback to direct providers if gateway has issues
- BYOK support through gateway (use existing keys)

### New Provider Type
```typescript
// packages/types/src/providers.ts
export type LLMProvider = 'anthropic' | 'openai' | 'openai-compat' | 'vercel-gateway';
```

---

## Surgical Patch Spec

### Phase 1: Add Vercel Gateway Provider Type

**File: `packages/types/src/providers.ts`**

1. Add to `LLMProvider` type:
```typescript
export type LLMProvider = 'anthropic' | 'openai' | 'openai-compat' | 'vercel-gateway';
```

2. Add to `SupportedProvider` type:
```typescript
export type SupportedProvider =
  | 'anthropic'
  | 'openai'
  | 'openai-compat'
  | 'vercel-gateway'  // NEW
  // ... rest unchanged
```

3. Add to `PROVIDER_REGISTRY`:
```typescript
'vercel-gateway': {
  id: 'vercel-gateway',
  displayName: 'Vercel AI Gateway',
  canonicalProvider: 'vercel-gateway',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  envVar: 'AI_GATEWAY_API_KEY',
  testEndpoint: 'https://ai-gateway.vercel.sh/v1/models',
  dashboardUrl: 'https://vercel.com/~/ai-gateway',
  // No models array - gateway proxies to all providers
},
```

4. Add to `PROVIDER_MODEL_DEFAULTS`:
```typescript
'vercel-gateway': {
  fast: 'anthropic/claude-sonnet-4.5',
  standard: 'anthropic/claude-sonnet-4.5',
  powerful: 'anthropic/claude-opus-4.5',
  reasoning: 'openai/gpt-5.2-codex',
},
```

---

### Phase 2: Create Vercel Gateway Adapter

**New file: `packages/llm/src/providers/vercel-gateway.ts`**

```typescript
/**
 * Vercel AI Gateway Provider
 *
 * Routes requests through Vercel's unified AI Gateway using the OpenAI-compatible API.
 * Model format: "provider/model" (e.g., "anthropic/claude-sonnet-4.5")
 */

import type { LLMProviderAdapter, ProviderContext, ResolvedRequestConfig } from './types.js';
import type { LLMResponse, Message, ToolDefinition, RespondParams, StreamParams } from 'types';

// Reuse OpenAI-compat implementation since Gateway exposes OpenAI-compatible API
import { formatMessagesForOpenAI, formatToolsForOpenAI, parseOpenAIResponse, parseOpenAIStream } from './openai-compat.js';

const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

export const vercelGatewayProvider: LLMProviderAdapter = {
  name: 'vercel-gateway',

  async respond(context: ProviderContext, params: RespondParams): Promise<LLMResponse> {
    const { config, logger, startTime } = context;

    // Gateway uses OpenAI-compatible Chat Completions API
    const url = `${config.baseUrl || GATEWAY_BASE_URL}/chat/completions`;

    const body = buildRequestBody(config, params);

    logger.debug('Vercel Gateway request', {
      url,
      model: config.model,
      hasTools: !!params.tools?.length
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Vercel Gateway error (${response.status}): ${error}`);
    }

    const data = await response.json();
    return parseOpenAIResponse(data, config.model, startTime);
  },

  async *stream(context: ProviderContext, params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const { config, logger, startTime } = context;

    const url = `${config.baseUrl || GATEWAY_BASE_URL}/chat/completions`;
    const body = buildRequestBody(config, params, true);

    logger.debug('Vercel Gateway stream request', { url, model: config.model });

    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Vercel Gateway error (${response.status}): ${error}`);
    }

    // Reuse OpenAI-compat stream parsing
    return yield* parseOpenAIStream(response, config.model, startTime, logger);
  },

  formatTools: formatToolsForOpenAI,
  formatMessages: formatMessagesForOpenAI,
};

function buildHeaders(config: ResolvedRequestConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  return headers;
}

function buildRequestBody(
  config: ResolvedRequestConfig,
  params: RespondParams | StreamParams,
  stream = false
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,  // Already in "provider/model" format
    messages: formatMessagesForOpenAI(params.messages),
    stream,
  };

  if (config.maxTokens) body.max_tokens = config.maxTokens;
  if (config.temperature !== undefined) body.temperature = config.temperature;

  if (params.tools?.length) {
    body.tools = formatToolsForOpenAI(params.tools);
    body.tool_choice = 'auto';
  }

  // Handle response schema (structured outputs)
  if ('responseSchema' in params && params.responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: params.responseSchema.name,
        schema: params.responseSchema.schema,
        strict: params.responseSchema.strict ?? true,
      },
    };
  }

  // Handle reasoning/thinking (provider-specific options)
  if (config.reasoning) {
    // Gateway passes through provider options
    // For OpenAI models: reasoningEffort
    // For Anthropic models: thinking config
    body.provider_options = buildProviderOptions(config);
  }

  return body;
}

function buildProviderOptions(config: ResolvedRequestConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  // Extract provider from model string (e.g., "anthropic/claude-sonnet-4.5" -> "anthropic")
  const [provider] = config.model.split('/');

  if (config.reasoning) {
    if (provider === 'openai') {
      options.openai = {
        reasoningEffort: config.reasoning.effort || 'medium',
        reasoningSummary: 'detailed',
      };
    } else if (provider === 'anthropic') {
      options.anthropic = {
        thinking: config.reasoning.enabled ? { enabled: true } : undefined,
      };
    }
  }

  return options;
}

export default vercelGatewayProvider;
```

---

### Phase 3: Register Gateway Provider

**File: `packages/llm/src/providers/registry.ts`**

Add import and registration:

```typescript
import { vercelGatewayProvider } from './vercel-gateway.js';

const PROVIDERS: Record<LLMProvider, LLMProviderAdapter> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  'openai-compat': openaiCompatProvider,
  'vercel-gateway': vercelGatewayProvider,  // NEW
};
```

---

### Phase 4: Update Adapter for Gateway Model Format

**File: `packages/llm/src/adapter.ts`**

The gateway uses `provider/model` format. Add helper to detect and handle this:

```typescript
// In resolveRequestConfig()

// Check if model is in gateway format (provider/model)
const isGatewayFormat = llm.model.includes('/');
if (isGatewayFormat && !llm.provider) {
  // Auto-detect vercel-gateway provider for gateway-format models
  llm.provider = 'vercel-gateway';
}
```

---

### Phase 5: Add Gateway Model Mapping

**File: `packages/types/src/providers.ts`**

Add helper to convert existing models to gateway format:

```typescript
/**
 * Convert a model ID to Vercel Gateway format.
 * @example toGatewayModel('claude-sonnet-4.5') => 'anthropic/claude-sonnet-4.5'
 * @example toGatewayModel('llama-3.3-70b', 'cerebras') => 'cerebras/llama-3.3-70b'
 */
export function toGatewayModel(modelId: string, provider?: string): string {
  // If already in gateway format, return as-is
  if (modelId.includes('/')) return modelId;

  // Look up provider from registry
  const providerSlug = provider || getProviderForModel(modelId);
  if (!providerSlug) {
    throw new Error(`Cannot determine provider for model '${modelId}'`);
  }

  // Map our provider names to Vercel Gateway slugs
  const gatewaySlug = PROVIDER_TO_GATEWAY_SLUG[providerSlug] || providerSlug;
  return `${gatewaySlug}/${modelId}`;
}

/**
 * Map our provider IDs to Vercel Gateway slugs.
 * Most match, but some need translation.
 */
const PROVIDER_TO_GATEWAY_SLUG: Partial<Record<SupportedProvider, string>> = {
  'z.ai-coder': 'zai',
  'gemini': 'google',
  // Others match: anthropic, openai, cerebras, groq, etc.
};
```

---

### Phase 6: Configuration Support

**File: `config/defaults.json`**

Add gateway configuration:

```json
{
  "gateway": {
    "enabled": false,
    "provider": "vercel-gateway",
    "fallback_to_direct": true,
    "byok": {}
  }
}
```

**File: `packages/types/src/config.ts`**

Add gateway config types:

```typescript
export interface GatewayConfig {
  /** Enable routing through Vercel AI Gateway */
  enabled: boolean;
  /** Provider ID (default: 'vercel-gateway') */
  provider?: string;
  /** Fall back to direct provider access if gateway fails */
  fallback_to_direct?: boolean;
  /** BYOK credentials for specific providers */
  byok?: Record<string, { apiKey: string }>;
  /** Provider routing order */
  provider_order?: string[];
  /** Restrict to specific providers */
  only_providers?: string[];
}
```

---

### Phase 7: Environment Variables

Add support for gateway API key:

```bash
# .env.example
AI_GATEWAY_API_KEY=your_vercel_ai_gateway_key
```

**File: `packages/harness-daemon/src/harness/local_providers.ts`**

Add gateway to provider list:

```typescript
// In LocalProviderManager
const GATEWAY_ENV_VAR = 'AI_GATEWAY_API_KEY';

getApiKey(provider: string): string | null {
  // Check for gateway key first if gateway is enabled
  if (provider === 'vercel-gateway') {
    return process.env.AI_GATEWAY_API_KEY || this.loadFromStorage(provider);
  }
  // ... existing logic
}
```

---

## Implementation Order

1. **Phase 1**: Add types (no behavior change)
2. **Phase 2**: Create adapter (unused until registered)
3. **Phase 3**: Register adapter (now callable)
4. **Phase 4**: Update model resolution (auto-detect gateway format)
5. **Phase 5**: Add model mapping helpers
6. **Phase 6**: Configuration support
7. **Phase 7**: Environment variable support

---

## Testing Strategy

### Unit Tests
```typescript
// packages/llm/src/providers/vercel-gateway.test.ts
describe('VercelGatewayProvider', () => {
  it('formats model in provider/model format', () => {
    expect(toGatewayModel('claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
  });

  it('passes through already-formatted models', () => {
    expect(toGatewayModel('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
  });

  it('maps provider slugs correctly', () => {
    expect(toGatewayModel('glm-4.7', 'z.ai-coder')).toBe('zai/glm-4.7');
  });
});
```

### Integration Tests
- Test gateway request/response cycle with mock server
- Test streaming with gateway
- Test tool calls through gateway
- Test fallback behavior when gateway is unavailable

---

## Rollout Plan

### Stage 1: Opt-in (default off)
- Gateway disabled by default
- Users can enable via config: `"gateway": { "enabled": true }`
- Existing direct provider access unchanged

### Stage 2: Default on, opt-out available
- Gateway enabled by default for new installations
- Users can disable via config: `"gateway": { "enabled": false }`
- Direct providers still available

### Stage 3: Gateway primary (future)
- Gateway is primary path
- Direct providers available as fallback
- Consider deprecating individual provider adapters

---

## Migration Path for Existing Users

1. **No action required initially** - Existing configs continue to work
2. **To use gateway**:
   - Add `AI_GATEWAY_API_KEY` to environment
   - Enable in config or use gateway-format models directly
3. **BYOK through gateway**:
   - Keep existing provider keys
   - Configure BYOK in gateway config

---

## Benefits

1. **Simplified key management** - One key for all providers
2. **Unified billing** - Single invoice
3. **Automatic failover** - Provider outages handled transparently
4. **Cost savings** - No markup on tokens
5. **Observability** - Built-in tracing
6. **Future-proof** - New providers available automatically

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Gateway outage | `fallback_to_direct: true` config |
| Latency increase | Gateway adds ~10-50ms; monitor performance |
| Feature parity | Some provider-specific features may not be supported |
| Vendor lock-in | Direct providers remain available |

---

## Files to Modify

| File | Changes |
|------|---------|
| `packages/types/src/providers.ts` | Add `vercel-gateway` type and registry entry |
| `packages/llm/src/providers/vercel-gateway.ts` | **NEW** - Gateway adapter implementation |
| `packages/llm/src/providers/registry.ts` | Register gateway provider |
| `packages/llm/src/adapter.ts` | Auto-detect gateway format models |
| `packages/types/src/config.ts` | Add `GatewayConfig` type |
| `config/defaults.json` | Add gateway config section |
| `packages/harness-daemon/src/harness/local_providers.ts` | Support gateway API key |

---

## Sources

- [Vercel AI Gateway Documentation](https://vercel.com/docs/ai-gateway)
- [OpenAI-Compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-compat)
- [Anthropic-Compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-compat)
- [Provider Options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)
- [Getting Started Guide](https://vercel.com/docs/ai-gateway/getting-started)
