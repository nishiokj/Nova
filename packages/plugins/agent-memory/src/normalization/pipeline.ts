/**
 * Normalization Pipeline
 *
 * Main pipeline for normalizing entity data.
 * Orchestrates HTML conversion, timestamp handling, PII detection,
 * link extraction, and text normalization.
 */

import type {
  NormalizationOptions,
  TextNormalizationResult,
  TimestampNormalizationResult,
  EntityNormalizationResult,
  FieldNormalizationSpec,
  EntityNormalizationSpec,
  DetectedPII,
  ExtractedLink,
} from './types.js'
import { DEFAULT_NORMALIZATION_OPTIONS } from './types.js'
import { htmlToText, htmlToTextWithLinks, containsHtml } from './html.js'
import { normalizeTimestamp } from './timestamps.js'
import { detectPII, redactPII, analyzePII } from './pii.js'
import { extractLinks } from './links.js'
import { normalizeText } from './text.js'
import type { EntityType } from '../models/canonical.js'

// ============ Entity Field Specifications ============

/**
 * Default normalization specs for canonical entity types.
 */
const ENTITY_SPECS: Record<string, EntityNormalizationSpec> = {
  message: {
    entityType: 'message',
    fields: [
      { field: 'subject', type: 'text' },
      { field: 'body_text', type: 'text' },
      { field: 'body_html', type: 'html' },
      { field: 'sent_at', type: 'timestamp' },
      { field: 'received_at', type: 'timestamp' },
    ],
  },
  issue: {
    entityType: 'issue',
    fields: [
      { field: 'title', type: 'text', required: true },
      { field: 'description', type: 'html' },
      { field: 'due_at', type: 'timestamp' },
      { field: 'completed_at', type: 'timestamp' },
    ],
  },
  event: {
    entityType: 'event',
    fields: [
      { field: 'title', type: 'text', required: true },
      { field: 'description', type: 'html' },
      { field: 'location', type: 'text' },
      { field: 'start_at', type: 'timestamp', required: true },
      { field: 'end_at', type: 'timestamp' },
    ],
  },
  notification: {
    entityType: 'notification',
    fields: [
      { field: 'title', type: 'text' },
      { field: 'body', type: 'text' },
      { field: 'triggered_at', type: 'timestamp', required: true },
      { field: 'read_at', type: 'timestamp' },
    ],
  },
  observation: {
    entityType: 'observation',
    fields: [
      { field: 'content', type: 'text', required: true },
    ],
  },
  org: {
    entityType: 'org',
    fields: [
      { field: 'name', type: 'text', required: true },
      { field: 'description', type: 'html' },
    ],
  },
  person: {
    entityType: 'person',
    fields: [
      { field: 'display_name', type: 'text' },
    ],
  },
  identity: {
    entityType: 'identity',
    fields: [
      { field: 'display_name', type: 'text' },
      { field: 'username', type: 'text' },
    ],
  },
  account: {
    entityType: 'account',
    fields: [
      { field: 'display_name', type: 'text' },
      { field: 'last_synced_at', type: 'timestamp' },
    ],
  },
  link: {
    entityType: 'link',
    fields: [
      { field: 'context', type: 'text' },
    ],
  },
  attachment: {
    entityType: 'attachment',
    fields: [
      { field: 'filename', type: 'text', required: true },
    ],
  },
}

// ============ Pipeline Class ============

/**
 * Normalization pipeline for processing entity fields.
 */
export class NormalizationPipeline {
  private options: Required<NormalizationOptions>
  private entitySpecs: Map<string, EntityNormalizationSpec>

  constructor(options: NormalizationOptions = {}) {
    this.options = this.mergeOptions(options)
    this.entitySpecs = new Map(Object.entries(ENTITY_SPECS))
  }

  /**
   * Merge user options with defaults.
   */
  private mergeOptions(options: NormalizationOptions): Required<NormalizationOptions> {
    return {
      html: { ...DEFAULT_NORMALIZATION_OPTIONS.html, ...options.html },
      timestamp: { ...DEFAULT_NORMALIZATION_OPTIONS.timestamp, ...options.timestamp },
      pii: { ...DEFAULT_NORMALIZATION_OPTIONS.pii, ...options.pii },
      links: { ...DEFAULT_NORMALIZATION_OPTIONS.links, ...options.links },
      text: { ...DEFAULT_NORMALIZATION_OPTIONS.text, ...options.text },
    }
  }

  /**
   * Register a custom entity normalization spec.
   */
  registerEntitySpec(spec: EntityNormalizationSpec): this {
    this.entitySpecs.set(spec.entityType, spec)
    return this
  }

  /**
   * Get the spec for an entity type.
   */
  getEntitySpec(entityType: string): EntityNormalizationSpec | undefined {
    return this.entitySpecs.get(entityType)
  }

  // ============ Field Normalization ============

  /**
   * Normalize a text field.
   */
  normalizeTextField(
    value: string,
    options?: Partial<NormalizationOptions>
  ): TextNormalizationResult {
    const opts = options ? this.mergeOptions(options) : this.options

    if (!value || typeof value !== 'string') {
      return {
        text: '',
        original: value || '',
        pii: [],
        links: [],
      }
    }

    let text = value
    let links: ExtractedLink[] = []
    let htmlConverted = false

    // Check for HTML and convert if present
    if (containsHtml(text)) {
      const result = htmlToTextWithLinks(text, opts.html)
      text = result.text
      links = result.links
      htmlConverted = true
    }

    // Normalize the text
    const normalized = normalizeText(text, opts.text)

    // Detect PII
    const pii = detectPII(normalized, opts.pii)

    // Extract additional links from text
    const textLinks = extractLinks(normalized, opts.links)
    links = [...links, ...textLinks]

    // Deduplicate links
    links = deduplicateLinks(links)

    // Check for truncation
    const maxLength = opts.text?.maxLength ?? 0
    const truncated = maxLength > 0 && value.length > maxLength

    return {
      text: normalized,
      original: value,
      pii,
      links,
      truncated,
      htmlConverted,
    }
  }

  /**
   * Normalize an HTML field.
   */
  normalizeHtmlField(
    value: string,
    options?: Partial<NormalizationOptions>
  ): TextNormalizationResult {
    const opts = options ? this.mergeOptions(options) : this.options

    if (!value || typeof value !== 'string') {
      return {
        text: '',
        original: value || '',
        pii: [],
        links: [],
        htmlConverted: false,
      }
    }

    // Always convert HTML to text
    const { text, links } = htmlToTextWithLinks(value, opts.html)

    // Normalize the resulting text
    const normalized = normalizeText(text, opts.text)

    // Detect PII
    const pii = detectPII(normalized, opts.pii)

    // Extract additional links
    const textLinks = extractLinks(normalized, opts.links)
    const allLinks = deduplicateLinks([...links, ...textLinks])

    const htmlMaxLength = opts.text?.maxLength ?? 0
    const truncated = htmlMaxLength > 0 && normalized.length > htmlMaxLength

    return {
      text: normalized,
      original: value,
      pii,
      links: allLinks,
      truncated,
      htmlConverted: true,
    }
  }

  /**
   * Normalize a timestamp field.
   */
  normalizeTimestampField(
    value: string | number | Date,
    options?: Partial<NormalizationOptions>
  ): TimestampNormalizationResult {
    const opts = options ? this.mergeOptions(options) : this.options
    return normalizeTimestamp(value, opts.timestamp)
  }

  // ============ Entity Normalization ============

  /**
   * Normalize all fields of an entity.
   */
  normalizeEntity(
    entityType: EntityType,
    data: Record<string, unknown>,
    options?: Partial<NormalizationOptions>
  ): EntityNormalizationResult {
    const spec = this.entitySpecs.get(entityType)

    if (!spec) {
      // No spec - return unchanged with empty results
      return {
        success: true,
        fields: {},
        allPii: [],
        allLinks: [],
        errors: [],
      }
    }

    const allPii: DetectedPII[] = []
    const allLinks: ExtractedLink[] = []
    const fields: Record<string, TextNormalizationResult | TimestampNormalizationResult> = {}
    const errors: Array<{ field: string; error: string }> = []

    for (const fieldSpec of spec.fields) {
      const value = data[fieldSpec.field]

      // Skip undefined/null unless required
      if (value === undefined || value === null) {
        if (fieldSpec.required) {
          errors.push({
            field: fieldSpec.field,
            error: `Required field '${fieldSpec.field}' is missing`,
          })
        }
        continue
      }

      try {
        const fieldOptions = fieldSpec.options
          ? this.mergeOptions({ ...options, ...fieldSpec.options })
          : (options ? this.mergeOptions(options) : this.options)

        switch (fieldSpec.type) {
          case 'text': {
            const result = this.normalizeTextField(String(value), fieldOptions)
            fields[fieldSpec.field] = result
            if (result.pii) allPii.push(...result.pii)
            if (result.links) allLinks.push(...result.links)
            break
          }
          case 'html': {
            const result = this.normalizeHtmlField(String(value), fieldOptions)
            fields[fieldSpec.field] = result
            if (result.pii) allPii.push(...result.pii)
            if (result.links) allLinks.push(...result.links)
            break
          }
          case 'timestamp': {
            const result = this.normalizeTimestampField(value as string | number | Date, fieldOptions)
            fields[fieldSpec.field] = result
            if (!result.valid) {
              errors.push({
                field: fieldSpec.field,
                error: result.error || 'Invalid timestamp',
              })
            }
            break
          }
        }
      } catch (err) {
        errors.push({
          field: fieldSpec.field,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return {
      success: errors.length === 0,
      fields,
      allPii: deduplicatePii(allPii),
      allLinks: deduplicateLinks(allLinks),
      errors,
    }
  }

  /**
   * Apply normalized values back to entity data.
   */
  applyNormalization(
    data: Record<string, unknown>,
    result: EntityNormalizationResult
  ): Record<string, unknown> {
    const updated = { ...data }

    for (const [field, fieldResult] of Object.entries(result.fields)) {
      if ('text' in fieldResult) {
        // Text/HTML result
        updated[field] = fieldResult.text
      } else if ('normalized' in fieldResult && fieldResult.valid) {
        // Timestamp result
        updated[field] = fieldResult.normalized
      }
    }

    return updated
  }

  // ============ Batch Processing ============

  /**
   * Normalize multiple entities of the same type.
   */
  normalizeEntities(
    entityType: EntityType,
    entities: Array<Record<string, unknown>>,
    options?: Partial<NormalizationOptions>
  ): Array<{ original: Record<string, unknown>; result: EntityNormalizationResult; normalized: Record<string, unknown> }> {
    return entities.map(entity => {
      const result = this.normalizeEntity(entityType, entity, options)
      const normalized = this.applyNormalization(entity, result)
      return { original: entity, result, normalized }
    })
  }

  // ============ Analysis ============

  /**
   * Analyze an entity for PII without modifying it.
   */
  analyzeEntityPii(
    entityType: EntityType,
    data: Record<string, unknown>
  ): {
    hasPii: boolean
    riskLevel: 'none' | 'low' | 'medium' | 'high'
    byField: Record<string, ReturnType<typeof analyzePII>>
  } {
    const spec = this.entitySpecs.get(entityType)
    if (!spec) {
      return { hasPii: false, riskLevel: 'none', byField: {} }
    }

    const byField: Record<string, ReturnType<typeof analyzePII>> = {}
    let overallRiskLevel: 'none' | 'low' | 'medium' | 'high' = 'none'
    let hasPii = false

    for (const fieldSpec of spec.fields) {
      const value = data[fieldSpec.field]
      if (typeof value !== 'string') continue

      const analysis = analyzePII(value, this.options.pii)
      byField[fieldSpec.field] = analysis

      if (analysis.hasPII) {
        hasPii = true
        if (
          analysis.riskLevel === 'high' ||
          (analysis.riskLevel === 'medium' && overallRiskLevel !== 'high') ||
          (analysis.riskLevel === 'low' && overallRiskLevel === 'none')
        ) {
          overallRiskLevel = analysis.riskLevel
        }
      }
    }

    return { hasPii, riskLevel: overallRiskLevel, byField }
  }

  /**
   * Extract all links from an entity.
   */
  extractEntityLinks(
    entityType: EntityType,
    data: Record<string, unknown>
  ): ExtractedLink[] {
    const spec = this.entitySpecs.get(entityType)
    if (!spec) return []

    const allLinks: ExtractedLink[] = []

    for (const fieldSpec of spec.fields) {
      const value = data[fieldSpec.field]
      if (typeof value !== 'string') continue

      let text = value
      if (fieldSpec.type === 'html' && containsHtml(value)) {
        const { text: converted, links } = htmlToTextWithLinks(value, this.options.html)
        text = converted
        allLinks.push(...links)
      }

      const links = extractLinks(text, this.options.links)
      allLinks.push(...links)
    }

    return deduplicateLinks(allLinks)
  }
}

// ============ Helpers ============

/**
 * Deduplicate PII items by position.
 */
function deduplicatePii(items: DetectedPII[]): DetectedPII[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = `${item.type}:${item.start}:${item.end}:${item.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Deduplicate links by normalized value.
 */
function deduplicateLinks(links: ExtractedLink[]): ExtractedLink[] {
  const seen = new Set<string>()
  return links.filter(link => {
    const key = `${link.type}:${link.normalized}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ============ Factory ============

/**
 * Create a normalization pipeline with default options.
 */
export function createNormalizationPipeline(
  options: NormalizationOptions = {}
): NormalizationPipeline {
  return new NormalizationPipeline(options)
}

/**
 * Default pipeline instance.
 */
export const defaultPipeline = new NormalizationPipeline()
