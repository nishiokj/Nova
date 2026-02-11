/**
 * Obsidian Connector Transform Tests
 *
 * Tests for transforming Obsidian notes to canonical entities.
 *
 * @module connectors/obsidian/transforms.test
 */

import { describe, it, expect } from 'vitest'
import {
  obsidianNoteTransform,
  obsidianTransforms,
} from './transforms.js'
import type { ObsidianNoteSource } from './schemas.js'
import type { Observation } from '../../models/canonical.js'

// ============ Mock Data ============

const mockNoteSource: ObsidianNoteSource = {
  id: 'TestNote.md',
  title: 'Test Note',
  content: `# Test Note

This is a test note with some content.

## Section 1

Some text here with [[Internal Link]].

## Section 2

More text with [External Link](https://example.com).

Tags: #work #important
`,
  tags: ['#work', '#important'],
  internalLinks: ['Internal Link'],
  externalLinks: [{ text: 'External Link', url: 'https://example.com' }],
  headings: [
    { level: 1, text: 'Test Note' },
    { level: 2, text: 'Section 1' },
    { level: 2, text: 'Section 2' },
  ],
  excerpt: 'This is a test note with some content.',
  path: '/Users/test/Documents/Brain/TestNote.md',
  relativePath: 'TestNote.md',
  metadata: {
    mtime: 1704067200,
    birthtime: 1704067200,
    size: 200,
    wordCount: 25,
    charCount: 150,
  },
  frontmatter: {
    title: 'Test Note',
    tags: ['#work', '#important'],
  },
  modified_at: '2024-01-01T00:00:00.000Z',
  created_at: '2024-01-01T00:00:00.000Z',
}

const insightNoteSource: ObsidianNoteSource = {
  id: 'Insight.md',
  title: 'Great Insight',
  content: `# Great Insight

This is a brilliant idea I had.

#insight #idea
`,
  tags: ['#insight', '#idea'],
  internalLinks: [],
  externalLinks: [],
  headings: [{ level: 1, text: 'Great Insight' }],
  excerpt: 'This is a brilliant idea I had.',
  path: '/Users/test/Documents/Brain/Insight.md',
  relativePath: 'Insight.md',
  metadata: {
    mtime: 1704067200,
    birthtime: 1704067200,
    size: 50,
    wordCount: 10,
    charCount: 50,
  },
  frontmatter: {
    title: 'Great Insight',
  },
  modified_at: '2024-01-01T00:00:00.000Z',
  created_at: '2024-01-01T00:00:00.000Z',
}

const summaryNoteSource: ObsidianNoteSource = {
  id: 'Summary.md',
  title: 'Weekly Summary',
  content: `# Weekly Summary

Summary of work done this week.

#summary #recap
`,
  tags: ['#summary', '#recap'],
  internalLinks: [],
  externalLinks: [],
  headings: [{ level: 1, text: 'Weekly Summary' }],
  excerpt: 'Summary of work done this week.',
  path: '/Users/test/Documents/Brain/Summary.md',
  relativePath: 'Summary.md',
  metadata: {
    mtime: 1704067200,
    birthtime: 1704067200,
    size: 50,
    wordCount: 6,
    charCount: 35,
  },
  frontmatter: {},
  modified_at: '2024-01-01T00:00:00.000Z',
  created_at: '2024-01-01T00:00:00.000Z',
}

// ============ Transform Tests ============

describe('obsidianNoteTransform', () => {
  describe('transform configuration', () => {
    it('should have correct ID', () => {
      expect(obsidianNoteTransform.id).toBe('obsidian:note:v1')
    })

    it('should have correct name', () => {
      expect(obsidianNoteTransform.name).toBe('Obsidian Note → Canonical Observation')
    })

    it('should reference correct connector', () => {
      expect(obsidianNoteTransform.source.connector).toBe('obsidian')
    })

    it('should reference correct entity type', () => {
      expect(obsidianNoteTransform.source.entityType).toBe('note')
    })

    it('should output observation entity type', () => {
      expect(obsidianNoteTransform.outputType).toBe('observation')
    })

    it('should be enabled', () => {
      expect(obsidianNoteTransform.enabled).toBe(true)
    })

    it('should have version 1', () => {
      expect(obsidianNoteTransform.version).toBe(1)
    })

    it('should quarantine on error', () => {
      expect(obsidianNoteTransform.onError).toBe('quarantine')
    })
  })

  describe('transform method', () => {
    it('should transform note to observation', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)

      expect(result).toBeDefined()
      expect(result.primary).toBeDefined()
      expect(result.primary.entityType).toBe('observation')
      expect(result.primary.data).toBeDefined()
    })

    it('should create valid observation entity', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.id).toBeDefined()
      expect(observation.entity_type).toBe('observation')
      expect(observation.content).toBeDefined()
      expect(observation.observation_type).toBeDefined()
      expect(observation.related_entity_ids).toEqual([])
      expect(observation.created_at).toBeDefined()
      expect(observation.updated_at).toBeDefined()
      expect(observation.source_refs).toHaveLength(1)
    })

    it('should include title in content', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.content).toContain('# Test Note')
    })

    it('should include excerpt in content', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.content).toContain(mockNoteSource.excerpt!)
    })

    it('should include metadata section in content', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.content).toContain('**Metadata**')
    })

    it('should include tags in metadata', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.content).toContain('Tags:')
      expect(observation.content).toContain('#work')
      expect(observation.content).toContain('#important')
    })

    it('should include internal links in metadata', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.content).toContain('Links to:')
      expect(observation.content).toContain('Internal Link')
    })

    it('should include external links in metadata', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.content).toContain('External links:')
      expect(observation.content).toContain('https://example.com')
    })

    it('should include headings in metadata', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.content).toContain('Headings:')
      expect(observation.content).toContain('Test Note')
      expect(observation.content).toContain('Section 1')
      expect(observation.content).toContain('Section 2')
    })

    it('should have correct source reference', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.source_refs[0].connector).toBe('obsidian')
      expect(observation.source_refs[0].account_id).toBe('local')
      expect(observation.source_refs[0].entity_type).toBe('note')
      expect(observation.source_refs[0].source_id).toBe('TestNote.md')
    })

    it('should include metadata in observation', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.metadata).toBeDefined()
      expect(observation.metadata!.source_path).toBe(mockNoteSource.path)
      expect(observation.metadata!.relative_path).toBe(mockNoteSource.relativePath)
      expect(observation.metadata!.title).toBe(mockNoteSource.title)
      expect(observation.metadata!.tags).toEqual(mockNoteSource.tags)
      expect(observation.metadata!.internal_links).toEqual(mockNoteSource.internalLinks)
      expect(observation.metadata!.external_links).toEqual(mockNoteSource.externalLinks)
      expect(observation.metadata!.headings).toEqual(mockNoteSource.headings)
      expect(observation.metadata!.excerpt).toBe(mockNoteSource.excerpt)
      expect(observation.metadata!.word_count).toBe(mockNoteSource.metadata.wordCount)
      expect(observation.metadata!.char_count).toBe(mockNoteSource.metadata.charCount)
      expect(observation.metadata!.frontmatter).toEqual(mockNoteSource.frontmatter)
    })

    it('should extract keywords', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.metadata!.keywords).toBeDefined()
      expect(Array.isArray(observation.metadata!.keywords)).toBe(true)
    })

    it('should include extracted keywords from tags', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation
      const keywords = observation.metadata!.keywords as string[]

      expect(keywords).toContain('work')
      expect(keywords).toContain('important')
    })
  })

  describe('observation type inference', () => {
    it('should infer "note" type for regular notes', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.observation_type).toBe('note')
    })

    it('should infer "insight" type from #insight tag', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(insightNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.observation_type).toBe('insight')
    })

    it('should infer "insight" type from #idea tag', () => {
      const insightWithIdea: ObsidianNoteSource = {
        ...insightNoteSource,
        tags: ['#idea'],
      }

      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(insightWithIdea, ctx)
      const observation = result.primary.data as Observation

      expect(observation.observation_type).toBe('insight')
    })

    it('should infer "summary" type from #summary tag', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(summaryNoteSource, ctx)
      const observation = result.primary.data as Observation

      expect(observation.observation_type).toBe('summary')
    })

    it('should infer "summary" type from #recap tag', () => {
      const recapNote: ObsidianNoteSource = {
        ...summaryNoteSource,
        tags: ['#recap'],
      }

      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(recapNote, ctx)
      const observation = result.primary.data as Observation

      expect(observation.observation_type).toBe('summary')
    })
  })

  describe('display text', () => {
    it('should use excerpt as display text when available', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const displayText = result.primary.displayText

      expect(displayText).toBe(mockNoteSource.excerpt)
    })

    it('should use first 200 chars of content when no excerpt', () => {
      const noteWithoutExcerpt: ObsidianNoteSource = {
        ...mockNoteSource,
        excerpt: undefined,
      }

      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(noteWithoutExcerpt, ctx)
      const displayText = result.primary.displayText

      expect(displayText).toBeDefined()
      expect(displayText!.length).toBeLessThanOrEqual(200)
    })
  })

  describe('source reference key', () => {
    it('should generate valid source reference key', () => {
      const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

      const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
      const sourceRefKey = result.primary.sourceRefKey

      expect(sourceRefKey).toBeDefined()
      expect(typeof sourceRefKey).toBe('string')
      expect(sourceRefKey).toContain('obsidian')
      expect(sourceRefKey).toContain('local')
      expect(sourceRefKey).toContain('note')
      expect(sourceRefKey).toContain('TestNote.md')
    })
  })
})

// ============ Transform Registry Tests ============

describe('obsidianTransforms', () => {
  it('should be an array', () => {
    expect(Array.isArray(obsidianTransforms)).toBe(true)
  })

  it('should contain note transform', () => {
    expect(obsidianTransforms).toContain(obsidianNoteTransform)
  })

  it('should have at least one transform', () => {
    expect(obsidianTransforms.length).toBeGreaterThanOrEqual(1)
  })
})

describe('Transform validation', () => {
  it('should validate note source with input schema', () => {
    // The transform should have an inputSchema that validates the source
    expect(obsidianNoteTransform.inputSchema).toBeDefined()
  })

  it('should handle note without title', () => {
    const noteWithoutTitle: ObsidianNoteSource = {
      ...mockNoteSource,
      title: undefined,
    }

    const ctx = {
      accountId: 'local',
      accountConfig: {},
    }

    const result = obsidianNoteTransform.transform(noteWithoutTitle, ctx)

    // Should still produce a valid observation
    expect(result.primary).toBeDefined()
    const observation = result.primary.data as Observation
    expect(observation.entity_type).toBe('observation')
  })

  it('should handle note with empty tags', () => {
    const noteWithoutTags: ObsidianNoteSource = {
      ...mockNoteSource,
      tags: [],
      internalLinks: [],
      externalLinks: [],
    }

    const ctx = {
      accountId: 'local',
      accountConfig: {},
    }

    const result = obsidianNoteTransform.transform(noteWithoutTags, ctx)

    expect(result.primary).toBeDefined()
    const observation = result.primary.data as Observation
    expect(observation.observation_type).toBe('note')
  })

  it('should handle note with no headings', () => {
    const noteWithoutHeadings: ObsidianNoteSource = {
      ...mockNoteSource,
      headings: [],
    }

    const ctx = {
        accountId: 'local',
        accountConfig: {},
      }

    const result = obsidianNoteTransform.transform(noteWithoutHeadings, ctx)

    expect(result.primary).toBeDefined()
    const observation = result.primary.data as Observation
    expect(observation.entity_type).toBe('observation')
  })

  it('should include word and character counts in metadata', () => {
    const ctx = {
      accountId: 'local',
      accountConfig: {},
    }

    const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
    const observation = result.primary.data as Observation

    expect(observation.metadata!.word_count).toBe(25)
    expect(observation.metadata!.char_count).toBe(150)
  })

  it('should include file metadata in observation metadata', () => {
    const ctx = {
      accountId: 'local',
      accountConfig: {},
    }

    const result = obsidianNoteTransform.transform(mockNoteSource, ctx)
    const observation = result.primary.data as Observation

    expect(observation.metadata!.file_size).toBe(200)
    expect(observation.metadata!.created_at).toBe('2024-01-01T00:00:00.000Z')
    expect(observation.metadata!.modified_at).toBe('2024-01-01T00:00:00.000Z')
  })
})
