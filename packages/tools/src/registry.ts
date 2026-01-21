/**
 * Tool Registry - Registry and executor for agent tools.
 *
 * Ported from: src/harness/agent/tool_registry.py
 */

import type { ToolResult, ToolDefinition } from 'types';
import { successResult, errorResult, timeoutResult } from 'types';
import { profiler } from 'shared';
import type {
  Tool,
  ToolExecutor,
  ToolExecutionContext,
  ToolRegistrationOptions,
  CachedToolResult,
  CacheConfig,
  ToolRegistryConfig,
} from './types.js';
import { createTool, DEFAULT_CACHE_CONFIG, DEFAULT_TOOL_CONFIG } from './types.js';
import { validateToolArgs, TOOL_SCHEMAS } from './tool_schemas.js';

// ============================================
// TOOL REGISTRY
// ============================================

/**
 * Options for tool execution.
 */
export interface ToolExecuteOptions {
  /** Working directory for the tool */
  cwd?: string;
  /** Timeout override in milliseconds */
  timeout?: number;
  /** Allowed tools restriction (for skill-based filtering) */
  allowedTools?: Set<string>;
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
  }

  // ============================================
  // REGISTRATION
  // ============================================

  /**
   * Register a tool.
   */
  register(options: ToolRegistrationOptions): void {
    const tool = createTool(options);

    // Set enabled based on config
    if (this.config.enabledTools.includes(tool.name)) {
      tool.enabled = true;
    } else {
      tool.enabled = options.enabled ?? false;
    }

    this.tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool by name.
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered tools.
   */
  list(enabledOnly = true): Tool[] {
    const tools = Array.from(this.tools.values());
    if (enabledOnly) {
      return tools.filter((t) => t.enabled);
    }
    return tools;
  }

  /**
   * Get tool definitions for LLM.
   */
  getDefinitions(enabledOnly = true): ToolDefinition[] {
    return this.list(enabledOnly).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: t.strict,
    }));
  }

  /**
   * Enable a tool.
   */
  enable(name: string): boolean {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = true;
      return true;
    }
    return false;
  }

  /**
   * Disable a tool.
   */
  disable(name: string): boolean {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = false;
      return true;
    }
    return false;
  }

  /**
   * Check if a tool is parallel-safe.
   */
  isParallelSafe(name: string): boolean {
    const tool = this.tools.get(name);
    return !!(tool && tool.enabled && tool.readOnly && tool.parallelizable);
  }

  // ============================================
  // WORKING DIRECTORY
  // ============================================

  /**
   * Get the default working directory.
   */
  getWorkingDir(): string {
    return this.defaultWorkingDir;
  }

  /**
   * Set the default working directory.
   */
  setDefaultWorkingDir(dir: string): void {
    this.defaultWorkingDir = dir;
  }

  // ============================================
  // EXECUTION
  // ============================================

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

    // Resolve cwd: explicit option > defaultWorkingDir
    const resolvedCwd = options?.cwd ?? this.defaultWorkingDir;
    const argsWithCwd = {
      ...args,
      cwd: resolvedCwd,
    };

    // Debug: log if cwd looks suspicious
    if (!resolvedCwd || resolvedCwd === '.' || resolvedCwd.length < 3) {
      console.warn(`[ToolRegistry] Suspicious cwd for tool ${name}: "${resolvedCwd}" (defaultWorkingDir: "${this.defaultWorkingDir}")`);
    }

    // Check allowed tools restriction
    if (options?.allowedTools && !options.allowedTools.has(name)) {
      return errorResult(
        name,
        `Tool '${name}' not allowed by active skill`,
        0
      );
    }

    // Validate arguments against schema
    if (TOOL_SCHEMAS[name]) {
      const validation = validateToolArgs(name, argsWithCwd);
      if (!validation.success) {
        return errorResult(name, validation.error, 0);
      }
    }

    // Check cache for read-only tools
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

    // Build execution context for the tool executor
    const execContext: ToolExecutionContext = {
      workdirOverride: resolvedCwd,
      allowedTools: options?.allowedTools,
    };

    // Execute with timeout
    const timeout = options?.timeout ?? tool.timeoutMs;
    const startTime = Date.now();
    const asyncId = profiler.asyncBegin(`tool:${name}`, 'tool');

    try {
      const result = await this.executeWithTimeout(
        tool,
        argsWithCwd,
        timeout,
        execContext
      );

      result.durationMs = Date.now() - startTime;
      profiler.asyncEnd(`tool:${name}`, asyncId, 'tool', {
        success: result.isSuccess,
        durationMs: result.durationMs,
        cacheHit: isCacheable && cacheKey ? !!this.cache.get(cacheKey) : false,
      });

      // Cache successful read-only results
      if (isCacheable && cacheKey && result.isSuccess) {
        this.storeCachedResult(cacheKey, result);
        result.metadata = { ...result.metadata, cached: true };
      }

      // Invalidate caches for write operations
      if (result.isSuccess && (name === 'Write' || name === 'Edit')) {
        const path = (argsWithCwd as Record<string, unknown>).path as string;
        if (path) {
          this.invalidateCacheForPath(path);
        }
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      profiler.asyncEnd(`tool:${name}`, asyncId, 'tool', { error: true, durationMs });
      const message =
        error instanceof Error ? error.message : String(error);
      return errorResult(name, message, durationMs);
    }
  }

  /**
   * Execute tool with timeout.
   */
  private async executeWithTimeout(
    tool: Tool,
    args: Record<string, unknown>,
    timeoutMs: number,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve(timeoutResult(tool.name, timeoutMs));
      }, timeoutMs);

      tool
        .executor(args, context)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          const message =
            error instanceof Error ? error.message : String(error);
          resolve(errorResult(tool.name, message, 0));
        });
    });
  }

  // ============================================
  // CACHING
  // ============================================

  /**
   * Generate cache key for tool call.
   */
  private generateCacheKey(
    name: string,
    args: Record<string, unknown>
  ): string {
    const sorted = Object.entries(args).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const parts = [name, ...sorted.map(([k, v]) => `${k}=${v}`)];
    return parts.join('|');
  }

  /**
   * Get cached result if valid.
   */
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

  /**
   * Store result in cache.
   */
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

  /**
   * Invalidate cache entries for a path.
   */
  private invalidateCacheForPath(path: string): void {
    const keysToRemove: string[] = [];

    for (const key of this.cache.keys()) {
      const [toolName] = key.split('|');
      if (toolName === 'Read' && key.includes(`path=${path}`)) {
        keysToRemove.push(key);
      } else if (toolName === 'Glob' || toolName === 'Grep') {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.cache.delete(key);
    }
  }

  /**
   * Clear all cached results.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
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
