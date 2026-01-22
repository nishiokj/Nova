/**
 * Provider key retrieval for skill scripts.
 *
 * Uses environment variables for API key configuration.
 * This keeps skill scripts portable and independent of the harness daemon.
 */

/**
 * Get a provider API key from environment variables.
 *
 * Checks common naming conventions:
 * - ${PROVIDER}_API_TOKEN (e.g., REPLICATE_API_TOKEN)
 * - ${PROVIDER}_API_KEY (e.g., REPLICATE_API_KEY)
 */
export function getProviderKey(provider: string): string | null {
  const upperProvider = provider.toUpperCase();

  // Check primary env var (TOKEN variant)
  const tokenVar = `${upperProvider}_API_TOKEN`;
  if (process.env[tokenVar]) {
    return process.env[tokenVar]!.trim();
  }

  // Check alternate env var (KEY variant)
  const keyVar = `${upperProvider}_API_KEY`;
  if (process.env[keyVar]) {
    return process.env[keyVar]!.trim();
  }

  return null;
}

/**
 * Check if a provider is configured.
 */
export function isProviderConfigured(provider: string): boolean {
  return getProviderKey(provider) !== null;
}
