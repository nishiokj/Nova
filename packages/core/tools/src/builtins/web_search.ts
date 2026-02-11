/**
 * WebSearch tool - Perform web searches using DuckDuckGo.
 *
 * No API key required - uses DuckDuckGo's HTML search.
 */

import type { ToolResult } from 'types';
import type { ToolRegistrationOptions, ToolExecutionContext } from '../types.js';

// ============================================
// TYPES
// ============================================

export interface WebSearchArgs {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  count?: number;
}

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

// ============================================
// CONSTANTS
// ============================================

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DEFAULT_RESULT_COUNT = 10;
const MAX_RESULT_COUNT = 25;
const FETCH_TIMEOUT_MS = 15000;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ============================================
// EXECUTOR
// ============================================

/**
 * Execute a web search using DuckDuckGo HTML.
 */
export async function executeWebSearch(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const startTime = Date.now();
  const query = String(args.query ?? '').trim();

  if (!query) {
    return {
      toolName: 'WebSearch',
      status: 'error',
      output: 'Search query is required',
      error: 'Search query is required',
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }

  // Parse optional parameters
  const allowedDomains = parseStringArray(args.allowed_domains);
  const blockedDomains = parseStringArray(args.blocked_domains);
  const count = Math.min(
    Math.max(1, Number(args.count) || DEFAULT_RESULT_COUNT),
    MAX_RESULT_COUNT
  );

  try {
    // Build search query with domain filters
    const searchQuery = buildSearchQuery(query, allowedDomains, blockedDomains);

    // Fetch DuckDuckGo HTML results
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const formData = new URLSearchParams();
    formData.append('q', searchQuery);
    formData.append('b', ''); // No pagination
    formData.append('kl', ''); // No region filter

    const response = await fetch(DDG_HTML_ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: formData.toString(),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        toolName: 'WebSearch',
        status: 'error',
        output: `Search request failed (${response.status}): ${response.statusText}`,
        error: `Search request failed (${response.status}): ${response.statusText}`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    const html = await response.text();
    const results = parseSearchResults(html, count);

    if (results.length === 0) {
      return {
        toolName: 'WebSearch',
        status: 'success',
        output: `No results found for: "${query}"`,
        isSuccess: true,
        durationMs: Date.now() - startTime,
      };
    }

    // Format results for the agent
    const formattedResults = formatSearchResults(results, query);

    return {
      toolName: 'WebSearch',
      status: 'success',
      output: formattedResults,
      isSuccess: true,
      durationMs: Date.now() - startTime,
      metadata: {
        query,
        resultCount: results.length,
        allowedDomains,
        blockedDomains,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        toolName: 'WebSearch',
        status: 'error',
        output: `Search timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`,
        error: `Search timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      toolName: 'WebSearch',
      status: 'error',
      output: `Web search failed: ${errorMessage}`,
      error: `Web search failed: ${errorMessage}`,
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }
}

// ============================================
// HTML PARSING
// ============================================

/**
 * Parse search results from DuckDuckGo HTML response.
 */
function parseSearchResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML uses <a class="result__a"> for result links
  // and <a class="result__snippet"> for descriptions

  // Match result blocks - each result is in a div with class "result"
  const resultBlockRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result|$)/gi;

  // More targeted: find result links and snippets
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  // Alternative approach: find all result entries more reliably
  // DuckDuckGo structure: result__a contains the link, result__snippet contains description

  let match;
  const links: { url: string; title: string }[] = [];
  const snippets: string[] = [];

  // Extract all links
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    const title = stripHtml(match[2]).trim();

    if (url && title) {
      // Skip internal DDG navigation links (starting with /)
      if (url.startsWith('/')) {
        continue;
      }

      // Extract actual URL from DDG redirect
      const actualUrl = extractActualUrl(url);
      if (actualUrl) {
        links.push({ url: actualUrl, title });
      }
    }
  }

  // Extract all snippets
  while ((match = snippetRegex.exec(html)) !== null) {
    const snippet = stripHtml(match[1]).trim();
    if (snippet) {
      snippets.push(snippet);
    }
  }

  // Combine links and snippets
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      description: snippets[i] || '',
    });
  }

  return results;
}

/**
 * Extract the actual URL from DuckDuckGo's redirect URL.
 */
function extractActualUrl(ddgUrl: string): string | null {
  // DDG uses //duckduckgo.com/l/?uddg=<encoded_url>&rut=<hash>
  if (ddgUrl.includes('uddg=')) {
    const match = ddgUrl.match(/uddg=([^&]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return null;
      }
    }
  }

  // Direct URL (no redirect)
  if (ddgUrl.startsWith('http://') || ddgUrl.startsWith('https://')) {
    return ddgUrl;
  }

  return null;
}

/**
 * Strip HTML tags from text.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================
// HELPERS
// ============================================

/**
 * Parse an array argument that might be a string, array, or undefined.
 */
function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // Single domain as string
      return value.trim() ? [value.trim()] : [];
    }
  }
  return [];
}

/**
 * Build a search query with domain filters.
 * DuckDuckGo supports site: operator for domain filtering.
 */
function buildSearchQuery(
  query: string,
  allowedDomains: string[],
  blockedDomains: string[]
): string {
  let modifiedQuery = query;

  // Add site: operators for allowed domains (OR together)
  if (allowedDomains.length > 0) {
    if (allowedDomains.length === 1) {
      modifiedQuery = `site:${allowedDomains[0]} ${modifiedQuery}`;
    } else {
      const siteFilters = allowedDomains.map((d) => `site:${d}`).join(' OR ');
      modifiedQuery = `(${siteFilters}) ${modifiedQuery}`;
    }
  }

  // Add -site: operators for blocked domains
  for (const domain of blockedDomains) {
    modifiedQuery = `${modifiedQuery} -site:${domain}`;
  }

  return modifiedQuery;
}

/**
 * Format search results into a readable string.
 */
function formatSearchResults(results: SearchResult[], query: string): string {
  const lines: string[] = [
    `## Search Results for: "${query}"`,
    '',
  ];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const index = i + 1;

    lines.push(`### ${index}. ${result.title}`);
    lines.push(`**URL:** ${result.url}`);
    if (result.description) {
      lines.push(`**Summary:** ${result.description}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Found ${results.length} results.`);

  return lines.join('\n');
}

// ============================================
// TOOL REGISTRATION
// ============================================

export const webSearchToolOptions: ToolRegistrationOptions = {
  name: 'WebSearch',
  description: `Search the web for information using DuckDuckGo. Returns search results with titles, URLs, and summaries.

Usage:
- Provide a search query to find relevant web pages
- Use allowed_domains to restrict results to specific sites
- Use blocked_domains to exclude specific sites from results
- Results include title, URL, and summary of each page

IMPORTANT: After using search results to answer a question, always include a "Sources:" section with the URLs you referenced.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to execute',
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include results from these domains (e.g., ["github.com", "stackoverflow.com"])',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude results from these domains',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (1-25, default: 10)',
      },
    },
    required: ['query'],
  },
  required: ['query'],
  executor: executeWebSearch,
  enabled: true,
  timeoutMs: 20000,
  readOnly: true,
  parallelizable: true,
  costHint: 'low',
};
