/**
 * Structured output helpers.
 *
 * Provides light-weight coercion from model output into a JSON object.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObject(value: string): Record<string, unknown> | null {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return tryParseJson(value.slice(start, end + 1));
}

/**
 * Coerce structured output into a JSON object when possible.
 */
export function coerceStructuredOutput(
  value: unknown
): Record<string, unknown> | null {
  if (!value) return null;
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return tryParseJson(trimmed) ?? extractJsonObject(trimmed);
}
