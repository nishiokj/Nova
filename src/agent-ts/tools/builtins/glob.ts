/**
 * Glob tool - Find files by pattern using fast-glob.
 */

import fg from 'fast-glob';
import { resolve } from 'path';
import type { ToolResult } from '../../types/tools.js';
import { successResult, errorResult } from '../../types/tools.js';
import type { ToolExecutionContext, ToolRegistrationOptions } from '../types.js';

/** Default ignore patterns for common non-source directories */
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/.ruff_cache/**',
  '**/site-packages/**',
  '**/*.egg-info/**',
  '**/htmlcov/**',
  '**/.tox/**',
  '**/.eggs/**',
];

/**
 * Find files matching a glob pattern using fast-glob.
 */
export async function executeGlob(
  args: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const cwd = (args.cwd as string) ?? context?.workdirOverride ?? process.cwd();
  const maxResults = (args.maxResults as number) ?? 200;
  const includeHidden = (args.includeHidden as boolean) ?? false;
  const maxDepth = (args.maxDepth as number) ?? 20;

  const startTime = Date.now();
  const resolvedCwd = resolve(cwd);

  try {
    const matches = await fg(pattern, {
      cwd: resolvedCwd,
      dot: includeHidden,
      onlyFiles: false,
      unique: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      deep: maxDepth,
      ignore: DEFAULT_IGNORE,
    });

    const durationMs = Date.now() - startTime;

    if (matches.length === 0) {
      return successResult(
        'Glob',
        `No files found matching pattern: ${pattern}`,
        durationMs
      );
    }

    // Limit results
    const truncated = matches.length > maxResults;
    const limitedMatches = matches.slice(0, maxResults);

    // Sort matches
    limitedMatches.sort();

    let output = limitedMatches.join('\n');
    if (truncated) {
      output += `\n...[truncated at ${maxResults} results, ${matches.length} total]`;
    }

    return {
      ...successResult('Glob', output, durationMs),
      metadata: {
        pattern,
        matchCount: limitedMatches.length,
        totalMatches: matches.length,
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
      maxDepth: {
        type: 'number',
        description: 'Maximum directory depth to traverse (default: 20)',
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
