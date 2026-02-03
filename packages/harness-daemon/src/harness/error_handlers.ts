/**
 * Recoverable Error Handlers - Unified error classification and messaging.
 *
 * Consolidates near-identical error handling blocks into a single classification function.
 */

import { RateLimitError, CircuitOpenError, RetriesExhaustedError } from 'llm';
import type { RateLimitData } from 'types';

/**
 * Result of classifying a recoverable error.
 * Contains all info needed to handle the error uniformly.
 */
export interface RecoverableErrorResult {
  /** User-facing message explaining what happened */
  userMessage: string;
  /** Log level for this error type */
  logLevel: 'warning' | 'error';
  /** Structured metadata for logging */
  logMeta: Record<string, unknown>;
  /** Optional rate limit event data (for RateLimitError) */
  rateLimitData?: RateLimitData;
}

/**
 * Classify an error as recoverable or not.
 * Returns classification info if recoverable, null if it should fall through to generic handling.
 */
export function classifyRecoverableError(
  error: unknown,
  requestId: string
): RecoverableErrorResult | null {
  // Rate limit errors - most detailed handling
  if (RateLimitError.isRateLimitError(error)) {
    const rateLimitInfo = error.info;
    const logMeta = {
      requestId,
      provider: error.provider,
      model: error.model,
      type: rateLimitInfo.type,
      retryAfterMs: rateLimitInfo.retryAfterMs,
      limitType: rateLimitInfo.limitType,
    };

    let userMessage: string;
    if (rateLimitInfo.type === 'billing') {
      userMessage = `⚠️ Billing limit reached for ${error.provider}. Please check your account billing status. Your conversation has been saved.`;
    } else if (rateLimitInfo.type === 'quota') {
      userMessage = `⚠️ API quota exceeded for ${error.provider} (${rateLimitInfo.limitType ?? 'requests'}). This may be a daily or monthly limit. Your conversation has been saved.`;
    } else {
      const waitTime = rateLimitInfo.retryAfterMs
        ? ` Please wait ${Math.ceil(rateLimitInfo.retryAfterMs / 1000)} seconds and try again.`
        : ' Please wait a moment and try again.';
      userMessage = `⚠️ Rate limit reached for ${error.provider}.${waitTime} Your conversation has been saved.`;
    }

    return {
      userMessage,
      logLevel: 'warning',
      logMeta,
      rateLimitData: {
        provider: error.provider,
        model: error.model,
        type: rateLimitInfo.type,
        retryAfterMs: rateLimitInfo.retryAfterMs,
        limitType: rateLimitInfo.limitType,
        message: rateLimitInfo.message,
        contextPreserved: true,
      },
    };
  }

  // Circuit breaker errors
  if (error instanceof CircuitOpenError) {
    return {
      userMessage: '⚠️ Service temporarily unavailable (circuit breaker open). Please wait a moment and try again. Your conversation has been saved.',
      logLevel: 'warning',
      logMeta: { requestId, message: error.message },
    };
  }

  // Retries exhausted errors
  if (error instanceof RetriesExhaustedError) {
    const causeMessage = error.cause instanceof Error ? error.cause.message : String(error.cause ?? '');
    return {
      userMessage: `⚠️ Request failed after ${error.attempts} attempts. Please wait a moment and try again. Your conversation has been saved.`,
      logLevel: 'warning',
      logMeta: { requestId, attempts: error.attempts, cause: causeMessage },
    };
  }

  // Not a recoverable error - fall through to generic handling
  return null;
}

/**
 * Get the error message from an unknown error value.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
