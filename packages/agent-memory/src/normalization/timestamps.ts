/**
 * Timestamp Normalization
 *
 * Handles parsing, validation, and normalization of timestamps
 * from various source formats to ISO 8601.
 */

import type { TimestampOptions, TimestampNormalizationResult } from './types.js'
import { DEFAULT_TIMESTAMP_OPTIONS } from './types.js'

// ============ Common Timestamp Formats ============

/**
 * Common timestamp formats used by external APIs.
 */
const TIMESTAMP_PATTERNS: Array<{ pattern: RegExp; parse: (match: RegExpMatchArray) => Date | null }> = [
  // ISO 8601: 2024-01-15T10:30:00Z or 2024-01-15T10:30:00.123Z
  {
    pattern: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-]\d{2}):?(\d{2}))$/,
    parse: (m) => new Date(m[0]),
  },
  // ISO 8601 without timezone: 2024-01-15T10:30:00
  {
    pattern: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/,
    parse: (m) => new Date(m[0] + 'Z'),
  },
  // Date only: 2024-01-15
  {
    pattern: /^(\d{4})-(\d{2})-(\d{2})$/,
    parse: (m) => new Date(`${m[0]}T00:00:00Z`),
  },
  // Unix timestamp (seconds): 1705312200
  {
    pattern: /^(\d{10})$/,
    parse: (m) => new Date(parseInt(m[1], 10) * 1000),
  },
  // Unix timestamp (milliseconds): 1705312200000
  {
    pattern: /^(\d{13})$/,
    parse: (m) => new Date(parseInt(m[1], 10)),
  },
  // RFC 2822: Mon, 15 Jan 2024 10:30:00 +0000
  {
    pattern: /^\w{3},\s+\d{1,2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}$/,
    parse: (m) => new Date(m[0]),
  },
  // US format: 01/15/2024 or 1/15/2024
  {
    pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    parse: (m) => new Date(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T00:00:00Z`),
  },
  // European format: 15/01/2024 or 15-01-2024
  {
    pattern: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/,
    parse: (m) => {
      // Ambiguous - could be US or EU. If first > 12, it's definitely day
      const first = parseInt(m[1], 10)
      const second = parseInt(m[2], 10)
      if (first > 12) {
        return new Date(`${m[3]}-${second.toString().padStart(2, '0')}-${first.toString().padStart(2, '0')}T00:00:00Z`)
      }
      // Default to US interpretation
      return new Date(`${m[3]}-${first.toString().padStart(2, '0')}-${second.toString().padStart(2, '0')}T00:00:00Z`)
    },
  },
  // Year-month: 2024-01
  {
    pattern: /^(\d{4})-(\d{2})$/,
    parse: (m) => new Date(`${m[0]}-01T00:00:00Z`),
  },
  // GitHub/API style with timezone name: 2024-01-15 10:30:00 UTC
  {
    pattern: /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\w+)$/,
    parse: (m) => {
      const tz = m[7].toUpperCase()
      if (tz === 'UTC' || tz === 'GMT') {
        return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
      }
      // Other timezones - try native parsing
      return new Date(m[0])
    },
  },
]

// ============ Timezone Handling ============

/**
 * Common timezone abbreviations to UTC offset.
 */
const TIMEZONE_OFFSETS: Record<string, string> = {
  UTC: '+00:00',
  GMT: '+00:00',
  EST: '-05:00',
  EDT: '-04:00',
  CST: '-06:00',
  CDT: '-05:00',
  MST: '-07:00',
  MDT: '-06:00',
  PST: '-08:00',
  PDT: '-07:00',
  // Add more as needed
}

/**
 * Extract timezone from a timestamp string.
 */
export function extractTimezone(timestamp: string): string | undefined {
  // Check for offset format
  const offsetMatch = timestamp.match(/([+-]\d{2}):?(\d{2})$/)
  if (offsetMatch) {
    return `${offsetMatch[1]}:${offsetMatch[2]}`
  }

  // Check for Z (UTC)
  if (timestamp.endsWith('Z')) {
    return 'UTC'
  }

  // Check for abbreviation
  const abbrevMatch = timestamp.match(/\s+([A-Z]{2,4})$/)
  if (abbrevMatch && TIMEZONE_OFFSETS[abbrevMatch[1]]) {
    return abbrevMatch[1]
  }

  return undefined
}

// ============ Parsing ============

/**
 * Parse a timestamp string into a Date object.
 */
export function parseTimestamp(input: string): Date | null {
  if (!input || typeof input !== 'string') {
    return null
  }

  const trimmed = input.trim()

  // Try each pattern
  for (const { pattern, parse } of TIMESTAMP_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) {
      const date = parse(match)
      if (date && !isNaN(date.getTime())) {
        return date
      }
    }
  }

  // Fall back to native Date parsing
  const nativeDate = new Date(trimmed)
  if (!isNaN(nativeDate.getTime())) {
    return nativeDate
  }

  return null
}

/**
 * Check if a date is valid (not NaN, not too old, not too far in future).
 */
export function isValidDate(date: Date, options: TimestampOptions = {}): boolean {
  const opts = { ...DEFAULT_TIMESTAMP_OPTIONS, ...options }

  if (isNaN(date.getTime())) {
    return false
  }

  const now = Date.now()

  // Check future dates
  if (!opts.allowFuture && date.getTime() > now) {
    return false
  }

  // Check maximum age
  if (opts.maxAgeDays > 0) {
    const maxAgeMs = opts.maxAgeDays * 24 * 60 * 60 * 1000
    if (now - date.getTime() > maxAgeMs) {
      return false
    }
  }

  // Sanity check: not before 1970 or after year 3000
  const year = date.getFullYear()
  if (year < 1970 || year > 3000) {
    return false
  }

  return true
}

// ============ Formatting ============

/**
 * Format a Date object according to options.
 */
export function formatTimestamp(date: Date, options: TimestampOptions = {}): string {
  const opts = { ...DEFAULT_TIMESTAMP_OPTIONS, ...options }

  switch (opts.outputFormat) {
    case 'unix':
      return Math.floor(date.getTime() / 1000).toString()
    case 'epoch_ms':
      return date.getTime().toString()
    case 'iso8601':
    default:
      return date.toISOString()
  }
}

// ============ Main Normalization ============

/**
 * Normalize a timestamp to a consistent format.
 */
export function normalizeTimestamp(
  input: string | number | Date,
  options: TimestampOptions = {}
): TimestampNormalizationResult {
  const opts = { ...DEFAULT_TIMESTAMP_OPTIONS, ...options }
  const originalStr = typeof input === 'object' ? input.toISOString() : String(input)

  // Handle different input types
  let date: Date | null = null

  if (input instanceof Date) {
    date = input
  } else if (typeof input === 'number') {
    // Assume Unix timestamp - detect seconds vs milliseconds
    if (input > 1e12) {
      date = new Date(input) // milliseconds
    } else {
      date = new Date(input * 1000) // seconds
    }
  } else if (typeof input === 'string') {
    date = parseTimestamp(input)
  }

  // Check validity
  if (!date || !isValidDate(date, opts)) {
    return {
      normalized: '',
      original: originalStr,
      valid: false,
      timezone: extractTimezone(originalStr),
      error: date ? 'Date outside valid range' : 'Unable to parse timestamp',
    }
  }

  return {
    normalized: formatTimestamp(date, opts),
    original: originalStr,
    valid: true,
    timezone: extractTimezone(originalStr) || 'UTC',
  }
}

/**
 * Convert a timestamp to a Date object, or return null if invalid.
 */
export function toDate(input: string | number | Date): Date | null {
  const result = normalizeTimestamp(input)
  if (!result.valid) {
    return null
  }
  return new Date(result.normalized)
}

/**
 * Check if a string looks like a timestamp.
 */
export function isTimestampLike(value: unknown): boolean {
  if (value instanceof Date) {
    return true
  }
  if (typeof value === 'number') {
    // Could be unix timestamp
    return value > 0 && value < 1e15
  }
  if (typeof value === 'string') {
    // Check against patterns
    for (const { pattern } of TIMESTAMP_PATTERNS) {
      if (pattern.test(value.trim())) {
        return true
      }
    }
  }
  return false
}

/**
 * Get the current timestamp in ISO 8601 format.
 */
export function nowISO(): string {
  return new Date().toISOString()
}

/**
 * Get the current timestamp as Unix seconds.
 */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}
