/**
 * WebSearch tool - Perform web searches using Brave Search API.
 *
 * Requires BRAVE_SEARCH_API_KEY environment variable.
 * Free tier: 2,000 queries/month at https://brave.com/search/api/
 */

import type { ToolResult } from 'types';
import { Effect } from 'effect';
import type {
  ToolRegistrationOptions,
  ToolExecutionContext,
  ToolExecutionError,
} from '../types.js';
import { toToolExecutionError } from '../types.js';

// ============================================
// TYPES
// ============================================

export interface WebSearchArgs {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  count?: number;
}

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  query: { original: string; more_results_available: boolean };
  web?: { results: BraveWebResult[] };
  mixed?: { main: Array<{ type: string; index?: number }> };
}

// ============================================
// CONSTANTS
// ============================================

const BRAVE_API_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_RESULT_COUNT = 10;
const MAX_RESULT_COUNT = 20; // Brave API max
const FETCH_TIMEOUT_MS = 15000;
const ENV_KEY = 'BRAVE_SEARCH_API_KEY';

// ============================================
// EXECUTOR
// ============================================

export async function executeWebSearch(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const startTime = Date.now();
  const query = String(args.query ?? '').trim();

  if (!query) {
    return errorResult('Search query is required', startTime);
  }

  const apiKey = context?.envOverrides?.[ENV_KEY] ?? process.env[ENV_KEY];
  if (!apiKey) {
    return errorResult(
      `${ENV_KEY} is not set. Get a free key at https://brave.com/search/api/`,
      startTime
    );
  }

  const allowedDomains = parseStringArray(args.allowed_domains);
  const blockedDomains = parseStringArray(args.blocked_domains);
  const count = Math.min(
    Math.max(1, Number(args.count) || DEFAULT_RESULT_COUNT),
    MAX_RESULT_COUNT
  );

  try {
    const searchQuery = buildSearchQuery(query, allowedDomains, blockedDomains);

    const params = new URLSearchParams({
      q: searchQuery,
      count: String(count),
    });

    const signal = composeSignals(context?.signal, FETCH_TIMEOUT_MS);

    const response = await fetch(`${BRAVE_API_ENDPOINT}?${params}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return errorResult(
        `Brave Search API error (${response.status}): ${body || response.statusText}`,
        startTime
      );
    }

    const data = (await response.json()) as BraveSearchResponse;
    const results = data.web?.results ?? [];

    if (results.length === 0) {
      return {
        toolName: 'WebSearch',
        status: 'success',
        output: `No results found for: "${query}"`,
        isSuccess: true,
        durationMs: Date.now() - startTime,
      };
    }

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
      return errorResult(`Search timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`, startTime);
    }

    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Web search failed: ${msg}`, startTime);
  }
}

export function executeWebSearchEffect(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Effect.Effect<ToolResult, ToolExecutionError> {
  return Effect.tryPromise({
    try: () => executeWebSearch(args, context),
    catch: (error) =>
      toToolExecutionError(error, 'execution_error', {
        toolName: 'WebSearch',
        query: args.query,
      }),
  });
}

// ============================================
// HELPERS
// ============================================

function errorResult(message: string, startTime: number): ToolResult {
  return {
    toolName: 'WebSearch',
    status: 'error',
    output: message,
    error: message,
    isSuccess: false,
    durationMs: Date.now() - startTime,
  };
}

function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return value.trim() ? [value.trim()] : [];
    }
  }
  return [];
}

/**
 * Build a search query with domain filters.
 * Brave supports the same site: operator as Google/DDG.
 */
function buildSearchQuery(
  query: string,
  allowedDomains: string[],
  blockedDomains: string[]
): string {
  let q = query;

  if (allowedDomains.length === 1) {
    q = `site:${allowedDomains[0]} ${q}`;
  } else if (allowedDomains.length > 1) {
    const filters = allowedDomains.map((d) => `site:${d}`).join(' OR ');
    q = `(${filters}) ${q}`;
  }

  for (const domain of blockedDomains) {
    q = `${q} -site:${domain}`;
  }

  return q;
}

function formatSearchResults(results: BraveWebResult[], query: string): string {
  const lines: string[] = [
    `## Search Results for: "${query}"`,
    '',
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`### ${i + 1}. ${r.title}`);
    lines.push(`**URL:** ${r.url}`);
    if (r.description) {
      lines.push(`**Summary:** ${r.description}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Found ${results.length} results.`);

  return lines.join('\n');
}

function composeSignals(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([parentSignal, timeoutSignal]);
}

// ============================================
// TOOL REGISTRATION
// ============================================

export const webSearchToolOptions: ToolRegistrationOptions = {
  name: 'WebSearch',
  description: `Search the web using Brave Search API. Returns structured results with titles, URLs, and summaries.

Usage:
- Provide a search query to find relevant web pages
- Use allowed_domains to restrict results to specific sites
- Use blocked_domains to exclude specific sites from results

Requires BRAVE_SEARCH_API_KEY environment variable (free tier: 2,000 queries/month).

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
        description: 'Number of results to return (1-20, default: 10)',
      },
    },
    required: ['query'],
  },
  required: ['query'],
  executor: executeWebSearchEffect,
  enabled: true,
  timeoutMs: 20000,
  readOnly: true,
  parallelizable: true,
  costHint: 'low',
};
