/**
 * Provider registry - singleton providers accessible by name.
 * Providers are stateless, so we use singletons instead of factories.
 */

import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { LLMProviderAdapter } from './types.js';

const PROVIDERS: Record<string, LLMProviderAdapter> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  'openai-compat': new OpenAICompatProvider(),
};

export function getProvider(name: string): LLMProviderAdapter {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unsupported provider: ${name}`);
  }
  return provider;
}
