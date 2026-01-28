/**
 * Obsidian Connector
 *
 * Connector for reading Obsidian vault data from the local filesystem.
 * Obsidian stores notes as markdown files in a folder structure.
 *
 * @module connectors/obsidian
 */

import { join, relative } from 'path'
import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { z } from 'zod'
import type { ConnectorType } from '../../ids.js'
import type {
  Connector,
  ConnectorCapabilities,
  LocalAuthConfig,
  AccountInfo,
  ConnectorContext,
  SyncEstimate,
} from '../../connector/sdk/types.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
} from '../../sync/types.js'
import {
  ObsidianNoteSourceSchema,
  ObsidianVaultSchema,
  ObsidianNoteRowSchema,
  type ObsidianNoteSource,
  type ObsidianVault,
  type ObsidianNoteRow,
  unixTimestampToISOString,
  extractTitle,
  extractTags,
  extractInternalLinks,
  extractExternalLinks,
  extractHeadings,
  extractExcerpt,
  parseFrontmatter,
  countWords,
  countCharacters,
} from './schemas.js'
import { obsidianNoteTransform, obsidianTransforms } from './transforms.js'
import type { Transformation } from '../../transform/types.js'

// Re-export schemas
export {
  ObsidianNoteRowSchema,
  ObsidianParsedNoteSchema,
  ObsidianVaultSchema,
  ObsidianNoteSourceSchema,
  unixTimestampToISOString,
  extractTitle,
  extractTags,
  extractInternalLinks,
  extractExternalLinks,
  extractHeadings,
  extractExcerpt,
  parseFrontmatter,
  countWords,
  countCharacters,
  type ObsidianNoteRow,
  type ObsidianParsedNote,
  type ObsidianVault,
  type ObsidianNoteSource,
} from './schemas.js'

// Re-export transforms
export {
  obsidianNoteTransform,
  obsidianTransforms,
} from './transforms.js'

// ============ Configuration ============

export interface ObsidianConnectorConfig {
  /** Path to Obsidian vault (default: ~/Documents/ObsidianVault) */
  vaultPath?: string
  /** Maximum notes to fetch per page (default: 100) */
  pageSize?: number
  /** Maximum content bytes to read (default: 10MB) */
  maxContentBytes?: number
  /** Only sync notes from specific subfolders */
  folderFilter?: string[]
  /** Only sync notes with specific tags */
  tagFilter?: string[]
  /** Exclude notes with specific tags */
  excludeTagFilter?: string[]
  /** Include subfolders recursively (default: true) */
  recursive?: boolean
  /** File extensions to sync (default: ['.md']) */
  extensions?: string[]
}

const DEFAULT_VAULT_PATH = join(process.env.HOME || process.env.USERPROFILE || '', 'Documents', 'ObsidianVault')
const DEFAULT_MAX_CONTENT_BYTES = 10 * 1024 * 1024 // 10MB

// ============ Cursor Types ============

interface BackfillCursor {
  paths: string[]
  index: number
}

interface IncrementalCursor {
  sinceMtime: number
}

// ============ Obsidian Connector ============

export class ObsidianConnector implements Connector {
  readonly type: ConnectorType = 'obsidian'
  readonly displayName = 'Obsidian'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: false,
    supportsWrite: false,
    supportedEntityTypes: ['note', 'vault'],
  }

  readonly authConfig: LocalAuthConfig = {
    type: 'local',
    dataPath: DEFAULT_VAULT_PATH,
    requiresSystemAccess: false, // Only needs file read access
  }

  private readonly vaultPath: string
  private readonly pageSize: number
  private readonly maxContentBytes: number
  private readonly folderFilter: string[] | undefined
  private readonly tagFilter: string[] | undefined
  private readonly excludeTagFilter: string[] | undefined
  private readonly recursive: boolean
  private readonly extensions: string[]

  private vaultMetadata: ObsidianVault | null = null

  constructor(config: ObsidianConnectorConfig = {}) {
    this.vaultPath = config.vaultPath ?? DEFAULT_VAULT_PATH
    this.pageSize = config.pageSize ?? 100
    this.maxContentBytes = config.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES
    this.folderFilter = config.folderFilter
    this.tagFilter = config.tagFilter
    this.excludeTagFilter = config.excludeTagFilter
    this.recursive = config.recursive ?? true
    this.extensions = config.extensions ?? ['.md']
  }

  // ============ File System Access ============

  /**
   * Get the vault path, throwing if it doesn't exist
   */
  private getVaultPath(): string {
    if (!existsSync(this.vaultPath)) {
      throw new Error(
        `Obsidian vault not found at ${this.vaultPath}. ` +
        'Ensure the path is correct and the vault exists.'
      )
    }
    return this.vaultPath
  }

  /**
   * Recursively list all markdown files in the vault
   */
  private listNoteFiles(dir: string, baseDir: string = this.vaultPath): string[] {
    const files: string[] = []

    try {
      const entries = readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)

        if (entry.isDirectory()) {
          // Skip hidden directories
          if (entry.name.startsWith('.')) continue

          // Skip .obsidian directory (internal Obsidian config)
          if (entry.name === '.obsidian') continue

          // Check folder filter
          if (this.folderFilter && this.folderFilter.length > 0) {
            const relPath = relative(baseDir, fullPath)
            if (!this.folderFilter.some(f => relPath.startsWith(f))) {
              continue
            }
          }

          // Recurse if enabled
          if (this.recursive) {
            files.push(...this.listNoteFiles(fullPath, baseDir))
          }
        } else if (entry.isFile()) {
          // Check file extension
          if (this.extensions.some(ext => entry.name.endsWith(ext))) {
            // Skip hidden files
            if (!entry.name.startsWith('.')) {
              files.push(fullPath)
            }
          }
        }
      }
    } catch (error) {
      // Skip directories we can't read
      return []
    }

    return files
  }

  /**
   * Read and parse a markdown file
   */
  private readNoteFile(filePath: string): ObsidianNoteRow | null {
    try {
      const stats = statSync(filePath)

      // Check file size limit
      if (stats.size > this.maxContentBytes) {
        console.warn(`[ObsidianConnector] Skipping large file: ${filePath} (${stats.size} bytes)`)
        return null
      }

      const content = readFileSync(filePath, 'utf-8')
      const frontmatter = parseFrontmatter(content)

      return {
        path: filePath,
        filename: filePath.split('/').pop() || filePath.split('\\').pop() || 'unknown',
        relativePath: relative(this.vaultPath, filePath),
        content,
        mtime: stats.mtimeMs / 1000, // Convert to seconds
        birthtime: stats.birthtimeMs / 1000,
        size: stats.size,
        frontmatter,
        isFolder: false,
      }
    } catch (error) {
      console.warn(`[ObsidianConnector] Failed to read file: ${filePath}`, error)
      return null
    }
  }

  /**
   * Check if a note matches the tag filters
   */
  private matchesTagFilters(note: ObsidianNoteRow): boolean {
    const tags = extractTags(note)

    // Must include at least one required tag
    if (this.tagFilter && this.tagFilter.length > 0) {
      const hasRequiredTag = this.tagFilter.some(req =>
        tags.some(tag => tag === req || tag.startsWith(req))
      )
      if (!hasRequiredTag) {
        return false
      }
    }

    // Must not have any excluded tags
    if (this.excludeTagFilter && this.excludeTagFilter.length > 0) {
      const hasExcludedTag = this.excludeTagFilter.some(excl =>
        tags.some(tag => tag === excl || tag.startsWith(excl))
      )
      if (hasExcludedTag) {
        return false
      }
    }

    return true
  }

  /**
   * Parse a note row into a source item
   */
  private noteToSourceItem(note: ObsidianNoteRow): ObsidianNoteSource | null {
    // Apply tag filters
    if (!this.matchesTagFilters(note)) {
      return null
    }

    const title = extractTitle(note)
    const tags = extractTags(note)
    const internalLinks = extractInternalLinks(note)
    const externalLinks = extractExternalLinks(note)
    const headings = extractHeadings(note)
    const excerpt = extractExcerpt(note)
    const wordCount = countWords(note.content)
    const charCount = countCharacters(note.content)

    const sourceData = {
      id: note.relativePath,
      title,
      content: note.content,
      tags,
      internalLinks,
      externalLinks,
      headings,
      excerpt,
      path: note.path,
      relativePath: note.relativePath,
      metadata: {
        mtime: note.mtime,
        birthtime: note.birthtime,
        size: note.size,
        wordCount,
        charCount,
      },
      frontmatter: note.frontmatter,
      modified_at: unixTimestampToISOString(note.mtime),
      created_at: unixTimestampToISOString(note.birthtime),
    }

    const validated = ObsidianNoteSourceSchema.safeParse(sourceData)
    if (!validated.success) {
      console.warn('[ObsidianConnector] Invalid note source:', validated.error.message)
      return null
    }

    return validated.data
  }

  // ============ Account Discovery ============

  async listAccounts(_ctx: ConnectorContext): Promise<AccountInfo[]> {
    const vaultPath = this.getVaultPath()
    const username = process.env.USER ?? process.env.USERNAME ?? 'local'

    return [{
      externalId: 'local',
      displayName: `Obsidian (${this.vaultPath.split('/').pop()})`,
      username,
      isPrimary: true,
      metadata: {
        vaultPath,
      },
    }]
  }

  // ============ Estimate Methods ============

  async estimateScope(
    _ctx: ConnectorContext,
    syncType: 'backfill' | 'incremental',
    entityTypes?: string[]
  ): Promise<SyncEstimate> {
    const types = entityTypes ?? this.capabilities.supportedEntityTypes

    try {
      const vaultPath = this.getVaultPath()
      const noteFiles = this.listNoteFiles(vaultPath)

      const entities = types.map((type) => {
        if (type === 'note') {
          return {
            type,
            count: noteFiles.length,
            description: `~${noteFiles.length.toLocaleString()} notes`,
          }
        }
        if (type === 'vault') {
          return {
            type,
            count: 1,
            description: '1 vault',
          }
        }
        return { type, description: `${type} (count unavailable)` }
      })

      const parts = entities.filter((e) => e.count != null).map((e) => e.description)
      const label = syncType === 'backfill' ? 'Full backfill' : 'Incremental sync'

      return {
        entities,
        summary: parts.length > 0 ? `${label}: ${parts.join(', ')}` : label,
      }
    } catch (error) {
      return {
        entities: types.map((type) => ({
          type,
          description: `${type} (unable to access vault)`,
        })),
      }
    }
  }

  // ============ Sync Methods ============

  async fetchPage(
    _ctx: ConnectorContext,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? ['note']
    const items: SourceItem[] = []

    // Parse cursor
    let cursor: BackfillCursor = { paths: [], index: 0 }
    if (options.cursor) {
      try {
        cursor = JSON.parse(options.cursor) as BackfillCursor
      } catch {
        // Invalid cursor, start fresh
      }
    }

    // If we haven't listed files yet, do it now
    if (cursor.paths.length === 0) {
      const vaultPath = this.getVaultPath()
      cursor.paths = this.listNoteFiles(vaultPath).sort() // Sort for consistent ordering
    }

    const limit = options.limit ?? this.pageSize

    // Filter by entity types
    if (!entityTypes.includes('note')) {
      return { items: [], hasMore: false }
    }

    // Fetch notes from cursor position
    let fetched = 0
    while (fetched < limit && cursor.index < cursor.paths.length) {
      const filePath = cursor.paths[cursor.index]
      cursor.index++

      const note = this.readNoteFile(filePath)
      if (!note) continue

      const sourceItem = this.noteToSourceItem(note)
      if (sourceItem) {
        items.push({
          source_id: sourceItem.id,
          entity_type: 'note',
          raw_data: sourceItem,
          source_timestamp: sourceItem.modified_at,
        })
        fetched++
      }
    }

    const hasMore = cursor.index < cursor.paths.length
    const nextCursor = hasMore
      ? JSON.stringify({ paths: cursor.paths, index: cursor.index })
      : undefined

    return { items, hasMore, nextCursor }
  }

  async fetchChanges(
    _ctx: ConnectorContext,
    options: FetchChangesOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? ['note']
    const items: SourceItem[] = []

    // Parse cursor or use 'since' timestamp
    let cursor: IncrementalCursor
    if (options.cursor) {
      try {
        cursor = JSON.parse(options.cursor) as IncrementalCursor
      } catch {
        const sinceDate = options.since
          ? new Date(options.since)
          : new Date(Date.now() - 24 * 60 * 60 * 1000)
        cursor = {
          sinceMtime: sinceDate.getTime() / 1000,
        }
      }
    } else {
      const sinceDate = options.since
        ? new Date(options.since)
        : new Date(Date.now() - 24 * 60 * 60 * 1000) // Default: last 24 hours
      cursor = {
        sinceMtime: sinceDate.getTime() / 1000,
      }
    }

    const limit = options.limit ?? this.pageSize

    // Filter by entity types
    if (!entityTypes.includes('note')) {
      return { items: [], hasMore: false }
    }

    // List all files and filter by modification time
    const vaultPath = this.getVaultPath()
    const noteFiles = this.listNoteFiles(vaultPath).sort()

    let fetched = 0
    for (const filePath of noteFiles) {
      if (fetched >= limit) break

      try {
        const stats = statSync(filePath)
        const mtime = stats.mtimeMs / 1000

        // Only include files modified since cursor
        if (mtime > cursor.sinceMtime) {
          const note = this.readNoteFile(filePath)
          if (!note) continue

          const sourceItem = this.noteToSourceItem(note)
          if (sourceItem) {
            items.push({
              source_id: sourceItem.id,
              entity_type: 'note',
              raw_data: sourceItem,
              source_timestamp: sourceItem.modified_at,
            })
            fetched++
          }
        }
      } catch {
        continue
      }
    }

    // For incremental sync, we return all changes at once
    // The next cursor would be the latest modification time
    const latestMtime = items.length > 0
      ? Math.max(...items.map(item => {
          const data = item.raw_data as ObsidianNoteSource
          return data.metadata.mtime
        }))
      : cursor.sinceMtime

    return {
      items,
      hasMore: false,
      nextCursor: JSON.stringify({ sinceMtime: latestMtime }),
    }
  }

  // ============ Schema Methods ============

  getSourceSchema(entityType: string): z.ZodSchema | undefined {
    if (entityType === 'note') {
      return ObsidianNoteSourceSchema
    }
    if (entityType === 'vault') {
      return ObsidianVaultSchema
    }
    return undefined
  }

  // ============ Transform Registration ============

  /**
   * Register Obsidian transformations with a registry.
   * Called during daemon/engine setup to enable processing.
   */
  registerTransforms(registry: { register<T>(t: Transformation<T>): void }): void {
    for (const transform of obsidianTransforms) {
      registry.register(transform)
    }
  }
}

// ============ Factory ============

export function createObsidianConnector(
  config?: ObsidianConnectorConfig
): ObsidianConnector {
  return new ObsidianConnector(config)
}
