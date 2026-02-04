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
  redirectUri: 'http://localhost:8976/callback',
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
