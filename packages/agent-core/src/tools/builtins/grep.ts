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
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_EXTENSIONS,
  shouldSkipDir,
  shouldSkipFile,
} from '../types.js';
import { canUseRipgrep, runRipgrepLines } from './ripgrep.js';

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

const RIPGREP_GLOB_IGNORES = [
  ...Array.from(DEFAULT_EXCLUDE_DIRS).map((dir) => `!**/${dir}/**`),
  '!**/*.egg-info/**',
  ...Array.from(DEFAULT_EXCLUDE_EXTENSIONS).map((ext) => `!**/*${ext}`),
];

const RIPGREP_IGNORE_ARGS = RIPGREP_GLOB_IGNORES.flatMap((pattern) => [
  '--glob',
  pattern,
]);

function formatRipgrepLine(line: string): string {
  const firstColon = line.indexOf(':');
  if (firstColon === -1) return line;
  const secondColon = line.indexOf(':', firstColon + 1);
  if (secondColon === -1) return line;
  const prefix = line.slice(0, secondColon + 1);
  const content = line.slice(secondColon + 1);
  return prefix + content.slice(0, 200);
}

function isRipgrepRegexError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes('regex') || lowered.includes('pcre') || lowered.includes('parse');
}

async function tryRipgrepGrep(
  pattern: string,
  resolvedCwd: string,
  resolvedPath: string,
  maxResults: number,
  caseSensitive: boolean
): Promise<{
  matches: string[];
  truncated: boolean;
  error?: string;
  noMatches?: boolean;
} | null> {
  if (!(await canUseRipgrep())) return null;

  const relativePath = relative(resolvedCwd, resolvedPath) || '.';
  const args = [
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--color',
    'never',
    '--text',
    '--no-ignore',
    ...(caseSensitive ? [] : ['-i']),
    ...RIPGREP_IGNORE_ARGS,
    '-e',
    pattern,
    '--',
    relativePath,
  ];

  try {
    const rgResult = await runRipgrepLines(args, {
      cwd: resolvedCwd,
      maxLines: maxResults,
    });

    if (rgResult.exitCode === 1 && rgResult.lines.length === 0) {
      return { matches: [], truncated: false, noMatches: true };
    }

    if (rgResult.exitCode === 2 && !rgResult.truncated) {
      if (rgResult.stderr && isRipgrepRegexError(rgResult.stderr)) {
        return null;
      }
      const message = rgResult.stderr || 'ripgrep failed';
      return { matches: [], truncated: false, error: message };
    }

    const matches = rgResult.lines.map(formatRipgrepLine);
    const truncated = rgResult.truncated || matches.length >= maxResults;

    return { matches, truncated };
  } catch {
    return null;
  }
}

async function executeGrepFallback(
  pattern: string,
  resolvedCwd: string,
  resolvedPath: string,
  regex: RegExp,
  maxResults: number,
  startTime: number,
  pathIsFile: boolean
): Promise<ToolResult> {
  const matches: GrepMatch[] = [];

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

  if (pathIsFile) {
    await searchFile(resolvedPath);
  } else {
    await searchDir(resolvedPath);
  }

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

  // Compile regex
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch {
    return errorResult(
      'Grep',
      `Invalid regex pattern: ${pattern}`,
      Date.now() - startTime
    );
  }

  try {
    let pathStats;
    try {
      pathStats = await stat(resolvedPath);
    } catch {
      return successResult(
        'Grep',
        `Path not found: ${searchPath} (try ../path or ../../path for sibling directories)`,
        Date.now() - startTime
      );
    }

    const rgResult = await tryRipgrepGrep(
      pattern,
      resolvedCwd,
      resolvedPath,
      maxResults,
      caseSensitive
    );

    if (rgResult) {
      if (rgResult.error) {
        return errorResult(
          'Grep',
          `Search failed: ${rgResult.error}`,
          Date.now() - startTime
        );
      }

      if (rgResult.noMatches || rgResult.matches.length === 0) {
        return successResult(
          'Grep',
          `No matches found for pattern: ${pattern}`,
          Date.now() - startTime
        );
      }

      const output = rgResult.matches.join('\n');
      const finalOutput = rgResult.truncated
        ? output + `\n...[truncated at ${maxResults} results]`
        : output;

      return {
        ...successResult('Grep', finalOutput, Date.now() - startTime),
        metadata: {
          pattern,
          matchCount: rgResult.matches.length,
          truncated: rgResult.truncated,
        },
      };
    }

    return await executeGrepFallback(
      pattern,
      resolvedCwd,
      resolvedPath,
      regex,
      maxResults,
      startTime,
      pathStats.isFile()
    );
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
