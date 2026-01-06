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
   * Add file content to context.
   */
  addFileContent(path: string, content: string, language?: string): void {
    this._items.push({
      type: 'file_content',
      path,
      content,
      language,
      timestamp: Date.now(),
    });
    this._readFiles.add(path);
    this._version++;
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
   * Append a pre-built context item (used by Wizard to merge Worker results).
   */
  appendItem(item: ContextItem): void {
    this._items.push(item);
    this._version++;
  }

  /**
   * Get read files as array (for Worker snapshot).
   */
  getReadFilesArray(): string[] {
    return Array.from(this._readFiles);
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
    return context;
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
