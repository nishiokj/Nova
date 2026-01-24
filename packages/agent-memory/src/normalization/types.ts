/**
 * Normalization Pipeline Types
 *
 * Types and interfaces for the data normalization system.
 */

import { z } from 'zod'

// ============ PII Detection ============

/**
 * Types of PII that can be detected.
 */
export const PIITypeSchema = z.enum([
  'email',
  'phone',
  'credit_card',
  'ssn',
  'ip_address',
  'date_of_birth',
])

export type PIIType = z.infer<typeof PIITypeSchema>

/**
 * A detected PII instance in text.
 */
export interface DetectedPII {
  /** Type of PII detected */
  type: PIIType
  /** The matched value */
  value: string
  /** Start index in the original text */
  start: number
  /** End index in the original text */
  end: number
  /** Confidence score (0-1) */
  confidence: number
}

// ============ Link Extraction ============

/**
 * Types of links that can be extracted.
 */
export const LinkTypeSchema = z.enum([
  'url',
  'email',
  'mention',
  'hashtag',
  'reference',
])

export type LinkType = z.infer<typeof LinkTypeSchema>

/**
 * An extracted link from text.
 */
export interface ExtractedLink {
  /** Type of link */
  type: LinkType
  /** The original matched text */
  original: string
  /** Normalized/resolved URL or value */
  normalized: string
  /** Start index in the original text */
  start: number
  /** End index in the original text */
  end: number
  /** Domain for URLs */
  domain?: string
  /** Additional context (e.g., link text for HTML) */
  context?: string
}

// ============ Normalization Options ============

/**
 * Options for HTML to text conversion.
 */
export interface HtmlToTextOptions {
  /** Preserve line breaks from <br>, <p>, etc. (default: true) */
  preserveLineBreaks?: boolean
  /** Preserve list formatting (default: true) */
  preserveLists?: boolean
  /** Maximum line length (0 for unlimited) */
  maxLineLength?: number
  /** Replace images with alt text (default: true) */
  useImageAlt?: boolean
  /** Preserve link URLs in parentheses (default: false) */
  preserveLinks?: boolean
}

/**
 * Options for timestamp normalization.
 */
export interface TimestampOptions {
  /** Default timezone for ambiguous timestamps */
  defaultTimezone?: string
  /** Output format (default: ISO 8601) */
  outputFormat?: 'iso8601' | 'unix' | 'epoch_ms'
  /** Whether to accept future dates (default: true) */
  allowFuture?: boolean
  /** Maximum age in days for valid dates (0 for unlimited) */
  maxAgeDays?: number
}

/**
 * Options for PII detection.
 */
export interface PIIOptions {
  /** Types of PII to detect (default: all) */
  types?: PIIType[]
  /** Whether to redact detected PII (default: false) */
  redact?: boolean
  /** Redaction string (default: '[REDACTED]') */
  redactionString?: string
  /** Minimum confidence threshold (0-1, default: 0.7) */
  minConfidence?: number
}

/**
 * Options for link extraction.
 */
export interface LinkExtractionOptions {
  /** Types of links to extract (default: all) */
  types?: LinkType[]
  /** Normalize URLs (lowercase scheme/host, etc.) */
  normalize?: boolean
  /** Resolve relative URLs against this base */
  baseUrl?: string
  /** Extract domain from URLs */
  extractDomains?: boolean
}

/**
 * Options for text normalization.
 */
export interface TextNormalizationOptions {
  /** Normalize Unicode (NFC) (default: true) */
  normalizeUnicode?: boolean
  /** Collapse multiple whitespace (default: true) */
  collapseWhitespace?: boolean
  /** Remove control characters (default: true) */
  removeControlChars?: boolean
  /** Trim leading/trailing whitespace (default: true) */
  trim?: boolean
  /** Maximum text length (0 for unlimited) */
  maxLength?: number
  /** Truncation suffix if maxLength exceeded */
  truncationSuffix?: string
}

/**
 * Combined options for the full normalization pipeline.
 */
export interface NormalizationOptions {
  /** HTML to text conversion options */
  html?: HtmlToTextOptions
  /** Timestamp normalization options */
  timestamp?: TimestampOptions
  /** PII detection options */
  pii?: PIIOptions
  /** Link extraction options */
  links?: LinkExtractionOptions
  /** Text normalization options */
  text?: TextNormalizationOptions
}

// ============ Normalization Results ============

/**
 * Result of normalizing a text field.
 */
export interface TextNormalizationResult {
  /** The normalized text */
  text: string
  /** Original text before normalization */
  original: string
  /** Detected PII (if detection enabled) */
  pii?: DetectedPII[]
  /** Extracted links */
  links?: ExtractedLink[]
  /** Whether the text was truncated */
  truncated?: boolean
  /** Whether HTML was converted */
  htmlConverted?: boolean
}

/**
 * Result of normalizing a timestamp.
 */
export interface TimestampNormalizationResult {
  /** The normalized timestamp (ISO 8601 string) */
  normalized: string
  /** Original input */
  original: string
  /** Whether the timestamp was valid */
  valid: boolean
  /** Parsed timezone (if detected) */
  timezone?: string
  /** Error message if invalid */
  error?: string
}

/**
 * Result of a full entity normalization.
 */
export interface EntityNormalizationResult {
  /** Whether normalization succeeded */
  success: boolean
  /** Normalized field values */
  fields: Record<string, TextNormalizationResult | TimestampNormalizationResult>
  /** All detected PII across fields */
  allPii: DetectedPII[]
  /** All extracted links across fields */
  allLinks: ExtractedLink[]
  /** Errors encountered */
  errors: Array<{ field: string; error: string }>
}

// ============ Field Specification ============

/**
 * Specification for how to normalize a field.
 */
export interface FieldNormalizationSpec {
  /** Field name in the entity */
  field: string
  /** Type of normalization */
  type: 'text' | 'html' | 'timestamp'
  /** Whether this field is required */
  required?: boolean
  /** Custom options for this field */
  options?: Partial<NormalizationOptions>
}

/**
 * Specification for normalizing an entity type.
 */
export interface EntityNormalizationSpec {
  /** Entity type */
  entityType: string
  /** Fields to normalize */
  fields: FieldNormalizationSpec[]
}

// ============ Default Options ============

export const DEFAULT_HTML_OPTIONS: Required<HtmlToTextOptions> = {
  preserveLineBreaks: true,
  preserveLists: true,
  maxLineLength: 0,
  useImageAlt: true,
  preserveLinks: false,
}

export const DEFAULT_TIMESTAMP_OPTIONS: Required<TimestampOptions> = {
  defaultTimezone: 'UTC',
  outputFormat: 'iso8601',
  allowFuture: true,
  maxAgeDays: 0,
}

export const DEFAULT_PII_OPTIONS: Required<PIIOptions> = {
  types: ['email', 'phone', 'credit_card', 'ssn', 'ip_address', 'date_of_birth'],
  redact: false,
  redactionString: '[REDACTED]',
  minConfidence: 0.7,
}

export const DEFAULT_LINK_OPTIONS: Required<LinkExtractionOptions> = {
  types: ['url', 'email', 'mention', 'hashtag', 'reference'],
  normalize: true,
  baseUrl: '',
  extractDomains: true,
}

export const DEFAULT_TEXT_OPTIONS: Required<TextNormalizationOptions> = {
  normalizeUnicode: true,
  collapseWhitespace: true,
  removeControlChars: true,
  trim: true,
  maxLength: 0,
  truncationSuffix: '...',
}

export const DEFAULT_NORMALIZATION_OPTIONS: Required<NormalizationOptions> = {
  html: DEFAULT_HTML_OPTIONS,
  timestamp: DEFAULT_TIMESTAMP_OPTIONS,
  pii: DEFAULT_PII_OPTIONS,
  links: DEFAULT_LINK_OPTIONS,
  text: DEFAULT_TEXT_OPTIONS,
}
