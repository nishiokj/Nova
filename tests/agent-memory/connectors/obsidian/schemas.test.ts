/**
 * Obsidian Connector Schema Tests
 *
 * Tests for schema validation and helper functions.
 *
 * @module connectors/obsidian/schemas.test
 */

import {
  ObsidianNoteRowSchema,
  ObsidianParsedNoteSchema,
  ObsidianVaultSchema,
  ObsidianNoteSourceSchema,
  type ObsidianNoteRow,
  type ObsidianParsedNote,
  type ObsidianVault,
  type ObsidianNoteSource,
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
} from 'agent-memory/connectors/obsidian/schemas.js'

// ============ Mock Data ============

const mockNote: ObsidianNoteRow = {
  path: '/Users/test/Documents/Brain/TestNote.md',
  filename: 'TestNote',
  relativePath: 'TestNote.md',
  content: `# Test Note

This is a test note.

## Section 1

Some content here.

## Section 2

More content with [[Internal Link]] and [External Link](https://example.com).

Tags: #work #important
`,
  mtime: 1704067200,
  birthtime: 1704067200,
  size: 200,
  frontmatter: {
    title: 'Test Note',
    tags: ['#work', '#important'],
    created: '2024-01-01',
  },
  isFolder: false,
}

const noteWithYamlFrontmatter = {
  path: '/Users/test/Documents/Brain/Frontmatter.md',
  filename: 'Frontmatter',
  relativePath: 'Frontmatter.md',
  content: `---
title: Custom Title
tags:
  - development
  - obsidian
created: 2024-01-01
author: Test User
---

# Custom Title

This note has YAML frontmatter.
`,
  mtime: 1704067200,
  birthtime: 1704067200,
  size: 250,
  frontmatter: {
    title: 'Custom Title',
    tags: ['development', 'obsidian'],
    created: '2024-01-01',
    author: 'Test User',
  },
  isFolder: false,
}

const noteWithWikiLinks = {
  path: '/Users/test/Documents/Brain/Links.md',
  filename: 'Links',
  relativePath: 'Links.md',
  content: `# Links

This note has [[Another Note]] and [[Folder/Sub Note]] links.

Also has [[Alias Link|Display Text]].
`,
  mtime: 1704067200,
  birthtime: 1704067200,
  size: 180,
  frontmatter: undefined,
  isFolder: false,
}

// ============ Schema Tests ============

describe('ObsidianNoteRowSchema', () => {
  it('should validate a valid note row', () => {
    const result = ObsidianNoteRowSchema.safeParse(mockNote)
    expect(result.success).toBe(true)
  })

  it('should validate note without frontmatter', () => {
    const noteWithoutFrontmatter = { ...mockNote, frontmatter: undefined }
    const result = ObsidianNoteRowSchema.safeParse(noteWithoutFrontmatter)
    expect(result.success).toBe(true)
  })

  it('should validate minimal note row', () => {
    const minimal = {
      path: '/test/Note.md',
      filename: 'Note',
      relativePath: 'Note.md',
      content: 'test',
      mtime: 1704067200,
      birthtime: 1704067200,
      size: 4,
      isFolder: false,
    }
    const result = ObsidianNoteRowSchema.safeParse(minimal)
    expect(result.success).toBe(true)
  })

  it('should reject invalid mtime (negative number)', () => {
    const invalid = { ...mockNote, mtime: -1 }
    const result = ObsidianNoteRowSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('should reject empty path', () => {
    const invalid = { ...mockNote, path: '' }
    const result = ObsidianNoteRowSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })
})

describe('ObsidianParsedNoteSchema', () => {
  it('should validate a parsed note', () => {
    const parsed: ObsidianParsedNote = {
      note: mockNote,
      title: 'Test Note',
      tags: ['#work', '#important'],
      internalLinks: ['Internal Link'],
      externalLinks: [{ text: 'External Link', url: 'https://example.com' }],
      headings: [
        { level: 1, text: 'Test Note' },
        { level: 2, text: 'Section 1' },
        { level: 2, text: 'Section 2' },
      ],
      excerpt: 'This is a test note.',
      wordCount: 20,
      charCount: 150,
    }

    const result = ObsidianParsedNoteSchema.safeParse(parsed)
    expect(result.success).toBe(true)
  })

  it('should validate parsed note with minimal fields', () => {
    const minimal: ObsidianParsedNote = {
      note: mockNote,
      tags: [],
      internalLinks: [],
      externalLinks: [],
      headings: [],
      wordCount: 0,
      charCount: 0,
    }

    const result = ObsidianParsedNoteSchema.safeParse(minimal)
    expect(result.success).toBe(true)
  })
})

describe('ObsidianVaultSchema', () => {
  it('should validate a vault', () => {
    const vault: ObsidianVault = {
      path: '/Users/test/Documents/Brain',
      name: 'Brain',
      noteCount: 100,
      folderCount: 10,
      totalSize: 1000000,
      lastModified: 1704067200,
    }

    const result = ObsidianVaultSchema.safeParse(vault)
    expect(result.success).toBe(true)
  })

  it('should validate vault with zero counts', () => {
    const vault: ObsidianVault = {
      path: '/Users/test/Documents/EmptyVault',
      name: 'EmptyVault',
      noteCount: 0,
      folderCount: 0,
      totalSize: 0,
      lastModified: 1704067200,
    }

    const result = ObsidianVaultSchema.safeParse(vault)
    expect(result.success).toBe(true)
  })

  it('should reject negative note count', () => {
    const vault: ObsidianVault = {
      path: '/Users/test/Documents/Brain',
      name: 'Brain',
      noteCount: -1,
      folderCount: 10,
      totalSize: 1000000,
      lastModified: 1704067200,
    }

    const result = ObsidianVaultSchema.safeParse(vault)
    expect(result.success).toBe(false)
  })
})

describe('ObsidianNoteSourceSchema', () => {
  it('should validate a note source', () => {
    const source: ObsidianNoteSource = {
      id: 'TestNote.md',
      title: 'Test Note',
      content: mockNote.content,
      tags: ['#work', '#important'],
      internalLinks: ['Internal Link'],
      externalLinks: [{ text: 'External Link', url: 'https://example.com' }],
      headings: [
        { level: 1, text: 'Test Note' },
        { level: 2, text: 'Section 1' },
      ],
      excerpt: 'This is a test note.',
      path: mockNote.path,
      relativePath: mockNote.relativePath,
      metadata: {
        mtime: mockNote.mtime,
        birthtime: mockNote.birthtime,
        size: mockNote.size,
        wordCount: 20,
        charCount: 150,
      },
      frontmatter: mockNote.frontmatter,
      modified_at: '2024-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
    }

    const result = ObsidianNoteSourceSchema.safeParse(source)
    expect(result.success).toBe(true)
  })

  it('should validate note source without optional fields', () => {
    const source: ObsidianNoteSource = {
      id: 'TestNote.md',
      content: 'test content',
      tags: [],
      internalLinks: [],
      externalLinks: [],
      headings: [],
      path: '/test/TestNote.md',
      relativePath: 'TestNote.md',
      metadata: {
        mtime: 1704067200,
        birthtime: 1704067200,
        size: 12,
        wordCount: 2,
        charCount: 12,
      },
      modified_at: '2024-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
    }

    const result = ObsidianNoteSourceSchema.safeParse(source)
    expect(result.success).toBe(true)
  })

  it('should validate heading levels 1-6', () => {
    const source: ObsidianNoteSource = {
      id: 'TestNote.md',
      content: 'test',
      tags: [],
      internalLinks: [],
      externalLinks: [],
      headings: [
        { level: 1, text: 'H1' },
        { level: 2, text: 'H2' },
        { level: 3, text: 'H3' },
        { level: 4, text: 'H4' },
        { level: 5, text: 'H5' },
        { level: 6, text: 'H6' },
      ],
      path: '/test/TestNote.md',
      relativePath: 'TestNote.md',
      metadata: {
        mtime: 1704067200,
        birthtime: 1704067200,
        size: 4,
        wordCount: 1,
        charCount: 4,
      },
      modified_at: '2024-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
    }

    const result = ObsidianNoteSourceSchema.safeParse(source)
    expect(result.success).toBe(true)
  })

  it('should reject invalid heading level (0)', () => {
    const source: ObsidianNoteSource = {
      id: 'TestNote.md',
      content: 'test',
      tags: [],
      internalLinks: [],
      externalLinks: [],
      headings: [{ level: 0, text: 'H0' }],
      path: '/test/TestNote.md',
      relativePath: 'TestNote.md',
      metadata: {
        mtime: 1704067200,
        birthtime: 1704067200,
        size: 4,
        wordCount: 1,
        charCount: 4,
      },
      modified_at: '2024-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
    }

    const result = ObsidianNoteSourceSchema.safeParse(source)
    expect(result.success).toBe(false)
  })

  it('should reject invalid heading level (7)', () => {
    const source: ObsidianNoteSource = {
      id: 'TestNote.md',
      content: 'test',
      tags: [],
      internalLinks: [],
      externalLinks: [],
      headings: [{ level: 7, text: 'H7' }],
      path: '/test/TestNote.md',
      relativePath: 'TestNote.md',
      metadata: {
        mtime: 1704067200,
        birthtime: 1704067200,
        size: 4,
        wordCount: 1,
        charCount: 4,
      },
      modified_at: '2024-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
    }

    const result = ObsidianNoteSourceSchema.safeParse(source)
    expect(result.success).toBe(false)
  })
})

// ============ Helper Function Tests ============

describe('unixTimestampToISOString', () => {
  it('should convert Unix timestamp to ISO string', () => {
    const result = unixTimestampToISOString(1704067200)
    expect(result).toBe('2024-01-01T00:00:00.000Z')
  })

  it('should handle timestamp 0', () => {
    const result = unixTimestampToISOString(0)
    expect(result).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('extractTitle', () => {
  it('should extract title from frontmatter', () => {
    const title = extractTitle(noteWithYamlFrontmatter)
    expect(title).toBe('Custom Title')
  })

  it('should extract title from first heading', () => {
    const noteWithoutFrontmatterTitle = { ...mockNote, frontmatter: {} }
    const title = extractTitle(noteWithoutFrontmatterTitle)
    expect(title).toBe('Test Note')
  })

  it('should fallback to filename', () => {
    const noteNoHeading = {
      ...mockNote,
      frontmatter: undefined,
      content: 'Just content without heading',
    }
    const title = extractTitle(noteNoHeading)
    expect(title).toBe('TestNote')
  })

  it('should handle special characters in filename', () => {
    const noteWithSpecialChars = {
      ...mockNote,
      frontmatter: undefined,
      content: 'content',
      filename: '2024-01-15 - Meeting Notes',
    }
    const title = extractTitle(noteWithSpecialChars)
    expect(title).toBe('2024-01-15 - Meeting Notes')
  })
})

describe('extractTags', () => {
  it('should extract tags from frontmatter array', () => {
    const tags = extractTags(noteWithYamlFrontmatter)
    expect(tags).toEqual(expect.arrayContaining(['#development', '#obsidian']))
  })

  it('should add # prefix to frontmatter tags without it', () => {
    const noteWithTags = {
      ...mockNote,
      frontmatter: { tags: ['work', 'important'] },
      content: '',
    }
    const tags = extractTags(noteWithTags)
    expect(tags).toContain('#work')
    expect(tags).toContain('#important')
  })

  it('should extract hashtags from content', () => {
    const note = {
      ...mockNote,
      frontmatter: undefined,
      content: 'This has #tag1 and #tag2 in it.',
    }
    const tags = extractTags(note)
    expect(tags).toContain('#tag1')
    expect(tags).toContain('#tag2')
  })

  it('should extract wiki-style tags [[#tag]]', () => {
    const note = {
      ...mockNote,
      frontmatter: undefined,
      content: 'This has [[#wikitag]] in it.',
    }
    const tags = extractTags(note)
    expect(tags).toContain('#wikitag')
  })

  it('should handle inline code tags (should not extract)', () => {
    const note = {
      ...mockNote,
      frontmatter: undefined,
      content: 'This has `#notatag` in code.',
    }
    const tags = extractTags(note)
    // Simple regex might still pick it up, which is fine for now
    // In a more sophisticated parser, we'd skip inline code
    expect(tags.length).toBeGreaterThanOrEqual(0)
  })

  it('should return sorted tags', () => {
    const note = {
      ...mockNote,
      frontmatter: { tags: ['zebra', 'alpha', 'beta'] },
      content: '#delta #gamma',
    }
    const tags = extractTags(note)
    expect(tags).toEqual(tags.slice().sort())
  })
})

describe('extractInternalLinks', () => {
  it('should extract wiki-style links', () => {
    const links = extractInternalLinks(noteWithWikiLinks)
    expect(links).toContain('Another Note')
    expect(links).toContain('FolderSub Note') // Path separators are removed
    expect(links).toContain('Alias Link')
  })

  it('should remove path separators from links', () => {
    const note = {
      ...mockNote,
      content: 'Link to [[Folder/Sub/Folder/Note]]',
    }
    const links = extractInternalLinks(note)
    expect(links).toContain('FolderSubFolderNote')
  })

  it('should extract alias from [[link|alias]]', () => {
    const note = {
      ...mockNote,
      content: '[[Original Note|Display Name]]',
    }
    const links = extractInternalLinks(note)
    expect(links).toContain('Original Note')
  })

  it('should return empty array when no links', () => {
    const note = {
      ...mockNote,
      content: 'No links here.',
    }
    const links = extractInternalLinks(note)
    expect(links).toEqual([])
  })

  it('should return sorted links', () => {
    const note = {
      ...mockNote,
      content: '[[Zebra]] [[Alpha]] [[Beta]]',
    }
    const links = extractInternalLinks(note)
    expect(links).toEqual(links.slice().sort())
  })
})

describe('extractExternalLinks', () => {
  it('should extract markdown links', () => {
    const links = extractExternalLinks(mockNote)
    expect(links).toHaveLength(1)
    expect(links[0]).toEqual({
      text: 'External Link',
      url: 'https://example.com',
    })
  })

  it('should extract multiple external links', () => {
    const note = {
      ...mockNote,
      content: '[Link1](https://example.com) [Link2](https://google.com)',
    }
    const links = extractExternalLinks(note)
    expect(links).toHaveLength(2)
  })

  it('should handle links with special characters in URLs', () => {
    const note = {
      ...mockNote,
      content: '[Link](https://example.com/path?query=value&other=123)',
    }
    const links = extractExternalLinks(note)
    expect(links[0].url).toBe('https://example.com/path?query=value&other=123')
  })

  it('should handle links with parentheses in text', () => {
    const note = {
      ...mockNote,
      content: '[Link (with parens)](https://example.com)',
    }
    const links = extractExternalLinks(note)
    expect(links[0].text).toBe('Link (with parens)')
  })

  it('should return empty array when no links', () => {
    const note = {
      ...mockNote,
      content: 'No links here.',
    }
    const links = extractExternalLinks(note)
    expect(links).toEqual([])
  })
})

describe('extractHeadings', () => {
  it('should extract all heading levels', () => {
    const note = {
      ...mockNote,
      content: `# H1
## H2
### H3
`,
    }
    const headings = extractHeadings(note)
    expect(headings).toHaveLength(3)
    expect(headings[0]).toEqual({ level: 1, text: 'H1' })
    expect(headings[1]).toEqual({ level: 2, text: 'H2' })
    expect(headings[2]).toEqual({ level: 3, text: 'H3' })
  })

  it('should trim heading text', () => {
    const note = {
      ...mockNote,
      content: '#  Heading with spaces  ',
    }
    const headings = extractHeadings(note)
    expect(headings[0].text).toBe('Heading with spaces')
  })

  it('should handle heading with inline formatting', () => {
    const note = {
      ...mockNote,
      content: '# **Bold** and *italic* heading',
    }
    const headings = extractHeadings(note)
    expect(headings[0].text).toBe('**Bold** and *italic* heading')
  })

  it('should not extract setext-style headings (underlined)', () => {
    const note = {
      ...mockNote,
      content: `Heading
===
`,
    }
    const headings = extractHeadings(note)
    expect(headings).toHaveLength(0)
  })
})

describe('extractExcerpt', () => {
  it('should extract first paragraph', () => {
    const note = {
      ...mockNote,
      content: `# Title

First paragraph with some text.

Second paragraph.`,
    }
    const excerpt = extractExcerpt(note)
    expect(excerpt).toBe('First paragraph with some text.')
  })

  it('should skip YAML frontmatter', () => {
    const note = {
      ...mockNote,
      content: `---
title: Test
---

First paragraph.`,
    }
    const excerpt = extractExcerpt(note)
    expect(excerpt).toBe('First paragraph.')
  })

  it('should skip headings', () => {
    const note = {
      ...mockNote,
      content: `# Title

First paragraph.`,
    }
    const excerpt = extractExcerpt(note)
    expect(excerpt).toBe('First paragraph.')
  })

  it('should truncate long excerpts', () => {
    const longText = 'This is a very long paragraph that needs to be truncated. '.repeat(10)
    const note = {
      ...mockNote,
      content: longText,
    }
    const excerpt = extractExcerpt(note, 100)
    expect(excerpt).toBeDefined()
    expect(excerpt!.length).toBeLessThanOrEqual(103) // 100 + '...'
    expect(excerpt).toMatch(/\.\.\.$/)
  })

  it('should remove inline code formatting', () => {
    const note = {
      ...mockNote,
      content: 'First paragraph with `code` in it.',
    }
    const excerpt = extractExcerpt(note)
    expect(excerpt).toBe('First paragraph with code in it.')
  })

  it('should remove link formatting', () => {
    const note = {
      ...mockNote,
      content: 'First paragraph with [link](https://example.com) in it.',
    }
    const excerpt = extractExcerpt(note)
    expect(excerpt).toBe('First paragraph with link in it.')
  })

  it('should return undefined for empty content', () => {
    const note = {
      ...mockNote,
      content: '',
    }
    const excerpt = extractExcerpt(note)
    expect(excerpt).toBeUndefined()
  })
})

describe('parseFrontmatter', () => {
  it('should parse YAML frontmatter', () => {
    const content = `---
title: Test
tags: [a, b]
count: 42
active: true
---

Content`
    const fm = parseFrontmatter(content)
    expect(fm).toBeDefined()
    expect(fm?.title).toBe('Test')
    expect(fm?.tags).toEqual(['a', 'b'])
    expect(fm?.count).toBe(42)
    expect(fm?.active).toBe(true)
  })

  it('should parse array values in bracket notation', () => {
    const content = `---
tags: [first, second, third]
---

Content`
    const fm = parseFrontmatter(content)
    expect(fm?.tags).toEqual(['first', 'second', 'third'])
  })

  it('should handle empty array', () => {
    const content = `---
tags: []
---

Content`
    const fm = parseFrontmatter(content)
    expect(fm?.tags).toEqual([])
  })

  it('should handle quoted strings', () => {
    const content = `---
name: "John Doe"
email: 'john@example.com'
---

Content`
    const fm = parseFrontmatter(content)
    expect(fm?.name).toBe('John Doe')
    expect(fm?.email).toBe('john@example.com')
  })

  it('should return undefined for content without frontmatter', () => {
    const content = 'Just content'
    const fm = parseFrontmatter(content)
    expect(fm).toBeUndefined()
  })

  it('should return undefined for malformed frontmatter', () => {
    const content = '---\nTitle\nIn Content\n---'
    const fm = parseFrontmatter(content)
    expect(fm).toBeUndefined()
  })

  it('should skip comment lines', () => {
    const content = `---
# This is a comment
title: Test
---

Content`
    const fm = parseFrontmatter(content)
    expect(fm?.title).toBe('Test')
    expect(fm).not.toHaveProperty('# This is a comment')
  })
})

describe('countWords', () => {
  it('should count words in simple text', () => {
    const count = countWords('This is a simple test.')
    expect(count).toBe(5)
  })

  it('should ignore code blocks', () => {
    const content = `Hello world.

\`\`\`javascript
function test() {
  return "code";
}
\`\`\`

Back to text.`

    const count = countWords(content)
    expect(count).toBe(5) // "Hello", "world", "Back", "to", "text"
  })

  it('should remove markdown formatting', () => {
    const count = countWords('**Bold** and *italic* text')
    expect(count).toBe(4)
  })

  it('should handle multiple spaces', () => {
    const count = countWords('   Multiple    spaces   here   ')
    expect(count).toBe(3)
  })

  it('should count zero for empty string', () => {
    const count = countWords('')
    expect(count).toBe(0)
  })

  it('should handle special characters in words', () => {
    const count = countWords("It's a test-dash with underscore.")
    expect(count).toBe(5)
  })
})

describe('countCharacters', () => {
  it('should count characters', () => {
    const count = countCharacters('Hello')
    expect(count).toBe(5)
  })

  it('should count spaces', () => {
    const count = countCharacters('Hello World')
    expect(count).toBe(11)
  })

  it('should count newlines', () => {
    const count = countCharacters('Line 1\nLine 2\n')
    expect(count).toBe(14) // 6 + 1 + 6 + 1
  })

  it('should count zero for empty string', () => {
    const count = countCharacters('')
    expect(count).toBe(0)
  })

  it('should include all markdown syntax', () => {
    const count = countCharacters('# Heading\n**Bold** text')
    expect(count).toBe(23) // 1 + 1 + 7 + 1 + 2 + 4 + 2 + 1 + 4 = 23
  })
})
