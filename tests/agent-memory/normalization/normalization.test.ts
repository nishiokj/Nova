/**
 * Normalization Pipeline Tests
 *
 * Unit tests for the normalization system.
 */


import {
  // HTML
  htmlToText,
  htmlToTextWithLinks,
  decodeHtmlEntities,
  containsHtml,
  // Timestamps
  normalizeTimestamp,
  parseTimestamp,
  isValidDate,
  isTimestampLike,
  extractTimezone,
  // PII
  detectPII,
  redactPII,
  maskPII,
  analyzePII,
  containsPII,
  // Links
  extractLinks,
  extractUrlsOnly,
  extractDomains,
  normalizeUrl,
  countLinks,
  // Text
  normalizeText,
  normalizeUnicode,
  removeDiacritics,
  collapseWhitespace,
  removeControlChars,
  truncate,
  slugify,
  isEmpty,
  wordCount,
  // Pipeline
  NormalizationPipeline,
  createNormalizationPipeline,
} from 'agent-memory/normalization/index.js'

// ============ HTML Conversion Tests ============

describe('HTML to Text', () => {
  test('converts simple HTML to text', () => {
    const html = '<p>Hello <strong>World</strong></p>'
    expect(htmlToText(html)).toBe('Hello World')
  })

  test('handles line breaks', () => {
    const html = '<p>Line 1</p><p>Line 2</p>'
    const text = htmlToText(html)
    expect(text).toContain('Line 1')
    expect(text).toContain('Line 2')
  })

  test('converts lists', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>'
    const text = htmlToText(html)
    expect(text).toContain('1. Item 1')
    expect(text).toContain('2. Item 2')
  })

  test('removes scripts and styles', () => {
    const html = '<script>alert("evil")</script><p>Safe text</p><style>body{}</style>'
    expect(htmlToText(html)).toBe('Safe text')
  })

  test('decodes HTML entities', () => {
    const html = '&lt;script&gt; &amp; &quot;quotes&quot;'
    expect(htmlToText(html)).toBe('<script> & "quotes"')
  })

  test('handles image alt text', () => {
    const html = '<p>See <img src="x.jpg" alt="a cat"> here</p>'
    expect(htmlToText(html)).toBe('See [a cat] here')
  })

  test('returns empty for null/undefined', () => {
    expect(htmlToText(null as any)).toBe('')
    expect(htmlToText(undefined as any)).toBe('')
  })
})

describe('HTML Entity Decoding', () => {
  test('decodes named entities', () => {
    expect(decodeHtmlEntities('&nbsp;&amp;&lt;&gt;')).toBe(' &<>')
  })

  test('decodes numeric entities', () => {
    expect(decodeHtmlEntities('&#65;&#66;&#67;')).toBe('ABC')
  })

  test('decodes hex entities', () => {
    expect(decodeHtmlEntities('&#x41;&#x42;&#x43;')).toBe('ABC')
  })
})

describe('HTML Detection', () => {
  test('detects HTML tags', () => {
    expect(containsHtml('<p>text</p>')).toBe(true)
    expect(containsHtml('<div>')).toBe(true)
    expect(containsHtml('<br/>')).toBe(true)
  })

  test('returns false for plain text', () => {
    expect(containsHtml('Hello World')).toBe(false)
    expect(containsHtml('3 < 5')).toBe(false)
  })
})

describe('HTML Link Extraction', () => {
  test('extracts links from HTML', () => {
    const html = '<p>Visit <a href="https://example.com">Example</a></p>'
    const result = htmlToTextWithLinks(html)
    expect(result.links.length).toBe(1)
    expect(result.links[0].type).toBe('url')
    expect(result.links[0].normalized).toBe('https://example.com')
  })

  test('extracts mailto links as email type', () => {
    const html = '<a href="mailto:test@example.com">Email</a>'
    const result = htmlToTextWithLinks(html)
    expect(result.links[0].type).toBe('email')
    expect(result.links[0].normalized).toBe('test@example.com')
  })
})

// ============ Timestamp Tests ============

describe('Timestamp Parsing', () => {
  test('parses ISO 8601 format', () => {
    const date = parseTimestamp('2024-01-15T10:30:00Z')
    expect(date).not.toBeNull()
    expect(date!.toISOString()).toBe('2024-01-15T10:30:00.000Z')
  })

  test('parses ISO 8601 with offset', () => {
    const date = parseTimestamp('2024-01-15T10:30:00+05:00')
    expect(date).not.toBeNull()
  })

  test('parses Unix timestamp (seconds)', () => {
    const date = parseTimestamp('1705312200')
    expect(date).not.toBeNull()
    expect(date!.getFullYear()).toBe(2024)
  })

  test('parses Unix timestamp (milliseconds)', () => {
    const date = parseTimestamp('1705312200000')
    expect(date).not.toBeNull()
  })

  test('parses date only', () => {
    const date = parseTimestamp('2024-01-15')
    expect(date).not.toBeNull()
    expect(date!.getUTCFullYear()).toBe(2024)
    expect(date!.getUTCMonth()).toBe(0)
    expect(date!.getUTCDate()).toBe(15)
  })

  test('returns null for invalid input', () => {
    expect(parseTimestamp('not a date')).toBeNull()
    expect(parseTimestamp('')).toBeNull()
  })
})

describe('Timestamp Normalization', () => {
  test('normalizes to ISO 8601 by default', () => {
    const result = normalizeTimestamp('2024-01-15T10:30:00Z')
    expect(result.valid).toBe(true)
    expect(result.normalized).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  test('normalizes Unix timestamp', () => {
    const result = normalizeTimestamp(1705312200)
    expect(result.valid).toBe(true)
    expect(result.normalized).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('normalizes Date object', () => {
    const result = normalizeTimestamp(new Date('2024-01-15'))
    expect(result.valid).toBe(true)
  })

  test('returns error for invalid timestamp', () => {
    const result = normalizeTimestamp('invalid')
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('Timezone Extraction', () => {
  test('extracts UTC from Z suffix', () => {
    expect(extractTimezone('2024-01-15T10:30:00Z')).toBe('UTC')
  })

  test('extracts offset', () => {
    expect(extractTimezone('2024-01-15T10:30:00+05:00')).toBe('+05:00')
  })

  test('returns undefined for no timezone', () => {
    expect(extractTimezone('2024-01-15T10:30:00')).toBeUndefined()
  })
})

describe('Timestamp Validation', () => {
  test('validates reasonable dates', () => {
    expect(isValidDate(new Date('2024-01-15'))).toBe(true)
  })

  test('rejects invalid dates', () => {
    expect(isValidDate(new Date('invalid'))).toBe(false)
  })

  test('respects maxAgeDays option', () => {
    const oldDate = new Date('1990-01-01')
    expect(isValidDate(oldDate, { maxAgeDays: 365 })).toBe(false)
    expect(isValidDate(oldDate, { maxAgeDays: 0 })).toBe(true)
  })
})

describe('Timestamp Detection', () => {
  test('detects ISO strings', () => {
    expect(isTimestampLike('2024-01-15T10:30:00Z')).toBe(true)
  })

  test('detects Unix timestamps', () => {
    expect(isTimestampLike(1705312200)).toBe(true)
  })

  test('rejects non-timestamps', () => {
    expect(isTimestampLike('hello')).toBe(false)
    expect(isTimestampLike({})).toBe(false)
  })
})

// ============ PII Detection Tests ============

describe('PII Detection', () => {
  test('detects email addresses', () => {
    const pii = detectPII('Contact john@example.com for info')
    expect(pii.length).toBe(1)
    expect(pii[0].type).toBe('email')
    expect(pii[0].value).toBe('john@example.com')
  })

  test('detects phone numbers', () => {
    const pii = detectPII('Call me at (555) 123-4567')
    expect(pii.length).toBe(1)
    expect(pii[0].type).toBe('phone')
  })

  test('detects credit card numbers', () => {
    const pii = detectPII('Card: 4111 1111 1111 1111')
    expect(pii.length).toBe(1)
    expect(pii[0].type).toBe('credit_card')
  })

  test('detects SSNs', () => {
    const pii = detectPII('SSN: 123-45-6789')
    expect(pii.length).toBe(1)
    expect(pii[0].type).toBe('ssn')
  })

  test('detects IP addresses', () => {
    const pii = detectPII('Server at 8.8.8.8')
    expect(pii.length).toBe(1)
    expect(pii[0].type).toBe('ip_address')
  })

  test('filters by PII type', () => {
    const pii = detectPII('john@example.com 555-123-4567', { types: ['email'] })
    expect(pii.length).toBe(1)
    expect(pii[0].type).toBe('email')
  })

  test('returns empty for clean text', () => {
    const pii = detectPII('Hello World')
    expect(pii.length).toBe(0)
  })
})

describe('PII Redaction', () => {
  test('redacts detected PII', () => {
    const result = redactPII('Email: john@example.com')
    expect(result.text).toBe('Email: [REDACTED]')
    expect(result.redacted.length).toBe(1)
  })

  test('uses custom redaction string', () => {
    const result = redactPII('john@example.com', { redactionString: '***' })
    expect(result.text).toBe('***')
  })
})

describe('PII Masking', () => {
  test('partially masks PII', () => {
    const result = maskPII('john@example.com')
    expect(result.text).toMatch(/^jo.*om$/)
    expect(result.masked.length).toBe(1)
  })
})

describe('PII Analysis', () => {
  test('returns risk level', () => {
    const analysis = analyzePII('SSN: 123-45-6789')
    expect(analysis.hasPII).toBe(true)
    expect(analysis.riskLevel).toBe('high')
  })

  test('returns none for clean text', () => {
    const analysis = analyzePII('Hello World')
    expect(analysis.hasPII).toBe(false)
    expect(analysis.riskLevel).toBe('none')
  })
})

describe('containsPII', () => {
  test('returns true when PII present', () => {
    expect(containsPII('Email: test@example.com')).toBe(true)
  })

  test('returns false when no PII', () => {
    expect(containsPII('Hello World')).toBe(false)
  })
})

// ============ Link Extraction Tests ============

describe('Link Extraction', () => {
  test('extracts URLs', () => {
    const links = extractLinks('Visit https://example.com for more')
    expect(links.length).toBe(1)
    expect(links[0].type).toBe('url')
    expect(links[0].domain).toBe('example.com')
  })

  test('extracts emails', () => {
    const links = extractLinks('Email: test@example.com')
    expect(links.length).toBe(1)
    expect(links[0].type).toBe('email')
  })

  test('extracts mentions', () => {
    const links = extractLinks('Thanks @johndoe!')
    expect(links.length).toBe(1)
    expect(links[0].type).toBe('mention')
    expect(links[0].normalized).toBe('johndoe')
  })

  test('extracts hashtags', () => {
    const links = extractLinks('Check #TypeScript')
    expect(links.length).toBe(1)
    expect(links[0].type).toBe('hashtag')
    expect(links[0].normalized).toBe('typescript')
  })

  test('extracts issue references', () => {
    const links = extractLinks('Fixed in #123')
    expect(links.length).toBe(1)
    expect(links[0].type).toBe('reference')
  })

  test('filters by type', () => {
    const links = extractLinks('test@example.com https://example.com', { types: ['url'] })
    expect(links.length).toBe(1)
    expect(links[0].type).toBe('url')
  })
})

describe('URL Normalization', () => {
  test('lowercases host', () => {
    const normalized = normalizeUrl('https://EXAMPLE.COM/path')
    expect(normalized).toBe('https://example.com/path')
  })

  test('removes default ports', () => {
    const normalized = normalizeUrl('https://example.com:443/path')
    expect(normalized).toBe('https://example.com/path')
  })

  test('returns null for invalid URLs', () => {
    expect(normalizeUrl('not a url')).toBeNull()
  })
})

describe('Domain Extraction', () => {
  test('extracts domains from URLs', () => {
    const domains = extractDomains('Visit https://example.com and https://test.org')
    expect(domains).toContain('example.com')
    expect(domains).toContain('test.org')
  })

  test('extracts domains from emails', () => {
    const domains = extractDomains('Email: test@example.com')
    expect(domains).toContain('example.com')
  })
})

describe('Link Counting', () => {
  test('counts links by type', () => {
    const counts = countLinks('Visit https://example.com and email test@example.com @mention')
    expect(counts.url).toBe(1)
    expect(counts.email).toBe(1)
    expect(counts.mention).toBe(1)
  })
})

// ============ Text Normalization Tests ============

describe('Text Normalization', () => {
  test('collapses whitespace', () => {
    expect(normalizeText('hello   world')).toBe('hello world')
  })

  test('removes control characters', () => {
    expect(normalizeText('hello\x00world')).toBe('helloworld')
  })

  test('normalizes line endings', () => {
    expect(normalizeText('line1\r\nline2')).toBe('line1\nline2')
  })

  test('trims whitespace', () => {
    expect(normalizeText('  hello  ')).toBe('hello')
  })

  test('respects maxLength', () => {
    const result = normalizeText('hello world', { maxLength: 8 })
    expect(result.length).toBeLessThanOrEqual(8)
  })
})

describe('Unicode Normalization', () => {
  test('normalizes to NFC', () => {
    // e + combining acute = é
    const composed = normalizeUnicode('e\u0301')
    expect(composed).toBe('é')
  })
})

describe('Diacritics Removal', () => {
  test('removes accents', () => {
    expect(removeDiacritics('café')).toBe('cafe')
    expect(removeDiacritics('naïve')).toBe('naive')
  })
})

describe('Whitespace Collapsing', () => {
  test('collapses multiple spaces', () => {
    expect(collapseWhitespace('hello    world')).toBe('hello world')
  })

  test('handles tabs and other whitespace', () => {
    expect(collapseWhitespace('hello\t\tworld')).toBe('hello world')
  })
})

describe('Control Character Removal', () => {
  test('removes control characters', () => {
    expect(removeControlChars('hello\x00\x01world')).toBe('helloworld')
  })

  test('preserves newlines and tabs', () => {
    expect(removeControlChars('hello\n\tworld')).toBe('hello\n\tworld')
  })
})

describe('Truncation', () => {
  test('truncates to length', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
  })

  test('does not truncate short text', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  test('uses custom suffix', () => {
    expect(truncate('hello world', 9, '…')).toBe('hello wo…')
  })
})

describe('Slugify', () => {
  test('converts to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  test('removes special characters', () => {
    expect(slugify('Hello! World?')).toBe('hello-world')
  })

  test('handles accents', () => {
    expect(slugify('Café Résumé')).toBe('cafe-resume')
  })
})

describe('isEmpty', () => {
  test('returns true for empty', () => {
    expect(isEmpty('')).toBe(true)
    expect(isEmpty('   ')).toBe(true)
    expect(isEmpty(null)).toBe(true)
    expect(isEmpty(undefined)).toBe(true)
  })

  test('returns false for non-empty', () => {
    expect(isEmpty('hello')).toBe(false)
    expect(isEmpty(' a ')).toBe(false)
  })
})

describe('Word Count', () => {
  test('counts words', () => {
    expect(wordCount('hello world')).toBe(2)
    expect(wordCount('one two three four')).toBe(4)
  })

  test('returns 0 for empty', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('   ')).toBe(0)
  })
})

// ============ Pipeline Tests ============

describe('NormalizationPipeline', () => {
  const pipeline = createNormalizationPipeline()

  describe('normalizeTextField', () => {
    test('normalizes plain text', () => {
      const result = pipeline.normalizeTextField('Hello  World')
      expect(result.text).toBe('Hello World')
      expect(result.htmlConverted).toBe(false)
    })

    test('converts HTML when detected', () => {
      const result = pipeline.normalizeTextField('<p>Hello</p>')
      expect(result.text).toBe('Hello')
      expect(result.htmlConverted).toBe(true)
    })

    test('detects PII', () => {
      const result = pipeline.normalizeTextField('Email: test@example.com')
      expect(result.pii?.length).toBe(1)
      expect(result.pii?.[0].type).toBe('email')
    })

    test('extracts links', () => {
      const result = pipeline.normalizeTextField('Visit https://example.com')
      expect(result.links?.length).toBe(1)
    })
  })

  describe('normalizeHtmlField', () => {
    test('always converts HTML', () => {
      const result = pipeline.normalizeHtmlField('<p>Hello <strong>World</strong></p>')
      expect(result.text).toBe('Hello World')
      expect(result.htmlConverted).toBe(true)
    })

    test('extracts links from HTML', () => {
      const result = pipeline.normalizeHtmlField('<a href="https://example.com">Link</a>')
      expect(result.links?.length).toBeGreaterThan(0)
    })
  })

  describe('normalizeTimestampField', () => {
    test('normalizes valid timestamp', () => {
      const result = pipeline.normalizeTimestampField('2024-01-15T10:30:00Z')
      expect(result.valid).toBe(true)
      expect(result.normalized).toMatch(/2024-01-15/)
    })

    test('handles invalid timestamp', () => {
      const result = pipeline.normalizeTimestampField('not a date')
      expect(result.valid).toBe(false)
    })
  })

  describe('normalizeEntity', () => {
    test('normalizes message entity', () => {
      const data = {
        subject: 'Hello  World',
        body_html: '<p>Test <strong>message</strong></p>',
        sent_at: '2024-01-15T10:30:00Z',
      }

      const result = pipeline.normalizeEntity('message', data)
      expect(result.success).toBe(true)
      expect(result.fields.subject).toBeDefined()
      expect(result.fields.body_html).toBeDefined()
      expect(result.fields.sent_at).toBeDefined()
    })

    test('normalizes issue entity', () => {
      const data = {
        title: 'Fix bug',
        description: '<ul><li>Step 1</li><li>Step 2</li></ul>',
      }

      const result = pipeline.normalizeEntity('issue', data)
      expect(result.success).toBe(true)
    })

    test('collects all PII across fields', () => {
      const data = {
        subject: 'Email from test@example.com',
        body_text: 'Call 555-123-4567',
      }

      const result = pipeline.normalizeEntity('message', data)
      expect(result.allPii.length).toBe(2)
    })

    test('collects all links across fields', () => {
      const data = {
        subject: 'Check https://example.com',
        body_text: 'Also https://test.org',
      }

      const result = pipeline.normalizeEntity('message', data)
      expect(result.allLinks.length).toBe(2)
    })
  })

  describe('applyNormalization', () => {
    test('applies normalized values to data', () => {
      const data = {
        title: 'Hello  World',
        description: '<p>Test</p>',
      }

      const result = pipeline.normalizeEntity('issue', data)
      const applied = pipeline.applyNormalization(data, result)

      expect(applied.title).toBe('Hello World')
      expect(applied.description).toBe('Test')
    })
  })

  describe('analyzeEntityPii', () => {
    test('analyzes PII in entity', () => {
      const data = {
        subject: 'Email from john@example.com',
        body_text: 'SSN: 123-45-6789',
      }

      const analysis = pipeline.analyzeEntityPii('message', data)
      expect(analysis.hasPii).toBe(true)
      expect(analysis.riskLevel).toBe('high')
      expect(Object.keys(analysis.byField).length).toBe(2)
    })
  })

  describe('extractEntityLinks', () => {
    test('extracts all links from entity', () => {
      const data = {
        subject: 'Visit https://example.com',
        body_html: '<a href="https://test.org">Link</a>',
      }

      const links = pipeline.extractEntityLinks('message', data)
      expect(links.length).toBe(2)
    })
  })
})

describe('Custom Entity Specs', () => {
  test('registers custom entity spec', () => {
    const pipeline = new NormalizationPipeline()

    pipeline.registerEntitySpec({
      entityType: 'custom',
      fields: [
        { field: 'content', type: 'html', required: true },
        { field: 'timestamp', type: 'timestamp' },
      ],
    })

    const spec = pipeline.getEntitySpec('custom')
    expect(spec).toBeDefined()
    expect(spec?.fields.length).toBe(2)
  })
})
