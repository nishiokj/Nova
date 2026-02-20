/**
 * Agent Constants - Centralized configuration values.
 *
 * All magic numbers and patterns consolidated here for easy maintenance.
 */

/**
 * Tool execution limits and thresholds.
 */
export const TOOL_LIMITS = {
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
 * Truncate tool output to max length for the given tool.
 * Appends a truncation notice if content was trimmed.
 */
export function truncateToolOutput(output: string, toolName: string): string {
  const maxLen = getMaxOutputLength(toolName);
  if (output.length <= maxLen) return output;
  return `${output.slice(0, maxLen)}\n... [truncated ${output.length - maxLen} chars]`;
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
