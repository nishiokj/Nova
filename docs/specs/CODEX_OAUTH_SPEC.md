# Codex OAuth Implementation Spec

## Goal

Add OpenAI Codex as a provider with OAuth-based subscription authentication, allowing users to authenticate with their ChatGPT Plus/Pro accounts instead of requiring a Platform API key.

## Background

OpenAI's Codex uses a dedicated OAuth flow for subscription-based access:
- **Client ID**: `app_EMoamEEZ73f0CkXaXp7hrann` (public client)
- **Auth Endpoint**: `https://auth.openai.com/oauth/authorize`
- **Token Endpoint**: `https://auth.openai.com/oauth/token`
- **API Endpoint**: `https://api.openai.com/v1/responses` (Responses API, not Chat Completions)
- **Flow**: OAuth 2.0 Authorization Code with PKCE (S256)

OAuth tokens are scoped to Codex/Responses API only - they do NOT work with the general OpenAI Platform API.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Auth Flow (One-time)                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  User ──► TUI/CLI ──► CodexAuthService ──► Browser ──► OpenAI OAuth │
│                              │                              │        │
│                              │◄─────── auth code ───────────┘        │
│                              │                                       │
│                              ▼                                       │
│                       Token Exchange                                 │
│                              │                                       │
│                              ▼                                       │
│                    Store tokens in                                   │
│                 ~/.jesus/codex-auth.json                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       Inference Flow (Per-request)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Agent ──► LLMAdapter ──► CodexProvider ──► Responses API            │
│                 │               │                                    │
│                 │               ├── Check token expiry               │
│                 │               ├── Refresh if needed                │
│                 │               └── Authorization: Bearer <token>    │
│                 │                                                    │
│                 └── ProviderKeyService.getApiKey('codex')            │
│                            │                                         │
│                            ▼                                         │
│                   CodexTokenManager                                  │
│                   (returns current access token)                     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Primary Files

**New files:**
- `packages/llm/src/providers/codex.ts` - Codex provider (Responses API adapter)
- `packages/llm/src/auth/codex-auth.ts` - OAuth flow + token management
- `packages/llm/src/auth/types.ts` - Auth-related types

**Modified files:**
- `packages/types/src/providers.ts` - Add `codex` to provider registry
- `packages/llm/src/providers/registry.ts` - Register CodexProvider
- `packages/llm/src/adapter.ts` - Integrate CodexTokenManager with ProviderKeyService

---

## Part 1 — Provider Registration

### Patch 1.1 — Add `codex` to SupportedProvider type
**File:** `packages/types/src/providers.ts`

```typescript
export type SupportedProvider =
  | 'anthropic'
  | 'openai'
  | 'openai-compat'
  | 'vercel-gateway'
  | 'codex'  // ← Add
  // ... existing providers
```

### Patch 1.2 — Add Codex to PROVIDER_REGISTRY
**File:** `packages/types/src/providers.ts`

```typescript
codex: {
  id: 'codex',
  displayName: 'OpenAI Codex (Subscription)',
  canonicalProvider: 'codex',  // New canonical - uses Responses API
  baseUrl: 'https://api.openai.com',
  models: [
    {
      id: 'codex-mini-latest',
      name: 'Codex Mini',
      context_window: 192_000,
      description: 'Fast coding model for subscription users'
    },
    {
      id: 'gpt-5.2-codex',
      name: 'GPT-5.2 Codex',
      context_window: 256_000,
      reasoning: ['low', 'medium', 'high']
    },
  ],
  // No envVar - uses OAuth tokens, not API keys
  authRequired: true,
  testEndpoint: 'https://api.openai.com/v1/responses',
  testMethod: 'POST',
  testBody: {
    model: 'codex-mini-latest',
    input: 'test',
    max_output_tokens: 1,
  },
  dashboardUrl: 'https://chatgpt.com/settings',
},
```

### Patch 1.3 — Add `codex` to LLMProvider type
**File:** `packages/types/src/providers.ts`

```typescript
export type LLMProvider = 'anthropic' | 'openai' | 'openai-compat' | 'vercel-gateway' | 'codex';
```

### Patch 1.4 — Add Codex model defaults
**File:** `packages/types/src/providers.ts`

```typescript
codex: {
  fast: 'codex-mini-latest',
  standard: 'codex-mini-latest',
  powerful: 'gpt-5.2-codex',
  reasoning: 'gpt-5.2-codex',
},
```

---

## Part 2 — Auth Types & Token Management

### Patch 2.1 — Create auth types
**File:** `packages/llm/src/auth/types.ts` (new file)

```typescript
/**
 * OAuth token storage format.
 * Compatible with Codex CLI's ~/.codex/auth.json for interoperability.
 */
export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_at: number;  // Unix timestamp (seconds)
  scope?: string;
}

/**
 * PKCE challenge pair for OAuth flow.
 */
export interface PKCEChallenge {
  verifier: string;   // Random 43-128 char string
  challenge: string;  // Base64url(SHA256(verifier))
}

/**
 * OAuth configuration for Codex.
 */
export interface CodexOAuthConfig {
  clientId: string;
  authEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  scope: string;
}

/**
 * Token manager interface for OAuth providers.
 */
export interface TokenManager {
  /** Get current valid access token, refreshing if needed */
  getAccessToken(): Promise<string | null>;
  /** Check if tokens exist (may be expired) */
  hasTokens(): boolean;
  /** Clear stored tokens (logout) */
  clearTokens(): Promise<void>;
  /** Store new tokens from OAuth callback */
  storeTokens(tokens: CodexTokens): Promise<void>;
}
```

### Patch 2.2 — Create CodexTokenManager
**File:** `packages/llm/src/auth/codex-auth.ts` (new file)

```typescript
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import type { CodexTokens, PKCEChallenge, CodexOAuthConfig, TokenManager } from './types.js';

/**
 * Default OAuth configuration for Codex.
 * Uses OpenAI's public client ID (same as official Codex CLI).
 */
export const CODEX_OAUTH_CONFIG: CodexOAuthConfig = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  redirectUri: 'http://localhost:8976/callback',  // Local callback
  scope: 'openid profile email offline_access',
};

/** Token refresh buffer - refresh 5 minutes before expiry */
const REFRESH_BUFFER_SECONDS = 300;

/** Token storage path */
const TOKEN_PATH = join(homedir(), '.jesus', 'codex-auth.json');

/**
 * Manages Codex OAuth tokens - storage, refresh, and retrieval.
 */
export class CodexTokenManager implements TokenManager {
  private tokens: CodexTokens | null = null;
  private refreshPromise: Promise<string | null> | null = null;

  constructor(private config: CodexOAuthConfig = CODEX_OAUTH_CONFIG) {}

  /**
   * Load tokens from disk on startup.
   */
  async initialize(): Promise<void> {
    if (existsSync(TOKEN_PATH)) {
      try {
        const data = await readFile(TOKEN_PATH, 'utf-8');
        this.tokens = JSON.parse(data);
      } catch {
        this.tokens = null;
      }
    }
  }

  /**
   * Get current valid access token, refreshing if needed.
   * Returns null if no tokens or refresh fails.
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.tokens) return null;

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = this.tokens.expires_at;

    // Token still valid (with buffer)
    if (now < expiresAt - REFRESH_BUFFER_SECONDS) {
      return this.tokens.access_token;
    }

    // Need refresh - dedupe concurrent refresh calls
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshTokens().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  /**
   * Refresh the access token using the refresh token.
   */
  private async refreshTokens(): Promise<string | null> {
    if (!this.tokens?.refresh_token) return null;

    try {
      const response = await fetch(this.config.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.config.clientId,
          refresh_token: this.tokens.refresh_token,
        }),
      });

      if (!response.ok) {
        console.error(`Token refresh failed: ${response.status}`);
        return null;
      }

      const data = await response.json();
      const newTokens: CodexTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? this.tokens.refresh_token,
        token_type: 'Bearer',
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
        scope: data.scope,
      };

      await this.storeTokens(newTokens);
      return newTokens.access_token;
    } catch (error) {
      console.error('Token refresh error:', error);
      return null;
    }
  }

  hasTokens(): boolean {
    return this.tokens !== null;
  }

  async clearTokens(): Promise<void> {
    this.tokens = null;
    if (existsSync(TOKEN_PATH)) {
      await writeFile(TOKEN_PATH, '{}', 'utf-8');
    }
  }

  async storeTokens(tokens: CodexTokens): Promise<void> {
    this.tokens = tokens;
    const dir = join(homedir(), '.jesus');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
}

// ============================================
// PKCE Helpers
// ============================================

/**
 * Generate a PKCE code verifier and challenge.
 */
export function generatePKCE(): PKCEChallenge {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the authorization URL for the OAuth flow.
 */
export function buildAuthUrl(config: CodexOAuthConfig, pkce: PKCEChallenge, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scope,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${config.authEndpoint}?${params}`;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  config: CodexOAuthConfig,
  code: string,
  verifier: string
): Promise<CodexTokens> {
  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    scope: data.scope,
  };
}

// ============================================
// Singleton instance
// ============================================

let tokenManagerInstance: CodexTokenManager | null = null;

export function getCodexTokenManager(): CodexTokenManager {
  if (!tokenManagerInstance) {
    tokenManagerInstance = new CodexTokenManager();
  }
  return tokenManagerInstance;
}
```

---

## Part 3 — Codex Provider (Responses API)

### Patch 3.1 — Create CodexProvider
**File:** `packages/llm/src/providers/codex.ts` (new file)

```typescript
/**
 * Codex Provider - Uses OpenAI's Responses API (not Chat Completions).
 *
 * The Responses API is required for Codex subscription access.
 * Key differences from Chat Completions:
 * - Endpoint: /v1/responses (not /v1/chat/completions)
 * - Request format: { model, input, ... } (not { model, messages, ... })
 * - Response format: { output: [...], ... } (not { choices: [...], ... })
 * - Supports `store: true` for reasoning traces
 */

import type { LLMResponse, Message, ToolDefinition, ToolCall } from 'types';
import type { LLMProviderAdapter, ProviderContext, RespondParams, StreamParams } from './types.js';

/**
 * Convert our message format to Responses API input format.
 */
function formatInput(messages: Message[]): ResponsesInput[] {
  return messages.map((msg) => {
    if (msg.role === 'user') {
      return { type: 'message', role: 'user', content: msg.content };
    }
    if (msg.role === 'assistant') {
      return { type: 'message', role: 'assistant', content: msg.content };
    }
    if (msg.role === 'system') {
      return { type: 'message', role: 'system', content: msg.content };
    }
    if (msg.role === 'tool') {
      return {
        type: 'function_call_output',
        call_id: msg.toolCallId,
        output: msg.content,
      };
    }
    throw new Error(`Unknown message role: ${(msg as Message).role}`);
  });
}

/**
 * Convert tool definitions to Responses API format.
 */
function formatTools(tools: ToolDefinition[]): ResponsesTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

/**
 * Parse Responses API output into our format.
 */
function parseResponse(data: ResponsesAPIResponse): LLMResponse {
  let content = '';
  const toolCalls: ToolCall[] = [];

  for (const item of data.output ?? []) {
    if (item.type === 'message' && item.content) {
      for (const block of item.content) {
        if (block.type === 'output_text') {
          content += block.text;
        }
      }
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }

  return {
    content: content || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: data.usage
      ? {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
    stopReason: data.status === 'completed' ? 'end_turn' : undefined,
  };
}

export const CodexProvider: LLMProviderAdapter = {
  name: 'codex',

  async respond(context: ProviderContext, params: RespondParams): Promise<LLMResponse> {
    const { config, logger } = context;
    const { messages, tools, systemPrompt } = params;

    const allMessages: Message[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    const body: Record<string, unknown> = {
      model: config.model,
      input: formatInput(allMessages),
      store: true,  // Required for reasoning traces
    };

    if (config.maxTokens) body.max_output_tokens = config.maxTokens;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools?.length) body.tools = formatTools(tools);
    if (config.reasoning) {
      body.reasoning = { effort: config.reasoning };
    }

    const url = `${config.baseUrl}/v1/responses`;

    logger.debug('Codex request', { url, model: config.model });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Codex API error ${response.status}: ${errorText}`);
    }

    const data: ResponsesAPIResponse = await response.json();
    return parseResponse(data);
  },

  async *stream(context: ProviderContext, params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const { config, logger } = context;
    const { messages, tools, systemPrompt } = params;

    const allMessages: Message[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    const body: Record<string, unknown> = {
      model: config.model,
      input: formatInput(allMessages),
      stream: true,
      store: true,
    };

    if (config.maxTokens) body.max_output_tokens = config.maxTokens;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools?.length) body.tools = formatTools(tools);
    if (config.reasoning) {
      body.reasoning = { effort: config.reasoning };
    }

    const url = `${config.baseUrl}/v1/responses`;

    logger.debug('Codex stream request', { url, model: config.model });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Codex API error ${response.status}: ${errorText}`);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;

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
          const event = JSON.parse(data);

          if (event.type === 'response.output_text.delta') {
            const text = event.delta ?? '';
            fullContent += text;
            yield text;
          }

          if (event.type === 'response.function_call_arguments.done') {
            toolCalls.push({
              id: event.call_id,
              name: event.name,
              arguments: event.arguments,
            });
          }

          if (event.type === 'response.done' && event.response?.usage) {
            usage = event.response.usage;
          }
        } catch {
          // Ignore parse errors in stream
        }
      }
    }

    return {
      content: fullContent || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage
        ? {
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
      stopReason: 'end_turn',
    };
  },
};

// ============================================
// Responses API Types (internal)
// ============================================

interface ResponsesInput {
  type: 'message' | 'function_call_output';
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  call_id?: string;
  output?: string;
}

interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface ResponsesAPIResponse {
  id: string;
  status: 'completed' | 'failed' | 'in_progress';
  output?: Array<{
    type: 'message' | 'function_call';
    content?: Array<{ type: string; text?: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}
```

### Patch 3.2 — Register CodexProvider
**File:** `packages/llm/src/providers/registry.ts`

Add import and registration:

```typescript
import { CodexProvider } from './codex.js';

const PROVIDERS: Record<LLMProvider, LLMProviderAdapter> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  'openai-compat': OpenAICompatProvider,
  'vercel-gateway': VercelGatewayProvider,
  codex: CodexProvider,  // ← Add
};
```

---

## Part 4 — Adapter Integration

### Patch 4.1 — Add Codex token resolution to adapter
**File:** `packages/llm/src/adapter.ts`

Add import at top:
```typescript
import { getCodexTokenManager } from './auth/codex-auth.js';
```

In `resolveRequestConfig()`, add special handling for codex provider before the API key resolution block:

```typescript
// Special handling for Codex OAuth tokens
if (provider === 'codex') {
  const tokenManager = getCodexTokenManager();
  const token = await tokenManager.getAccessToken();
  if (!token) {
    throw new Error(
      'Codex OAuth not configured. Run the authentication flow first with /providers codex login'
    );
  }
  return {
    provider: 'codex',
    displayProvider: 'codex',
    model,
    apiKey: token,  // OAuth access token
    baseUrl: getProviderBaseUrl('codex') ?? 'https://api.openai.com',
    maxTokens: llm.maxTokens,
    temperature: llm.temperature,
    reasoning: llm.reasoning,
  };
}
```

Note: This requires `resolveRequestConfig` to become `async`. Update signature and callers accordingly.

### Patch 4.2 — Make resolveRequestConfig async
**File:** `packages/llm/src/adapter.ts`

Change:
```typescript
private resolveRequestConfig(llm: LLMRequestConfig): ResolvedRequestConfig
```
To:
```typescript
private async resolveRequestConfig(llm: LLMRequestConfig): Promise<ResolvedRequestConfig>
```

Update `respond()` and `stream()` to await the config:
```typescript
const resolved = await this.resolveRequestConfig(params.llm);
```

---

## Part 5 — OAuth Flow Handler (CLI/TUI)

### Patch 5.1 — Create OAuth flow orchestrator
**File:** `packages/llm/src/auth/codex-oauth-flow.ts` (new file)

```typescript
/**
 * Orchestrates the Codex OAuth flow for CLI/TUI environments.
 *
 * Flow:
 * 1. Generate PKCE challenge
 * 2. Start local HTTP server for callback
 * 3. Open browser to auth URL
 * 4. Wait for callback with auth code
 * 5. Exchange code for tokens
 * 6. Store tokens
 */

import { createServer, type Server } from 'http';
import { URL } from 'url';
import { randomBytes } from 'crypto';
import {
  CODEX_OAUTH_CONFIG,
  generatePKCE,
  buildAuthUrl,
  exchangeCodeForTokens,
  getCodexTokenManager,
} from './codex-auth.js';

export interface OAuthFlowCallbacks {
  onAuthUrl: (url: string) => void;
  onSuccess: () => void;
  onError: (error: Error) => void;
}

/**
 * Run the OAuth flow and return when complete.
 * Opens browser, waits for callback, exchanges tokens.
 */
export async function runCodexOAuthFlow(callbacks: OAuthFlowCallbacks): Promise<void> {
  const pkce = generatePKCE();
  const state = randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:8976`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400);
        res.end(`OAuth error: ${error}`);
        server.close();
        const err = new Error(`OAuth error: ${error}`);
        callbacks.onError(err);
        reject(err);
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400);
        res.end('State mismatch - possible CSRF attack');
        server.close();
        const err = new Error('OAuth state mismatch');
        callbacks.onError(err);
        reject(err);
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        server.close();
        const err = new Error('Missing authorization code');
        callbacks.onError(err);
        reject(err);
        return;
      }

      try {
        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(CODEX_OAUTH_CONFIG, code, pkce.verifier);

        // Store tokens
        const tokenManager = getCodexTokenManager();
        await tokenManager.storeTokens(tokens);

        // Success response
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: system-ui; text-align: center; padding: 50px;">
              <h1>Authentication Successful</h1>
              <p>You can close this window and return to the terminal.</p>
            </body>
          </html>
        `);

        server.close();
        callbacks.onSuccess();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end(`Token exchange failed: ${err}`);
        server.close();
        const error = err instanceof Error ? err : new Error(String(err));
        callbacks.onError(error);
        reject(error);
      }
    });

    server.listen(8976, '127.0.0.1', () => {
      const authUrl = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      callbacks.onAuthUrl(authUrl);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      const err = new Error('OAuth flow timed out');
      callbacks.onError(err);
      reject(err);
    }, 5 * 60 * 1000);
  });
}

/**
 * Check if Codex OAuth is configured.
 */
export async function isCodexAuthenticated(): Promise<boolean> {
  const tokenManager = getCodexTokenManager();
  await tokenManager.initialize();
  return tokenManager.hasTokens();
}

/**
 * Logout from Codex (clear tokens).
 */
export async function logoutCodex(): Promise<void> {
  const tokenManager = getCodexTokenManager();
  await tokenManager.clearTokens();
}
```

---

## Acceptance Criteria

1. **Provider Registration**
   - `codex` appears in `SupportedProvider` type
   - `getProviderDefinition('codex')` returns valid config
   - `codex` models appear in `getAllModels()`

2. **OAuth Flow**
   - `runCodexOAuthFlow()` opens browser to OpenAI auth
   - Callback successfully exchanges code for tokens
   - Tokens stored at `~/.jesus/codex-auth.json` with 0600 permissions
   - Token refresh works when access token expires

3. **Inference**
   - `adapter.respond({ llm: { provider: 'codex', model: 'codex-mini-latest' } })` succeeds
   - Request hits `/v1/responses` endpoint (not `/v1/chat/completions`)
   - OAuth token used as Bearer token
   - Streaming works via SSE

4. **Error Handling**
   - Missing OAuth tokens → clear error message with login instructions
   - Expired refresh token → error prompting re-authentication
   - Invalid model → appropriate error from Responses API

---

## Security Considerations

1. **Token Storage**: Tokens stored with 0600 permissions (owner read/write only)
2. **PKCE**: S256 challenge method prevents authorization code interception
3. **State Parameter**: Random state prevents CSRF attacks
4. **No Secrets in Code**: Uses OpenAI's public client ID (no client secret needed for public clients)
5. **Refresh Token Rotation**: If OpenAI rotates refresh tokens, we store the new one

---

## Future Enhancements

1. **Device Code Flow**: For headless/SSH environments where localhost callback doesn't work
2. **Token Import**: Import existing tokens from `~/.codex/auth.json` for Codex CLI interoperability
3. **Multi-Account**: Support multiple Codex accounts with account switching
4. **Scope Refinement**: Request minimal scopes needed for API access
