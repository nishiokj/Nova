/**
 * Provider registry - singleton providers accessible by name.
 * Providers are stateless, so we use singletons instead of factories.
 */

import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { VercelGatewayProvider } from './vercel-gateway.js';
import { CodexProvider } from './codex.js';
import type { LLMProviderAdapter } from './types.js';

const PROVIDERS: Record<string, LLMProviderAdapter> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  'openai-compat': new OpenAICompatProvider(),
  'vercel-gateway': new VercelGatewayProvider(),
  codex: new CodexProvider(),
};

export function getProvider(name: string): LLMProviderAdapter {
  const provider = (PROVIDERS as Partial<Record<string, LLMProviderAdapter>>)[name];
  if (!provider) {
    throw new Error(`Unsupported provider: ${name}`);
  }
  return provider;
}
