/**
 * Tool Registry - Registry and executor for agent tools.
 */

import type {
  ToolResult,
  ToolDefinition,
  RunControlMetadata,
  RunExecutionMetadata,
} from 'types';
import { errorResult, timeoutResult } from 'types';
import { Effect } from 'effect';
import { profiler } from 'shared';
import type {
  Tool,
  ToolExecutor,
  ToolExecutionContext,
  ToolExecutionError,
  ToolRegistrationOptions,
  CachedToolResult,
  CacheConfig,
  ToolRegistryConfig,
} from './types.js';
import {
  createTool,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_TOOL_CONFIG,
  toToolExecutionError,
} from './types.js';
import { validateToolArgs, TOOL_SCHEMAS } from './tool_schemas.js';

/**
 * Options for tool execution.
 */
export interface ToolExecuteOptions {
  /** Working directory for the tool */
  cwd?: string;
  /** Timeout override in milliseconds */
  timeout?: number;
  /** Optional cooperative cancellation signal */
  signal?: AbortSignal;
  /** Optional run execution metadata */
  execution?: RunExecutionMetadata;
  /** Optional run control snapshot */
  control?: RunControlMetadata;
  /** Additional metadata propagated to tool runtime */
  metadata?: Record<string, unknown>;
  /** Allowed tools restriction (for skill-based filtering) */
  allowedTools?: Set<string>;
  /** Environment variables to inject (e.g., provider API keys) */
  envOverrides?: Record<string, string>;
}

/**
 * Registry for tools available to the agent.
 * Manages tool registration, execution, caching, and lifecycle.
 *
 * This registry is stateless with respect to execution context - all context
 * is passed per-call via ToolExecuteOptions. This makes it safe to share
 * one registry across concurrent sessions.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private config: ToolRegistryConfig;
  private cacheConfig: CacheConfig;
  private cache = new Map<string, CachedToolResult>();
  private defaultWorkingDir: string;
  private dangerousMode: boolean;

  constructor(
    config: Partial<ToolRegistryConfig> = {},
    defaultWorkingDir?: string
  ) {
    this.config = { ...DEFAULT_TOOL_CONFIG, ...config };
    this.cacheConfig = {
      ...DEFAULT_CACHE_CONFIG,
      ...config.cache,
    };
    this.defaultWorkingDir = defaultWorkingDir ?? process.cwd();
    this.dangerousMode = config.dangerousMode ?? false;
  }

  register(options: ToolRegistrationOptions): void {
    const tool = createTool(options);

    if (this.config.enabledTools.includes(tool.name)) {
      tool.enabled = true;
    } else {
      tool.enabled = options.enabled ?? false;
    }

    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(enabledOnly = true): Tool[] {
    const tools = Array.from(this.tools.values());
    if (enabledOnly) {
      return tools.filter((t) => t.enabled);
    }
    return tools;
  }

  getDefinitions(enabledOnly = true): ToolDefinition[] {
    return this.list(enabledOnly).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: t.strict,
    }));
  }

  enable(name: string): boolean {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = true;
      return true;
    }
    return false;
  }

  disable(name: string): boolean {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = false;
      return true;
    }
    return false;
  }

  isParallelSafe(name: string): boolean {
    const tool = this.tools.get(name);
    return !!(tool && tool.enabled && tool.readOnly && tool.parallelizable);
  }

  getWorkingDir(): string {
    return this.defaultWorkingDir;
  }

  setDefaultWorkingDir(dir: string): void {
    this.defaultWorkingDir = dir;
  }

  /**
   * Execute a tool by name.
   *
   * All execution context (cwd, allowedTools) is passed explicitly via options.
   * This makes the registry stateless and safe for concurrent use.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    options?: ToolExecuteOptions
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return errorResult(name, `Tool '${name}' not found`, 0);
    }

    if (!tool.enabled) {
      return errorResult(name, `Tool '${name}' is disabled`, 0);
    }

    const resolvedCwd = options?.cwd ?? this.defaultWorkingDir;
    const argsWithCwd = {
      ...args,
      cwd: resolvedCwd,
    };

    // Debug: log if cwd looks suspicious
    if (!resolvedCwd || resolvedCwd === '.' || resolvedCwd.length < 3) {
      console.warn(`[ToolRegistry] Suspicious cwd for tool ${name}: "${resolvedCwd}" (defaultWorkingDir: "${this.defaultWorkingDir}")`);
    }

    if (options?.allowedTools && !options.allowedTools.has(name)) {
      return errorResult(
        name,
        `Tool '${name}' not allowed by active skill`,
        0
      );
    }

    if (TOOL_SCHEMAS[name]) {
      const validation = validateToolArgs(name, argsWithCwd);
      if (!validation.success) {
        return errorResult(name, validation.error, 0);
      }
    }

    const isCacheable =
      tool.readOnly && this.cacheConfig.cacheableTools.has(name);
    let cacheKey: string | null = null;

    if (isCacheable) {
      cacheKey = this.generateCacheKey(name, argsWithCwd);
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        cached.metadata = { ...cached.metadata, cacheHit: true };
        return cached;
      }
    }

    const execContext: ToolExecutionContext = {
      execution: options?.execution,
      control: options?.control,
      signal: options?.signal,
      workdirOverride: resolvedCwd,
      allowedTools: options?.allowedTools,
      envOverrides: options?.envOverrides,
      dangerousMode: this.dangerousMode,
      metadata: { ...(options?.metadata ?? {}), toolName: name },
    };

    const timeout = options?.timeout ?? tool.timeoutMs;
    const startTime = Date.now();
    const asyncId = profiler.asyncBegin(`tool:${name}`, 'tool');

    const result = await Effect.runPromise(
      this.executeToolEffect(tool.executor, argsWithCwd, execContext).pipe(
        Effect.timeoutFail({
          duration: timeout,
          onTimeout: () =>
            toToolExecutionError(
              { type: 'timeout', message: `Tool execution timed out after ${timeout}ms` },
              'timeout',
              { toolName: name, timeoutMs: timeout }
            ),
        }),
        Effect.catchAll((executionError) =>
          Effect.succeed(
            this.mapExecutionErrorToResult(
              name,
              executionError,
              Date.now() - startTime
            )
          )
        )
      )
    );

    result.durationMs = Date.now() - startTime;
    profiler.asyncEnd(`tool:${name}`, asyncId, 'tool', {
      success: result.isSuccess,
      durationMs: result.durationMs,
      cacheHit: isCacheable && cacheKey ? !!this.cache.get(cacheKey) : false,
    });

    if (isCacheable && cacheKey && result.isSuccess) {
      this.storeCachedResult(cacheKey, result);
      result.metadata = { ...result.metadata, cached: true };
    }

    if (result.isSuccess && (name === 'Write' || name === 'Edit' || name === 'BatchEdit' || name === 'apply_patch')) {
      if (name === 'apply_patch') {
        // apply_patch can touch multiple files — clear all read caches
        this.clearCache();
      } else {
        const argsRecord = argsWithCwd as Record<string, unknown>;
        const invalidate = (pathValue: unknown) => {
          if (typeof pathValue === 'string' && pathValue.length > 0) {
            this.invalidateCacheForPath(pathValue);
          }
        };

        if (name === 'BatchEdit') {
          const edits = argsRecord.edits;
          if (Array.isArray(edits)) {
            for (const edit of edits) {
              if (!edit || typeof edit !== 'object') continue;
              const editArgs = edit as Record<string, unknown>;
              invalidate(editArgs.path ?? editArgs.file_path);
            }
          }
        } else {
          invalidate(argsRecord.path ?? argsRecord.file_path);
        }
      }
    }

    return result;
  }

  private executeToolEffect(
    executor: ToolExecutor,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Effect.Effect<ToolResult, ToolExecutionError> {
    return Effect.suspend(() => executor(args, context)).pipe(
      Effect.raceFirst(this.awaitCancellation(context))
    );
  }

  private awaitCancellation(
    context: ToolExecutionContext
  ): Effect.Effect<never, ToolExecutionError> {
    if (!context.signal) {
      return Effect.never;
    }
    if (context.signal.aborted) {
      return Effect.fail(
        toToolExecutionError(
          { type: 'cancelled', message: 'Tool execution cancelled before start' },
          'cancelled'
        )
      );
    }

    return Effect.async<never, ToolExecutionError>((resume) => {
      const onAbort = () => {
        resume(
          Effect.fail(
            toToolExecutionError(
              { type: 'cancelled', message: 'Tool execution cancelled' },
              'cancelled'
            )
          )
        );
      };
      context.signal?.addEventListener('abort', onAbort, { once: true });
      return Effect.sync(() => {
        context.signal?.removeEventListener('abort', onAbort);
      });
    });
  }

  private mapExecutionErrorToResult(
    toolName: string,
    executionError: ToolExecutionError,
    durationMs: number
  ): ToolResult {
    if (executionError.type === 'timeout') {
      return timeoutResult(toolName, durationMs);
    }

    if (executionError.type === 'cancelled' || executionError.type === 'paused') {
      return {
        toolName,
        status: 'cancelled',
        output: executionError.message,
        error: executionError.message,
        durationMs,
        isSuccess: false,
        metadata: executionError.metadata,
      };
    }

    const result = errorResult(toolName, executionError.message, durationMs);
    result.metadata = executionError.metadata;
    return result;
  }

  private generateCacheKey(
    name: string,
    args: Record<string, unknown>
  ): string {
    const sorted = Object.entries(args).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const parts = [name, ...sorted.map(([k, v]) => `${k}=${String(v)}`)];
    return parts.join('|');
  }

  private getCachedResult(key: string): ToolResult | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > this.cacheConfig.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    cached.hitCount++;
    return { ...cached.result };
  }

  private storeCachedResult(key: string, result: ToolResult): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.cacheConfig.maxSize) {
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldest = k;
        }
      }
      if (oldest) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      hitCount: 0,
    });
  }

  private invalidateCacheForPath(path: string): void {
    const keysToRemove: string[] = [];

    for (const key of this.cache.keys()) {
      const [toolName] = key.split('|');
      if (toolName === 'Read' && (key.includes(`path=${path}`) || key.includes(`file_path=${path}`))) {
        keysToRemove.push(key);
      } else if (toolName === 'Glob' || toolName === 'Grep') {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.cache.delete(key);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): {
    size: number;
    maxSize: number;
    ttlMs: number;
    totalHits: number;
  } {
    let totalHits = 0;
    for (const cached of this.cache.values()) {
      totalHits += cached.hitCount;
    }

    return {
      size: this.cache.size,
      maxSize: this.cacheConfig.maxSize,
      ttlMs: this.cacheConfig.ttlMs,
      totalHits,
    };
  }
}
