/**
 * Provider key retrieval for skill scripts.
 *
 * Reads encrypted API keys from the same GraphD store used by harness-daemon.
 * This allows skills to access provider keys without env vars.
 */

import { createDecipheriv, scryptSync } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { GraphStore } from 'graphd';

const LOCAL_USER_ID = 'local_user';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

const MASTER_KEY_PATH = join(homedir(), '.config', 'rex', 'master.key');
const GRAPHD_PATH = join(homedir(), '.graphd', 'graphd.db');

interface ProviderCredential {
  encryptedKey: string;
  iv: string;
}

/**
 * Get the master encryption key.
 */
function getMasterKey(): Buffer | null {
  // Check env var first
  const envKey = process.env.REX_ENCRYPTION_KEY;
  if (envKey) {
    return scryptSync(envKey, 'rex-local-salt', KEY_LENGTH);
  }

  // Check if key file exists
  if (existsSync(MASTER_KEY_PATH)) {
    const keyHex = readFileSync(MASTER_KEY_PATH, 'utf-8').trim();
    return Buffer.from(keyHex, 'hex');
  }

  return null;
}

/**
 * Decrypt a provider credential.
 */
function decrypt(encrypted: ProviderCredential, masterKey: Buffer): string {
  const iv = Buffer.from(encrypted.iv, 'base64');
  const ciphertextWithTag = Buffer.from(encrypted.encryptedKey, 'base64');
  const authTag = ciphertextWithTag.subarray(-AUTH_TAG_LENGTH);
  const ciphertext = ciphertextWithTag.subarray(0, -AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Get a provider API key from the store.
 *
 * Falls back to environment variable if store access fails.
 */
export function getProviderKey(provider: string): string | null {
  // Check environment variable first (allows override)
  const envVar = `${provider.toUpperCase()}_API_TOKEN`;
  const envKey = process.env[envVar];
  if (envKey) {
    return envKey;
  }

  // Also check common variations
  const altEnvVar = `${provider.toUpperCase()}_API_KEY`;
  const altEnvKey = process.env[altEnvVar];
  if (altEnvKey) {
    return altEnvKey;
  }

  // Try to read from GraphD store
  if (!existsSync(GRAPHD_PATH)) {
    return null;
  }

  const masterKey = getMasterKey();
  if (!masterKey) {
    return null;
  }

  try {
    const store = new GraphStore(GRAPHD_PATH);
    store.initialize();

    const credential = store.getProviderCredential(LOCAL_USER_ID, provider);
    store.close();

    if (!credential) {
      return null;
    }

    const decrypted = decrypt(
      { encryptedKey: credential.encryptedKey, iv: credential.iv },
      masterKey
    );

    // Strip paste markers that may have been saved
    return decrypted
      ?.replace(/\x1b\[200~/g, '')
      .replace(/\x1b\[201~/g, '')
      .replace(/\[200~/g, '')
      .replace(/\[201~/g, '')
      .trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a provider is configured.
 */
export function isProviderConfigured(provider: string): boolean {
  return getProviderKey(provider) !== null;
}
