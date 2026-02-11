/**
 * WebFetch tool - Fetch and process web page content.
 *
 * Retrieves content from a URL, converts HTML to markdown, and extracts
 * prompt-relevant sections using lightweight heuristics.
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
const MAX_EXTRACTED_BLOCKS = 8;
const MIN_KEYWORD_LENGTH = 3;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'as',
  'at',
  'by',
  'from',
  'about',
  'into',
  'over',
  'after',
  'before',
  'between',
  'within',
  'without',
  'via',
  'what',
  'when',
  'where',
  'why',
  'how',
  'which',
  'who',
  'whom',
  'please',
  'show',
  'find',
  'list',
  'give',
  'tell',
  'summarize',
  'summary',
  'extract',
  'information',
  'info',
  'details',
  'data',
  'page',
  'website',
  'site',
  'content',
]);

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
      error: 'URL is required',
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }

  if (!prompt) {
    return {
      toolName: 'WebFetch',
      status: 'error',
      output: 'Prompt describing what to extract is required',
      error: 'Prompt describing what to extract is required',
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
        error: `Invalid URL protocol: ${parsedUrl.protocol}. Only HTTPS is supported.`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }
  } catch {
    return {
      toolName: 'WebFetch',
      status: 'error',
      output: `Invalid URL: ${url}`,
      error: `Invalid URL: ${url}`,
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }

  try {
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(parsedUrl.href, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const responseUrl = new URL(response.url);
    if (responseUrl.protocol !== 'https:') {
      return {
        toolName: 'WebFetch',
        status: 'error',
        output: `Invalid redirect protocol: ${responseUrl.protocol}. Only HTTPS is supported.`,
        error: `Invalid redirect protocol: ${responseUrl.protocol}. Only HTTPS is supported.`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    if (!response.ok) {
      return {
        toolName: 'WebFetch',
        status: 'error',
        output: `Failed to fetch URL (${response.status}): ${response.statusText}`,
        error: `Failed to fetch URL (${response.status}): ${response.statusText}`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    const contentTypeHeader = response.headers.get('content-type') ?? '';
    const { mimeType, charset } = parseContentType(contentTypeHeader);
    const rawContent = await readResponseText(response, charset);
    const rawLength = rawContent.length;
    const contentFlags = detectContentFlags(mimeType, rawContent);

    if (!contentFlags.isText) {
      return {
        toolName: 'WebFetch',
        status: 'error',
        output: `Unsupported content type: ${contentTypeHeader}. WebFetch only supports HTML, JSON, and text content.`,
        error: `Unsupported content type: ${contentTypeHeader}. WebFetch only supports HTML, JSON, and text content.`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    let content = rawContent;
    let htmlSource: string | undefined;
    if (contentFlags.isHtml) {
      const title = extractTitle(rawContent);
      const extracted = extractPrimaryHtml(rawContent);
      content = htmlToMarkdown(extracted.html, title);
      htmlSource = extracted.source;
    } else if (contentFlags.isJson) {
      content = formatJson(rawContent);
    }

    const extraction = extractRelevantContent(content, prompt);
    let finalContent = extraction.content;
    const extractedLength = finalContent.length;

    if (finalContent.length > MAX_CONTENT_LENGTH) {
      finalContent = finalContent.slice(0, MAX_CONTENT_LENGTH) + '\n\n[Content truncated...]';
    }

    const outputLines = [
      `## Fetched: ${responseUrl.href}`,
      '',
      `**Prompt:** ${prompt}`,
    ];
    if (responseUrl.href !== parsedUrl.href) {
      outputLines.push(`**Redirected from:** ${parsedUrl.href}`);
    }
    if (extraction.mode === 'extracted') {
      outputLines.push(
        `**Extraction:** matched ${extraction.matchedBlocks} of ${extraction.totalBlocks} blocks`
      );
    } else {
      outputLines.push('**Extraction:** full content');
    }
    if (extraction.keywords.length > 0) {
      outputLines.push(`**Keywords:** ${extraction.keywords.join(', ')}`);
    }
    if (htmlSource) {
      outputLines.push(`**HTML source:** ${htmlSource}`);
    }
    outputLines.push('', '---', '', finalContent, '', '---', '');
    outputLines.push(
      `*Content length: ${finalContent.length} chars${extractedLength > MAX_CONTENT_LENGTH ? ` (truncated from ${extractedLength})` : ''}*`
    );

    const output = outputLines.join('\n');

    return {
      toolName: 'WebFetch',
      status: 'success',
      output,
      isSuccess: true,
      durationMs: Date.now() - startTime,
      metadata: {
        url: responseUrl.href,
        originalUrl: parsedUrl.href,
        redirected: responseUrl.href !== parsedUrl.href,
        contentType: contentTypeHeader,
        contentLength: finalContent.length,
        rawLength,
        extractedLength,
        truncated: extractedLength > MAX_CONTENT_LENGTH,
        extractionMode: extraction.mode,
        extractionKeywords: extraction.keywords,
        htmlSource,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        toolName: 'WebFetch',
        status: 'error',
        output: `Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`,
        error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`,
        isSuccess: false,
        durationMs: Date.now() - startTime,
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      toolName: 'WebFetch',
      status: 'error',
      output: `Failed to fetch URL: ${errorMessage}`,
      error: `Failed to fetch URL: ${errorMessage}`,
      isSuccess: false,
      durationMs: Date.now() - startTime,
    };
  }
}

// ============================================
// CONTENT PROCESSING
// ============================================

interface ContentFlags {
  isHtml: boolean;
  isJson: boolean;
  isText: boolean;
}

function parseContentType(value: string): { mimeType: string; charset?: string } {
  if (!value) {
    return { mimeType: '' };
  }

  const [typePart, ...params] = value.split(';');
  let charset: string | undefined;

  for (const param of params) {
    const [key, val] = param.trim().split('=');
    if (key?.toLowerCase() === 'charset' && val) {
      charset = val.replace(/["']/g, '').trim();
    }
  }

  return { mimeType: typePart.trim().toLowerCase(), charset };
}

async function readResponseText(response: Response, charset?: string): Promise<string> {
  try {
    const buffer = await response.arrayBuffer();
    return decodeBuffer(buffer, charset);
  } catch {
    return response.text();
  }
}

function decodeBuffer(buffer: ArrayBuffer, charset?: string): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch {
      // Fall back to UTF-8 below.
    }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

function detectContentFlags(mimeType: string, content: string): ContentFlags {
  const normalized = mimeType.toLowerCase();
  if (normalized && normalized !== 'application/octet-stream') {
    const isHtml = normalized.includes('html') || normalized.includes('xhtml');
    const isJson = normalized.includes('json');
    const isText =
      normalized.startsWith('text/') ||
      normalized.includes('json') ||
      normalized.includes('xml') ||
      normalized.includes('xhtml');
    return { isHtml, isJson, isText };
  }

  const sample = content.slice(0, 1000);
  if (sample.includes('\u0000')) {
    return { isHtml: false, isJson: false, isText: false };
  }

  const normalizedSample = sample.trim().toLowerCase();
  const isHtml =
    normalizedSample.startsWith('<!doctype') ||
    normalizedSample.includes('<html') ||
    normalizedSample.includes('<body');
  const isJson = normalizedSample.startsWith('{') || normalizedSample.startsWith('[');

  return { isHtml, isJson, isText: true };
}

function extractPrimaryHtml(html: string): { html: string; source: string } {
  const candidates: Array<{ source: string; regex: RegExp; group: number }> = [
    { source: 'article', regex: /<article[^>]*>([\s\S]*?)<\/article>/i, group: 1 },
    { source: 'main', regex: /<main[^>]*>([\s\S]*?)<\/main>/i, group: 1 },
    {
      source: 'content',
      regex:
        /<(div|section)[^>]*(id|class)=["'][^"']*(content|article|post|entry|main)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
      group: 4,
    },
    { source: 'body', regex: /<body[^>]*>([\s\S]*?)<\/body>/i, group: 1 },
  ];

  for (const candidate of candidates) {
    const match = candidate.regex.exec(html);
    if (!match) {
      continue;
    }
    const extracted = match[candidate.group]?.trim();
    if (extracted) {
      return { html: extracted, source: candidate.source };
    }
  }

  return { html, source: 'document' };
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) {
    return undefined;
  }
  const title = decodeHtmlEntities(stripHtmlTags(match[1])).trim();
  return title || undefined;
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function extractRelevantContent(
  text: string,
  prompt: string
): {
  content: string;
  mode: 'full' | 'extracted';
  matchedBlocks: number;
  totalBlocks: number;
  keywords: string[];
} {
  const keywords = extractKeywords(prompt);
  const blocks = text
    .split(/\n{2,}/g)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return {
      content: text,
      mode: 'full',
      matchedBlocks: 0,
      totalBlocks: 0,
      keywords,
    };
  }

  if (keywords.length === 0) {
    return {
      content: text,
      mode: 'full',
      matchedBlocks: 0,
      totalBlocks: blocks.length,
      keywords,
    };
  }

  const scored = blocks.map((block, index) => {
    const lower = block.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      let pos = lower.indexOf(keyword);
      while (pos !== -1) {
        score += 1;
        pos = lower.indexOf(keyword, pos + keyword.length);
      }
    }
    if (block.startsWith('#')) {
      score += 1;
    }
    return { block, index, score };
  });

  const matches = scored.filter((item) => item.score > 0);
  if (matches.length === 0) {
    return {
      content: text,
      mode: 'full',
      matchedBlocks: 0,
      totalBlocks: blocks.length,
      keywords,
    };
  }

  matches.sort((a, b) => b.score - a.score);
  const selected = matches
    .slice(0, MAX_EXTRACTED_BLOCKS)
    .sort((a, b) => a.index - b.index);

  return {
    content: selected.map((item) => item.block).join('\n\n'),
    mode: 'extracted',
    matchedBlocks: selected.length,
    totalBlocks: blocks.length,
    keywords,
  };
}

function extractKeywords(prompt: string): string[] {
  const tokens = prompt
    .toLowerCase()
    .replace(/['"]/g, ' ')
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);

  const keywords = new Set<string>();
  for (const token of tokens) {
    if (token.length < MIN_KEYWORD_LENGTH) {
      continue;
    }
    if (STOPWORDS.has(token)) {
      continue;
    }
    keywords.add(token);
  }

  return Array.from(keywords);
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ============================================
// HTML TO MARKDOWN CONVERSION
// ============================================

/**
 * Convert HTML to a readable markdown-like format.
 * This is a lightweight extraction - not a full HTML parser.
 */
function htmlToMarkdown(html: string, title?: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<(nav|footer|aside|form|svg|canvas|iframe|template|menu)[\s\S]*?<\/\1>/gi, '');

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

  // Convert images
  text = text.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, '![$1]');
  text = text.replace(/<img[^>]*>/gi, '');

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
  text = stripHtmlTags(text);

  // Decode common HTML entities
  text = decodeHtmlEntities(text);

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.split('\n').map((line) => line.trim()).join('\n');
  text = text.trim();

  const normalizedTitle = title ? decodeHtmlEntities(stripHtmlTags(title)).trim() : '';
  if (normalizedTitle) {
    return `# ${normalizedTitle}\n\n${text}`;
  }

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
- Prompt keywords are used to extract the most relevant sections (full content if no matches)
- Large content is truncated to prevent context overflow

Redirects are followed automatically; the output notes when a redirect occurred.`,
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
