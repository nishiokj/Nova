/**
 * Text Normalization
 *
 * General text cleaning and normalization utilities.
 * Handles Unicode, whitespace, control characters, and length limits.
 */

import type { TextNormalizationOptions } from './types.js'
import { DEFAULT_TEXT_OPTIONS } from './types.js'

// ============ Unicode Normalization ============

/**
 * Normalize Unicode to NFC form.
 * This ensures consistent representation of characters.
 */
export function normalizeUnicode(text: string): string {
  return text.normalize('NFC')
}

/**
 * Remove combining characters (diacritics).
 * Useful for search/matching.
 */
export function removeDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

// ============ Whitespace Handling ============

/**
 * Collapse multiple whitespace characters to single space.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/[\s\uFEFF\xA0]+/g, ' ')
}

/**
 * Normalize line endings to Unix style (\n).
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Remove excessive blank lines (more than 2 consecutive).
 */
export function normalizeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

/**
 * Trim each line of text.
 */
export function trimLines(text: string): string {
  return text.split('\n').map(line => line.trim()).join('\n')
}

// ============ Control Characters ============

/**
 * Control characters that should be removed.
 * Excludes common whitespace (space, tab, newline, carriage return).
 */
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/**
 * Remove control characters from text.
 */
export function removeControlChars(text: string): string {
  return text.replace(CONTROL_CHAR_PATTERN, '')
}

/**
 * Remove null bytes.
 */
export function removeNullBytes(text: string): string {
  return text.replace(/\x00/g, '')
}

// ============ Length Handling ============

/**
 * Truncate text to a maximum length.
 */
export function truncate(text: string, maxLength: number, suffix = '...'): string {
  if (maxLength <= 0 || text.length <= maxLength) {
    return text
  }

  const targetLength = maxLength - suffix.length
  if (targetLength <= 0) {
    return suffix.substring(0, maxLength)
  }

  // Try to break at word boundary
  const truncated = text.substring(0, targetLength)
  const lastSpace = truncated.lastIndexOf(' ')

  if (lastSpace > targetLength * 0.8) {
    return truncated.substring(0, lastSpace) + suffix
  }

  return truncated + suffix
}

/**
 * Truncate text at word boundaries.
 */
export function truncateWords(text: string, maxWords: number, suffix = '...'): string {
  const words = text.split(/\s+/)
  if (words.length <= maxWords) {
    return text
  }

  return words.slice(0, maxWords).join(' ') + suffix
}

// ============ Cleaning ============

/**
 * Remove zero-width characters.
 */
export function removeZeroWidth(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '')
}

/**
 * Replace multiple consecutive characters with a single one.
 * Useful for cleaning up repeated punctuation.
 */
export function deduplicateChars(text: string, chars: string): string {
  const escaped = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`([${escaped}])\\1+`, 'g')
  return text.replace(pattern, '$1')
}

/**
 * Remove leading/trailing quotes from a string.
 */
export function unquote(text: string): string {
  const trimmed = text.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

// ============ Case Handling ============

/**
 * Convert to lowercase.
 */
export function toLowerCase(text: string): string {
  return text.toLowerCase()
}

/**
 * Convert to uppercase.
 */
export function toUpperCase(text: string): string {
  return text.toUpperCase()
}

/**
 * Convert to title case.
 */
export function toTitleCase(text: string): string {
  return text.replace(/\w\S*/g, (word) => {
    return word.charAt(0).toUpperCase() + word.substring(1).toLowerCase()
  })
}

/**
 * Convert to sentence case (first letter of first word uppercase).
 */
export function toSentenceCase(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return text
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.substring(1).toLowerCase()
}

// ============ Slug Generation ============

/**
 * Convert text to a URL-safe slug.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9\s-]/g, '')    // Remove non-alphanumeric
    .replace(/[\s_]+/g, '-')          // Replace spaces and underscores with hyphens
    .replace(/-+/g, '-')              // Collapse multiple hyphens
    .replace(/^-|-$/g, '')            // Remove leading/trailing hyphens
}

// ============ Main Normalization ============

/**
 * Apply full text normalization.
 */
export function normalizeText(text: string, options: TextNormalizationOptions = {}): string {
  const opts = { ...DEFAULT_TEXT_OPTIONS, ...options }

  if (!text || typeof text !== 'string') {
    return ''
  }

  let result = text

  // Normalize line endings first
  result = normalizeLineEndings(result)

  // Remove null bytes
  result = removeNullBytes(result)

  // Remove control characters
  if (opts.removeControlChars) {
    result = removeControlChars(result)
  }

  // Remove zero-width characters
  result = removeZeroWidth(result)

  // Normalize Unicode
  if (opts.normalizeUnicode) {
    result = normalizeUnicode(result)
  }

  // Collapse whitespace
  if (opts.collapseWhitespace) {
    // Preserve paragraph breaks
    result = result.replace(/[ \t]+/g, ' ')
    result = normalizeBlankLines(result)
  }

  // Trim
  if (opts.trim) {
    result = result.trim()
  }

  // Truncate
  if (opts.maxLength > 0 && result.length > opts.maxLength) {
    result = truncate(result, opts.maxLength, opts.truncationSuffix)
  }

  return result
}

/**
 * Check if text is empty or only whitespace.
 */
export function isEmpty(text: string | null | undefined): boolean {
  if (!text) {
    return true
  }
  return text.trim().length === 0
}

/**
 * Check if text is non-empty.
 */
export function isNotEmpty(text: string | null | undefined): text is string {
  return !isEmpty(text)
}

/**
 * Get word count.
 */
export function wordCount(text: string): number {
  if (isEmpty(text)) {
    return 0
  }
  return text.trim().split(/\s+/).length
}

/**
 * Get character count (excluding whitespace).
 */
export function charCount(text: string, includeWhitespace = true): number {
  if (isEmpty(text)) {
    return 0
  }
  if (includeWhitespace) {
    return text.length
  }
  return text.replace(/\s/g, '').length
}
