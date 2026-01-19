/**
 * Agent Constants - Centralized configuration values.
 *
 * All magic numbers and patterns consolidated here for easy maintenance.
 */

/**
 * Tool execution limits and thresholds.
 */
export const TOOL_LIMITS = {
  /** Max identical tool calls before stagnation detection */
  MAX_IDENTICAL_CALLS: 2,
  /** Max output length for general tools (chars) */
  MAX_OUTPUT_LENGTH: 8000,
  /** Max output length for file reads (chars) - higher to accommodate large files */
  MAX_FILE_READ_OUTPUT_LENGTH: 50000,
} as const;

/**
 * Get max output length based on tool name.
 */
export function getMaxOutputLength(toolName: string): number {
  return toolName.toLowerCase() === 'read'
    ? TOOL_LIMITS.MAX_FILE_READ_OUTPUT_LENGTH
    : TOOL_LIMITS.MAX_OUTPUT_LENGTH;
}

/**
 * Patterns that indicate LLM refusal to complete a task.
 */
export const REFUSAL_PATTERNS = [
  /cannot be completed/i,
  /can't be completed/i,
  /cannot complete/i,
  /unable to complete/i,
  /exceeds? (?:the )?(?:budget|limit)/i,
  /not (?:possible|achievable|feasible)/i,
] as const;

/**
 * Check if a response matches refusal patterns.
 */
export function isRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}
