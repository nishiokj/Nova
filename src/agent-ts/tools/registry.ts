/**
 * Tool Registry - Registry and executor for agent tools.
 *
 * Ported from: src/harness/agent/tool_registry.py
 */

import type { ToolResult, ToolDefinition } from '../types/tools.js';
import { successResult, errorResult, timeoutResult } from '../types/tools.js';
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

// ============================================
// TOOL REGISTRY
// ============================================

/**
 * Registry for tools available to the agent.
 * Manages tool registration, execution, caching, and lifecycle.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private config: ToolRegistryConfig;
  private cacheConfig: CacheConfig;
  private cache = new Map<string, CachedToolResult>();
  private defaultWorkingDir: string;
  private currentContext: ToolExecutionContext = {};

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
  // CONTEXT MANAGEMENT
  // ============================================

  /**
   * Get the current working directory.
   */
  getWorkingDir(): string {
    return this.currentContext.workdirOverride ?? this.defaultWorkingDir;
  }

  /**
   * Set the default working directory.
   */
  setDefaultWorkingDir(dir: string): void {
    this.defaultWorkingDir = dir;
  }

  /**
   * Execute with a specific context.
   */
  async withContext<T>(
    context: ToolExecutionContext,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.currentContext;
    this.currentContext = { ...previous, ...context };
    try {
      return await fn();
    } finally {
      this.currentContext = previous;
    }
  }

  // ============================================
  // EXECUTION
  // ============================================

  /**
   * Execute a tool by name.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    timeoutOverride?: number
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return errorResult(name, `Tool '${name}' not found`, 0);
    }

    if (!tool.enabled) {
      return errorResult(name, `Tool '${name}' is disabled`, 0);
    }

    // Check allowed tools restriction
    if (
      this.currentContext.allowedTools &&
      !this.currentContext.allowedTools.has(name)
    ) {
      return errorResult(
        name,
        `Tool '${name}' not allowed by active skill`,
        0
      );
    }

    // Check cache for read-only tools
    const isCacheable =
      tool.readOnly && this.cacheConfig.cacheableTools.has(name);
    let cacheKey: string | null = null;

    if (isCacheable) {
      cacheKey = this.generateCacheKey(name, args);
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        cached.metadata = { ...cached.metadata, cacheHit: true };
        return cached;
      }
    }

    // Execute with timeout
    const timeout = timeoutOverride ?? tool.timeoutMs;
    const startTime = Date.now();

    try {
      const result = await this.executeWithTimeout(
        tool,
        args,
        timeout
      );

      result.durationMs = Date.now() - startTime;

      // Cache successful read-only results
      if (isCacheable && cacheKey && result.isSuccess) {
        this.storeCachedResult(cacheKey, result);
        result.metadata = { ...result.metadata, cached: true };
      }

      // Invalidate caches for write operations
      if (result.isSuccess && (name === 'Write' || name === 'Edit')) {
        const path = args.path as string;
        if (path) {
          this.invalidateCacheForPath(path);
        }
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
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
    timeoutMs: number
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve(timeoutResult(tool.name, timeoutMs));
      }, timeoutMs);

      tool
        .executor(args, this.currentContext)
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
