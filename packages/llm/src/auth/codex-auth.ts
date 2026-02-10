import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
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
  redirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
};

/** Token refresh buffer - refresh 5 minutes before expiry */
const REFRESH_BUFFER_SECONDS = 300;

/** Token storage path */
const TOKEN_PATH = join(homedir(), '.config', 'rex', 'codex-auth.json');
const LEGACY_TOKEN_PATH = join(homedir(), '.codex', 'auth.json');
const KNOWN_TOKEN_PATHS = [TOKEN_PATH, LEGACY_TOKEN_PATH] as const;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function extractTokenExpiry(token: string): number | undefined {
  try {
    const payload = parseJwt(token);
    return asPositiveNumber(payload.exp);
  } catch {
    return undefined;
  }
}

function normalizeStoredTokens(raw: unknown): CodexTokens | null {
  const root = asRecord(raw);
  if (!root) return null;

  const nestedTokens = asRecord(root.tokens);
  const tokenSource = nestedTokens ?? root;

  const accessToken = asNonEmptyString(tokenSource.access_token);
  const refreshToken = asNonEmptyString(tokenSource.refresh_token);
  if (!accessToken || !refreshToken) {
    return null;
  }

  const expiresAt =
    asPositiveNumber(tokenSource.expires_at) ??
    asPositiveNumber(root.expires_at) ??
    extractTokenExpiry(accessToken) ??
    Math.floor(Date.now() / 1000) + 3600;
  const scope = asNonEmptyString(tokenSource.scope) ?? asNonEmptyString(root.scope);
  const accountId =
    asNonEmptyString(root.chatgpt_account_id) ??
    asNonEmptyString(tokenSource.chatgpt_account_id) ??
    asNonEmptyString(tokenSource.account_id) ??
    extractAccountId(asNonEmptyString(tokenSource.id_token) ?? '');

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_at: expiresAt,
    ...(scope ? { scope } : {}),
    ...(accountId ? { chatgpt_account_id: accountId } : {}),
  };
}

function readStoredTokensFromPathSync(filePath: string): CodexTokens | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    return normalizeStoredTokens(JSON.parse(content));
  } catch {
    return null;
  }
}

async function readStoredTokensFromPath(filePath: string): Promise<CodexTokens | null> {
  if (!existsSync(filePath)) return null;
  try {
    const content = await readFile(filePath, 'utf-8');
    return normalizeStoredTokens(JSON.parse(content));
  } catch {
    return null;
  }
}

export function hasStoredCodexTokens(): boolean {
  for (const tokenPath of KNOWN_TOKEN_PATHS) {
    if (readStoredTokensFromPathSync(tokenPath)) {
      return true;
    }
  }
  return false;
}

export async function loadStoredCodexTokens(): Promise<CodexTokens | null> {
  for (const tokenPath of KNOWN_TOKEN_PATHS) {
    const tokens = await readStoredTokensFromPath(tokenPath);
    if (tokens) {
      return tokens;
    }
  }
  return null;
}

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
    this.tokens = await loadStoredCodexTokens();
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

  /**
   * Get the ChatGPT account ID (required for API requests).
   * Returns null if no tokens or account ID not available.
   */
  getAccountId(): string | null {
    return this.tokens?.chatgpt_account_id ?? null;
  }

  async clearTokens(): Promise<void> {
    this.tokens = null;
    if (existsSync(TOKEN_PATH)) {
      await writeFile(TOKEN_PATH, '{}', 'utf-8');
    }
  }

  async storeTokens(tokens: CodexTokens): Promise<void> {
    this.tokens = tokens;
    const dir = join(homedir(), '.config', 'rex');
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
 * Parse a JWT token and extract the payload (without verification).
 */
function parseJwt(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

/**
 * Extract ChatGPT account ID from id_token JWT.
 * The account ID is in the custom claim 'https://api.openai.com/auth'.
 */
function extractAccountId(idToken: string): string | undefined {
  try {
    const payload = parseJwt(idToken);
    const authClaim = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    return authClaim?.chatgpt_account_id as string | undefined;
  } catch {
    return undefined;
  }
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

  // Extract account ID from id_token if present
  const chatgptAccountId = data.id_token ? extractAccountId(data.id_token) : undefined;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    scope: data.scope,
    chatgpt_account_id: chatgptAccountId,
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
