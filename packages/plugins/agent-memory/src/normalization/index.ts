/**
 * Normalization Pipeline
 *
 * Data cleaning and normalization system for the agent memory.
 * Handles HTML conversion, timestamp normalization, PII detection,
 * link extraction, and text normalization.
 *
 * @module normalization
 */

// Types
export type {
  PIIType,
  DetectedPII,
  LinkType,
  ExtractedLink,
  HtmlToTextOptions,
  TimestampOptions,
  PIIOptions,
  LinkExtractionOptions,
  TextNormalizationOptions,
  NormalizationOptions,
  TextNormalizationResult,
  TimestampNormalizationResult,
  EntityNormalizationResult,
  FieldNormalizationSpec,
  EntityNormalizationSpec,
} from './types.js'

export {
  PIITypeSchema,
  LinkTypeSchema,
  DEFAULT_HTML_OPTIONS,
  DEFAULT_TIMESTAMP_OPTIONS,
  DEFAULT_PII_OPTIONS,
  DEFAULT_LINK_OPTIONS,
  DEFAULT_TEXT_OPTIONS,
  DEFAULT_NORMALIZATION_OPTIONS,
} from './types.js'

// HTML Conversion
export {
  htmlToText,
  htmlToTextWithLinks,
  decodeHtmlEntities,
  extractLinksFromHtml,
  containsHtml,
} from './html.js'

// Timestamp Normalization
export {
  normalizeTimestamp,
  parseTimestamp,
  formatTimestamp,
  extractTimezone,
  isValidDate,
  toDate,
  isTimestampLike,
  nowISO,
  nowUnix,
} from './timestamps.js'

// PII Detection
export {
  detectPII,
  redactPII,
  maskPII,
  analyzePII,
  containsPII,
} from './pii.js'

// Link Extraction
export {
  extractLinks,
  extractUrlsOnly,
  extractDomains,
  normalizeUrl,
  extractDomain,
  replaceLinks,
  containsLinks,
  countLinks,
} from './links.js'

// Text Normalization
export {
  normalizeText,
  normalizeUnicode,
  removeDiacritics,
  collapseWhitespace,
  normalizeLineEndings,
  normalizeBlankLines,
  trimLines,
  removeControlChars,
  removeNullBytes,
  removeZeroWidth,
  truncate,
  truncateWords,
  deduplicateChars,
  unquote,
  toLowerCase,
  toUpperCase,
  toTitleCase,
  toSentenceCase,
  slugify,
  isEmpty,
  isNotEmpty,
  wordCount,
  charCount,
} from './text.js'

// Pipeline
export {
  NormalizationPipeline,
  createNormalizationPipeline,
  defaultPipeline,
} from './pipeline.js'
