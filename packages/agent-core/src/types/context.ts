/**
 * Context Window and Context Item types.
 *
 * Design Principle: Match the OpenAI Responses API Input Model
 *
 * The OpenAI Responses API input field is an array of heterogeneous items:
 * input: [
 *   { type: 'message', role: 'user', content: [...] },
 *   { type: 'function_call', call_id: '...', name: '...', arguments: '...' },
 *   { type: 'function_call_output', call_id: '...', output: '...' },
 *   { type: 'reasoning', content: '...' },
 * ]
 *
 * Our ContextWindow.items IS the input array. We canonicalize around item types.
 */

import type { ContentBlock } from './llm.js';
import type { ContextWindowMetrics } from './session.js';
import { createContextWindowMetrics, updateContextMetrics } from './session.js';

// ============================================
// CONTEXT ITEM TYPES
// ============================================

/** Item types that can exist in a context window */
export type ContextItemType =
  | 'message'              // User/assistant/system messages
  | 'function_call'        // Tool invocation by model
  | 'function_call_output' // Result of tool execution
  | 'reasoning'            // Chain of thought (from reasoning models)
  | 'file_content';        // File loaded into context

/** Message item */
export interface MessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ContentBlock[];
  timestamp: number;
}

/** Function call item - model wants to call a tool */
export interface FunctionCallItem {
  type: 'function_call';
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  timestamp: number;
}

/** Function call output - result from tool execution */
export interface FunctionCallOutputItem {
  type: 'function_call_output';
  callId: string;
  output: string;
  isError?: boolean;
  durationMs?: number;
  timestamp: number;
}

/** Reasoning item - chain of thought */
export interface ReasoningItem {
  type: 'reasoning';
  content: string;
  timestamp: number;
}

/** File content item - file loaded into context */
export interface FileContentItem {
  type: 'file_content';
  id: string;
  path: string;
  content: string;
  language?: string;
  timestamp: number;
}

/** Union of all context item types */
export type ContextItem =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | FileContentItem;

// ============================================
// CONTEXT WINDOW SNAPSHOT (for persistence)
// ============================================

export interface ContextWindowSnapshot {
  sessionKey: string;
  maxTokens: number;
  items: ContextItem[];
  metrics: ContextWindowMetrics;
  version: number;
  readFiles: string[];
  fileContentCounter?: number;
}

// ============================================
// EJECTION & COMPACTION TYPES
// ============================================

/** Result of ejecting file content items */
export interface EjectResult {
  ejectedCount: number;
  ejectedIds: string[];
  pathsRemoved: string[];
}

/** Options for context compaction */
export interface CompactOptions {
  /** Remove file_content older than this many milliseconds */
  maxFileContentAgeMs?: number;
  /** Keep at most this many file_content items (LRU eviction) */
  maxFileContentCount?: number;
  /** Remove file_content items for the same path, keeping only the newest */
  deduplicateByPath?: boolean;
  /** Truncate function_call_output items longer than this */
  truncateOutputsTo?: number;
}

/** Result of compaction */
export interface CompactResult {
  itemsRemoved: number;
  fileContentRemoved: number;
  outputsTruncated: number;
  bytesRecovered: number;
}

// ============================================
// CONTEXT WINDOW TELEMETRY
// ============================================

export interface ContextWindowTelemetry {
  /** Index signature for Record<string, unknown> compatibility */
  [key: string]: unknown;
  sessionKey: string;
  itemCount: number;
  itemsByType: Record<ContextItemType, number>;
  readFilesCount: number;
  contextTokens: number;
  outputTokens: number;
  maxTokens: number;
  percentageUsed: number;
  version: number;
  /** For dashboard inspection */
  recentItems?: Array<{ type: string; preview: string; timestamp: number }>;
}

// ============================================
// CONTEXT WINDOW CLASS
// ============================================

/**
 * ContextWindow manages the conversation state for a session.
 *
 * Key design principles:
 * - items[] directly maps to OpenAI Responses API input format
 * - Mutations increment _version for optimistic concurrency
 * - getItemsForLLM() handles provider-specific conversion
 */
export class ContextWindow {
  readonly sessionKey: string;
  readonly maxTokens: number;

  private _items: ContextItem[] = [];
  private _metrics: ContextWindowMetrics;
  private _version = 0;
  private _readFiles: Set<string> = new Set();
  private _fileContentCounter = 0;

  constructor(sessionKey: string, maxTokens = 200_000) {
    this.sessionKey = sessionKey;
    this.maxTokens = maxTokens;
    this._metrics = createContextWindowMetrics(maxTokens);
  }

  // =========================================================================
  // Mutation Methods (increment _version)
  // =========================================================================

  /**
   * Add a message to the context window.
   */
  addMessage(role: MessageItem['role'], content: string | ContentBlock[]): void {
    this._items.push({
      type: 'message',
      role,
      content,
      timestamp: Date.now(),
    });
    this._version++;
    this._metrics = {
      ...this._metrics,
      messageCount: this._items.filter(i => i.type === 'message').length,
    };
  }

  /**
   * Add a function call (tool invocation by model).
   */
  addFunctionCall(callId: string, name: string, args: Record<string, unknown>): void {
    this._items.push({
      type: 'function_call',
      callId,
      name,
      arguments: args,
      timestamp: Date.now(),
    });
    this._version++;
  }

  /**
   * Add function call output (result from tool execution).
   */
  addFunctionCallOutput(
    callId: string,
    output: string,
    isError?: boolean,
    durationMs?: number
  ): void {
    this._items.push({
      type: 'function_call_output',
      callId,
      output,
      isError,
      durationMs,
      timestamp: Date.now(),
    });
    this._version++;
  }

  /**
   * Add reasoning content (chain of thought).
   */
  addReasoning(content: string): void {
    this._items.push({
      type: 'reasoning',
      content,
      timestamp: Date.now(),
    });
    this._version++;
  }

  /**
   * Add file content to context. Returns the generated ID.
   */
  addFileContent(path: string, content: string, language?: string): string {
    const id = `fc_${this.sessionKey.slice(0, 4)}_${++this._fileContentCounter}`;
    this._items.push({
      type: 'file_content',
      id,
      path,
      content,
      language,
      timestamp: Date.now(),
    });
    this._readFiles.add(path);
    this._version++;
    return id;
  }

  /**
   * Update metrics after an LLM response.
   */
  updateMetrics(promptTokens: number, completionTokens: number): void {
    this._metrics = updateContextMetrics(
      this._metrics,
      promptTokens,
      completionTokens,
      this._items.filter(i => i.type === 'message').length
    );
    this._version++;
  }

  /**
   * Mark a file as read (without adding content to context).
   */
  markFileRead(path: string): void {
    this._readFiles.add(path);
  }

  /**
   * Append a pre-built context item (used by Orchestrator to merge Agent results).
   */
  appendItem(item: ContextItem): void {
    this._items.push(item);
    this._version++;
  }

  /**
   * Get read files as array (for Agent tracking).
   */
  getReadFilesArray(): string[] {
    return Array.from(this._readFiles);
  }

  // =========================================================================
  // Ejection & Compaction Methods
  // =========================================================================

  /**
   * Eject all file_content items for a given path.
   * Removes the path from _readFiles if no items remain.
   */
  ejectFileContentByPath(path: string): EjectResult {
    const ejectedIds: string[] = [];
    this._items = this._items.filter((item) => {
      if (item.type === 'file_content' && item.path === path) {
        ejectedIds.push(item.id);
        return false;
      }
      return true;
    });

    if (ejectedIds.length > 0) {
      this._readFiles.delete(path);
      this._version++;
    }

    return {
      ejectedCount: ejectedIds.length,
      ejectedIds,
      pathsRemoved: ejectedIds.length > 0 ? [path] : [],
    };
  }

  /**
   * Eject a specific file_content item by ID.
   */
  ejectFileContentById(id: string): EjectResult {
    let ejectedPath: string | null = null;

    this._items = this._items.filter((item) => {
      if (item.type === 'file_content' && item.id === id) {
        ejectedPath = item.path;
        return false;
      }
      return true;
    });

    if (ejectedPath) {
      // Check if any other items for this path remain
      const hasOtherItems = this._items.some(
        (item) => item.type === 'file_content' && item.path === ejectedPath
      );
      if (!hasOtherItems) {
        this._readFiles.delete(ejectedPath);
      }
      this._version++;
      return {
        ejectedCount: 1,
        ejectedIds: [id],
        pathsRemoved: hasOtherItems ? [] : [ejectedPath],
      };
    }

    return { ejectedCount: 0, ejectedIds: [], pathsRemoved: [] };
  }

  /**
   * Invalidate file content after a file modification.
   * Convenience alias for ejectFileContentByPath.
   */
  invalidateFileContent(path: string): EjectResult {
    return this.ejectFileContentByPath(path);
  }

  /**
   * Compact the context window to reduce size.
   */
  compact(options: CompactOptions = {}): CompactResult {
    const {
      maxFileContentAgeMs,
      maxFileContentCount,
      deduplicateByPath = false,
      truncateOutputsTo,
    } = options;

    let itemsRemoved = 0;
    let fileContentRemoved = 0;
    let outputsTruncated = 0;
    let bytesRecovered = 0;
    const now = Date.now();
    const pathsRemoved = new Set<string>();

    // Track newest file_content per path for deduplication
    const newestByPath = new Map<string, { item: FileContentItem; index: number }>();

    // First pass: identify items to remove
    const toRemove = new Set<number>();

    this._items.forEach((item, index) => {
      if (item.type === 'file_content') {
        // Age-based removal
        if (maxFileContentAgeMs && now - item.timestamp > maxFileContentAgeMs) {
          toRemove.add(index);
          bytesRecovered += item.content.length;
          pathsRemoved.add(item.path);
          return;
        }

        // Track for deduplication
        if (deduplicateByPath) {
          const existing = newestByPath.get(item.path);
          if (existing) {
            if (item.timestamp > existing.item.timestamp) {
              toRemove.add(existing.index);
              bytesRecovered += existing.item.content.length;
              newestByPath.set(item.path, { item, index });
            } else {
              toRemove.add(index);
              bytesRecovered += item.content.length;
            }
          } else {
            newestByPath.set(item.path, { item, index });
          }
        }
      }
    });

    // Count-based removal (LRU - remove oldest first)
    if (maxFileContentCount) {
      const fileItems = this._items
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item, index }) => item.type === 'file_content' && !toRemove.has(index)
        )
        .sort((a, b) => a.item.timestamp - b.item.timestamp);

      const excess = fileItems.length - maxFileContentCount;
      if (excess > 0) {
        for (let i = 0; i < excess; i++) {
          const { item, index } = fileItems[i];
          toRemove.add(index);
          bytesRecovered += (item as FileContentItem).content.length;
          pathsRemoved.add((item as FileContentItem).path);
        }
      }
    }

    // Apply removals
    if (toRemove.size > 0) {
      this._items = this._items.filter((_, index) => !toRemove.has(index));
      itemsRemoved = toRemove.size;
      fileContentRemoved = toRemove.size;
      this._version++;
    }

    // Update _readFiles - remove paths with no remaining file_content
    for (const path of pathsRemoved) {
      const hasRemaining = this._items.some(
        (item) => item.type === 'file_content' && item.path === path
      );
      if (!hasRemaining) {
        this._readFiles.delete(path);
      }
    }

    // Truncate long outputs
    if (truncateOutputsTo) {
      for (const item of this._items) {
        if (
          item.type === 'function_call_output' &&
          item.output.length > truncateOutputsTo
        ) {
          const originalLength = item.output.length;
          item.output =
            item.output.slice(0, truncateOutputsTo) +
            `\n... [truncated ${originalLength - truncateOutputsTo} chars]`;
          bytesRecovered += originalLength - item.output.length;
          outputsTruncated++;
        }
      }
      if (outputsTruncated > 0) {
        this._version++;
      }
    }

    return {
      itemsRemoved,
      fileContentRemoved,
      outputsTruncated,
      bytesRecovered,
    };
  }

  // =========================================================================
  // Query Methods
  // =========================================================================

  get items(): readonly ContextItem[] {
    return this._items;
  }

  get metrics(): Readonly<ContextWindowMetrics> {
    return this._metrics;
  }

  get version(): number {
    return this._version;
  }

  get readFiles(): ReadonlySet<string> {
    return this._readFiles;
  }

  /**
   * Check if a file has been read in this session.
   */
  hasReadFile(path: string): boolean {
    return this._readFiles.has(path);
  }

  /**
   * Get items filtered by type.
   */
  getItemsByType<T extends ContextItem>(type: ContextItemType): T[] {
    return this._items.filter(item => item.type === type) as T[];
  }

  /**
   * Get the last N items.
   */
  getRecentItems(count: number): readonly ContextItem[] {
    return this._items.slice(-count);
  }

  // =========================================================================
  // LLM Integration
  // =========================================================================

  /**
   * Convert items to format suitable for LLM API calls.
   * Handles provider-specific conversions.
   */
  getItemsForLLM(): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    for (const item of this._items) {
      switch (item.type) {
        case 'message':
          result.push({
            type: 'message',
            role: item.role,
            content: item.content,
          });
          break;

        case 'function_call':
          result.push({
            type: 'function_call',
            call_id: item.callId,
            name: item.name,
            arguments: JSON.stringify(item.arguments),
          });
          break;

        case 'function_call_output':
          result.push({
            type: 'function_call_output',
            call_id: item.callId,
            output: item.output,
          });
          break;

        case 'reasoning':
          result.push({
            type: 'reasoning',
            content: item.content,
          });
          break;

        case 'file_content':
          // File content is typically injected as a user message
          result.push({
            type: 'message',
            role: 'user',
            content: `[File: ${item.path}]\n\`\`\`${item.language ?? ''}\n${item.content}\n\`\`\``,
          });
          break;
      }
    }

    return result;
  }

  /**
   * Convert items to Anthropic Messages API format.
   * Anthropic uses tool_use/tool_result content blocks instead of function_call items.
   */
  getItemsForAnthropic(): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    let pendingToolCalls: Array<{
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];

    for (const item of this._items) {
      switch (item.type) {
        case 'message':
          // Flush pending tool calls before user message
          if (item.role === 'user' && pendingToolCalls.length > 0) {
            result.push({
              role: 'assistant',
              content: pendingToolCalls,
            });
            pendingToolCalls = [];
          }
          result.push({
            role: item.role,
            content: item.content,
          });
          break;

        case 'function_call':
          pendingToolCalls.push({
            type: 'tool_use',
            id: item.callId,
            name: item.name,
            input: item.arguments,
          });
          break;

        case 'function_call_output':
          // Flush pending tool calls first
          if (pendingToolCalls.length > 0) {
            result.push({
              role: 'assistant',
              content: pendingToolCalls,
            });
            pendingToolCalls = [];
          }
          result.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: item.callId,
              content: item.output,
              is_error: item.isError,
            }],
          });
          break;

        case 'reasoning':
          // Anthropic doesn't have a separate reasoning type
          // Include as assistant message
          result.push({
            role: 'assistant',
            content: `[Reasoning]\n${item.content}`,
          });
          break;

        case 'file_content':
          result.push({
            role: 'user',
            content: `[File: ${item.path}]\n\`\`\`${item.language ?? ''}\n${item.content}\n\`\`\``,
          });
          break;
      }
    }

    // Flush any remaining tool calls
    if (pendingToolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: pendingToolCalls,
      });
    }

    return result;
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  /**
   * Serialize to snapshot for persistence.
   */
  serialize(): ContextWindowSnapshot {
    return {
      sessionKey: this.sessionKey,
      maxTokens: this.maxTokens,
      items: [...this._items],
      metrics: { ...this._metrics },
      version: this._version,
      readFiles: Array.from(this._readFiles),
      fileContentCounter: this._fileContentCounter,
    };
  }

  /**
   * Deserialize from snapshot.
   */
  static deserialize(snapshot: ContextWindowSnapshot): ContextWindow {
    const context = new ContextWindow(snapshot.sessionKey, snapshot.maxTokens);
    context._items = [...snapshot.items];
    context._metrics = { ...snapshot.metrics };
    context._version = snapshot.version;
    context._readFiles = new Set(snapshot.readFiles);
    context._fileContentCounter = snapshot.fileContentCounter ?? 0;
    return context;
  }

  /**
   * Create an independent copy of this context window.
   * Used for agent isolation - agents work on clones, not the original.
   */
  clone(): ContextWindow {
    return ContextWindow.deserialize(this.serialize());
  }

  /**
   * Check if context is near capacity based on token usage.
   * @param threshold - Fraction of maxTokens (0.0 to 1.0), default 0.8
   */
  isNearFull(threshold: number = 0.8): boolean {
    return this._metrics.percentageUsed >= threshold;
  }

  // =========================================================================
  // Telemetry
  // =========================================================================

  /**
   * Generate telemetry data for observability.
   */
  toTelemetry(): ContextWindowTelemetry {
    const itemsByType: Record<ContextItemType, number> = {
      message: 0,
      function_call: 0,
      function_call_output: 0,
      reasoning: 0,
      file_content: 0,
    };

    for (const item of this._items) {
      itemsByType[item.type]++;
    }

    // Get recent items for preview
    const recentItems = this._items.slice(-5).map(item => {
      let preview = '';
      switch (item.type) {
        case 'message':
          preview = typeof item.content === 'string'
            ? item.content.slice(0, 100)
            : '[content blocks]';
          break;
        case 'function_call':
          preview = `${item.name}(...)`;
          break;
        case 'function_call_output':
          preview = item.output.slice(0, 100);
          break;
        case 'reasoning':
          preview = item.content.slice(0, 100);
          break;
        case 'file_content':
          preview = item.path;
          break;
      }
      return {
        type: item.type,
        preview,
        timestamp: item.timestamp,
      };
    });

    return {
      sessionKey: this.sessionKey,
      itemCount: this._items.length,
      itemsByType,
      readFilesCount: this._readFiles.size,
      contextTokens: this._metrics.contextTokens,
      outputTokens: this._metrics.outputTokens,
      maxTokens: this.maxTokens,
      percentageUsed: this._metrics.percentageUsed,
      version: this._version,
      recentItems,
    };
  }
}
