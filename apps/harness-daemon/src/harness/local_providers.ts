/**
 * Local provider management for harness-daemon.
 *
 * Manages API keys stored directly in the config file (~/.rex/config.json).
 * No authentication required - this is for local CLI use.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { HarnessConfigFile, ProvidersConfigSection } from './config_types.js';
import { setConfigProviders } from './config_loader.js';

// ============================================
// TYPES
// ============================================

export interface ProviderInfo {
  provider: string;
  configured: boolean;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface ProvidersListResult {
  success: boolean;
  error?: string;
  providers?: ProviderInfo[];
  [key: string]: unknown;
}

export interface ProviderSaveResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ProviderTestResult {
  success: boolean;
  valid?: boolean;
  error?: string;
  [key: string]: unknown;
}

// ============================================
// CONSTANTS
// ============================================

const SUPPORTED_PROVIDERS = [
  'anthropic',
  'openai',
  'cerebras',
  'together',
  'groq',
  'fireworks',
  'gemini',
];

// ============================================
// LOCAL PROVIDER MANAGER
// ============================================

/**
 * Local provider manager - stores API keys in config file.
 */
export class LocalProviderManager {
  private configPath: string;
  private providers: ProvidersConfigSection;
  private providerTimestamps: Map<string, number> = new Map();

  constructor(configPath: string, providers: ProvidersConfigSection = {}) {
    this.configPath = configPath;
    this.providers = providers;

    // Initialize timestamps for existing providers
    for (const provider of Object.keys(providers)) {
      if (providers[provider]) {
        this.providerTimestamps.set(provider, Date.now());
      }
    }
  }

  /**
   * List all providers and their configuration status.
   */
  listProviders(): ProvidersListResult {
    try {
      const providers = SUPPORTED_PROVIDERS.map((provider) => ({
        provider,
        configured: !!this.providers[provider],
        updatedAt: this.providerTimestamps.get(provider),
      }));

      return { success: true, providers };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to list providers',
      };
    }
  }

  /**
   * Save an API key for a provider.
   */
  saveProviderKey(provider: string, apiKey: string): ProviderSaveResult {
    try {
      // Update in memory
      this.providers[provider] = apiKey;
      this.providerTimestamps.set(provider, Date.now());

      // Update module-level cache for immediate use
      setConfigProviders(this.providers);

      // Persist to config file
      this.writeConfigFile();

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to save API key',
      };
    }
  }

  /**
   * Delete an API key for a provider.
   */
  deleteProviderKey(provider: string): ProviderSaveResult {
    try {
      // Update in memory
      delete this.providers[provider];
      this.providerTimestamps.delete(provider);

      // Update module-level cache
      setConfigProviders(this.providers);

      // Persist to config file
      this.writeConfigFile();

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to delete API key',
      };
    }
  }

  /**
   * Test an API key for a provider.
   */
  async testProviderKey(provider: string): Promise<ProviderTestResult> {
    const apiKey = this.providers[provider];
    if (!apiKey) {
      return { success: true, valid: false, error: 'No API key configured' };
    }

    try {
      const valid = await this.testApiKey(provider, apiKey);
      return { success: true, valid };
    } catch (err) {
      return {
        success: true,
        valid: false,
        error: err instanceof Error ? err.message : 'Test failed',
      };
    }
  }

  /**
   * Get current providers config.
   */
  getProviders(): ProvidersConfigSection {
    return { ...this.providers };
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private writeConfigFile(): void {
    if (!this.configPath) {
      throw new Error('No config path set - cannot save providers');
    }

    // Read existing config
    let config: HarnessConfigFile;
    if (existsSync(this.configPath)) {
      const content = readFileSync(this.configPath, 'utf-8');
      config = JSON.parse(content) as HarnessConfigFile;
    } else {
      throw new Error(`Config file not found: ${this.configPath}`);
    }

    // Update providers section
    config.providers = this.providers;

    // Write back
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[local-providers] Saved providers to ${this.configPath}`);
  }

  private async testApiKey(provider: string, apiKey: string): Promise<boolean> {
    switch (provider) {
      case 'anthropic': {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-3-haiku-20240307',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        return response.status !== 401 && response.status !== 403;
      }
      case 'openai': {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        return response.ok;
      }
      case 'cerebras': {
        const response = await fetch('https://api.cerebras.ai/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        return response.ok;
      }
      case 'together': {
        const response = await fetch('https://api.together.xyz/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        return response.ok;
      }
      case 'groq': {
        const response = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        return response.ok;
      }
      case 'fireworks': {
        const response = await fetch('https://api.fireworks.ai/inference/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        return response.ok;
      }
      case 'gemini': {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        return response.ok;
      }
      default:
        return apiKey.length > 0;
    }
  }
}
