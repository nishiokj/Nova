/**
 * Auth service for harness-daemon.
 *
 * Handles Google OAuth, session management, and provider credential management.
 * Integrated directly into the daemon - no separate service needed.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { GraphStore } from 'graphd';
import type { UserRecord, ProviderCredentialRecord } from 'graphd';
import { stderrLogger, type HarnessLogger } from './harness_infra.js';

// ============================================
// TYPES
// ============================================

export interface AuthServiceConfig {
  graphdDbPath: string;
  masterKeyPath: string;
  callbackHost: string;
  callbackPort: number;
  google: {
    clientId: string;
    redirectUri: string;
  };
}

interface PendingAuthState {
  stateToken: string;
  createdAt: number;
  deviceName?: string;
  // PKCE code verifier (stored for token exchange)
  codeVerifier?: string;
  // Populated after successful callback
  sessionToken?: string;
  userId?: string;
  email?: string;
  name?: string | null;
}

interface EncryptedData {
  ciphertext: string;
  iv: string;
}

interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

// ============================================
// CONSTANTS
// ============================================

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// ============================================
// AUTH SERVICE
// ============================================

export class AuthService {
  private config: AuthServiceConfig;
  private store: GraphStore;
  private masterKey: Buffer | null = null;
  private pendingAuthStates = new Map<string, PendingAuthState>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private callbackServer: Server | null = null;
  private logger: HarnessLogger;

  constructor(config: AuthServiceConfig, logger: HarnessLogger = stderrLogger) {
    this.config = config;
    this.logger = logger;
    this.store = new GraphStore(config.graphdDbPath);
    this.store.initialize();

    // Clean up old pending states every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanupPendingStates(), 5 * 60 * 1000);

    // Start callback server for OAuth redirect
    this.startCallbackServer();
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }
    this.store.close();
  }

  private startCallbackServer(): void {
    this.callbackServer = createServer((req, res) => this.handleHttpRequest(req, res));
    this.callbackServer.listen(this.config.callbackPort, this.config.callbackHost, () => {
      this.logger.info(`[auth-service] OAuth callback server listening on http://${this.config.callbackHost}:${this.config.callbackPort}`);
    });
    this.callbackServer.on('error', (err) => {
      this.logger.error(`[auth-service] Callback server error: ${err}`);
    });
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(this.errorPage('Missing code or state parameter'));
        return;
      }

      this.handleCallback(code, state)
        .then((result) => {
          if (result.success) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this.successPage(result.email ?? 'Unknown'));
          } else {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(this.errorPage(result.error ?? 'Authentication failed'));
          }
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(this.errorPage(err instanceof Error ? err.message : 'Internal error'));
        });
      return;
    }

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private successPage(email: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0d1117; color: #c9d1d9; }
    .container { text-align: center; padding: 40px; border: 1px solid #30363d; border-radius: 12px; background: #161b22; }
    h1 { color: #58a6ff; margin-bottom: 16px; }
    p { margin: 8px 0; }
    .email { color: #8b949e; }
    .success { color: #3fb950; font-size: 48px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">✓</div>
    <h1>Signed In Successfully</h1>
    <p>Welcome, <strong>${email}</strong></p>
    <p class="email">You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`;
  }

  private errorPage(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>Authentication Failed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0d1117; color: #c9d1d9; }
    .container { text-align: center; padding: 40px; border: 1px solid #30363d; border-radius: 12px; background: #161b22; }
    h1 { color: #f85149; margin-bottom: 16px; }
    p { margin: 8px 0; color: #8b949e; }
    .error { color: #f85149; font-size: 48px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="error">✗</div>
    <h1>Authentication Failed</h1>
    <p>${message}</p>
    <p>Please close this window and try again.</p>
  </div>
</body>
</html>`;
  }

  // =========================================================================
  // OAuth Flow
  // =========================================================================

  /**
   * Start the OAuth flow with PKCE. Returns auth URL and state token.
   * Uses PKCE (Proof Key for Code Exchange) - no client secret required.
   */
  startAuth(deviceName?: string): { authUrl: string; stateToken: string } {
    const stateToken = this.generateStateToken();
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);

    this.pendingAuthStates.set(stateToken, {
      stateToken,
      createdAt: Date.now(),
      deviceName,
      codeVerifier, // Store for token exchange
    });

    const params = new URLSearchParams({
      client_id: this.config.google.clientId,
      redirect_uri: this.config.google.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: stateToken,
      access_type: 'offline',
      prompt: 'consent',
      // PKCE parameters
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return {
      authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
      stateToken,
    };
  }

  /**
   * Handle OAuth callback. Called when user completes sign-in.
   */
  async handleCallback(code: string, state: string): Promise<{
    success: boolean;
    error?: string;
    sessionToken?: string;
    email?: string;
  }> {
    const pendingState = this.pendingAuthStates.get(state);
    if (!pendingState) {
      return { success: false, error: 'Invalid or expired state token' };
    }
    if (!pendingState.codeVerifier) {
      return { success: false, error: 'Missing PKCE code verifier' };
    }
    this.pendingAuthStates.delete(state);

    try {
      // Exchange code for tokens using PKCE
      const tokens = await this.exchangeCodeForTokens(code, pendingState.codeVerifier);

      // Fetch user info
      const userInfo = await this.fetchUserInfo(tokens.access_token);

      // Create/update user
      const user = this.store.upsertUser(
        userInfo.sub,
        userInfo.email,
        userInfo.name,
        userInfo.picture
      );

      // Create session
      const sessionToken = this.generateSessionToken();
      this.store.createUserSession(sessionToken, user.id, pendingState.deviceName);

      // Store for polling
      this.pendingAuthStates.set(`session:${state}`, {
        stateToken: sessionToken,
        createdAt: Date.now(),
        deviceName: pendingState.deviceName,
        sessionToken,
        userId: user.id,
        email: user.email,
        name: user.name,
      });

      return { success: true, sessionToken, email: user.email };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Authentication failed',
      };
    }
  }

  /**
   * Poll for completed session.
   */
  pollSession(stateToken: string): {
    pending: boolean;
    sessionToken?: string;
    userId?: string;
    email?: string;
    name?: string | null;
  } {
    const sessionData = this.pendingAuthStates.get(`session:${stateToken}`);
    if (!sessionData || !sessionData.sessionToken) {
      return { pending: true };
    }

    // Clean up
    this.pendingAuthStates.delete(`session:${stateToken}`);

    return {
      pending: false,
      sessionToken: sessionData.sessionToken,
      userId: sessionData.userId,
      email: sessionData.email,
      name: sessionData.name,
    };
  }

  /**
   * Verify a session token.
   */
  verifySession(sessionToken: string): {
    valid: boolean;
    user?: { id: string; email: string; name: string | null };
  } {
    const session = this.store.validateUserSession(sessionToken);
    if (!session) {
      return { valid: false };
    }

    const user = this.store.getUser(session.userId);
    if (!user) {
      return { valid: false };
    }

    return {
      valid: true,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /**
   * Logout (revoke session).
   */
  logout(sessionToken: string): boolean {
    return this.store.revokeUserSession(sessionToken);
  }

  // =========================================================================
  // Provider Credentials
  // =========================================================================

  /**
   * List configured providers for a user.
   */
  listProviders(sessionToken: string): {
    success: boolean;
    error?: string;
    providers?: Array<{ provider: string; configured: boolean; updatedAt?: number }>;
  } {
    const session = this.store.validateUserSession(sessionToken);
    if (!session) {
      return { success: false, error: 'Invalid session' };
    }

    const credentials = this.store.listProviderCredentials(session.userId);
    const allProviders = [
      'anthropic', 'openai', 'openai-compat', 'vercel-gateway', 'gemini',
      'cerebras', 'together', 'groq', 'fireworks',
    ];

    const providers = allProviders.map((provider) => {
      const cred = credentials.find((c) => c.provider === provider);
      return {
        provider,
        configured: !!cred,
        updatedAt: cred?.updatedAt,
      };
    });

    return { success: true, providers };
  }

  /**
   * Save an API key for a provider.
   */
  saveProviderKey(sessionToken: string, provider: string, apiKey: string): {
    success: boolean;
    error?: string;
  } {
    const session = this.store.validateUserSession(sessionToken);
    if (!session) {
      return { success: false, error: 'Invalid session' };
    }

    const masterKey = this.getMasterKey();
    const encrypted = this.encrypt(apiKey, masterKey);
    const credentialId = `cred_${randomBytes(12).toString('hex')}`;

    this.store.upsertProviderCredential(
      credentialId,
      session.userId,
      provider,
      encrypted.ciphertext,
      encrypted.iv
    );

    return { success: true };
  }

  /**
   * Delete a provider's API key.
   */
  deleteProviderKey(sessionToken: string, provider: string): {
    success: boolean;
    error?: string;
  } {
    const session = this.store.validateUserSession(sessionToken);
    if (!session) {
      return { success: false, error: 'Invalid session' };
    }

    const deleted = this.store.deleteProviderCredential(session.userId, provider);
    return { success: deleted };
  }

  /**
   * Test a provider's API key.
   */
  async testProviderKey(sessionToken: string, provider: string): Promise<{
    valid: boolean;
    error?: string;
  }> {
    const session = this.store.validateUserSession(sessionToken);
    if (!session) {
      return { valid: false, error: 'Invalid session' };
    }

    const credential = this.store.getProviderCredential(session.userId, provider);
    if (!credential) {
      return { valid: false, error: 'No API key configured' };
    }

    const masterKey = this.getMasterKey();
    const apiKey = this.decrypt(
      { ciphertext: credential.encryptedKey, iv: credential.iv },
      masterKey
    );

    try {
      const valid = await this.testApiKey(provider, apiKey);
      return { valid };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Test failed' };
    }
  }

  /**
   * Get a decrypted API key for a provider (for internal use by harness).
   */
  getProviderApiKey(userId: string, provider: string): string | null {
    const credential = this.store.getProviderCredential(userId, provider);
    if (!credential) {
      return null;
    }

    const masterKey = this.getMasterKey();
    return this.decrypt(
      { ciphertext: credential.encryptedKey, iv: credential.iv },
      masterKey
    );
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<GoogleTokenResponse> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.google.clientId,
        redirect_uri: this.config.google.redirectUri,
        grant_type: 'authorization_code',
        // PKCE: use code_verifier instead of client_secret
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${await response.text()}`);
    }

    return response.json() as Promise<GoogleTokenResponse>;
  }

  private async fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`User info fetch failed: ${await response.text()}`);
    }

    return response.json() as Promise<GoogleUserInfo>;
  }

  private getMasterKey(): Buffer {
    if (this.masterKey) {
      return this.masterKey;
    }

    const keyPath = this.config.masterKeyPath;

    // Check if key file exists
    if (existsSync(keyPath)) {
      const keyHex = readFileSync(keyPath, 'utf-8').trim();
      this.masterKey = Buffer.from(keyHex, 'hex');
      return this.masterKey;
    }

    // Generate new key
    this.logger.info(`[auth-service] Generating master key at ${keyPath}`);
    const newKey = randomBytes(KEY_LENGTH);
    const keyDir = dirname(keyPath);
    if (!existsSync(keyDir)) {
      mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(keyPath, newKey.toString('hex'), { mode: 0o600 });
    this.masterKey = newKey;
    return this.masterKey;
  }

  private encrypt(plaintext: string, masterKey: Buffer): EncryptedData {
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

  private decrypt(encrypted: EncryptedData, masterKey: Buffer): string {
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

  private generateSessionToken(): string {
    return randomBytes(32).toString('hex');
  }

  private generateStateToken(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Generate a cryptographically random code verifier for PKCE.
   * Must be 43-128 characters, using unreserved URI characters.
   */
  private generateCodeVerifier(): string {
    // 32 bytes = 43 base64url characters
    return randomBytes(32)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 43);
  }

  /**
   * Generate code challenge from verifier using S256 method.
   */
  private generateCodeChallenge(verifier: string): string {
    return createHash('sha256')
      .update(verifier)
      .digest('base64url');
  }

  private cleanupPendingStates(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    for (const [token, state] of this.pendingAuthStates) {
      if (now - state.createdAt > maxAge) {
        this.pendingAuthStates.delete(token);
      }
    }
  }
}

/**
 * Default Google OAuth client ID for Nova CLI.
 * This is a "Desktop" type OAuth client - no secret required with PKCE.
 *
 * To use your own client ID, set GOOGLE_CLIENT_ID environment variable.
 * Create a "Desktop" type OAuth client in Google Cloud Console.
 */
const DEFAULT_GOOGLE_CLIENT_ID = process.env.NOVA_GOOGLE_CLIENT_ID ?? '380690977483-43jcgqd6g58ev7514pr1onk5diaiikqb.apps.googleusercontent.com';

/**
 * Create auth service from environment.
 * Uses PKCE flow - no client secret required.
 */
export function createAuthServiceFromEnv(logger: HarnessLogger = stderrLogger): AuthService | null {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? DEFAULT_GOOGLE_CLIENT_ID;

  if (!clientId) {
    logger.info('[auth-service] Google OAuth not configured (no GOOGLE_CLIENT_ID)');
    return null;
  }

  const host = process.env.AUTH_SERVICE_HOST ?? '127.0.0.1';
  const port = process.env.AUTH_SERVICE_PORT ?? '9556';
  const graphdDbPath = process.env.GRAPHD_DB_PATH ?? join(homedir(), '.graphd', 'graphd.db');
  const masterKeyPath = process.env.HARNESS_MASTER_KEY_PATH ?? join(homedir(), '.config', 'harness', 'master.key');
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `http://${host}:${port}/auth/google/callback`;

  return new AuthService({
    graphdDbPath,
    masterKeyPath,
    callbackHost: host,
    callbackPort: parseInt(port, 10),
    google: { clientId, redirectUri },
  }, logger);
}

/**
 * Create auth service from config file.
 * Reads configuration from the auth section of harness_config.json.
 */
export function createAuthServiceFromConfig(
  authConfig: { enabled: boolean; host: string; port: number; google_client_id?: string; google_redirect_uri?: string; master_key_path?: string; graphd_db_path?: string } | undefined,
  logger: HarnessLogger = stderrLogger
): AuthService | null {
  if (!authConfig?.enabled) {
    logger.info('[auth-service] Auth service not enabled in config');
    return null;
  }

  const clientId = authConfig.google_client_id ?? DEFAULT_GOOGLE_CLIENT_ID;
  if (!clientId) {
    logger.info('[auth-service] Google OAuth not configured (no google_client_id in config)');
    return null;
  }

  const host = authConfig.host ?? '127.0.0.1';
  const port = authConfig.port ?? 9556;
  const graphdDbPath = authConfig.graphd_db_path ?? join(homedir(), '.graphd', 'graphd.db');
  const masterKeyPath = authConfig.master_key_path ?? join(homedir(), '.config', 'harness', 'master.key');
  const redirectUri = authConfig.google_redirect_uri ?? `http://${host}:${port}/auth/google/callback`;

  return new AuthService({
    graphdDbPath,
    masterKeyPath,
    callbackHost: host,
    callbackPort: port,
    google: { clientId, redirectUri },
  }, logger);
}
