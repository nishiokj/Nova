/**
 * WebFetch tool - Fetch and process web page content.
 *
 * Retrieves content from a URL, converts HTML to markdown, and optionally
 * processes it with a prompt using a lightweight extraction model.
 */

import type { ToolResult } from 'types';
import type { ToolRegistrationOptions, ToolExecutionContext } from '../types.js';

// ============================================
// TYPES
// ============================================

export interface WebFetchArgs {
  url: string;
  prompt: string;
}

// ============================================
// CONSTANTS
// ============================================

const MAX_CONTENT_LENGTH = 100000; // 100KB limit for content
const FETCH_TIMEOUT_MS = 30000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AgentBot/1.0; +https://github.com/example/agent)';

// ============================================
// EXECUTOR
// ============================================

/**
 * Fetch content from a URL and process it.
 */
export async function executeWebFetch(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const startTime = Date.now();
  const url = String(args.url ?? '').trim();
  const prompt = String(args.prompt ?? '').trim();

  if (!url) {
    return {
      toolName: 'WebFetch',
      status: 'error',
      output: 'URL is required',
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }

  if (!prompt) {
    return {
      toolName: 'WebFetch',
      status: 'error',
      output: 'Prompt describing what to extract is required',
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    // Upgrade HTTP to HTTPS
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:';
    }
    if (parsedUrl.protocol !== 'https:') {
      return {
        toolName: 'WebFetch',
        status: 'error',
        output: `Invalid URL protocol: ${parsedUrl.protocol}. Only HTTPS is supported.`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }
  } catch {
    return {
      toolName: 'WebFetch',
      status: 'error',
      output: `Invalid URL: ${url}`,
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }

  try {
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(parsedUrl.href, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Check for redirects to different hosts
    const responseUrl = new URL(response.url);
    if (responseUrl.host !== parsedUrl.host) {
      return {
        toolName: 'WebFetch',
        status: 'success',
        output: `Redirect detected to different host. Please fetch the redirect URL directly: ${response.url}`,
        isSuccess: true,
        durationMs: Date.now() - startTime,
        metadata: {
          redirectUrl: response.url,
          originalUrl: url,
        },
      };
    }

    if (!response.ok) {
      return {
        toolName: 'WebFetch',
        status: 'error',
        output: `Failed to fetch URL (${response.status}): ${response.statusText}`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    // Get content type
    const contentType = response.headers.get('content-type') ?? '';
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
    const isText = contentType.includes('text/') || contentType.includes('application/json');

    if (!isHtml && !isText) {
      return {
        toolName: 'WebFetch',
        status: 'error',
        output: `Unsupported content type: ${contentType}. WebFetch only supports HTML and text content.`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    // Read content with size limit
    let content = await response.text();
    const originalLength = content.length;

    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.slice(0, MAX_CONTENT_LENGTH);
    }

    // Convert HTML to markdown-like text
    if (isHtml) {
      content = htmlToMarkdown(content);
    }

    // Truncate again after conversion if needed
    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.slice(0, MAX_CONTENT_LENGTH) + '\n\n[Content truncated...]';
    }

    // Build response with context about what was fetched
    const output = [
      `## Fetched: ${parsedUrl.href}`,
      '',
      `**Prompt:** ${prompt}`,
      '',
      '---',
      '',
      content,
      '',
      '---',
      '',
      `*Content length: ${content.length} chars${originalLength > MAX_CONTENT_LENGTH ? ` (truncated from ${originalLength})` : ''}*`,
    ].join('\n');

    return {
      toolName: 'WebFetch',
      status: 'success',
      output,
      isSuccess: true,
      durationMs: Date.now() - startTime,
      metadata: {
        url: parsedUrl.href,
        contentType,
        contentLength: content.length,
        truncated: originalLength > MAX_CONTENT_LENGTH,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        toolName: 'WebFetch',
        status: 'error',
        output: `Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      toolName: 'WebFetch',
      status: 'error',
      output: `Failed to fetch URL: ${errorMessage}`,
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }
}

// ============================================
// HTML TO MARKDOWN CONVERSION
// ============================================

/**
 * Convert HTML to a readable markdown-like format.
 * This is a lightweight extraction - not a full HTML parser.
 */
function htmlToMarkdown(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Convert headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  // Convert links - preserve both text and URL
  text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Convert lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<\/?[ou]l[^>]*>/gi, '\n');

  // Convert paragraphs and divs
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');

  // Convert line breaks
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Convert bold and italic
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // Convert code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Convert blockquotes
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.split('\n').map((line) => line.trim()).join('\n');
  text = text.trim();

  return text;
}

// ============================================
// TOOL REGISTRATION
// ============================================

export const webFetchToolOptions: ToolRegistrationOptions = {
  name: 'WebFetch',
  description: `Fetch content from a URL and extract information based on a prompt.

IMPORTANT: This tool WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g., Google Docs, Confluence, Jira, GitHub). For GitHub, use the gh CLI instead.

Usage:
- Provide the URL to fetch
- Provide a prompt describing what information to extract
- HTTP URLs are automatically upgraded to HTTPS
- HTML content is converted to markdown for easier reading
- Large content is truncated to prevent context overflow

When redirects occur to a different host, you will receive the redirect URL and should make a new request.`,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      prompt: {
        type: 'string',
        description: 'A prompt describing what information to extract from the page',
      },
    },
    required: ['url', 'prompt'],
  },
  required: ['url', 'prompt'],
  executor: executeWebFetch,
  enabled: true,
  timeoutMs: 35000,
  readOnly: true,
  parallelizable: true,
  costHint: 'standard',
};
