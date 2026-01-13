/**
 * Local provider management for harness-daemon.
 *
 * Manages API keys stored in GraphD (SQLite) with encryption.
 * No authentication required - uses a fixed local user ID for CLI use.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { GraphStore } from 'graphd';
import type { ProvidersConfigSection } from './config_types.js';
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

// Fixed user ID for local (non-OAuth) use
const LOCAL_USER_ID = 'local_user';

// Encryption constants
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// ============================================
// LOCAL PROVIDER MANAGER
// ============================================

/**
 * Local provider manager - stores API keys in GraphD (SQLite) with encryption.
 */
export class LocalProviderManager {
  private store: GraphStore;
  private masterKey: Buffer | null = null;
  private masterKeyPath: string;

  constructor(graphdDbPath: string) {
    this.store = new GraphStore(graphdDbPath);
    this.store.initialize();
    this.masterKeyPath = join(homedir(), '.config', 'rex', 'master.key');

    // Ensure local user exists
    this.ensureLocalUser();

    console.log(`[local-providers] Initialized with GraphD at ${graphdDbPath}`);
  }

  /**
   * Ensure the local user exists in the store.
   */
  private ensureLocalUser(): void {
    const existingUser = this.store.getUser(LOCAL_USER_ID);
    if (!existingUser) {
      this.store.upsertUser(LOCAL_USER_ID, 'local@localhost', 'Local User', undefined);
    }
  }

  /**
   * Close the store connection.
   */
  close(): void {
    this.store.close();
  }

  /**
   * List all providers and their configuration status.
   */
  listProviders(): ProvidersListResult {
    try {
      const credentials = this.store.listProviderCredentials(LOCAL_USER_ID);

      const providers = SUPPORTED_PROVIDERS.map((provider) => {
        const cred = credentials.find((c) => c.provider === provider);
        return {
          provider,
          configured: !!cred,
          updatedAt: cred?.updatedAt,
        };
      });

      return { success: true, providers };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to list providers',
      };
    }
  }

  /**
   * Save an API key for a provider (encrypted).
   */
  saveProviderKey(provider: string, apiKey: string): ProviderSaveResult {
    try {
      const masterKey = this.getMasterKey();
      const encrypted = this.encrypt(apiKey, masterKey);
      const credentialId = `cred_local_${provider}`;

      this.store.upsertProviderCredential(
        credentialId,
        LOCAL_USER_ID,
        provider,
        encrypted.ciphertext,
        encrypted.iv
      );

      // Update module-level cache for immediate use by config resolution
      this.updateConfigCache();

      console.log(`[local-providers] Saved ${provider} key to GraphD`);
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
      this.store.deleteProviderCredential(LOCAL_USER_ID, provider);

      // Update module-level cache
      this.updateConfigCache();

      console.log(`[local-providers] Deleted ${provider} key from GraphD`);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to delete API key',
      };
    }
  }

  /**
   * Get decrypted API key for a provider.
   */
  getProviderKey(provider: string): string | null {
    try {
      const credential = this.store.getProviderCredential(LOCAL_USER_ID, provider);
      if (!credential) {
        return null;
      }

      const masterKey = this.getMasterKey();
      return this.decrypt(
        { ciphertext: credential.encryptedKey, iv: credential.iv },
        masterKey
      );
    } catch (err) {
      console.error(`[local-providers] Failed to get ${provider} key:`, err);
      return null;
    }
  }

  /**
   * Get all providers as a config section (for harness initialization).
   */
  getProviders(): ProvidersConfigSection {
    const providers: ProvidersConfigSection = {};

    for (const provider of SUPPORTED_PROVIDERS) {
      const key = this.getProviderKey(provider);
      if (key) {
        providers[provider] = key;
        console.log(`[local-providers] Found stored key for ${provider}: ${key.slice(0, 8)}...`);
      }
    }

    console.log(`[local-providers] getProviders returning ${Object.keys(providers).length} keys`);
    return providers;
  }

  /**
   * Test an API key for a provider.
   */
  async testProviderKey(provider: string): Promise<ProviderTestResult> {
    const apiKey = this.getProviderKey(provider);
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

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /**
   * Update the module-level config cache with current provider keys.
   */
  private updateConfigCache(): void {
    const providers = this.getProviders();
    setConfigProviders(providers);
  }

  /**
   * Get or generate the master encryption key.
   */
  private getMasterKey(): Buffer {
    if (this.masterKey) {
      return this.masterKey;
    }

    // Check env var first
    const envKey = process.env.REX_ENCRYPTION_KEY;
    if (envKey) {
      this.masterKey = scryptSync(envKey, 'rex-local-salt', KEY_LENGTH);
      return this.masterKey;
    }

    // Check if key file exists
    if (existsSync(this.masterKeyPath)) {
      const keyHex = readFileSync(this.masterKeyPath, 'utf-8').trim();
      this.masterKey = Buffer.from(keyHex, 'hex');
      return this.masterKey;
    }

    // Generate new key
    console.log(`[local-providers] Generating master key at ${this.masterKeyPath}`);
    const newKey = randomBytes(KEY_LENGTH);
    const keyDir = dirname(this.masterKeyPath);
    if (!existsSync(keyDir)) {
      mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(this.masterKeyPath, newKey.toString('hex'), { mode: 0o600 });
    this.masterKey = newKey;
    return this.masterKey;
  }

  private encrypt(plaintext: string, masterKey: Buffer): { ciphertext: string; iv: string } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, masterKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    const ciphertextWithTag = Buffer.concat([
      Buffer.from(encrypted, 'base64'),
      authTag,
    ]).toString('base64');

    return { ciphertext: ciphertextWithTag, iv: iv.toString('base64') };
  }

  private decrypt(encrypted: { ciphertext: string; iv: string }, masterKey: Buffer): string {
    const iv = Buffer.from(encrypted.iv, 'base64');
    const ciphertextWithTag = Buffer.from(encrypted.ciphertext, 'base64');
    const authTag = ciphertextWithTag.subarray(-AUTH_TAG_LENGTH);
    const ciphertext = ciphertextWithTag.subarray(0, -AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
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
