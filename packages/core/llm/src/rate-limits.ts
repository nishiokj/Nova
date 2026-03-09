/**
 * Rate limit parsing and error creation utilities.
 *
 * Extracted from adapter.ts for better code organization.
 */

import type { RateLimitInfo, RateLimitType } from './policies.js';
import { RateLimitError } from './policies.js';

/**
 * Parse rate limit headers from a Response object.
 * Supports OpenAI, Anthropic, and OpenAI-compatible providers (Cerebras, Groq, etc.)
 */
export function parseRateLimitHeaders(headers: Headers): Partial<RateLimitInfo> {
  const result: Partial<RateLimitInfo> = {};

  // retry-after header (standard, in seconds)
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      result.retryAfterMs = seconds * 1000;
    }
  }

  // x-ratelimit-reset-* headers (OpenAI/Anthropic/Cerebras)
  // These can be timestamps or durations
  const resetRequests = headers.get('x-ratelimit-reset-requests');
  const resetTokens = headers.get('x-ratelimit-reset-tokens');
  const resetMs = headers.get('x-ratelimit-reset-ms'); // Cerebras specific

  if (resetMs) {
    const ms = parseInt(resetMs, 10);
    if (!isNaN(ms)) {
      result.retryAfterMs = ms;
    }
  } else if (resetRequests || resetTokens) {
    // Parse duration strings like "1s", "500ms", "2m30s"
    const parseResetDuration = (val: string): number | undefined => {
      // Try parsing as duration (e.g., "1s", "500ms", "2m30s")
      const msMatch = /^(\d+)ms$/.exec(val);
      if (msMatch) return parseInt(msMatch[1], 10);

      const sMatch = /^(\d+)s$/.exec(val);
      if (sMatch) return parseInt(sMatch[1], 10) * 1000;

      const mMatch = /^(\d+)m$/.exec(val);
      if (mMatch) return parseInt(mMatch[1], 10) * 60 * 1000;

      // Try parsing as seconds number
      const num = parseFloat(val);
      if (!isNaN(num) && num < 1000000) return num * 1000; // Assume seconds if small

      // Try parsing as timestamp
      const timestamp = Date.parse(val);
      if (!isNaN(timestamp)) {
        const waitMs = timestamp - Date.now();
        return waitMs > 0 ? waitMs : undefined;
      }
      return undefined;
    };

    const requestWait = resetRequests ? parseResetDuration(resetRequests) : undefined;
    const tokenWait = resetTokens ? parseResetDuration(resetTokens) : undefined;

    // Use the longer wait time
    if (requestWait !== undefined || tokenWait !== undefined) {
      result.retryAfterMs = Math.max(requestWait ?? 0, tokenWait ?? 0);
    }
  }

  // Remaining counts
  const remainingRequests = headers.get('x-ratelimit-remaining-requests');
  const remainingTokens = headers.get('x-ratelimit-remaining-tokens');
  if (remainingRequests !== null) {
    const remaining = parseInt(remainingRequests, 10);
    if (!isNaN(remaining)) {
      result.remaining = remaining;
      result.limitType = 'requests';
    }
  }
  if (remainingTokens !== null) {
    const remaining = parseInt(remainingTokens, 10);
    if (!isNaN(remaining) && (result.remaining === undefined || remaining < result.remaining)) {
      result.remaining = remaining;
      result.limitType = 'tokens';
    }
  }

  return result;
}

/**
 * Classify rate limit type from error message content.
 */
export function classifyRateLimitType(errorMessage: string, retryAfterMs?: number): RateLimitType {
  const lower = errorMessage.toLowerCase();

  // Billing/payment issues
  if (
    lower.includes('billing') ||
    lower.includes('payment') ||
    lower.includes('insufficient') ||
    lower.includes('credit') ||
    lower.includes('subscription')
  ) {
    return 'billing';
  }

  // Quota exhaustion (daily/weekly/monthly limits)
  if (
    lower.includes('quota') ||
    lower.includes('daily') ||
    lower.includes('weekly') ||
    lower.includes('monthly') ||
    lower.includes('exceeded your') ||
    lower.includes('limit exceeded') && (lower.includes('day') || lower.includes('month'))
  ) {
    return 'quota';
  }

  // Short window rate limit (per-minute, per-second)
  if (
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('requests per') ||
    lower.includes('tokens per')
  ) {
    // If we have retry-after and it's short, it's a window limit
    if (retryAfterMs !== undefined && retryAfterMs <= 120000) {
      return 'window';
    }
    // Default to window for generic rate limits (most common case)
    return 'window';
  }

  return 'unknown';
}

/**
 * Create a RateLimitError from a 429 response.
 */
export function createRateLimitError(
  provider: string,
  model: string,
  status: number,
  headers: Headers,
  responseText: string
): RateLimitError {
  const headerInfo = parseRateLimitHeaders(headers);

  // Parse the error message
  let errorMessage = responseText;
  try {
    const parsed = JSON.parse(responseText);
    errorMessage = parsed?.error?.message ?? parsed?.message ?? responseText;
  } catch {
    // Keep original text
  }

  const rateLimitType = classifyRateLimitType(errorMessage, headerInfo.retryAfterMs);

  const info: RateLimitInfo = {
    type: rateLimitType,
    retryAfterMs: headerInfo.retryAfterMs,
    limitType: headerInfo.limitType,
    remaining: headerInfo.remaining,
    message: errorMessage,
  };

  const displayWait = info.retryAfterMs
    ? ` (retry after ${Math.ceil(info.retryAfterMs / 1000)}s)`
    : '';

  return new RateLimitError(
    `${provider} rate limit [${rateLimitType}]: ${errorMessage}${displayWait}`,
    info,
    provider,
    model,
    status
  );
}
