/**
 * Extended tool types for the tool registry.
 *
 * Ported from: src/harness/agent/tool_registry.py
 */

import type { ToolResult, ToolDefinition } from 'types';

// ============================================
// TOOL EXECUTION CONTEXT
// ============================================

/**
 * Execution context for tools with environment and working directory overrides.
 */
export interface ToolExecutionContext {
  /** Environment variable overrides */
  envOverrides?: Record<string, string>;
  /** Working directory override */
  workdirOverride?: string;
  /** Tool policy restrictions */
  allowedTools?: Set<string>;
  /** Dangerous mode - bypasses safety checks */
  dangerousMode?: boolean;
}

/**
 * Create a default execution context.
 */
export function createExecutionContext(): ToolExecutionContext {
  return {};
}

// ============================================
// TOOL DEFINITION (EXTENDED)
// ============================================

/**
 * Full tool definition with executor.
 */
export interface Tool {
  /** Tool name */
  name: string;
  /** Description for LLM */
  description: string;
  /** Parameter schema */
  parameters: ToolDefinition['parameters'];
  /** Whether to enforce strict schema mode */
  strict?: boolean;
  /** Required parameter names */
  required: string[];
  /** Tool executor function */
  executor: ToolExecutor;
  /** Whether tool is enabled */
  enabled: boolean;
  /** Execution timeout in ms */
  timeoutMs: number;
  /** Whether tool is read-only (safe for caching) */
  readOnly: boolean;
  /** Whether tool can run in parallel */
  parallelizable: boolean;
  /** Cost hint for budgeting */
  costHint: 'low' | 'standard' | 'high';
}

/**
 * Tool executor function type.
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  context?: ToolExecutionContext
) => Promise<ToolResult>;

// ============================================
// TOOL REGISTRATION
// ============================================

/**
 * Options for registering a tool.
 */
export interface ToolRegistrationOptions {
  name: string;
  description: string;
  parameters: ToolDefinition['parameters'];
  strict?: boolean;
  required: string[];
  executor: ToolExecutor;
  enabled?: boolean;
  timeoutMs?: number;
  readOnly?: boolean;
  parallelizable?: boolean;
  costHint?: 'low' | 'standard' | 'high';
}

/**
 * Create a tool from registration options.
 */
export function createTool(options: ToolRegistrationOptions): Tool {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    strict: options.strict,
    required: options.required,
    executor: options.executor,
    enabled: options.enabled ?? true,
    timeoutMs: options.timeoutMs ?? 30000,
    readOnly: options.readOnly ?? false,
    parallelizable: options.parallelizable ?? false,
    costHint: options.costHint ?? 'standard',
  };
}

// ============================================
// CACHE TYPES
// ============================================

/**
 * Cached tool result.
 */
export interface CachedToolResult {
  result: ToolResult;
  timestamp: number;
  hitCount: number;
}

/**
 * Cache configuration.
 */
export interface CacheConfig {
  /** TTL in milliseconds */
  ttlMs: number;
  /** Maximum cache entries */
  maxSize: number;
  /** Tool names that can be cached */
  cacheableTools: Set<string>;
}

/**
 * Default cache configuration.
 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  ttlMs: 60000, // 1 minute
  maxSize: 100,
  cacheableTools: new Set(['Read', 'Glob', 'Grep']),
};

// ============================================
// TOOL REGISTRY CONFIG
// ============================================

/**
 * Tool registry configuration.
 */
export interface ToolRegistryConfig {
  /** List of enabled tool names */
  enabledTools: string[];
  /** Bash execution timeout in ms */
  bashTimeoutMs: number;
  /** Maximum output length */
  maxOutputLength: number;
  /** Cache configuration */
  cache?: Partial<CacheConfig>;
  /** Dangerous mode - bypasses all safety checks */
  dangerousMode?: boolean;
}

/**
 * Default tool registry configuration.
 */
export const DEFAULT_TOOL_CONFIG: ToolRegistryConfig = {
  enabledTools: ['Read', 'Write', 'Edit', 'BatchEdit', 'Bash', 'Glob', 'Grep', 'Skill', 'PromptUser', 'ExpandConversation', 'WebSearch', 'WebFetch'],
  bashTimeoutMs: 30000,
  maxOutputLength: 100000,
};

// ============================================
// FILESYSTEM EXCLUSIONS
// ============================================

/**
 * Directories to always exclude from filesystem searches.
 */
export const DEFAULT_EXCLUDE_DIRS = new Set([
  '__pycache__',
  '.venv',
  'venv',
  'site-packages',
  'dist',
  'build',
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  'node_modules',
  '.tox',
  '.eggs',
  '.cache',
  '.ruff_cache',
  'htmlcov',
  'coverage',
  'logs',
  'log',
]);

/**
 * File extensions to exclude from search results.
 */
export const DEFAULT_EXCLUDE_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.so',
  '.o',
  '.a',
  '.dylib',
  '.dll',
  '.exe',
  '.class',
  '.log',
]);

/**
 * Check if a directory should be skipped.
 */
export function shouldSkipDir(dirname: string): boolean {
  if (DEFAULT_EXCLUDE_DIRS.has(dirname)) {
    return true;
  }
  // Handle glob patterns like *.egg-info
  if (dirname.endsWith('.egg-info')) {
    return true;
  }
  return false;
}

/**
 * Check if a file should be skipped.
 */
export function shouldSkipFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.'));
  return DEFAULT_EXCLUDE_EXTENSIONS.has(ext.toLowerCase());
}

// ============================================
// DANGEROUS COMMAND PATTERNS
// ============================================

/**
 * Dangerous command patterns to block.
 */
export const DANGEROUS_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  '> /dev/sda',
  'mkfs',
  ':(){:|:&};:',
  'dd if=/dev/',
  'chmod -R 777 /',
  'chown -R',
];

/**
 * Check if a command is dangerous.
 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => command.includes(pattern));
}
