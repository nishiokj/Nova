/**
 * ContextWindow - Manages conversation state for a session.
 *
 * Key design principles:
 * - items[] directly maps to OpenAI Responses API input format
 * - Mutations increment _version for optimistic concurrency
 * - getItemsForLLM() handles provider-specific conversion
 */

import type { ContentBlock } from 'types';
import type { ContextWindowMetrics } from 'types';
import { createContextWindowMetrics, updateContextMetrics } from 'types';
import type {
  ContextItem,
  ContextItemType,
  ContextWindowSnapshot,
  ContextWindowTelemetry,
  MessageItem,
  FileContentItem,
  ArtifactPayload,
  ArtifactItem,
  EjectResult,
  CompactOptions,
  CompactResult,
} from 'types';

// =========================================================================
// Artifact Formatting
// =========================================================================

/**
 * Format an artifact for LLM consumption - compact, no fluff.
 * Only includes actionable information: signature, side effects, call graph, non-obvious insights.
 */
function formatArtifactForLLM(artifact: ArtifactPayload): string {
  const kindAbbrev: Record<string, string> = {
    function: 'fn',
    class: 'class',
    interface: 'iface',
    import: 'import',
    export: 'export',
    constant: 'const',
    pattern: 'pattern',
    summary: 'summary',
  };

  const parts: string[] = [];

  // Header: [kind] path:line name or signature
  const loc = artifact.line ? `${artifact.sourcePath}:${artifact.line}` : artifact.sourcePath;
  const header = artifact.signature
    ? `[${kindAbbrev[artifact.kind] ?? artifact.kind}] ${loc}\n${artifact.signature}`
    : `[${kindAbbrev[artifact.kind] ?? artifact.kind}] ${loc} ${artifact.name}`;
  parts.push(header);

  // Side effects
  if (artifact.modifies?.length) {
    parts.push(`→ modifies: ${artifact.modifies.join(', ')}`);
  }

  // Call graph (non-trivial calls only)
  if (artifact.calls?.length) {
    parts.push(`→ calls: ${artifact.calls.join(', ')}`);
  }

  // Non-obvious insight (skip if redundant with name)
  if (artifact.insight) {
    parts.push(`→ ${artifact.insight}`);
  }

  return parts.join('\n');
}

// =========================================================================
// System Message Builder
// =========================================================================

/**
 * Build the system message for a work item.
 */
export function buildSystemMessage(
  goal: string,
  objective: string,
  behavioralRules: string = '',
  workspaceRoot: string = '',
  constraints?: {
    iteration?: number;
    maxIterations?: number;
    toolCallsUsed?: number;
    maxToolCalls?: number;
    elapsedMs?: number;
    maxDurationMs?: number;
  }
): string {
  const workspaceInfo = workspaceRoot
    ? `\nWORKSPACE ROOT: ${workspaceRoot}\nAll file paths are relative to this workspace unless specified as absolute.\n`
    : '';
  const constraintsInfo = constraints ? formatConstraints(constraints) : '';

  // Only show GOAL if it differs meaningfully from OBJECTIVE
  const goalSection = goal !== objective && goal.length > 0
    ? `GOAL: ${goal}\n\n`
    : '';

  return `OBJECTIVE: ${objective}
${goalSection}${workspaceInfo}
${behavioralRules}${constraintsInfo ? `\n${constraintsInfo}` : ''}

RESPONSE ACTIONS:
- action: "done" + goalStateReached: true → objective complete
- action: "need_user_input" + userPrompt → blocked, need user decision
- action: "continue" → progress made, more work needed

Do not repeat identical tool calls.`;
}

function formatConstraints(constraints: {
  iteration?: number;
  maxIterations?: number;
  toolCallsUsed?: number;
  maxToolCalls?: number;
  elapsedMs?: number;
  maxDurationMs?: number;
}): string {
  const lines: string[] = [];
  if (typeof constraints.iteration === 'number' && typeof constraints.maxIterations === 'number') {
    lines.push(`- Iteration: ${constraints.iteration} of ${constraints.maxIterations}`);
  }
  if (typeof constraints.toolCallsUsed === 'number' && typeof constraints.maxToolCalls === 'number') {
    lines.push(`- Tool calls used: ${constraints.toolCallsUsed} of ${constraints.maxToolCalls}`);
  } else if (typeof constraints.maxToolCalls === 'number') {
    lines.push(`- Max tool calls: ${constraints.maxToolCalls}`);
  }
  if (typeof constraints.elapsedMs === 'number' && typeof constraints.maxDurationMs === 'number') {
    lines.push(`- Elapsed time: ${constraints.elapsedMs}ms of ${constraints.maxDurationMs}ms`);
  } else if (typeof constraints.maxDurationMs === 'number') {
    lines.push(`- Max duration: ${constraints.maxDurationMs}ms`);
  }
  if (lines.length === 0) return '';
  return `  CONSTRAINTS:\n  ${lines.join('\n  ')}`;
}

// =========================================================================
// ContextWindow Class
// =========================================================================

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

  private _artifactCounter = 0;

  /**
   * Add a semantic artifact to context. Returns the generated ID.
   */
  addArtifact(artifact: Omit<import('types').ArtifactItem, 'type' | 'id' | 'timestamp'>): string {
    const id = `art_${this.sessionKey.slice(0, 4)}_${++this._artifactCounter}`;
    this._items.push({
      type: 'artifact',
      id,
      ...artifact,
      timestamp: Date.now(),
    });
    this._version++;
    return id;
  }

  /**
   * Add multiple artifacts at once.
   */
  addArtifacts(artifacts: Array<Omit<import('types').ArtifactItem, 'type' | 'id' | 'timestamp'>>): string[] {
    return artifacts.map(a => this.addArtifact(a));
  }

  /**
   * Get all artifacts in context.
   */
  getArtifacts(): import('types').ArtifactItem[] {
    return this._items.filter((i): i is import('types').ArtifactItem => i.type === 'artifact');
  }

  /**
   * Get artifacts for a specific source path.
   */
  getArtifactsByPath(sourcePath: string): import('types').ArtifactItem[] {
    return this.getArtifacts().filter(a => a.sourcePath === sourcePath);
  }

  /**
   * Get artifacts by kind (function, class, etc.).
   */
  getArtifactsByKind(kind: import('types').ArtifactKind): import('types').ArtifactItem[] {
    return this.getArtifacts().filter(a => a.kind === kind);
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
   * Build a context summary showing what's already available.
   * Helps the model avoid re-reading files or re-discovering artifacts.
   */
  buildContextSummary(): string | null {
    const parts: string[] = [];

    // List files already in context
    if (this._readFiles.size > 0) {
      const fileList = Array.from(this._readFiles).slice(0, 20); // Cap at 20
      parts.push(`FILES IN CONTEXT (${this._readFiles.size}): ${fileList.join(', ')}${this._readFiles.size > 20 ? '...' : ''}`);
    }

    // List artifacts by kind
    const artifacts = this.getArtifacts();
    if (artifacts.length > 0) {
      const byKind = new Map<string, number>();
      for (const a of artifacts) {
        byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
      }
      const kindSummary = Array.from(byKind.entries())
        .map(([kind, count]) => `${count} ${kind}`)
        .join(', ');
      parts.push(`ARTIFACTS DISCOVERED: ${kindSummary}`);
    }

    if (parts.length === 0) return null;
    return `[CONTEXT STATE]\n${parts.join('\n')}\nDo not re-read these files or re-discover these artifacts.`;
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
   * Batches artifacts into a single message to reduce token overhead.
   */
  getItemsForLLM(): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    const artifactItems: ArtifactItem[] = [];

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

        case 'artifact':
          // Collect artifacts for batching
          artifactItems.push(item as ArtifactItem);
          break;
      }
    }

    // Batch all artifacts into single message at the end
    if (artifactItems.length > 0) {
      result.push({
        type: 'message',
        role: 'user',
        content: `[DISCOVERED ARTIFACTS: ${artifactItems.length}]\n${artifactItems.map(formatArtifactForLLM).join('\n---\n')}`,
      });
    }

    return result;
  }

  /**
   * Convert items to Anthropic Messages API format.
   * Anthropic uses tool_use/tool_result content blocks instead of function_call items.
   * Batches artifacts into a single message to reduce token overhead.
   */
  getItemsForAnthropic(): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    const artifactItems: ArtifactItem[] = [];
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

        case 'artifact':
          // Collect artifacts for batching
          artifactItems.push(item as ArtifactItem);
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

    // Batch all artifacts into single message at the end
    if (artifactItems.length > 0) {
      result.push({
        role: 'user',
        content: `[DISCOVERED ARTIFACTS: ${artifactItems.length}]\n${artifactItems.map(formatArtifactForLLM).join('\n---\n')}`,
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
   * Merge agent execution result into this context.
   * Ejects stale file content, merges filesRead, merges tool calls, adds response.
   */
  addAgentResultContext(result: {
    response: string;
    filesRead: string[];
    invalidatedPaths: string[];
    localContext?: ContextWindow;
  }): void {
    // Eject stale file content from writes/edits
    for (const path of result.invalidatedPaths) {
      this.ejectFileContentByPath(path);
    }
    // Merge filesRead into global _readFiles
    for (const path of result.filesRead) {
      this._readFiles.add(path);
    }
    // Merge tool call items from localContext to preserve tool history
    if (result.localContext) {
      for (const item of result.localContext.items) {
        if (item.type === 'function_call' || item.type === 'function_call_output') {
          this.appendItem(item);
        }
      }
    }
    // Add response
    if (result.response) {
      this.addMessage('assistant', result.response);
    }
  }

  /**
   * Check if context is near capacity based on estimated token usage.
   * @param threshold - Fraction of maxTokens (0.0 to 1.0), default 0.8
   */
  isNearFull(threshold: number = 0.8): boolean {
    return this.estimateTokenUsage() / this.maxTokens >= threshold;
  }

  /**
   * Estimate token usage from content. ~4 chars per token heuristic.
   */
  private estimateTokenUsage(): number {
    let chars = 0;
    for (const item of this._items) {
      switch (item.type) {
        case 'message':
          chars += typeof item.content === 'string' ? item.content.length : 500;
          break;
        case 'file_content':
          chars += item.content.length + item.path.length;
          break;
        case 'function_call_output':
          chars += item.output.length;
          break;
        case 'function_call':
          chars += JSON.stringify(item.arguments).length + item.name.length;
          break;
        case 'reasoning':
          chars += item.content.length;
          break;
      }
    }
    return Math.ceil(chars / 4);
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
      artifact: 0,
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
      inputTokens: this._metrics.inputTokens,
      peakInputTokens: this._metrics.peakInputTokens,
      outputTokens: this._metrics.outputTokens,
      totalOutputTokens: this._metrics.totalOutputTokens,
      maxTokens: this.maxTokens,
      percentageUsed: this._metrics.percentageUsed,
      version: this._version,
      recentItems,
    };
  }
}
