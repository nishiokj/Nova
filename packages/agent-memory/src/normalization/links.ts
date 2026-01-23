/**
 * Link Extraction
 *
 * Extracts and normalizes links from text content.
 * Handles URLs, emails, mentions, hashtags, and references.
 */

import type { LinkType, LinkExtractionOptions, ExtractedLink } from './types.js'
import { DEFAULT_LINK_OPTIONS } from './types.js'

// ============ Link Patterns ============

/**
 * URL pattern - matches HTTP(S) and common protocols.
 * Intentionally permissive to catch most URLs.
 */
const URL_PATTERN = /https?:\/\/[^\s<>\[\]{}|\\^`"']+/gi

/**
 * Email pattern - standard email format.
 */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g

/**
 * Mention pattern - @username style.
 */
const MENTION_PATTERN = /@([A-Za-z0-9_-]+)/g

/**
 * Hashtag pattern - #tag style.
 * Must contain at least one letter (to distinguish from issue references).
 */
const HASHTAG_PATTERN = /#([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * Reference pattern - issue/PR references like #123, repo#123, org/repo#123.
 */
const REFERENCE_PATTERN = /(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)?#(\d+)/g

// ============ URL Normalization ============

/**
 * Normalize a URL to a canonical form.
 */
export function normalizeUrl(url: string, baseUrl?: string): string | null {
  try {
    const resolved = baseUrl ? new URL(url, baseUrl) : new URL(url)

    // Lowercase scheme and host
    let normalized = resolved.href

    // Remove default ports
    if (
      (resolved.protocol === 'http:' && resolved.port === '80') ||
      (resolved.protocol === 'https:' && resolved.port === '443')
    ) {
      normalized = normalized.replace(`:${resolved.port}`, '')
    }

    // Remove trailing slash for root paths
    if (resolved.pathname === '/' && !resolved.search && !resolved.hash) {
      normalized = normalized.replace(/\/$/, '')
    }

    // Sort query parameters
    if (resolved.search) {
      const params = new URLSearchParams(resolved.search)
      const sorted = new URLSearchParams([...params].sort())
      normalized = normalized.replace(resolved.search, '?' + sorted.toString())
    }

    return normalized
  } catch {
    return null
  }
}

/**
 * Extract the domain from a URL.
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Clean up a URL that may have trailing punctuation.
 */
function cleanUrlTrailing(url: string): string {
  // Remove trailing punctuation that's not part of the URL
  return url.replace(/[.,;:!?)]+$/, '')
}

// ============ Extraction ============

/**
 * Extract URLs from text.
 */
function extractUrls(text: string, options: LinkExtractionOptions): ExtractedLink[] {
  const links: ExtractedLink[] = []
  const pattern = new RegExp(URL_PATTERN.source, URL_PATTERN.flags)

  let match
  while ((match = pattern.exec(text)) !== null) {
    const original = match[0]
    const cleaned = cleanUrlTrailing(original)

    const normalized = options.normalize
      ? normalizeUrl(cleaned, options.baseUrl) || cleaned
      : cleaned

    links.push({
      type: 'url',
      original,
      normalized,
      start: match.index,
      end: match.index + original.length,
      domain: options.extractDomains ? extractDomain(normalized) || undefined : undefined,
    })
  }

  return links
}

/**
 * Extract email addresses from text.
 */
function extractEmails(text: string, _options: LinkExtractionOptions): ExtractedLink[] {
  const links: ExtractedLink[] = []
  const pattern = new RegExp(EMAIL_PATTERN.source, EMAIL_PATTERN.flags)

  let match
  while ((match = pattern.exec(text)) !== null) {
    const email = match[0]

    links.push({
      type: 'email',
      original: email,
      normalized: email.toLowerCase(),
      start: match.index,
      end: match.index + email.length,
      domain: email.split('@')[1]?.toLowerCase(),
    })
  }

  return links
}

/**
 * Extract @mentions from text.
 */
function extractMentions(text: string, _options: LinkExtractionOptions): ExtractedLink[] {
  const links: ExtractedLink[] = []
  const pattern = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags)

  let match
  while ((match = pattern.exec(text)) !== null) {
    const full = match[0]
    const username = match[1]

    links.push({
      type: 'mention',
      original: full,
      normalized: username.toLowerCase(),
      start: match.index,
      end: match.index + full.length,
    })
  }

  return links
}

/**
 * Extract #hashtags from text.
 */
function extractHashtags(text: string, _options: LinkExtractionOptions): ExtractedLink[] {
  const links: ExtractedLink[] = []
  const pattern = new RegExp(HASHTAG_PATTERN.source, HASHTAG_PATTERN.flags)

  let match
  while ((match = pattern.exec(text)) !== null) {
    const full = match[0]
    const tag = match[1]

    links.push({
      type: 'hashtag',
      original: full,
      normalized: tag.toLowerCase(),
      start: match.index,
      end: match.index + full.length,
    })
  }

  return links
}

/**
 * Extract issue/PR references from text.
 */
function extractReferences(text: string, _options: LinkExtractionOptions): ExtractedLink[] {
  const links: ExtractedLink[] = []
  const pattern = new RegExp(REFERENCE_PATTERN.source, REFERENCE_PATTERN.flags)

  let match
  while ((match = pattern.exec(text)) !== null) {
    const full = match[0]
    const org = match[1]
    const repo = match[2]
    const number = match[3]

    // Skip if it looks like a hashtag (no org/repo context and at word boundary)
    if (!org && !repo && /^\s*#\d+\s*$/.test(full)) {
      // Pure reference without context - could be issue or just a number
      links.push({
        type: 'reference',
        original: full,
        normalized: `#${number}`,
        start: match.index,
        end: match.index + full.length,
        context: 'issue',
      })
    } else {
      const normalized = org
        ? `${org}/${repo}#${number}`
        : repo
          ? `${repo}#${number}`
          : `#${number}`

      links.push({
        type: 'reference',
        original: full,
        normalized,
        start: match.index,
        end: match.index + full.length,
        context: 'issue',
      })
    }
  }

  return links
}

// ============ Main Extraction ============

/**
 * Extract all links from text.
 */
export function extractLinks(text: string, options: LinkExtractionOptions = {}): ExtractedLink[] {
  const opts = { ...DEFAULT_LINK_OPTIONS, ...options }

  if (!text || typeof text !== 'string') {
    return []
  }

  const allLinks: ExtractedLink[] = []
  const typesToExtract = opts.types || ['url', 'email', 'mention', 'hashtag', 'reference']

  const extractors: Record<LinkType, (text: string, options: LinkExtractionOptions) => ExtractedLink[]> = {
    url: extractUrls,
    email: extractEmails,
    mention: extractMentions,
    hashtag: extractHashtags,
    reference: extractReferences,
  }

  for (const type of typesToExtract) {
    const extractor = extractors[type]
    if (extractor) {
      allLinks.push(...extractor(text, opts))
    }
  }

  // Sort by position
  allLinks.sort((a, b) => a.start - b.start)

  // Remove overlapping (keep longer match)
  return removeOverlapping(allLinks)
}

/**
 * Remove overlapping links, keeping longer matches.
 */
function removeOverlapping(links: ExtractedLink[]): ExtractedLink[] {
  if (links.length <= 1) {
    return links
  }

  const result: ExtractedLink[] = []
  let lastEnd = -1

  for (const link of links) {
    if (link.start >= lastEnd) {
      result.push(link)
      lastEnd = link.end
    } else {
      // Overlap - keep longer one
      const last = result[result.length - 1]
      if (last && (link.end - link.start) > (last.end - last.start)) {
        result[result.length - 1] = link
        lastEnd = link.end
      }
    }
  }

  return result
}

// ============ Utilities ============

/**
 * Replace links in text with a transformation.
 */
export function replaceLinks(
  text: string,
  transform: (link: ExtractedLink) => string,
  options: LinkExtractionOptions = {}
): string {
  const links = extractLinks(text, options)
  if (links.length === 0) {
    return text
  }

  let result = ''
  let lastIndex = 0

  for (const link of links) {
    result += text.substring(lastIndex, link.start)
    result += transform(link)
    lastIndex = link.end
  }

  result += text.substring(lastIndex)

  return result
}

/**
 * Extract just the URLs from text.
 */
export function extractUrlsOnly(text: string, options: LinkExtractionOptions = {}): string[] {
  const links = extractLinks(text, { ...options, types: ['url'] })
  return links.map(l => l.normalized)
}

/**
 * Extract domains from all URLs in text.
 */
export function extractDomains(text: string): string[] {
  const links = extractLinks(text, { types: ['url', 'email'], extractDomains: true })
  const domains = new Set<string>()

  for (const link of links) {
    if (link.domain) {
      domains.add(link.domain)
    }
  }

  return [...domains]
}

/**
 * Check if text contains any links.
 */
export function containsLinks(text: string, types?: LinkType[]): boolean {
  return extractLinks(text, { types }).length > 0
}

/**
 * Count links by type.
 */
export function countLinks(text: string): Record<LinkType, number> {
  const links = extractLinks(text)
  const counts: Record<LinkType, number> = {
    url: 0,
    email: 0,
    mention: 0,
    hashtag: 0,
    reference: 0,
  }

  for (const link of links) {
    counts[link.type]++
  }

  return counts
}
