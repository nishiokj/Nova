/**
 * Zod schemas for LLM API response validation.
 *
 * These schemas validate API responses from OpenAI and Anthropic,
 * providing structured error parsing and response validation.
 */

import { z } from 'zod';

// ============================================
// ERROR SCHEMAS
// ============================================

/**
 * OpenAI error format: { error: { message, type, code, param } }
 */
export const OpenAIErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.string().optional(),
    param: z.string().nullable().optional(),
  }),
});

/**
 * Anthropic error format: { type, error: { type, message } }
 */
export const AnthropicErrorSchema = z.object({
  type: z.string().optional(),
  error: z.object({
    type: z.string(),
    message: z.string(),
  }),
});

/**
 * Generic error with message field.
 */
export const GenericErrorSchema = z.object({
  message: z.string(),
});

// ============================================
// RESPONSE SCHEMAS
// ============================================

/**
 * OpenAI chat completion response.
 */
export const OpenAIChatCompletionSchema = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  model: z.string().optional(),
  choices: z.array(z.object({
    index: z.number().optional(),
    message: z.object({
      role: z.string(),
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      })).optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number().optional(),
  }).optional(),
});

/**
 * Anthropic content block types.
 */
export const AnthropicContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  }),
]);

/**
 * Anthropic message response.
 */
export const AnthropicMessageSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  role: z.string().optional(),
  content: z.array(AnthropicContentBlockSchema),
  model: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }).optional(),
});

// ============================================
// INFERRED TYPES
// ============================================

export type OpenAIError = z.infer<typeof OpenAIErrorSchema>;
export type AnthropicError = z.infer<typeof AnthropicErrorSchema>;
export type OpenAIChatCompletion = z.infer<typeof OpenAIChatCompletionSchema>;
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>;

// ============================================
// ERROR PARSING FUNCTIONS
// ============================================

/**
 * Parsed API error with structured information.
 */
export interface ParsedApiError {
  message: string;
  type?: string;
  code?: string;
  param?: string;
  provider: 'openai' | 'anthropic' | 'unknown';
}

/**
 * Parse an API error response to extract structured information.
 * Uses Zod schemas for type-safe parsing.
 */
export function parseApiErrorResponse(
  provider: string,
  status: number,
  responseText: string
): ParsedApiError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return {
      message: truncateError(responseText),
      provider: 'unknown',
    };
  }

  // Try OpenAI error format
  const openaiResult = OpenAIErrorSchema.safeParse(parsed);
  if (openaiResult.success) {
    const { message, type, code, param } = openaiResult.data.error;
    return {
      message,
      type: type ?? undefined,
      code: code ?? undefined,
      param: param ?? undefined,
      provider: 'openai',
    };
  }

  // Try Anthropic error format
  const anthropicResult = AnthropicErrorSchema.safeParse(parsed);
  if (anthropicResult.success) {
    const { type, message } = anthropicResult.data.error;
    return {
      message,
      type,
      provider: 'anthropic',
    };
  }

  // Try generic error format
  const genericResult = GenericErrorSchema.safeParse(parsed);
  if (genericResult.success) {
    return {
      message: genericResult.data.message,
      provider: 'unknown',
    };
  }

  // Fallback to stringified JSON
  return {
    message: JSON.stringify(parsed).slice(0, 500),
    provider: 'unknown',
  };
}

/**
 * Format a parsed error into an Error object.
 */
export function formatApiError(
  provider: string,
  status: number,
  parsed: ParsedApiError
): Error {
  const details = [
    parsed.type && `type=${parsed.type}`,
    parsed.code && `code=${parsed.code}`,
    parsed.param && `param=${parsed.param}`,
  ].filter(Boolean).join(', ');

  return new Error(
    `${provider} API error ${status}: ${parsed.message}${details ? ` (${details})` : ''}`
  );
}

/**
 * Truncate error message for display.
 */
function truncateError(text: string, maxLength = 500): string {
  return text.length > maxLength
    ? text.slice(0, maxLength) + '...'
    : text;
}
