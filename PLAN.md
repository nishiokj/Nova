# LLM Adapter Completions Endpoint Plan

## Current State Analysis

### Architecture
The adapter currently has:
- **Router pattern**: `LLMRouterAdapter` routes requests to provider-specific methods
- **Model registry**: Maps model names → `{ provider, baseUrl }`
- **Two provider implementations**:
  - Anthropic: `/v1/messages`
  - OpenAI: `/v1/responses` (Responses API, NOT Chat Completions)

### The Problem
The OpenAI implementation uses the **Responses API** (`/v1/responses`) which is:
- Specific to OpenAI's newer API
- Not compatible with standard OpenAI-compatible providers
- Uses different request/response schemas (e.g., `input` vs `messages`, `output` vs `choices`)

Most third-party providers (OpenRouter, DeepInfra, Cerebras, GLM 4.7, Together AI) implement the **Chat Completions API** (`/v1/chat/completions`) which uses:
- `messages` array (not `input`)
- `choices[].message.content` (not `output`)
- Different tool calling format

### GLM 4.7 API Reference
- **Endpoint**: `https://api.z.ai/api/paas/v4/chat/completions` (or via OpenRouter/DeepInfra)
- **Format**: Standard OpenAI Chat Completions compatible
- **Key params**: `model`, `messages`, `temperature`, `max_tokens`, `stream`, `tools`, `tool_choice`
- **Response**: Standard `choices` array with `message.content`, `finish_reason`, `usage`
- **Special feature**: `thinking` parameter for chain-of-thought (`{"type": "enabled"}`)

---

## Proposed Solution: Add `openai-compat` Provider

Add a third provider type that uses the standard Chat Completions API format. This is the minimal, surgical change that:
1. Doesn't break existing OpenAI Responses API functionality
2. Provides a generic endpoint for all OpenAI-compatible providers
3. Keeps provider-specific config (base URL, headers) in the existing config system

### Type Changes (`llm.ts`)

```typescript
// Change LLMProvider to include the new type
export type LLMProvider = 'anthropic' | 'openai' | 'openai-compat';
```

### Adapter Changes (`adapter.ts`)

1. **Add to model registry defaults** (line ~113-121):
```typescript
// Add GLM and other compat models
'glm-4.7': { provider: 'openai-compat', baseUrl: 'https://api.z.ai/api/paas/v4' },
'glm-4.6': { provider: 'openai-compat', baseUrl: 'https://api.z.ai/api/paas/v4' },
```

2. **Add provider base URL** (line ~106-109):
```typescript
const DEFAULT_PROVIDER_BASE_URLS: Record<LLMProvider, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  'openai-compat': 'https://api.openai.com',  // Fallback, usually overridden per-model
};
```

3. **Route to new methods** (add to `respond` at line ~280-288):
```typescript
case 'openai-compat':
  return this.respondOpenAICompat(params, resolved);
```

4. **Add Chat Completions implementation** (~150-200 lines):
```typescript
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
  messages: Message[]
): Array<{ role: string; content: string | unknown[] }> {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    // Handle tool_use/tool_result blocks
    // Convert to OpenAI function_call format
    // ...
  });
}

private async respondOpenAICompat(
  params: RespondParams,
  resolved: ResolvedRequestConfig
): Promise<LLMResponse> {
  const startTime = Date.now();

  const body: Record<string, unknown> = {
    model: resolved.model,
    messages: this.formatOpenAICompatMessages(params.messages),
    max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
  };

  if (params.temperature ?? resolved.temperature) {
    body.temperature = params.temperature ?? resolved.temperature;
  }

  if (params.tools?.length > 0) {
    body.tools = this.formatOpenAICompatTools(params.tools);
    body.tool_choice = 'auto';
  }

  // System message handling (some providers want it in messages, some separate)
  const systemMsg = params.messages.find(m => m.role === 'system');
  // ...

  const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  // Parse standard Chat Completions response
  // choices[0].message.content, choices[0].finish_reason, usage
  // ...
}
```

---

## API Schema: Chat Completions (Standard)

### Request
```typescript
interface ChatCompletionsRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | ContentPart[];
    tool_calls?: ToolCall[];      // For assistant messages
    tool_call_id?: string;        // For tool messages
  }>;
  max_tokens?: number;
  temperature?: number;           // 0.0 - 2.0
  top_p?: number;                 // 0.0 - 1.0
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: JSONSchema;
    };
  }>;
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' };
}
```

### Response
```typescript
interface ChatCompletionsResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;  // JSON string
        };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

---

## Implementation Tasks

### Phase 1: Core Implementation
1. [ ] Add `'openai-compat'` to `LLMProvider` type in `llm.ts`
2. [ ] Add default base URL for `openai-compat` provider
3. [ ] Add `formatOpenAICompatTools()` method
4. [ ] Add `formatOpenAICompatMessages()` method
5. [ ] Add `respondOpenAICompat()` method
6. [ ] Add `streamOpenAICompat()` method
7. [ ] Update `respond()` and `stream()` routing

### Phase 2: Model Registration
8. [ ] Add GLM 4.7 to default model registry
9. [ ] Test with GLM 4.7 via Z.AI endpoint

### Phase 3: Validation
10. [ ] Test with OpenRouter endpoint
11. [ ] Test with DeepInfra endpoint
12. [ ] Verify tool calling works correctly

---

## Provider Configuration Examples

```typescript
// GLM 4.7 via official Z.AI
const adapter = createAdapter({
  apiKeys: { 'openai-compat': 'your-zai-key' },
  modelRegistry: {
    'glm-4.7': { provider: 'openai-compat', baseUrl: 'https://api.z.ai/api/paas/v4' },
  },
});

// GLM 4.7 via OpenRouter
const adapter = createAdapter({
  apiKeys: { 'openai-compat': 'your-openrouter-key' },
  modelRegistry: {
    'z-ai/glm-4.7': { provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' },
  },
});

// Cerebras
const adapter = createAdapter({
  apiKeys: { 'openai-compat': 'your-cerebras-key' },
  modelRegistry: {
    'llama3.1-70b': { provider: 'openai-compat', baseUrl: 'https://api.cerebras.ai/v1' },
  },
});
```

---

## Code Smells to Address (Cleanup)

While implementing, consider these minor cleanups:

1. **Line 153-166**: `isReasoningModel()` and `supportsSamplingParams()` are OpenAI-specific but not scoped. Could move into OpenAI section or make provider-aware.

2. **Line 610-672**: `normalizeInput()` is Responses API-specific. The new Chat Completions path needs its own cleaner message formatter.

3. **Line 56-100**: `parseApiError()` is good but could use provider-specific error type extraction for `openai-compat` providers.

---

## Full Integration Wiring

### Configuration Lifecycle

```
harness_config.json
       │
       ▼
config_loader.ts::loadConfig()
       │
       ▼
config_loader.ts::createConfigFromFile()
       │
       ├─► resolveAgentConfig() for each agent
       │       │
       │       ├─► isSupportedProvider() validation
       │       ├─► resolveApiKey() from env
       │       └─► ResolvedAgentConfig with llm.provider, llm.baseUrl
       │
       ▼
FullHarnessConfig
       │
       ▼
harness.ts::AgentHarness constructor
       │
       ├─► Build apiKeys map: { provider: apiKey }
       ├─► Build baseUrls map: { provider: baseUrl }
       ├─► createAdapter(llmClientConfig) → LLMRouterAdapter
       └─► registerModel() for each agent's model
              │
              ▼
       ModelRegistry maps model → { provider, baseUrl }
```

### Files to Modify

| File | Location | Changes |
|------|----------|---------|
| `packages/agent-core/src/types/llm.ts` | Line 128 | Add `'openai-compat'` to `LLMProvider` type |
| `apps/harness-daemon/src/harness/config_types.ts` | Line 20 | Add `'openai-compat'` to `LLMProvider` type |
| `apps/harness-daemon/src/harness/config_loader.ts` | Line 240-244 | Add `'openai-compat': 'OPENAI_COMPAT_API_KEY'` to `API_KEY_ENV_MAP` |
| `apps/harness-daemon/src/harness/config_loader.ts` | Line 277-278 | Update `isSupportedProvider()` to include `'openai-compat'` |
| `packages/agent-core/src/llm/adapter.ts` | Line 106-109 | Add `'openai-compat'` default base URL |
| `packages/agent-core/src/llm/adapter.ts` | Line 280-288 | Route `'openai-compat'` to new methods |
| `packages/agent-core/src/llm/adapter.ts` | New section | Add Chat Completions implementation |

### Config File Changes

Add to `config/harness_config.json`:

```json
{
  "agents": {
    "glm-agent": {
      "llm": {
        "provider": "openai-compat",
        "model": "glm-4.7",
        "max_tokens": 16000,
        "temperature": 0.7,
        "api_base": "https://api.z.ai/api/paas/v4"
      },
      "budget": {
        "max_iterations": 10,
        "max_tool_calls": 50,
        "max_duration_ms": 120000
      },
      "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]
    }
  }
}
```

### Environment Variables

```bash
# For OpenAI-compatible providers, set this env var
export OPENAI_COMPAT_API_KEY="your-api-key"

# Or use provider-specific aliases (e.g., for Z.AI)
export ZAI_API_KEY="your-zai-key"  # if we add this mapping
```

### API Key Resolution Flow

```
config_loader.ts::resolveApiKey(provider)
       │
       ▼
API_KEY_ENV_MAP lookup
       │
       ├─► 'anthropic' → ANTHROPIC_API_KEY
       ├─► 'openai'    → OPENAI_API_KEY
       └─► 'openai-compat' → OPENAI_COMPAT_API_KEY (new)

       │
       ▼
process.env[envVar]
```

### Base URL Flow

```
harness_config.json
  agents.glm-agent.llm.api_base = "https://api.z.ai/api/paas/v4"
       │
       ▼
config_loader.ts::resolveAgentConfig()
  llm.baseUrl = entry.llm.api_base
       │
       ▼
harness.ts::constructor
  baseUrls[agent.llm.provider] = agent.llm.baseUrl
       │
       ▼
createAdapter({ baseUrls })
       │
       ▼
LLMRouterAdapter::resolveRequestConfig()
  baseUrl = llm.baseUrl ?? registryEntry?.baseUrl ?? this.baseUrls[provider] ?? DEFAULT
       │
       ▼
fetch(`${baseUrl}/chat/completions`)
```

---

## Brutal Integration Tests

These tests verify the full stack from config file through to actual LLM calls.

### Test File: `packages/agent-core/src/llm/__tests__/adapter.integration.test.ts`

```typescript
/**
 * BRUTAL Integration Tests for LLM Adapter
 *
 * These tests hit real APIs and verify the full wiring stack.
 * Skip in CI unless API keys are available.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createAdapter, type AdapterLogger } from '../adapter.js';
import type { LLMClientConfig, Message } from '../../types/llm.js';

const SKIP_INTEGRATION = !process.env.RUN_INTEGRATION_TESTS;

// Silent logger for tests
const silentLogger: AdapterLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: console.error,
};

describe.skipIf(SKIP_INTEGRATION)('Adapter Integration - OpenAI Compat', () => {

  describe('GLM 4.7 via Z.AI Direct', () => {
    const apiKey = process.env.ZAI_API_KEY ?? process.env.OPENAI_COMPAT_API_KEY;

    beforeAll(() => {
      if (!apiKey) throw new Error('ZAI_API_KEY or OPENAI_COMPAT_API_KEY required');
    });

    it('should complete a simple prompt', async () => {
      const adapter = createAdapter({
        apiKeys: { 'openai-compat': apiKey! },
        modelRegistry: {
          'glm-4.7': {
            provider: 'openai-compat',
            baseUrl: 'https://api.z.ai/api/paas/v4'
          },
        },
      }, silentLogger);

      const messages: Message[] = [
        { role: 'user', content: 'Say "hello" and nothing else.' },
      ];

      const response = await adapter.respond({
        messages,
        llm: { model: 'glm-4.7' },
        maxTokens: 50,
      });

      expect(response.content.toLowerCase()).toContain('hello');
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage.totalTokens).toBeGreaterThan(0);
      expect(response.model).toContain('glm');
    });

    it('should handle tool calls', async () => {
      const adapter = createAdapter({
        apiKeys: { 'openai-compat': apiKey! },
        modelRegistry: {
          'glm-4.7': {
            provider: 'openai-compat',
            baseUrl: 'https://api.z.ai/api/paas/v4'
          },
        },
      }, silentLogger);

      const messages: Message[] = [
        { role: 'user', content: 'What is 2 + 2? Use the calculator tool.' },
      ];

      const tools = [{
        name: 'calculator',
        description: 'Perform arithmetic calculations',
        parameters: {
          type: 'object' as const,
          properties: {
            expression: { type: 'string', description: 'The math expression' },
          },
          required: ['expression'],
        },
      }];

      const response = await adapter.respond({
        messages,
        tools,
        llm: { model: 'glm-4.7' },
        maxTokens: 200,
      });

      expect(response.stopReason).toBe('tool_use');
      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls!.length).toBeGreaterThan(0);
      expect(response.toolCalls![0].name).toBe('calculator');
    });

    it('should stream responses', async () => {
      const adapter = createAdapter({
        apiKeys: { 'openai-compat': apiKey! },
        modelRegistry: {
          'glm-4.7': {
            provider: 'openai-compat',
            baseUrl: 'https://api.z.ai/api/paas/v4'
          },
        },
      }, silentLogger);

      const messages: Message[] = [
        { role: 'user', content: 'Count from 1 to 5.' },
      ];

      const chunks: string[] = [];
      const generator = adapter.stream({
        messages,
        llm: { model: 'glm-4.7' },
        maxTokens: 100,
        onChunk: (chunk) => chunks.push(chunk),
      });

      let result;
      for await (const chunk of generator) {
        // Chunks are yielded
      }
      result = await generator.return(undefined as any);

      expect(chunks.length).toBeGreaterThan(0);
      expect(result.value.content).toContain('1');
      expect(result.value.content).toContain('5');
    });
  });

  describe('GLM 4.7 via OpenRouter', () => {
    const apiKey = process.env.OPENROUTER_API_KEY;

    beforeAll(() => {
      if (!apiKey) throw new Error('OPENROUTER_API_KEY required');
    });

    it('should complete via OpenRouter proxy', async () => {
      const adapter = createAdapter({
        apiKeys: { 'openai-compat': apiKey! },
        modelRegistry: {
          'z-ai/glm-4.7': {
            provider: 'openai-compat',
            baseUrl: 'https://openrouter.ai/api/v1'
          },
        },
      }, silentLogger);

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Say "test" and nothing else.' }],
        llm: { model: 'z-ai/glm-4.7' },
        maxTokens: 50,
      });

      expect(response.content.toLowerCase()).toContain('test');
      expect(response.usage.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('Cerebras (Fast Inference)', () => {
    const apiKey = process.env.CEREBRAS_API_KEY;

    beforeAll(() => {
      if (!apiKey) throw new Error('CEREBRAS_API_KEY required');
    });

    it('should complete via Cerebras', async () => {
      const adapter = createAdapter({
        apiKeys: { 'openai-compat': apiKey! },
        modelRegistry: {
          'llama3.1-70b': {
            provider: 'openai-compat',
            baseUrl: 'https://api.cerebras.ai/v1'
          },
        },
      }, silentLogger);

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'What is 1+1? Answer with just the number.' }],
        llm: { model: 'llama3.1-70b' },
        maxTokens: 10,
      });

      expect(response.content).toContain('2');
    });
  });

  describe('Error Handling', () => {
    it('should parse API errors correctly', async () => {
      const adapter = createAdapter({
        apiKeys: { 'openai-compat': 'invalid-key' },
        modelRegistry: {
          'glm-4.7': {
            provider: 'openai-compat',
            baseUrl: 'https://api.z.ai/api/paas/v4'
          },
        },
      }, silentLogger);

      await expect(adapter.respond({
        messages: [{ role: 'user', content: 'test' }],
        llm: { model: 'glm-4.7' },
      })).rejects.toThrow(/API error/);
    });

    it('should handle network timeouts gracefully', async () => {
      const adapter = createAdapter({
        apiKeys: { 'openai-compat': 'test-key' },
        modelRegistry: {
          'test-model': {
            provider: 'openai-compat',
            baseUrl: 'https://localhost:1' // unreachable
          },
        },
      }, silentLogger);

      await expect(adapter.respond({
        messages: [{ role: 'user', content: 'test' }],
        llm: { model: 'test-model' },
      })).rejects.toThrow();
    });
  });
});
```

### Test File: `apps/harness-daemon/src/harness/__tests__/harness.integration.test.ts`

```typescript
/**
 * BRUTAL End-to-End Harness Integration Tests
 *
 * Tests the full stack: config → harness → adapter → API
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentHarness, createHarnessFromEnv } from '../harness.js';
import { loadConfig, createConfigFromFile } from '../config_loader.js';
import type { HarnessConfigFile } from '../config_types.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SKIP_INTEGRATION = !process.env.RUN_INTEGRATION_TESTS;

describe.skipIf(SKIP_INTEGRATION)('Harness Integration - OpenAI Compat', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Config Loading with openai-compat provider', () => {
    it('should load config with openai-compat agent', () => {
      const configFile: HarnessConfigFile = {
        agents: {
          'glm-agent': {
            llm: {
              provider: 'openai-compat',
              model: 'glm-4.7',
              max_tokens: 16000,
              temperature: 0.7,
              api_base: 'https://api.z.ai/api/paas/v4',
            },
            budget: {
              max_iterations: 5,
              max_tool_calls: 20,
              max_duration_ms: 60000,
            },
            tools: ['Read', 'Glob'],
          },
        },
        tools: { bash_timeout_ms: 30000, max_output_length: 10000 },
        graphd: { enabled: false, host: 'localhost', port: 9444, db_path: '/tmp/test.db' },
        context: { max_tokens: 100000 },
      };

      const configPath = join(tempDir, 'config');
      const configFilePath = join(configPath, 'harness_config.json');
      mkdirSync(configPath, { recursive: true });
      writeFileSync(configFilePath, JSON.stringify(configFile));

      // Set env var for API key resolution
      process.env.OPENAI_COMPAT_API_KEY = 'test-key';

      const config = createConfigFromFile(configFile, tempDir);

      expect(config.agents['glm-agent']).toBeDefined();
      expect(config.agents['glm-agent'].llm.provider).toBe('openai-compat');
      expect(config.agents['glm-agent'].llm.baseUrl).toBe('https://api.z.ai/api/paas/v4');
      expect(config.agents['glm-agent'].llm.model).toBe('glm-4.7');
    });
  });

  describe('Full Harness Run with GLM 4.7', () => {
    const apiKey = process.env.ZAI_API_KEY ?? process.env.OPENAI_COMPAT_API_KEY;

    beforeAll(() => {
      if (!apiKey) throw new Error('ZAI_API_KEY or OPENAI_COMPAT_API_KEY required');
      process.env.OPENAI_COMPAT_API_KEY = apiKey;
    });

    it('should run a simple request through the full harness', async () => {
      const configFile: HarnessConfigFile = {
        agents: {
          standard: {
            llm: {
              provider: 'openai-compat',
              model: 'glm-4.7',
              max_tokens: 4000,
              temperature: 0.5,
              api_base: 'https://api.z.ai/api/paas/v4',
            },
            budget: {
              max_iterations: 3,
              max_tool_calls: 10,
              max_duration_ms: 30000,
            },
            tools: [],
          },
        },
        tools: { bash_timeout_ms: 30000, max_output_length: 10000 },
        graphd: { enabled: false, host: 'localhost', port: 9444, db_path: '/tmp/test.db' },
        context: { max_tokens: 50000 },
      };

      const config = createConfigFromFile(configFile, tempDir);
      const harness = new AgentHarness(config);

      await harness.start();

      const handle = harness.run({
        requestId: 'test-001',
        inputText: 'Say exactly: "Integration test passed"',
        sessionKey: 'test-session',
      });

      const result = await handle.result;

      expect(result.success).toBe(true);
      expect(result.finalText.toLowerCase()).toContain('integration');

      await harness.shutdown();
    }, 60000);

    it('should handle tool calls through harness', async () => {
      const configFile: HarnessConfigFile = {
        agents: {
          standard: {
            llm: {
              provider: 'openai-compat',
              model: 'glm-4.7',
              max_tokens: 8000,
              temperature: 0.3,
              api_base: 'https://api.z.ai/api/paas/v4',
            },
            budget: {
              max_iterations: 5,
              max_tool_calls: 20,
              max_duration_ms: 60000,
            },
            tools: ['Read', 'Glob'],
          },
        },
        tools: { bash_timeout_ms: 30000, max_output_length: 10000 },
        graphd: { enabled: false, host: 'localhost', port: 9444, db_path: '/tmp/test.db' },
        context: { max_tokens: 50000 },
      };

      // Create a test file to read
      const testFile = join(tempDir, 'test.txt');
      writeFileSync(testFile, 'This is test content for the harness integration test.');

      const config = createConfigFromFile(configFile, tempDir, tempDir);
      const harness = new AgentHarness(config);

      await harness.start();

      const handle = harness.run({
        requestId: 'test-002',
        inputText: `Read the file at ${testFile} and tell me what it says.`,
        sessionKey: 'test-session-2',
      });

      const result = await handle.result;

      expect(result.success).toBe(true);
      expect(result.finalText).toContain('test content');

      await harness.shutdown();
    }, 90000);
  });

  describe('Multi-Provider Switching', () => {
    it('should support multiple openai-compat endpoints in same config', async () => {
      const configFile: HarnessConfigFile = {
        agents: {
          'glm-agent': {
            llm: {
              provider: 'openai-compat',
              model: 'glm-4.7',
              max_tokens: 4000,
              api_base: 'https://api.z.ai/api/paas/v4',
            },
            budget: { max_iterations: 1, max_tool_calls: 0, max_duration_ms: 10000 },
          },
          'openrouter-agent': {
            llm: {
              provider: 'openai-compat',
              model: 'z-ai/glm-4.7',
              max_tokens: 4000,
              api_base: 'https://openrouter.ai/api/v1',
            },
            budget: { max_iterations: 1, max_tool_calls: 0, max_duration_ms: 10000 },
          },
        },
        tools: { bash_timeout_ms: 30000, max_output_length: 10000 },
        graphd: { enabled: false, host: 'localhost', port: 9444, db_path: '/tmp/test.db' },
        context: { max_tokens: 50000 },
      };

      const config = createConfigFromFile(configFile, tempDir);

      // Both agents should be configured
      expect(config.agents['glm-agent'].llm.baseUrl).toBe('https://api.z.ai/api/paas/v4');
      expect(config.agents['openrouter-agent'].llm.baseUrl).toBe('https://openrouter.ai/api/v1');

      // Both should use same provider type
      expect(config.agents['glm-agent'].llm.provider).toBe('openai-compat');
      expect(config.agents['openrouter-agent'].llm.provider).toBe('openai-compat');
    });
  });
});
```

### Running the Tests

```bash
# Run unit tests only (no API calls)
npm test

# Run integration tests with real APIs
RUN_INTEGRATION_TESTS=1 ZAI_API_KEY=your-key npm test

# Run specific integration test
RUN_INTEGRATION_TESTS=1 ZAI_API_KEY=your-key npx vitest run adapter.integration

# Run with verbose logging
RUN_INTEGRATION_TESTS=1 DEBUG=1 ZAI_API_KEY=your-key npm test
```

---

## Estimated Scope

- **Files modified**: 4
  - `packages/agent-core/src/types/llm.ts` (~1 line)
  - `packages/agent-core/src/llm/adapter.ts` (~200-250 lines)
  - `apps/harness-daemon/src/harness/config_types.ts` (~1 line)
  - `apps/harness-daemon/src/harness/config_loader.ts` (~10 lines)
- **Files added**: 2 (integration test files)
- **Lines added**: ~500 total
- **Lines modified**: ~15
- **Risk**: Low (additive change, doesn't touch existing paths)

---

## Sources

- [Z.AI Chat Completion API](https://docs.z.ai/api-reference/llm/chat-completion)
- [GLM-4.7 on OpenRouter](https://openrouter.ai/z-ai/glm-4.7)
- [GLM-4.7 on DeepInfra](https://deepinfra.com/zai-org/GLM-4.7/api)
- [GLM-4.7 Overview](https://docs.z.ai/guides/llm/glm-4.7)
