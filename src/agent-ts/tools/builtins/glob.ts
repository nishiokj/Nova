/**
 * Glob tool - Find files by pattern.
 *
 * Ported from: src/harness/agent/tool_registry.py (_glob_search)
 */

import { readdir, stat } from 'fs/promises';
import { resolve, join, relative } from 'path';
import type { ToolResult } from '../../types/tools.js';
import { successResult, errorResult } from '../../types/tools.js';
import type { ToolExecutionContext, ToolRegistrationOptions } from '../types.js';
import { shouldSkipDir, shouldSkipFile } from '../types.js';

/**
 * Simple glob pattern matching.
 * Supports: *, **, ?
 */
function matchGlob(pattern: string, path: string): boolean {
  // Normalize path separators
  pattern = pattern.replace(/\\/g, '/');
  path = path.replace(/\\/g, '/');

  // Convert glob to regex
  let regexStr = '^';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any path including /
        if (pattern[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        // * matches anything except /
        regexStr += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      regexStr += '[^/]';
      i++;
    } else if (c === '[') {
      // Character class
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== ']') j++;
      regexStr += pattern.slice(i, j + 1);
      i = j + 1;
    } else if ('.^$+{}|()'.includes(c)) {
      // Escape regex special chars
      regexStr += '\\' + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }

  regexStr += '$';

  try {
    const regex = new RegExp(regexStr, 'i');
    return regex.test(path);
  } catch {
    return false;
  }
}

/**
 * Find files matching a glob pattern.
 */
export async function executeGlob(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const cwd = (args.cwd as string) ?? context?.workdirOverride ?? process.cwd();
  const maxResults = (args.maxResults as number) ?? 200;
  const includeHidden = (args.includeHidden as boolean) ?? false;

  const startTime = Date.now();
  const resolvedCwd = resolve(cwd);

  try {
    const matches: string[] = [];

    // Walk directory tree
    async function walkDir(dirPath: string, relPath = ''): Promise<void> {
      if (matches.length >= maxResults) return;

      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true });
      } catch {
        return; // Skip inaccessible directories
      }

      for (const entry of entries) {
        if (matches.length >= maxResults) break;

        // Skip hidden files/dirs unless explicitly included
        if (!includeHidden && entry.name.startsWith('.')) {
          continue;
        }

        const fullPath = join(dirPath, entry.name);
        const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          if (!shouldSkipDir(entry.name)) {
            // Check if directory matches pattern
            if (matchGlob(pattern, entryRelPath) || matchGlob(pattern, entryRelPath + '/')) {
              matches.push(entryRelPath + '/');
            }
            await walkDir(fullPath, entryRelPath);
          }
        } else if (entry.isFile()) {
          if (!shouldSkipFile(entry.name)) {
            if (matchGlob(pattern, entryRelPath)) {
              matches.push(entryRelPath);
            }
          }
        }
      }
    }

    await walkDir(resolvedCwd);

    // Sort matches
    matches.sort();

    // Format output
    if (matches.length === 0) {
      return successResult(
        'Glob',
        `No files found matching pattern: ${pattern}`,
        Date.now() - startTime
      );
    }

    const truncated = matches.length >= maxResults;
    let output = matches.join('\n');
    if (truncated) {
      output += `\n...[truncated at ${maxResults} results]`;
    }

    return {
      ...successResult('Glob', output, Date.now() - startTime),
      metadata: {
        pattern,
        matchCount: matches.length,
        truncated,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('Glob', `Glob search failed: ${message}`, Date.now() - startTime);
  }
}

/**
 * Glob tool registration options.
 */
export const globToolOptions: ToolRegistrationOptions = {
  name: 'Glob',
  description: 'Find files by glob pattern (e.g., **/*.ts, src/**/*.py).',
  parameters: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Working directory to resolve patterns against',
      },
      pattern: {
        type: 'string',
        description: 'Glob pattern to match',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of matches to return (default: 200)',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Include hidden files and directories (default: false)',
      },
    },
    required: ['cwd', 'pattern'],
  },
  required: ['cwd', 'pattern'],
  executor: executeGlob,
  timeoutMs: 15000,
  readOnly: true,
  parallelizable: true,
  costHint: 'low',
};
