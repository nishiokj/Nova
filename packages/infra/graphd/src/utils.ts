/**
 * GraphD utility functions.
 *
 */

import { createHash } from 'crypto';
import { posix as path } from 'path';

/**
 * Normalize paths to repo-relative, forward-slash format.
 */
export function normalizePath(filePath: string, root: string): string {
  if (!filePath) return '';

  // Make both paths absolute
  const absRoot = path.resolve(root);
  const absPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);

  // Get relative path
  const rel = path.relative(absRoot, absPath);

  // Already uses forward slashes (posix)
  return rel;
}

/**
 * Convert repo-relative paths back to absolute paths.
 */
export function denormalizePath(filePath: string, root: string): string {
  if (!filePath) return '';
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(root, filePath);
}

/**
 * SHA1 hash of text content.
 * Used for content fingerprinting, not security.
 */
export function sha1Text(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * SHA1 hash of binary data.
 * Used for content fingerprinting, not security.
 */
export function sha1Bytes(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * Generate a symbol ID from components.
 * Uses truncated SHA1 for compact IDs.
 */
export function makeSymbolId(
  filePath: string,
  kind: string,
  name: string,
  spanStart: number,
  spanEnd: number
): string {
  const base = `${filePath}:${kind}:${name}:${spanStart}:${spanEnd}`;
  return sha1Text(base).slice(0, 16);
}

/**
 * Map of file extensions to language names.
 */
const EXTENSION_TO_LANG: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.rb': 'ruby',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
};

/**
 * Guess language from file path.
 */
export function guessLanguage(filePath: string): string {
  const ext = path.extname(filePath.toLowerCase());
  return EXTENSION_TO_LANG[ext] ?? 'unknown';
}

/**
 * Check if a path is a test file.
 */
export function isTestPath(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

  // Check for tests directory
  if (normalizedPath.includes('/tests/') || normalizedPath.startsWith('tests/')) {
    return true;
  }

  // Check for __tests__ directory (React/Jest convention)
  if (normalizedPath.includes('/__tests__/') || normalizedPath.startsWith('__tests__/')) {
    return true;
  }

  // Check for test file patterns
  const base = path.basename(normalizedPath);
  return (
    base.startsWith('test_') ||
    base.endsWith('_test.py') ||
    base.endsWith('_spec.py') ||
    /\.(?:test|spec)\.(?:[jt]sx?|[mc][jt]s)$/.test(base)
  );
}

/**
 * Safely parse an integer from a string value.
 */
export function safeInt(value: string | null | undefined, defaultValue = 0): number {
  if (value === null || value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Safely parse a float from a string value.
 */
export function safeFloat(value: string | null | undefined, defaultValue = 0): number {
  if (value === null || value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Safely parse JSON.
 */
export function safeJsonParse<T>(json: string | null | undefined, defaultValue: T): T {
  if (!json) return defaultValue;
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Generate a unique session key.
 * Format: {client_type}_{timestamp}_{uuid8}
 */
export function generateSessionKey(clientType = 'tui'): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const uid = crypto.randomUUID().slice(0, 8);
  return `${clientType}_${timestamp}_${uid}`;
}

/**
 * Parse client type from session key.
 * Format: {client_type}_{timestamp}_{uuid8}
 * The client type may itself contain underscores, so we parse from the right:
 * the last segment is the uuid8, second-to-last is the timestamp, everything
 * before that is the client type.
 */
export function parseClientType(sessionKey: string): string {
  const parts = sessionKey.split('_');
  if (parts.length < 3) return parts[0] ?? 'unknown';
  // Last two segments are timestamp and uuid8
  return parts.slice(0, -2).join('_');
}

/**
 * Get current Unix timestamp in seconds (matches Python time.time()).
 */
export function nowSeconds(): number {
  return Date.now() / 1000;
}

/**
 * Convert Unix seconds to Date.
 */
export function secondsToDate(seconds: number): Date {
  return new Date(seconds * 1000);
}

/**
 * Convert Date to Unix seconds.
 */
export function dateToSeconds(date: Date): number {
  return date.getTime() / 1000;
}
