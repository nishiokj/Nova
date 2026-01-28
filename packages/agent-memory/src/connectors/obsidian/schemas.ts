/**
 * Obsidian Schema Definitions
 *
 * Zod schemas for Obsidian vault data.
 * Obsidian stores notes as markdown files in a folder structure.
 *
 * @module connectors/obsidian/schemas
 */

import { z } from 'zod'

// ============ Raw Note Data ============

/**
 * Raw note data read from markdown file
 */
export const ObsidianNoteRowSchema = z.object({
  /** Absolute path to the note file */
  path: z.string().min(1),
  /** File name without extension */
  filename: z.string().min(1),
  /** Relative path from vault root */
  relativePath: z.string().min(1),
  /** Full markdown content */
  content: z.string(),
  /** File modification time (Unix timestamp in seconds) */
  mtime: z.number().nonnegative(),
  /** File creation time (Unix timestamp in seconds) */
  birthtime: z.number().nonnegative(),
  /** File size in bytes */
  size: z.number().nonnegative(),
  /** YAML frontmatter if present (parsed as object) */
  frontmatter: z.record(z.unknown()).optional(),
  /** Whether this is a folder (as opposed to a file) */
  isFolder: z.boolean().default(false),
})

export type ObsidianNoteRow = z.infer<typeof ObsidianNoteRowSchema>

// ============ Parsed Note Data ============

/**
 * Parsed note with extracted metadata
 */
export const ObsidianParsedNoteSchema = z.object({
  /** Original note data */
  note: ObsidianNoteRowSchema,
  /** Extracted title (first heading or filename) */
  title: z.string().optional(),
  /** Extracted tags from content and frontmatter */
  tags: z.array(z.string()).default([]),
  /** Extracted wiki-style links [[link]] */
  internalLinks: z.array(z.string()).default([]),
  /** Extracted markdown-style links [text](url) */
  externalLinks: z.array(z.object({
    text: z.string(),
    url: z.string(),
  })).default([]),
  /** Headings in the document */
  headings: z.array(z.object({
    level: z.number().int().min(1).max(6),
    text: z.string(),
  })).default([]),
  /** First line/paragraph as excerpt */
  excerpt: z.string().optional(),
  /** Word count */
  wordCount: z.number().int().nonnegative().default(0),
  /** Character count */
  charCount: z.number().int().nonnegative().default(0),
})

export type ObsidianParsedNote = z.infer<typeof ObsidianParsedNoteSchema>

// ============ Vault Metadata ============

/**
 * Vault-wide metadata
 */
export const ObsidianVaultSchema = z.object({
  /** Absolute path to vault root */
  path: z.string(),
  /** Vault name (last component of path) */
  name: z.string(),
  /** Total note count */
  noteCount: z.number().int().nonnegative().default(0),
  /** Total folder count */
  folderCount: z.number().int().nonnegative().default(0),
  /** Total size in bytes */
  totalSize: z.number().int().nonnegative().default(0),
  /** Last modification time */
  lastModified: z.number(),
})

export type ObsidianVault = z.infer<typeof ObsidianVaultSchema>

// ============ Source Item Schemas (for connector output) ============

/**
 * Note as a source item for the sync pipeline
 */
export const ObsidianNoteSourceSchema = z.object({
  /** Unique identifier for this note (relative path from vault) */
  id: z.string(),
  /** Note title */
  title: z.string().optional(),
  /** Full markdown content */
  content: z.string(),
  /** Extracted tags */
  tags: z.array(z.string()),
  /** Internal wiki links to other notes */
  internalLinks: z.array(z.string()),
  /** External links */
  externalLinks: z.array(z.object({
    text: z.string(),
    url: z.string(),
  })),
  /** Document structure */
  headings: z.array(z.object({
    level: z.number().int().min(1).max(6),
    text: z.string(),
  })),
  /** Brief excerpt from the content */
  excerpt: z.string().optional(),
  /** Full file path */
  path: z.string(),
  /** Relative path from vault root */
  relativePath: z.string(),
  /** File metadata */
  metadata: z.object({
    mtime: z.number(), // Unix timestamp in seconds
    birthtime: z.number(),
    size: z.number().int().nonnegative(),
    wordCount: z.number().int().nonnegative(),
    charCount: z.number().int().nonnegative(),
  }),
  /** YAML frontmatter if present */
  frontmatter: z.record(z.unknown()).optional(),
  /** When this was last modified (ISO string) */
  modified_at: z.string().datetime(),
  /** When this was created (ISO string) */
  created_at: z.string().datetime(),
})

export type ObsidianNoteSource = z.infer<typeof ObsidianNoteSourceSchema>

// ============ Helper Functions ============

/**
 * Convert Unix timestamp (seconds) to ISO string
 */
export function unixTimestampToISOString(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString()
}

/**
 * Extract title from note
 * Priority: frontmatter title > first heading > filename
 */
export function extractTitle(note: ObsidianNoteRow): string {
  // Check frontmatter for title
  if (note.frontmatter && typeof note.frontmatter === 'object') {
    const fm = note.frontmatter as Record<string, unknown>
    if (typeof fm.title === 'string' && fm.title.trim()) {
      return fm.title.trim()
    }
  }

  // Check content for first heading
  const headingMatch = note.content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    return headingMatch[1].trim()
  }

  // Fallback to filename (without extension)
  return note.filename.replace(/\.md$/, '')
}

/**
 * Extract tags from note content and frontmatter
 * Matches #tag and [[tag]] patterns
 */
export function extractTags(note: ObsidianNoteRow): string[] {
  const tags = new Set<string>()

  // Check frontmatter for tags array
  if (note.frontmatter && typeof note.frontmatter === 'object') {
    const fm = note.frontmatter as Record<string, unknown>
    const fmTags = fm.tags

    if (Array.isArray(fmTags)) {
      for (const tag of fmTags) {
        if (typeof tag === 'string') {
          tags.add(tag.startsWith('#') ? tag : `#${tag}`)
        }
      }
    }
  }

  // Extract hashtags from content (#tag)
  const hashtagMatches = note.content.matchAll(/(?<![\w`])#([a-zA-Z0-9_-]+)/g)
  for (const match of hashtagMatches) {
    tags.add(`#${match[1]}`)
  }

  // Extract wiki-style tags ([[#tag]])
  const wikiTagMatches = note.content.matchAll(/\[\[?#[a-zA-Z0-9_-]+(?:\|[^\]]+)?\]\]?/g)
  for (const match of wikiTagMatches) {
    const tag = match[0].replace(/\[|\]|#/g, '').split('|')[0]
    tags.add(`#${tag}`)
  }

  return Array.from(tags).sort()
}

/**
 * Extract internal wiki links [[link]] and [[link|alias]]
 */
export function extractInternalLinks(note: ObsidianNoteRow): string[] {
  const links = new Set<string>()
  const matches = note.content.matchAll(/\[\[([^\]]+)\]\]/g)

  for (const match of matches) {
    const link = match[1].split('|')[0] // Take the link part before |
    const normalized = link.replace(/\//g, '') // Remove path separators for now
    links.add(normalized)
  }

  return Array.from(links).sort()
}

/**
 * Extract external markdown links [text](url)
 */
export function extractExternalLinks(note: ObsidianNoteRow): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = []
  const matches = note.content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)

  for (const match of matches) {
    links.push({
      text: match[1],
      url: match[2],
    })
  }

  return links
}

/**
 * Extract headings from content
 */
export function extractHeadings(note: ObsidianNoteRow): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = []
  const matches = note.content.matchAll(/^(#{1,6})\s+(.+)$/gm)

  for (const match of matches) {
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
    })
  }

  return headings
}

/**
 * Extract first paragraph as excerpt
 */
export function extractExcerpt(note: ObsidianNoteRow, maxLength = 200): string | undefined {
  // Skip YAML frontmatter
  let content = note.content
  const frontmatterEnd = content.indexOf('---\n', 4)
  if (content.startsWith('---\n') && frontmatterEnd > 0) {
    content = content.slice(frontmatterEnd + 4)
  }

  // Find first paragraph (non-empty line not starting with #)
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'))

  if (lines.length === 0) {
    return undefined
  }

  let excerpt = lines[0].trim()
  // Remove markdown formatting
  excerpt = excerpt.replace(/`[^`]+`/g, 'code') // Inline code
  excerpt = excerpt.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links

  if (excerpt.length > maxLength) {
    excerpt = excerpt.substring(0, maxLength - 3) + '...'
  }

  return excerpt || undefined
}

/**
 * Parse YAML frontmatter from content
 */
export function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  if (!content.startsWith('---\n')) {
    return undefined
  }

  const end = content.indexOf('\n---\n', 4)
  if (end === -1) {
    return undefined
  }

  const yaml = content.slice(4, end)
  const frontmatter: Record<string, unknown> = {}

  // Simple YAML parser - enough for basic key-value pairs
  const lines = yaml.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIndex = trimmed.indexOf(':')
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim()
      const valueStr = trimmed.slice(colonIndex + 1).trim()

      // Try to parse different value types
      if (valueStr === 'true') {
        frontmatter[key] = true
      } else if (valueStr === 'false') {
        frontmatter[key] = false
      } else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
        // Parse array
        const arrayStr = valueStr.slice(1, -1)
        if (arrayStr.trim()) {
          frontmatter[key] = arrayStr.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        } else {
          frontmatter[key] = []
        }
      } else if (!isNaN(Number(valueStr))) {
        frontmatter[key] = Number(valueStr)
      } else if (valueStr.startsWith('"') || valueStr.startsWith("'")) {
        frontmatter[key] = valueStr.slice(1, -1)
      } else {
        frontmatter[key] = valueStr
      }
    }
  }

  return frontmatter
}

/**
 * Count words in markdown content
 */
export function countWords(content: string): number {
  // Remove code blocks
  let text = content.replace(/```[\s\S]*?```/g, '')

  // Remove inline code
  text = text.replace(/`[^`]+`/g, '')

  // Remove markdown formatting
  text = text.replace(/#{1,6}\s/g, '') // Headings
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1') // Bold
  text = text.replace(/\*([^*]+)\*/g, '$1') // Italic
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links

  // Split into words
  const words = text.split(/\s+/).filter(w => w.trim())
  return words.length
}

/**
 * Count characters in markdown content
 */
export function countCharacters(content: string): number {
  return content.length
}
