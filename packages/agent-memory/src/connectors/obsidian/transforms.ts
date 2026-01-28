/**
 * Obsidian Transformations
 *
 * Transforms raw Obsidian note data into canonical entities.
 */

import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { CanonicalSourceRef, Observation } from '../../models/canonical.js'
import type { Transformation, TransformResult, TransformOutput } from '../../transform/types.js'
import { ObsidianNoteSourceSchema, type ObsidianNoteSource } from './schemas.js'

// ============ Helper Functions ============

function createSourceRef(
  accountId: string,
  entityType: string,
  sourceId: string
): CanonicalSourceRef {
  return {
    connector: 'obsidian',
    account_id: accountId,
    entity_type: entityType,
    source_id: sourceId,
    last_synced_at: new Date().toISOString(),
  }
}

function createBaseEntity(id: string, sourceRef: CanonicalSourceRef) {
  const now = new Date().toISOString()
  return {
    id,
    created_at: now,
    updated_at: now,
    source_refs: [sourceRef],
  }
}

/**
 * Extract keywords from note content for indexing
 */
function extractKeywords(note: ObsidianNoteSource): string[] {
  const keywords = new Set<string>()

  // Add tags (without # prefix)
  for (const tag of note.tags) {
    keywords.add(tag.replace(/^#/, '').toLowerCase())
  }

  // Add headings (first 5)
  for (const heading of note.headings.slice(0, 5)) {
    const words = heading.text.split(/\s+/).filter(w => w.length > 3)
    for (const word of words) {
      keywords.add(word.toLowerCase())
    }
  }

  // Add title words
  if (note.title) {
    const words = note.title.split(/\s+/).filter(w => w.length > 3)
    for (const word of words) {
      keywords.add(word.toLowerCase())
    }
  }

  return Array.from(keywords).slice(0, 20)
}

/**
 * Determine the primary observation type based on note content
 */
function inferObservationType(note: ObsidianNoteSource): 'note' | 'summary' | 'insight' {
  const lowerContent = note.content.toLowerCase()

  // Check for insight patterns
  if (note.tags.some(t => t.includes('insight') || t.includes('idea'))) {
    return 'insight'
  }

  // Check for summary patterns
  if (note.tags.some(t => t.includes('summary') || t.includes('recap')) ||
      lowerContent.includes('summary') ||
      lowerContent.includes('recap')) {
    return 'summary'
  }

  // Default to note
  return 'note'
}

/**
 * Build related entity references from internal links
 */
function buildRelatedEntityRefs(note: ObsidianNoteSource): string[] {
  const refs: string[] = []

  // Internal links become related entities
  for (const link of note.internalLinks) {
    refs.push(link)
  }

  // Tags become related entities
  for (const tag of note.tags) {
    refs.push(tag)
  }

  return refs
}

// ============ Transformations ============

/**
 * Transform Obsidian note to canonical Observation entity.
 */
export const obsidianNoteTransform: Transformation<ObsidianNoteSource> = {
  id: 'obsidian:note:v1',
  name: 'Obsidian Note → Canonical Observation',
  source: {
    connector: 'obsidian',
    entityType: 'note',
  },
  inputSchema: ObsidianNoteSourceSchema,
  outputType: 'observation',

  transform(source, ctx): TransformResult {
    const sourceRef = createSourceRef(ctx.accountId, 'note', source.id)
    const observationType = inferObservationType(source)
    const keywords = extractKeywords(source)
    const relatedEntityRefs = buildRelatedEntityRefs(source)

    // Build content with metadata
    const contentLines: string[] = []

    if (source.title) {
      contentLines.push(`# ${source.title}`)
      contentLines.push('')
    }

    if (source.excerpt) {
      contentLines.push(`> ${source.excerpt}`)
      contentLines.push('')
    }

    // Add main content
    contentLines.push(source.content)

    // Add metadata section
    const metadataLines: string[] = []
    if (source.tags.length > 0) {
      metadataLines.push(`Tags: ${source.tags.join(', ')}`)
    }
    if (source.headings.length > 0) {
      metadataLines.push(`Headings: ${source.headings.map(h => h.text).join(', ')}`)
    }
    if (source.internalLinks.length > 0) {
      metadataLines.push(`Links to: ${source.internalLinks.join(', ')}`)
    }
    if (source.externalLinks.length > 0) {
      metadataLines.push(`External links: ${source.externalLinks.map(l => l.url).join(', ')}`)
    }

    if (metadataLines.length > 0) {
      contentLines.push('')
      contentLines.push('---')
      contentLines.push('**Metadata**')
      for (const line of metadataLines) {
        contentLines.push(`- ${line}`)
      }
    }

    const content = contentLines.join('\n')

    // Build the canonical observation
    const observation: Observation = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'observation',
      content,
      observation_type: observationType,
      related_entity_ids: [], // Will be populated if we track linked notes
      confidence: undefined, // Notes are explicit, not inferred
      metadata: {
        source_path: source.path,
        relative_path: source.relativePath,
        title: source.title,
        tags: source.tags,
        internal_links: source.internalLinks,
        external_links: source.externalLinks,
        headings: source.headings,
        excerpt: source.excerpt,
        word_count: source.metadata.wordCount,
        char_count: source.metadata.charCount,
        keywords,
        created_at: source.created_at,
        modified_at: source.modified_at,
        file_size: source.metadata.size,
        frontmatter: source.frontmatter,
      },
    }

    const primary: TransformOutput = {
      entityType: 'observation',
      data: observation,
      displayText: source.excerpt || source.content.substring(0, 200),
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    return {
      primary,
    }
  },

  onError: 'quarantine',
  enabled: true,
  version: 1,
}

/**
 * All Obsidian transformations.
 */
export const obsidianTransforms = [obsidianNoteTransform]
