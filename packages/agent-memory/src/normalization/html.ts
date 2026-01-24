/**
 * HTML to Text Conversion
 *
 * Converts HTML content to plain text while preserving meaningful structure.
 * Uses a lightweight regex-based approach (no DOM parser dependency).
 */

import type { HtmlToTextOptions, ExtractedLink } from './types.js'
import { DEFAULT_HTML_OPTIONS } from './types.js'

// ============ HTML Entity Decoding ============

/**
 * Common HTML entities and their replacements.
 */
const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&lsquo;': "'",
  '&rsquo;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '...',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&deg;': '°',
  '&bull;': '•',
  '&middot;': '·',
}

/**
 * Decode HTML entities in a string.
 */
export function decodeHtmlEntities(html: string): string {
  let result = html

  // Decode named entities
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    result = result.replace(new RegExp(entity, 'gi'), replacement)
  }

  // Decode numeric entities (&#123; or &#x1a;)
  result = result.replace(/&#(\d+);/g, (_, code) => {
    return String.fromCharCode(parseInt(code, 10))
  })
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
    return String.fromCharCode(parseInt(code, 16))
  })

  return result
}

// ============ HTML Tag Handling ============

/**
 * Tags that should be replaced with line breaks.
 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'article', 'section', 'header', 'footer', 'nav', 'aside',
  'blockquote', 'pre', 'figure', 'figcaption', 'address',
  'table', 'tr', 'thead', 'tbody', 'tfoot',
])

/**
 * Tags whose content should be completely removed.
 */
const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'math',
])

/**
 * Strip HTML comments.
 */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Remove content from tags that should be completely excluded.
 */
function removeExcludedContent(html: string): string {
  let result = html
  for (const tag of REMOVE_TAGS) {
    const pattern = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi')
    result = result.replace(pattern, '')
  }
  return result
}

/**
 * Extract links from HTML anchor tags.
 */
export function extractLinksFromHtml(html: string): ExtractedLink[] {
  const links: ExtractedLink[] = []
  const anchorPattern = /<a\s+[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match

  while ((match = anchorPattern.exec(html)) !== null) {
    const url = decodeHtmlEntities(match[1])
    const text = stripTags(match[2]).trim()

    // Skip javascript: and mailto: links for URL type
    if (url.startsWith('mailto:')) {
      links.push({
        type: 'email',
        original: match[0],
        normalized: url.replace('mailto:', ''),
        start: match.index,
        end: match.index + match[0].length,
        context: text,
      })
    } else if (!url.startsWith('javascript:') && url.length > 0) {
      try {
        const urlObj = new URL(url, 'https://placeholder.com')
        links.push({
          type: 'url',
          original: match[0],
          normalized: url.startsWith('http') ? url : urlObj.href,
          start: match.index,
          end: match.index + match[0].length,
          domain: url.startsWith('http') ? urlObj.hostname : undefined,
          context: text,
        })
      } catch {
        // Invalid URL, skip
      }
    }
  }

  return links
}

/**
 * Strip all HTML tags from a string.
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

/**
 * Convert list items to text with bullets/numbers.
 */
function convertLists(html: string, preserveLists: boolean): string {
  if (!preserveLists) {
    return html
  }

  let result = html
  let listCounter = 0

  // Unordered lists
  result = result.replace(/<ul[^>]*>/gi, '')
  result = result.replace(/<\/ul>/gi, '\n')

  // Ordered lists - track numbering
  result = result.replace(/<ol[^>]*>/gi, () => {
    listCounter = 0
    return ''
  })
  result = result.replace(/<\/ol>/gi, '\n')

  // List items
  result = result.replace(/<li[^>]*>/gi, () => {
    listCounter++
    return `${listCounter}. `
  })
  result = result.replace(/<\/li>/gi, '\n')

  return result
}

/**
 * Handle block-level tags by adding line breaks.
 */
function handleBlockTags(html: string, preserveLineBreaks: boolean): string {
  if (!preserveLineBreaks) {
    return html
  }

  let result = html

  // Add line breaks for block tags
  for (const tag of BLOCK_TAGS) {
    // Opening tag
    result = result.replace(new RegExp(`<${tag}[^>]*>`, 'gi'), '\n')
    // Closing tag
    result = result.replace(new RegExp(`</${tag}>`, 'gi'), '\n')
  }

  // Handle <br> tags specifically
  result = result.replace(/<br\s*\/?>/gi, '\n')

  return result
}

/**
 * Extract alt text from images.
 */
function handleImages(html: string, useImageAlt: boolean): string {
  if (!useImageAlt) {
    return html.replace(/<img[^>]*>/gi, '')
  }

  return html.replace(/<img\s+[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, (_, alt) => {
    return alt ? `[${decodeHtmlEntities(alt)}]` : ''
  }).replace(/<img[^>]*>/gi, '') // Remove images without alt
}

/**
 * Normalize whitespace in the result.
 */
function normalizeWhitespace(text: string): string {
  // Collapse multiple spaces to single space
  let result = text.replace(/[ \t]+/g, ' ')

  // Collapse multiple newlines to double newlines (paragraph break)
  result = result.replace(/\n{3,}/g, '\n\n')

  // Remove spaces at the beginning of lines
  result = result.replace(/\n +/g, '\n')

  // Remove spaces at the end of lines
  result = result.replace(/ +\n/g, '\n')

  return result.trim()
}

/**
 * Wrap text to a maximum line length.
 */
function wrapText(text: string, maxLineLength: number): string {
  if (maxLineLength <= 0) {
    return text
  }

  const lines = text.split('\n')
  const wrapped: string[] = []

  for (const line of lines) {
    if (line.length <= maxLineLength) {
      wrapped.push(line)
      continue
    }

    // Wrap long lines
    let remaining = line
    while (remaining.length > maxLineLength) {
      // Find last space before maxLineLength
      let breakPoint = remaining.lastIndexOf(' ', maxLineLength)
      if (breakPoint <= 0) {
        breakPoint = maxLineLength
      }
      wrapped.push(remaining.substring(0, breakPoint))
      remaining = remaining.substring(breakPoint).trim()
    }
    if (remaining.length > 0) {
      wrapped.push(remaining)
    }
  }

  return wrapped.join('\n')
}

// ============ Main Conversion ============

/**
 * Convert HTML to plain text.
 */
export function htmlToText(html: string, options: HtmlToTextOptions = {}): string {
  const opts = { ...DEFAULT_HTML_OPTIONS, ...options }

  if (!html || typeof html !== 'string') {
    return ''
  }

  let result = html

  // Step 1: Remove comments
  result = stripComments(result)

  // Step 2: Remove script, style, etc.
  result = removeExcludedContent(result)

  // Step 3: Handle lists
  result = convertLists(result, opts.preserveLists)

  // Step 4: Handle block tags
  result = handleBlockTags(result, opts.preserveLineBreaks)

  // Step 5: Handle images
  result = handleImages(result, opts.useImageAlt)

  // Step 6: Strip remaining tags
  result = stripTags(result)

  // Step 7: Decode HTML entities
  result = decodeHtmlEntities(result)

  // Step 8: Normalize whitespace
  result = normalizeWhitespace(result)

  // Step 9: Wrap text if needed
  result = wrapText(result, opts.maxLineLength)

  return result
}

/**
 * Convert HTML to text and extract links.
 */
export function htmlToTextWithLinks(
  html: string,
  options: HtmlToTextOptions = {}
): { text: string; links: ExtractedLink[] } {
  // Extract links before stripping HTML
  const links = extractLinksFromHtml(html)

  // Convert to text
  const text = htmlToText(html, options)

  return { text, links }
}

/**
 * Check if a string contains HTML tags.
 */
export function containsHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text)
}
