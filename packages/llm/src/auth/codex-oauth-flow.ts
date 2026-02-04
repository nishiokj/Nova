/**
 * Orchestrates the Codex OAuth flow for CLI/TUI environments.
 *
 * Flow:
 * 1. Generate PKCE challenge
 * 2. Start local HTTP server for callback
 * 3. Open browser to auth URL
 * 4. Wait for callback with auth code
 * 5. Exchange code for tokens
 * 6. Store tokens
 */

import { createServer } from 'http';
import { URL } from 'url';
import { randomBytes } from 'crypto';
import {
  CODEX_OAUTH_CONFIG,
  generatePKCE,
  buildAuthUrl,
  exchangeCodeForTokens,
  getCodexTokenManager,
} from './codex-auth.js';

export interface OAuthFlowCallbacks {
  onAuthUrl: (url: string) => void;
  onSuccess: () => void;
  onError: (error: Error) => void;
}

/**
 * Run the OAuth flow and return when complete.
 * Opens browser, waits for callback, exchanges tokens.
 */
export async function runCodexOAuthFlow(callbacks: OAuthFlowCallbacks): Promise<void> {
  const pkce = generatePKCE();
  const state = randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:8976`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400);
        res.end(`OAuth error: ${error}`);
        server.close();
        const err = new Error(`OAuth error: ${error}`);
        callbacks.onError(err);
        reject(err);
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400);
        res.end('State mismatch - possible CSRF attack');
        server.close();
        const err = new Error('OAuth state mismatch');
        callbacks.onError(err);
        reject(err);
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        server.close();
        const err = new Error('Missing authorization code');
        callbacks.onError(err);
        reject(err);
        return;
      }

      try {
        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(CODEX_OAUTH_CONFIG, code, pkce.verifier);

        // Store tokens
        const tokenManager = getCodexTokenManager();
        await tokenManager.storeTokens(tokens);

        // Success response
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: system-ui; text-align: center; padding: 50px;">
              <h1>Authentication Successful</h1>
              <p>You can close this window and return to the terminal.</p>
            </body>
          </html>
        `);

        server.close();
        callbacks.onSuccess();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end(`Token exchange failed: ${err}`);
        server.close();
        const error = err instanceof Error ? err : new Error(String(err));
        callbacks.onError(error);
        reject(error);
      }
    });

    server.listen(8976, '127.0.0.1', () => {
      const authUrl = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      callbacks.onAuthUrl(authUrl);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      const err = new Error('OAuth flow timed out');
      callbacks.onError(err);
      reject(err);
    }, 5 * 60 * 1000);
  });
}

/**
 * Check if Codex OAuth is configured.
 */
export async function isCodexAuthenticated(): Promise<boolean> {
  const tokenManager = getCodexTokenManager();
  await tokenManager.initialize();
  return tokenManager.hasTokens();
}

/**
 * Logout from Codex (clear tokens).
 */
export async function logoutCodex(): Promise<void> {
  const tokenManager = getCodexTokenManager();
  await tokenManager.clearTokens();
}
