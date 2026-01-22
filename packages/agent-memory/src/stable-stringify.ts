/**
 * Stable JSON stringify for deterministic hashing.
 * Produces consistent output regardless of object key insertion order.
 */

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, stableReplacer)
}

function stableReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value
  }

  // Sort object keys for deterministic output
  const sortedKeys = Object.keys(value as object).sort()
  const sorted: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    sorted[key] = (value as Record<string, unknown>)[key]
  }
  return sorted
}
