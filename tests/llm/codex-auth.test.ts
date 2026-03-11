/**
 * Behavioral tests for Codex OAuth pure functions.
 *
 * Covers:
 * - generatePKCE: verifier/challenge generation and cryptographic correctness
 * - buildAuthUrl: URL construction with correct query parameters
 * - CODEX_OAUTH_CONFIG: constant shape and values
 *
 * Does NOT test filesystem or network operations.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { generatePKCE, buildAuthUrl, CODEX_OAUTH_CONFIG } from 'llm/auth/codex-auth.js';

// ============================================
// CODEX_OAUTH_CONFIG
// ============================================

describe('CODEX_OAUTH_CONFIG', () => {
  it('has the expected clientId', () => {
    expect(CODEX_OAUTH_CONFIG.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
  });

  it('has the OpenAI auth endpoint', () => {
    expect(CODEX_OAUTH_CONFIG.authEndpoint).toBe('https://auth.openai.com/oauth/authorize');
  });

  it('has the OpenAI token endpoint', () => {
    expect(CODEX_OAUTH_CONFIG.tokenEndpoint).toBe('https://auth.openai.com/oauth/token');
  });

  it('redirects to localhost on port 1455', () => {
    expect(CODEX_OAUTH_CONFIG.redirectUri).toBe('http://localhost:1455/auth/callback');
  });

  it('requests offline_access scope for refresh tokens', () => {
    expect(CODEX_OAUTH_CONFIG.scope).toContain('offline_access');
  });

  it('requests openid scope', () => {
    expect(CODEX_OAUTH_CONFIG.scope).toContain('openid');
  });

  it('requests profile scope', () => {
    expect(CODEX_OAUTH_CONFIG.scope).toContain('profile');
  });

  it('requests email scope', () => {
    expect(CODEX_OAUTH_CONFIG.scope).toContain('email');
  });

  it('has exactly 5 keys', () => {
    expect(Object.keys(CODEX_OAUTH_CONFIG)).toHaveLength(5);
  });
});

// ============================================
// generatePKCE
// ============================================

describe('generatePKCE', () => {
  describe('verifier', () => {
    it('returns a string verifier', () => {
      const { verifier } = generatePKCE();
      expect(typeof verifier).toBe('string');
    });

    it('verifier is base64url-encoded (no +, /, or = characters)', () => {
      // Run multiple times to catch probabilistic issues
      for (let i = 0; i < 10; i++) {
        const { verifier } = generatePKCE();
        expect(verifier).not.toMatch(/[+/=]/);
      }
    });

    it('verifier is base64url of 32 random bytes (43 chars)', () => {
      const { verifier } = generatePKCE();
      // 32 bytes -> ceil(32 * 4/3) = 43 base64url chars (no padding)
      expect(verifier).toHaveLength(43);
    });

    it('generates unique verifiers across calls', () => {
      const verifiers = new Set<string>();
      for (let i = 0; i < 20; i++) {
        verifiers.add(generatePKCE().verifier);
      }
      expect(verifiers.size).toBe(20);
    });

    it('verifier only contains base64url characters', () => {
      const { verifier } = generatePKCE();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('challenge', () => {
    it('returns a string challenge', () => {
      const { challenge } = generatePKCE();
      expect(typeof challenge).toBe('string');
    });

    it('challenge is base64url-encoded SHA256 of verifier (43 chars)', () => {
      const { challenge } = generatePKCE();
      // SHA256 = 32 bytes -> 43 base64url chars
      expect(challenge).toHaveLength(43);
    });

    it('challenge only contains base64url characters', () => {
      const { challenge } = generatePKCE();
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('challenge is the SHA256 of the verifier (cryptographic verification)', () => {
      const { verifier, challenge } = generatePKCE();

      const recomputed = createHash('sha256')
        .update(verifier)
        .digest('base64url');

      expect(challenge).toBe(recomputed);
    });

    it('cryptographic verification holds across multiple generations', () => {
      for (let i = 0; i < 10; i++) {
        const { verifier, challenge } = generatePKCE();
        const recomputed = createHash('sha256')
          .update(verifier)
          .digest('base64url');
        expect(challenge).toBe(recomputed);
      }
    });

    it('different verifiers produce different challenges', () => {
      const a = generatePKCE();
      const b = generatePKCE();

      // Different verifiers -> different challenges (collision probability negligible)
      expect(a.verifier).not.toBe(b.verifier);
      expect(a.challenge).not.toBe(b.challenge);
    });
  });

  describe('return shape', () => {
    it('returns an object with exactly verifier and challenge keys', () => {
      const result = generatePKCE();
      expect(Object.keys(result).sort()).toEqual(['challenge', 'verifier']);
    });
  });
});

// ============================================
// buildAuthUrl
// ============================================

describe('buildAuthUrl', () => {
  const pkce = { verifier: 'test_verifier_value', challenge: 'test_challenge_value' };
  const state = 'random_state_123';

  describe('URL structure', () => {
    it('starts with the config authEndpoint', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      expect(url.startsWith(CODEX_OAUTH_CONFIG.authEndpoint)).toBe(true);
    });

    it('separates endpoint from params with ?', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const [base, queryString] = url.split('?');

      expect(base).toBe(CODEX_OAUTH_CONFIG.authEndpoint);
      expect(queryString).toBeDefined();
      expect(queryString.length).toBeGreaterThan(0);
    });

    it('is a valid URL', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const parsed = new URL(url);

      expect(parsed.protocol).toBe('https:');
      expect(parsed.hostname).toBe('auth.openai.com');
    });
  });

  describe('required query parameters', () => {
    it('includes client_id from config', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const params = new URL(url).searchParams;

      expect(params.get('client_id')).toBe(CODEX_OAUTH_CONFIG.clientId);
    });

    it('includes redirect_uri from config', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const params = new URL(url).searchParams;

      expect(params.get('redirect_uri')).toBe(CODEX_OAUTH_CONFIG.redirectUri);
    });

    it('sets response_type to code', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const params = new URL(url).searchParams;

      expect(params.get('response_type')).toBe('code');
    });

    it('includes scope from config', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const params = new URL(url).searchParams;

      expect(params.get('scope')).toBe(CODEX_OAUTH_CONFIG.scope);
    });

    it('includes code_challenge from pkce', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const params = new URL(url).searchParams;

      expect(params.get('code_challenge')).toBe(pkce.challenge);
    });

    it('sets code_challenge_method to S256', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const params = new URL(url).searchParams;

      expect(params.get('code_challenge_method')).toBe('S256');
    });

    it('includes state parameter', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const params = new URL(url).searchParams;

      expect(params.get('state')).toBe(state);
    });

    it('has exactly 7 query parameters', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);
      const params = new URL(url).searchParams;
      const keys = [...params.keys()];

      expect(keys).toHaveLength(7);
    });
  });

  describe('does NOT leak the verifier', () => {
    it('URL contains challenge but not verifier', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, state);

      expect(url).toContain(pkce.challenge);
      expect(url).not.toContain(pkce.verifier);
    });
  });

  describe('custom config', () => {
    it('uses a custom config clientId and endpoint', () => {
      const customConfig = {
        clientId: 'custom_client',
        authEndpoint: 'https://custom.auth.com/authorize',
        tokenEndpoint: 'https://custom.auth.com/token',
        redirectUri: 'http://localhost:9999/callback',
        scope: 'custom_scope',
      };
      const url = buildAuthUrl(customConfig, pkce, state);
      const params = new URL(url).searchParams;

      expect(url.startsWith('https://custom.auth.com/authorize?')).toBe(true);
      expect(params.get('client_id')).toBe('custom_client');
      expect(params.get('redirect_uri')).toBe('http://localhost:9999/callback');
      expect(params.get('scope')).toBe('custom_scope');
    });
  });

  describe('special characters in state', () => {
    it('URL-encodes state with special characters', () => {
      const specialState = 'state with spaces & symbols=yes';
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, specialState);
      const params = new URL(url).searchParams;

      expect(params.get('state')).toBe(specialState);
    });

    it('handles empty state', () => {
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, pkce, '');
      const params = new URL(url).searchParams;

      expect(params.get('state')).toBe('');
    });
  });

  describe('integration with generatePKCE', () => {
    it('produces a valid URL when given a real PKCE pair', () => {
      const realPkce = generatePKCE();
      const url = buildAuthUrl(CODEX_OAUTH_CONFIG, realPkce, 'live_state');
      const params = new URL(url).searchParams;

      expect(params.get('code_challenge')).toBe(realPkce.challenge);
      expect(params.get('code_challenge_method')).toBe('S256');

      // Verify the challenge in the URL matches SHA256 of the verifier
      const recomputed = createHash('sha256')
        .update(realPkce.verifier)
        .digest('base64url');
      expect(params.get('code_challenge')).toBe(recomputed);
    });
  });
});
