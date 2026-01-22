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
import { SUPPORTED_PROVIDER_IDS, getProviderDefinition } from 'types';

/**
 * Provider API keys configuration type.
 * NOTE: This is now internal-only - no longer used in config files.
 * API keys are stored exclusively in GraphD.
 */
export interface ProvidersConfigSection {
  [provider: string]: string | undefined;
}

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

// SUPPORTED_PROVIDERS is now imported from types as SUPPORTED_PROVIDER_IDS

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

      const providers = SUPPORTED_PROVIDER_IDS.map((provider) => {
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
      const decrypted = this.decrypt(
        { ciphertext: credential.encryptedKey, iv: credential.iv },
        masterKey
      );

      // Strip any bracketed paste markers that may have been saved before sanitization was added
      return decrypted
        ?.replace(/\x1b\[200~/g, '')
        .replace(/\x1b\[201~/g, '')
        .replace(/\[200~/g, '')
        .replace(/\[201~/g, '')
        .trim() ?? null;
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

    for (const provider of SUPPORTED_PROVIDER_IDS) {
      const key = this.getProviderKey(provider);
      if (key) {
        providers[provider] = key;
        // Log first 8 and last 4 chars to verify key integrity without exposing full key
        const keyPreview = key.length > 12
          ? `${key.slice(0, 8)}...${key.slice(-4)} (len=${key.length})`
          : `${key.slice(0, 8)}... (len=${key.length})`;
        console.log(`[local-providers] Found stored key for ${provider}: ${keyPreview}`);
      }
    }

    console.log(`[local-providers] getProviders returning ${Object.keys(providers).length} keys`);
    return providers;
  }

  /**
   * Export all stored provider keys to process.env.
   * This makes them available to child processes (e.g., skill scripts via Bash tool).
   * Uses each provider's standard env var name from PROVIDER_REGISTRY.
   */
  exportToEnv(): void {
    let exportCount = 0;
    for (const provider of SUPPORTED_PROVIDER_IDS) {
      const key = this.getProviderKey(provider);
      if (key) {
        const definition = getProviderDefinition(provider);
        if (definition?.envVar) {
          process.env[definition.envVar] = key;
          exportCount++;
        }
      }
    }
    if (exportCount > 0) {
      console.log(`[local-providers] Exported ${exportCount} provider keys to process.env`);
    }
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
   * Get or generate the master encryption key.
   */
  private getMasterKey(): Buffer {
    if (this.masterKey) {
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
    // Get provider definition from central registry
    const definition = getProviderDefinition(provider);
    if (!definition?.testEndpoint) {
      // No test endpoint defined, assume valid if key exists
      return apiKey.length > 0;
    }

    // Build request based on provider definition
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add custom test headers if defined
    if (definition.testHeaders) {
      Object.assign(headers, definition.testHeaders);
    }

    // Handle authentication - different providers use different methods
    let url = definition.testEndpoint;
    if (provider === 'gemini') {
      url = `${definition.testEndpoint}?key=${apiKey}`;
    } else if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Make request
    const fetchOptions: RequestInit = {
      method: definition.testMethod ?? 'GET',
      headers,
    };

    if (definition.testMethod === 'POST' && definition.testBody) {
      fetchOptions.body = JSON.stringify(definition.testBody);
    }

    const response = await fetch(url, fetchOptions);

    // Anthropic returns non-401/403 for valid keys (may return other errors)
    if (provider === 'anthropic') {
      return response.status !== 401 && response.status !== 403;
    }

    return response.ok;
  }
}
