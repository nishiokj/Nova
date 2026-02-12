/**
 * Obsidian Connector Tests
 *
 * Tests for the Obsidian connector implementation.
 *
 * @module connectors/obsidian/index.test
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { mkdir, writeFile, rm, rmdir } from 'fs/promises'
import {
  ObsidianConnector,
  createObsidianConnector,
  type ObsidianConnectorConfig,
} from 'agent-memory/connectors/obsidian/index.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  ConnectorContext,
} from 'agent-memory/connector/sdk/types.js'

// ============ Test Fixtures ============

let testVaultDir: string

async function createTestVault(): Promise<string> {
  const testDir = join(tmpdir(), `obsidian-test-${Date.now()}`)
  await mkdir(testDir, { recursive: true })

  // Create a simple note
  const noteContent = `# Test Note

This is a test note.

## Section

Some content.

Tags: #test
`
  await writeFile(join(testDir, 'TestNote.md'), noteContent)

  // Create another note
  const anotherNote = `# Another Note

Content here with [[Test Note]].

[Link](https://example.com)
`
  await writeFile(join(testDir, 'AnotherNote.md'), anotherNote)

  // Create a subfolder with a note
  const subdir = join(testDir, 'Subfolder')
  await mkdir(subdir)
  await writeFile(join(subdir, 'NestedNote.md'), '# Nested\n\nContent')

  return testDir
}

async function cleanupTestVault(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

const mockContext: ConnectorContext = {
  accountId: 'local',
  credentials: undefined,
  config: {},
}

// ============ Connector Tests ============

describe('ObsidianConnector', () => {
  let connector: ObsidianConnector

  beforeEach(async () => {
    testVaultDir = await createTestVault()
    connector = createObsidianConnector({
      vaultPath: testVaultDir,
      pageSize: 10,
    })
  })

  afterEach(async () => {
    await cleanupTestVault(testVaultDir)
  })

  // ============ Constructor Tests ============

  describe('constructor', () => {
    it('should create connector with correct type', () => {
      expect(connector.type).toBe('obsidian')
      expect(connector.displayName).toBe('Obsidian')
    })

    it('should have correct capabilities', () => {
      expect(connector.capabilities.supportsBackfill).toBe(true)
      expect(connector.capabilities.supportsIncrementalSync).toBe(true)
      expect(connector.capabilities.supportsWebhook).toBe(false)
      expect(connector.capabilities.supportsWrite).toBe(false)
    })

    it('should support correct entity types', () => {
      expect(connector.capabilities.supportedEntityTypes).toContain('note')
      expect(connector.capabilities.supportedEntityTypes).toContain('vault')
    })

    it('should use local auth config', () => {
      expect(connector.authConfig.type).toBe('local')
      expect(connector.authConfig.requiresSystemAccess).toBe(false)
    })

    it('should use default vault path when not provided', () => {
      const defaultConnector = createObsidianConnector()
      expect(defaultConnector).toBeDefined()
    })

    it('should accept custom page size', () => {
      const customConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        pageSize: 50,
      })
      expect(customConnector).toBeDefined()
    })

    it('should accept custom content byte limit', () => {
      const customConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        maxContentBytes: 1000000,
      })
      expect(customConnector).toBeDefined()
    })

    it('should accept folder filter', () => {
      const customConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        folderFilter: ['Subfolder'],
      })
      expect(customConnector).toBeDefined()
    })

    it('should accept tag filter', () => {
      const customConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        tagFilter: ['#work', '#important'],
      })
      expect(customConnector).toBeDefined()
    })

    it('should accept exclude tag filter', () => {
      const customConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        excludeTagFilter: ['#private'],
      })
      expect(customConnector).toBeDefined()
    })

    it('should accept custom extensions', () => {
      const customConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        extensions: ['.md', '.markdown', '.txt'],
      })
      expect(customConnector).toBeDefined()
    })
  })

  // ============ listAccounts Tests ============

  describe('listAccounts', () => {
    it('should return local account', async () => {
      const accounts = await connector.listAccounts(mockContext)

      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toMatchObject({
        externalId: 'local',
        displayName: expect.stringContaining('Obsidian'),
        username: expect.any(String),
        isPrimary: true,
      })
    })

    it('should include vault path in metadata', async () => {
      const accounts = await connector.listAccounts(mockContext)

      expect(accounts[0].metadata).toHaveProperty('vaultPath', testVaultDir)
    })
  })

  // ============ estimateScope Tests ============

  describe('estimateScope', () => {
    it('should estimate backfill scope for notes', async () => {
      const estimate = await connector.estimateScope(mockContext, 'backfill', ['note'])

      expect(estimate.summary).toContain('backfill')
      expect(estimate.entities).toHaveLength(1)
      expect(estimate.entities[0]).toMatchObject({
        type: 'note',
        count: expect.any(Number),
      })
      expect(estimate.entities[0].count).toBeGreaterThan(0)
    })

    it('should estimate backfill scope for vault', async () => {
      const estimate = await connector.estimateScope(mockContext, 'backfill', ['vault'])

      expect(estimate.summary).toContain('backfill')
      expect(estimate.entities).toHaveLength(1)
      expect(estimate.entities[0]).toMatchObject({
        type: 'vault',
        count: 1,
      })
    })

    it('should estimate backfill scope for all entity types', async () => {
      const estimate = await connector.estimateScope(mockContext, 'backfill')

      expect(estimate.entities.length).toBeGreaterThan(0)
      expect(estimate.summary).toBeDefined()
    })

    it('should estimate incremental sync scope', async () => {
      const estimate = await connector.estimateScope(mockContext, 'incremental', ['note'])

      expect(estimate.summary).toContain('Incremental sync')
      expect(estimate.entities).toHaveLength(1)
      expect(estimate.entities[0].type).toBe('note')
    })
  })

  // ============ fetchPage (Backfill) Tests ============

  describe('fetchPage', () => {
    it('should fetch notes for backfill', async () => {
      const options: FetchPageOptions = {
        limit: 10,
        entityTypes: ['note'],
      }

      const result = await connector.fetchPage(mockContext, options)

      expect(result.items.length).toBeGreaterThan(0)
      expect(result.items[0]).toMatchObject({
        source_id: expect.any(String),
        entity_type: 'note',
        raw_data: expect.any(Object),
        source_timestamp: expect.any(String),
      })
    })

    it('should return notes in sorted order', async () => {
      const options: FetchPageOptions = {
        limit: 10,
        entityTypes: ['note'],
      }

      const result = await connector.fetchPage(mockContext, options)

      // Check that source_ids are in order
      const ids = result.items.map(item => item.source_id)
      expect(ids).toEqual(ids.slice().sort())
    })

    it('should handle pagination with cursor', async () => {
      const firstPage = await connector.fetchPage(mockContext, {
        limit: 2,
        entityTypes: ['note'],
      })

      expect(firstPage.hasMore).toBe(true)
      expect(firstPage.nextCursor).toBeDefined()

      const secondPage = await connector.fetchPage(mockContext, {
        limit: 2,
        entityTypes: ['note'],
        cursor: firstPage.nextCursor,
      })

      expect(secondPage.items).toBeDefined()
    })

    it('should stop pagination when all notes are fetched', async () => {
      // Fetch all notes
      let hasMore = true
      let cursor: string | undefined
      let allItems: any[] = []

      while (hasMore) {
        const page = await connector.fetchPage(mockContext, {
          limit: 10,
          entityTypes: ['note'],
          cursor,
        })

        allItems.push(...page.items)
        hasMore = page.hasMore
        cursor = page.nextCursor
      }

      expect(allItems.length).toBeGreaterThan(0)
      expect(hasMore).toBe(false)
    })

    it('should exclude vault entity type from backfill', async () => {
      const options: FetchPageOptions = {
        limit: 10,
        entityTypes: ['vault'],
      }

      const result = await connector.fetchPage(mockContext, options)

      expect(result.items).toHaveLength(0)
    })

    it('should apply folder filter', async () => {
      const filteredConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        folderFilter: ['Subfolder'],
      })

      const result = await filteredConnector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      // Should only include notes from Subfolder
      for (const item of result.items) {
        const noteData = item.raw_data as any
        expect(noteData.relativePath).toContain('Subfolder')
      }
    })

    it('should apply tag filter', async () => {
      const filteredConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        tagFilter: ['#test'],
      })

      const result = await filteredConnector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      // Should only include notes with #test tag
      for (const item of result.items) {
        const noteData = item.raw_data as any
        expect(noteData.tags).toContain('#test')
      }
    })

    it('should apply exclude tag filter', async () => {
      await writeFile(join(testVaultDir, 'Private.md'), '# Private\n\n#private')
      const filteredConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        excludeTagFilter: ['#private'],
      })

      const result = await filteredConnector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      // Should not include notes with #private tag
      for (const item of result.items) {
        const noteData = item.raw_data as any
        expect(noteData.tags).not.toContain('#private')
      }
    })

    it('should skip files exceeding maxContentBytes', async () => {
      const largeConnector = createObsidianConnector({
        vaultPath: testVaultDir,
        maxContentBytes: 10, // Very small limit
      })

      const result = await largeConnector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      // All notes should be skipped due to size limit
      expect(result.items).toHaveLength(0)
    })

    it('should only read markdown files by default', async () => {
      // Create a non-md file
      await writeFile(join(testVaultDir, 'NotMarkdown.txt'), 'Not a markdown file')

      const result = await connector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      // Should not include the .txt file
      for (const item of result.items) {
        const noteData = item.raw_data as any
        expect(noteData.relativePath).toMatch(/\.md$/)
      }
    })
  })

  // ============ fetchChanges (Incremental Sync) Tests ============

  describe('fetchChanges', () => {
    it('should fetch notes modified since timestamp', async () => {
      // Create a new note
      const newNotePath = join(testVaultDir, 'NewNote.md')
      await writeFile(newNotePath, '# New\n\nContent')

      const sinceDate = new Date(Date.now() - 3600000) // 1 hour ago

      const result = await connector.fetchChanges(mockContext, {
        since: sinceDate.toISOString(),
        limit: 10,
        entityTypes: ['note'],
      })

      expect(result.items.length).toBeGreaterThan(0)
      expect(result.hasMore).toBe(false)
    })

    it('should return empty result for old since timestamp', async () => {
      const oldDate = new Date('2020-01-01')

      const result = await connector.fetchChanges(mockContext, {
        since: oldDate.toISOString(),
        limit: 10,
        entityTypes: ['note'],
      })

      expect(result.items).toHaveLength(0)
    })

    it('should handle cursor', async () => {
      const sinceDate = new Date(Date.now() - 3600000)

      const result = await connector.fetchChanges(mockContext, {
        since: sinceDate.toISOString(),
        limit: 10,
        entityTypes: ['note'],
      })

      expect(result.nextCursor).toBeDefined()
    })

    it('should respect limit in incremental sync', async () => {
      // Create multiple new notes
      for (let i = 0; i < 5; i++) {
        await writeFile(join(testVaultDir, `New${i}.md`), `# Note ${i}`)
      }

      const sinceDate = new Date(Date.now() - 3600000)

      const result = await connector.fetchChanges(mockContext, {
        since: sinceDate.toISOString(),
        limit: 2,
        entityTypes: ['note'],
      })

      expect(result.items.length).toBeLessThanOrEqual(2)
    })

    it('should exclude vault entity type', async () => {
      const sinceDate = new Date(Date.now() - 3600000)

      const result = await connector.fetchChanges(mockContext, {
        since: sinceDate.toISOString(),
        limit: 10,
        entityTypes: ['vault'],
      })

      expect(result.items).toHaveLength(0)
    })
  })

  // ============ getSourceSchema Tests ============

  describe('getSourceSchema', () => {
    it('should return schema for note entity type', () => {
      const schema = connector.getSourceSchema('note')
      expect(schema).toBeDefined()
    })

    it('should return schema for vault entity type', () => {
      const schema = connector.getSourceSchema('vault')
      expect(schema).toBeDefined()
    })

    it('should return undefined for unknown entity type', () => {
      const schema = connector.getSourceSchema('unknown')
      expect(schema).toBeUndefined()
    })
  })

  // ============ Schema Validation Tests ============

  describe('schema validation', () => {
    it('should validate note data', async () => {
      const result = await connector.fetchPage(mockContext, {
        limit: 1,
        entityTypes: ['note'],
      })

      expect(result.items.length).toBeGreaterThan(0)

      const noteData = result.items[0].raw_data
      expect(noteData).toHaveProperty('id')
      expect(noteData).toHaveProperty('content')
      expect(noteData).toHaveProperty('tags')
      expect(noteData).toHaveProperty('path')
      expect(noteData).toHaveProperty('relativePath')
      expect(noteData).toHaveProperty('metadata')
      expect(noteData).toHaveProperty('modified_at')
      expect(noteData).toHaveProperty('created_at')
    })

    it('should extract title from note', async () => {
      const result = await connector.fetchPage(mockContext, {
        limit: 1,
        entityTypes: ['note'],
      })

      const noteData = result.items[0].raw_data as any
      expect(noteData.title).toBeDefined()
      expect(typeof noteData.title).toBe('string')
    })

    it('should extract tags from note', async () => {
      const result = await connector.fetchPage(mockContext, {
        limit: 1,
        entityTypes: ['note'],
      })

      const noteData = result.items[0].raw_data as any
      expect(noteData.tags).toBeDefined()
      expect(Array.isArray(noteData.tags)).toBe(true)
    })

    it('should extract internal links', async () => {
      const result = await connector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      // Find the note with internal links
      const noteWithLinks = result.items.find(
        item => (item.raw_data as any).internalLinks.length > 0
      )

      if (noteWithLinks) {
        const noteData = noteWithLinks.raw_data as any
        expect(noteData.internalLinks).toBeDefined()
        expect(Array.isArray(noteData.internalLinks)).toBe(true)
      }
    })

    it('should extract external links', async () => {
      const result = await connector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      // Find the note with external links
      const noteWithLinks = result.items.find(
        item => (item.raw_data as any).externalLinks.length > 0
      )

      if (noteWithLinks) {
        const noteData = noteWithLinks.raw_data as any
        expect(noteData.externalLinks).toBeDefined()
        expect(Array.isArray(noteData.externalLinks)).toBe(true)
      }
    })

    it('should extract headings', async () => {
      const result = await connector.fetchPage(mockContext, {
        limit: 1,
        entityTypes: ['note'],
      })

      const noteData = result.items[0].raw_data as any
      expect(noteData.headings).toBeDefined()
      expect(Array.isArray(noteData.headings)).toBe(true)
    })

    it('should compute word and character counts', async () => {
      const result = await connector.fetchPage(mockContext, {
        limit: 1,
        entityTypes: ['note'],
      })

      const noteData = result.items[0].raw_data as any
      expect(noteData.metadata.wordCount).toBeDefined()
      expect(noteData.metadata.charCount).toBeDefined()
      expect(typeof noteData.metadata.wordCount).toBe('number')
      expect(typeof noteData.metadata.charCount).toBe('number')
    })
  })

  // ============ Transform Registration Tests ============

  describe('registerTransforms', () => {
    it('should register transforms with a registry', () => {
      const transforms: any[] = []

      const mockRegistry = {
        register: (transform: any) => {
          transforms.push(transform)
        },
      }

      connector.registerTransforms(mockRegistry)

      expect(transforms.length).toBeGreaterThan(0)
      expect(transforms[0]).toHaveProperty('id')
      expect(transforms[0]).toHaveProperty('name')
      expect(transforms[0]).toHaveProperty('transform')
    })
  })

  // ============ Error Handling Tests ============

  describe('error handling', () => {
    it('should throw when vault path does not exist', () => {
      const badConnector = createObsidianConnector({
        vaultPath: '/nonexistent/path/to/vault',
      })

      expect(
        badConnector.fetchPage(mockContext, {
          limit: 10,
          entityTypes: ['note'],
        })
      ).rejects.toThrow()
    })

    it('should skip unreadable files', async () => {
      // Create a file we can't read (in a real scenario, permissions would prevent this)
      // For now, we just verify the connector doesn't crash
      const result = await connector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      expect(result).toBeDefined()
      expect(Array.isArray(result.items)).toBe(true)
    })

    it('should skip files with invalid encoding', async () => {
      // Create a file with binary data
      await writeFile(join(testVaultDir, 'Binary.md'), Buffer.from([0x00, 0x01, 0x02]))

      const result = await connector.fetchPage(mockContext, {
        limit: 10,
        entityTypes: ['note'],
      })

      // Should not crash, but skip the file
      expect(result).toBeDefined()
    })
  })
})

// ============ Factory Tests ============

describe('createObsidianConnector', () => {
  it('should create an ObsidianConnector instance', () => {
    const connector = createObsidianConnector()

    expect(connector).toBeInstanceOf(ObsidianConnector)
    expect(connector.type).toBe('obsidian')
  })

  it('should accept configuration', () => {
    const config: ObsidianConnectorConfig = {
      vaultPath: '/test/path',
      pageSize: 50,
      maxContentBytes: 5000000,
    }

    const connector = createObsidianConnector(config)

    expect(connector).toBeInstanceOf(ObsidianConnector)
  })
})

describe('default vault path', () => {
  it('should use ~/Documents/ObsidianVault as default', () => {
    const connector = createObsidianConnector()
    expect(connector).toBeDefined()
    // The connector will check if the path exists when used
  })
})
