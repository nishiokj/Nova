import { CircuitOpenError, RateLimitError, RetriesExhaustedError } from 'llm';
import type { RateLimitData } from 'types';

export function getRateLimitInfo(error: RateLimitError): { userMessage: string; rateLimitData: RateLimitData } {
  const rateLimitInfo = error.info;
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

export function getCircuitOpenMessage(_error: CircuitOpenError): string {
  return '⚠️ Service temporarily unavailable (circuit breaker open). Please wait a moment and try again. Your conversation has been saved.';
}

export function getRetriesExhaustedMessage(error: RetriesExhaustedError): string {
  return `⚠️ Request failed after ${error.attempts} attempts. Please wait a moment and try again. Your conversation has been saved.`;
}

export function getGenericErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
