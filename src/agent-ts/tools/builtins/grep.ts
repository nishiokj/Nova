/**
 * Grep tool - Search file contents with regex.
 *
 * Ported from: src/harness/agent/tool_registry.py (_grep_search)
 */

import { readdir, readFile, stat } from 'fs/promises';
import { resolve, join, relative } from 'path';
import type { ToolResult } from '../../types/tools.js';
import { successResult, errorResult } from '../../types/tools.js';
import type { ToolExecutionContext, ToolRegistrationOptions } from '../types.js';
import { shouldSkipDir, shouldSkipFile } from '../types.js';

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

/**
 * Search file contents with regex pattern.
 */
export async function executeGrep(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const cwd = (args.cwd as string) ?? context?.workdirOverride ?? process.cwd();
  const searchPath = (args.path as string) ?? '.';
  const maxResults = (args.maxResults as number) ?? 20;
  const caseSensitive = (args.caseSensitive as boolean) ?? false;

  const startTime = Date.now();
  const resolvedCwd = resolve(cwd);
  const resolvedPath = resolve(resolvedCwd, searchPath);

  try {
    // Compile regex
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (e) {
      return errorResult(
        'Grep',
        `Invalid regex pattern: ${pattern}`,
        Date.now() - startTime
      );
    }

    const matches: GrepMatch[] = [];

    // Walk directory tree
    async function searchDir(dirPath: string): Promise<void> {
      if (matches.length >= maxResults) return;

      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true });
      } catch {
        return; // Skip inaccessible directories
      }

      for (const entry of entries) {
        if (matches.length >= maxResults) break;

        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (!shouldSkipDir(entry.name)) {
            await searchDir(fullPath);
          }
        } else if (entry.isFile()) {
          if (!shouldSkipFile(entry.name)) {
            await searchFile(fullPath);
          }
        }
      }
    }

    async function searchFile(filePath: string): Promise<void> {
      if (matches.length >= maxResults) return;

      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            matches.push({
              file: relative(resolvedCwd, filePath),
              line: i + 1,
              content: lines[i].slice(0, 200), // Truncate long lines
            });
            // Reset lastIndex for global regex
            regex.lastIndex = 0;
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Check if path is a file or directory
    const pathStats = await stat(resolvedPath);
    if (pathStats.isFile()) {
      await searchFile(resolvedPath);
    } else {
      await searchDir(resolvedPath);
    }

    // Format output
    if (matches.length === 0) {
      return successResult(
        'Grep',
        `No matches found for pattern: ${pattern}`,
        Date.now() - startTime
      );
    }

    const output = matches
      .map((m) => `${m.file}:${m.line}: ${m.content}`)
      .join('\n');

    const truncated = matches.length >= maxResults;
    const finalOutput = truncated
      ? output + `\n...[truncated at ${maxResults} results]`
      : output;

    return {
      ...successResult('Grep', finalOutput, Date.now() - startTime),
      metadata: {
        pattern,
        matchCount: matches.length,
        truncated,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('Grep', `Search failed: ${message}`, Date.now() - startTime);
  }
}

/**
 * Grep tool registration options.
 */
export const grepToolOptions: ToolRegistrationOptions = {
  name: 'Grep',
  description: 'Search file contents with a regex pattern.',
  parameters: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Working directory to search within',
      },
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for',
      },
      path: {
        type: 'string',
        description: "Optional subpath to scope the search (default: '.')",
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of matches to return (default: 20)',
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Whether the search should respect case',
      },
    },
    required: ['cwd', 'pattern'],
  },
  required: ['cwd', 'pattern'],
  executor: executeGrep,
  timeoutMs: 20000,
  readOnly: true,
  parallelizable: true,
  costHint: 'low',
};
