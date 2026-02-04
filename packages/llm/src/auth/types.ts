/**
 * OAuth token storage format.
 * Compatible with Codex CLI's ~/.codex/auth.json for interoperability.
 */
export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_at: number; // Unix timestamp (seconds)
  scope?: string;
}

/**
 * PKCE challenge pair for OAuth flow.
 */
export interface PKCEChallenge {
  verifier: string; // Random 43-128 char string
  challenge: string; // Base64url(SHA256(verifier))
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
