/**
 * ContextWindow - Manages conversation state for a session.
 *
 * Key design principles:
 * - items[] directly maps to OpenAI Responses API input format
 * - Mutations increment _version for optimistic concurrency
 * - getItemsForLLM() handles provider-specific conversion
 */

import type {
  ContentBlock,
  ContextWindowMetrics,
  LLMAdapter,
  LLMRequestConfig,
  Message,
  StructuredOutputSchema,
} from 'types';
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
// Epistemic Ledger (LLM-backed compaction summary)
// =========================================================================

type LedgerEntry = { text: string; sources: string[] };

type LedgerPayload = {
  constraints: LedgerEntry[];
  decision_boundaries: LedgerEntry[];
  actions: LedgerEntry[];
  open_questions: LedgerEntry[];
};

const LEDGER_RESPONSE_SCHEMA: StructuredOutputSchema = {
  name: 'epistemic_ledger',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      constraints: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'sources'],
        },
      },
      decision_boundaries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'sources'],
        },
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'sources'],
        },
      },
      open_questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'sources'],
        },
      },
    },
    required: ['constraints', 'decision_boundaries', 'actions', 'open_questions'],
  },
};

const LEDGER_MAX_ENTRY_CHARS = 220;
const LEDGER_MAX_ENTRIES_PER_SECTION = 8;
const LEDGER_MAX_ITEM_PREVIEW = 600;

/** Timeout for compaction LLM calls - 30 seconds is plenty for summarization */
const COMPACTION_LLM_TIMEOUT_MS = 30_000;

/**
 * Wrap a promise with a timeout. Rejects with Error if timeout is exceeded.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '...';
}

function flattenContentBlocks(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'tool_use':
        parts.push(`[tool_use ${block.name}]`);
        break;
      case 'tool_result':
        parts.push(`[tool_result${block.isError ? ' error' : ''}] ${block.content}`);
        break;
      case 'image':
        parts.push('[image]');
        break;
    }
  }
  return parts.join(' ');
}

function summarizeMessageContent(content: string | ContentBlock[]): string {
  const text = typeof content === 'string' ? content : flattenContentBlocks(content);
  return truncateText(text.replace(/\s+/g, ' ').trim(), LEDGER_MAX_ITEM_PREVIEW);
}

function summarizeItemForLedger(item: ContextItem): string {
  switch (item.type) {
    case 'message':
      return `${item.role}: ${summarizeMessageContent(item.content)}`;
    case 'function_call':
      return `call ${item.name} args=${truncateText(JSON.stringify(item.arguments), 240)}`;
    case 'function_call_output':
      return `output${item.isError ? ' (error)' : ''}: ${truncateText(item.output, 240)}`;
    case 'reasoning':
      return `reasoning: ${truncateText(item.content, 240)}`;
    case 'file_content':
      return `file ${item.path} (${item.content.length} chars)`;
    case 'artifact':
      return `artifact ${item.kind} ${item.sourcePath}:${item.name}`;
  }
}

function estimateItemTokens(item: ContextItem): number {
  switch (item.type) {
    case 'message': {
      const text = typeof item.content === 'string'
        ? item.content
        : flattenContentBlocks(item.content);
      return Math.ceil(text.length / 4);
    }
    case 'file_content':
      return Math.ceil((item.content.length + item.path.length) / 4);
    case 'function_call_output':
      return Math.ceil(item.output.length / 4);
    case 'function_call':
      return Math.ceil((JSON.stringify(item.arguments).length + item.name.length) / 4);
    case 'reasoning':
      return Math.ceil(item.content.length / 4);
    case 'artifact':
      return Math.ceil((item.name.length + item.sourcePath.length + (item.signature?.length ?? 0)) / 4);
  }
}

function estimateItemBytes(item: ContextItem): number {
  switch (item.type) {
    case 'message':
      return typeof item.content === 'string' ? item.content.length : 0;
    case 'file_content':
      return item.content.length;
    case 'function_call_output':
      return item.output.length;
    case 'function_call':
      return JSON.stringify(item.arguments).length + item.name.length;
    case 'reasoning':
      return item.content.length;
    case 'artifact':
      return item.name.length + item.sourcePath.length + (item.signature?.length ?? 0);
  }
}

function parseLedgerResponse(content: string, validIds: Set<string>): LedgerPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const payload = parsed as Partial<LedgerPayload>;
  const sections: Array<keyof LedgerPayload> = [
    'constraints',
    'decision_boundaries',
    'actions',
    'open_questions',
  ];

  for (const key of sections) {
    if (!Array.isArray(payload[key])) return null;
  }

  const normalizeEntries = (entries: LedgerEntry[]): LedgerEntry[] => {
    const normalized: LedgerEntry[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.text !== 'string' || !Array.isArray(entry.sources)) continue;
      const sources = entry.sources.filter((source) => validIds.has(source));
      if (sources.length === 0) continue;
      const text = truncateText(entry.text.replace(/\s+/g, ' ').trim(), LEDGER_MAX_ENTRY_CHARS);
      if (text.length === 0) continue;
      normalized.push({ text, sources });
      if (normalized.length >= LEDGER_MAX_ENTRIES_PER_SECTION) break;
    }
    return normalized;
  };

  return {
    constraints: normalizeEntries(payload.constraints as LedgerEntry[]),
    decision_boundaries: normalizeEntries(payload.decision_boundaries as LedgerEntry[]),
    actions: normalizeEntries(payload.actions as LedgerEntry[]),
    open_questions: normalizeEntries(payload.open_questions as LedgerEntry[]),
  };
}

function formatLedgerMessage(ledger: LedgerPayload): string {
  const sections: Array<{ title: string; entries: LedgerEntry[] }> = [
    { title: 'CONSTRAINTS', entries: ledger.constraints },
    { title: 'DECISION BOUNDARIES', entries: ledger.decision_boundaries },
    { title: 'ACTIONS COMPLETED', entries: ledger.actions },
    { title: 'OPEN QUESTIONS', entries: ledger.open_questions },
  ];

  const lines: string[] = ['[EPISTEMIC LEDGER]'];
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    lines.push(`[${section.title}]`);
    for (const entry of section.entries) {
      lines.push(`- ${entry.text} (sources: ${entry.sources.join(', ')})`);
    }
  }

  return lines.join('\n');
}

// =========================================================================
// System Message Builder
// =========================================================================

/**
 * Static system prompt content - MUST NOT contain dynamic values.
 * This content is cached by the LLM provider; any changes invalidate the cache.
 */
const STATIC_SYSTEM_SUFFIX = `RESPONSE ACTIONS:
- action: "done" + goalStateReached: true → objective complete
- action: "continue" → progress made, more work needed
- action: "handoff" → transition to execution mode (planning agents only)
- Use PromptUser tool when you need user input

Do not repeat identical tool calls.`;

/**
 * Build system prompt components, separating static (cacheable) from dynamic content.
 *
 * For optimal caching, API calls should be structured as:
 *   system (static) → tools (static) → messages (dynamic)
 *
 * @returns Object with:
 *   - system: Static behavioral rules only (for system parameter)
 *   - taskContext: Dynamic goal/objective/workspace (inject as first user message)
 */
export function buildSystemMessage(
  goal: string,
  objective: string,
  behavioralRules: string = '',
  workspaceRoot: string = ''
): { system: string; taskContext: string } {
  // Static system prompt - only behavioral rules, no per-task content
  const system = behavioralRules
    ? `${behavioralRules}\n\n${STATIC_SYSTEM_SUFFIX}`
    : STATIC_SYSTEM_SUFFIX;

  // Dynamic task context - changes per work item, goes in messages
  const workspaceInfo = workspaceRoot
    ? `WORKSPACE: ${workspaceRoot}\n`
    : '';

  const goalSection = goal !== objective && goal.length > 0
    ? `GOAL: ${goal}\n`
    : '';

  const taskContext = `${workspaceInfo}${goalSection}OBJECTIVE: ${objective}`;

  return { system, taskContext };
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
  updateMetrics(promptTokens: number, completionTokens: number, cachedTokens?: number): void {
    this._metrics = updateContextMetrics(
      this._metrics,
      promptTokens,
      completionTokens,
      this._items.filter(i => i.type === 'message').length,
      cachedTokens
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
   * Filter items in-place using a predicate.
   * Items for which the predicate returns false are removed.
   */
  filterItems(predicate: (item: ContextItem) => boolean): void {
    this._items = this._items.filter(predicate);
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
   * Eject all artifact items for a given source path.
   */
  private ejectArtifactsByPath(sourcePath: string): number {
    let removed = 0;
    this._items = this._items.filter((item) => {
      if (item.type === 'artifact' && item.sourcePath === sourcePath) {
        removed++;
        return false;
      }
      return true;
    });

    if (removed > 0) {
      this._version++;
    }

    return removed;
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
   * Invalidate file content and artifacts after a file modification.
   */
  invalidateFileContent(path: string): EjectResult {
    const result = this.ejectFileContentByPath(path);
    this.ejectArtifactsByPath(path);
    if (this._readFiles.delete(path)) {
      this._version++;
    }
    return result;
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

  /**
   * Compact with an LLM-generated ledger summarizing removed items.
   * Falls back to mechanical compaction if summarization fails.
   */
  async compactWithLedger(params: CompactOptions & {
    llm: LLMAdapter;
    llmConfig: LLMRequestConfig;
    targetReductionRatio?: number;
    preserveRecentItems?: number;
  }): Promise<CompactResult> {
    const {
      llm,
      llmConfig,
      targetReductionRatio = 0.66,
      preserveRecentItems = 12,
      maxFileContentAgeMs,
      maxFileContentCount,
      deduplicateByPath = false,
      truncateOutputsTo,
    } = params;

    const baseResult = this.compact({
      maxFileContentAgeMs,
      maxFileContentCount,
      deduplicateByPath,
      truncateOutputsTo,
    });

    const currentTokens = this.estimateTokenUsage();
    const ratio = Math.min(Math.max(targetReductionRatio, 0), 0.9);
    const targetTokens = Math.max(1, Math.floor(currentTokens * (1 - ratio)));

    if (currentTokens <= targetTokens) {
      return baseResult;
    }

    const preserveStart = Math.max(0, this._items.length - preserveRecentItems);
    const protectedIndices = new Set<number>();
    this._items.forEach((item, index) => {
      if (index >= preserveStart) {
        protectedIndices.add(index);
        return;
      }
      if (item.type === 'artifact') {
        protectedIndices.add(index);
        return;
      }
      if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
        protectedIndices.add(index);
      }
    });

    const candidates: number[] = [];
    for (let i = 0; i < preserveStart; i++) {
      if (!protectedIndices.has(i)) {
        candidates.push(i);
      }
    }

    if (candidates.length === 0) {
      return baseResult;
    }

    let tokensToRemove = currentTokens - targetTokens;
    const removalIndices: number[] = [];
    for (const index of candidates) {
      const item = this._items[index];
      removalIndices.push(index);
      tokensToRemove -= estimateItemTokens(item);
      if (tokensToRemove <= 0) break;
    }

    if (removalIndices.length === 0) {
      return baseResult;
    }

    const ledgerItems = removalIndices.map((index) => ({
      id: `i${index}`,
      item: this._items[index],
    }));
    const validIds = new Set(ledgerItems.map((entry) => entry.id));
    const ledgerLines = ledgerItems.map(
      (entry) => `- [${entry.id}] ${summarizeItemForLedger(entry.item)}`
    );

    const systemPrompt = [
      'You distill compact, actionable context.',
      'Only use the provided items.',
      'Each entry must cite source item ids in sources[].',
      'Prefer constraints and decision boundaries over narration.',
      'Keep entries concise.',
    ].join(' ');

    const userPrompt = [
      'Summarize these items into an epistemic ledger.',
      'If nothing is important, return empty arrays.',
      'Items:',
      ledgerLines.join('\n'),
    ].join('\n');

    let ledgerPayload: LedgerPayload | null = null;
    try {
      // Wrap LLM call with timeout to prevent hanging
      const response = await withTimeout(
        llm.respond({
          llm: {
            ...llmConfig,
            temperature: 0,
            maxTokens: Math.min(llmConfig.maxTokens ?? 800, 800),
          },
          messages: [{ role: 'user', content: userPrompt } satisfies Message],
          system: systemPrompt,
          responseSchema: LEDGER_RESPONSE_SCHEMA,
        }),
        COMPACTION_LLM_TIMEOUT_MS,
        'Compaction LLM call'
      );
      ledgerPayload = parseLedgerResponse(response.content, validIds);
    } catch {
      // Timeout or LLM error - fall back to mechanical compaction
      ledgerPayload = null;
    }

    if (!ledgerPayload) {
      return baseResult;
    }

    const ledgerMessage = formatLedgerMessage(ledgerPayload);
    if (ledgerMessage.trim().length === 0) {
      return baseResult;
    }

    const removedSet = new Set(removalIndices);
    const retained: ContextItem[] = [];
    const pathsRemoved = new Set<string>();
    let itemsRemoved = 0;
    let fileContentRemoved = 0;
    let bytesRecovered = 0;

    this._items.forEach((item, index) => {
      if (removedSet.has(index)) {
        itemsRemoved++;
        bytesRecovered += estimateItemBytes(item);
        if (item.type === 'file_content') {
          fileContentRemoved++;
          pathsRemoved.add(item.path);
        }
        return;
      }
      retained.push(item);
    });

    const summaryItem: MessageItem = {
      type: 'message',
      role: 'system',
      content: ledgerMessage,
      timestamp: Date.now(),
    };

    const removedBeforePreserve = removalIndices.length;
    let insertIndex = preserveStart - removedBeforePreserve;
    if (insertIndex < 0) insertIndex = 0;
    let minInsertIndex = retained.findIndex(
      (item) => !(item.type === 'message' && (item.role === 'system' || item.role === 'developer'))
    );
    if (minInsertIndex === -1) {
      minInsertIndex = retained.length;
    }
    if (insertIndex < minInsertIndex) insertIndex = minInsertIndex;

    retained.splice(insertIndex, 0, summaryItem);
    this._items = retained;
    this._version++;

    for (const path of pathsRemoved) {
      const hasRemaining = this._items.some(
        (item) => item.type === 'file_content' && item.path === path
      );
      if (!hasRemaining) {
        this._readFiles.delete(path);
      }
    }

    return {
      itemsRemoved: baseResult.itemsRemoved + itemsRemoved,
      fileContentRemoved: baseResult.fileContentRemoved + fileContentRemoved,
      outputsTruncated: baseResult.outputsTruncated,
      bytesRecovered: baseResult.bytesRecovered + bytesRecovered,
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
            isError: item.isError,
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
   *
   * Returns system content separately to enable proper cache prefixing:
   * API call order is: system → tools → messages
   * System content must NOT be in messages array or it breaks the cache prefix.
   *
   * Anthropic only accepts 'user' and 'assistant' roles in messages.
   * Batches artifacts into a single message to reduce token overhead.
   */
  getItemsForAnthropic(): { system: string; messages: Array<Record<string, unknown>> } {
    const systemParts: string[] = [];
    const messages: Array<Record<string, unknown>> = [];
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
          if (item.role === 'system' || item.role === 'developer') {
            // System/developer content goes in system parameter, not messages
            const content = typeof item.content === 'string'
              ? item.content
              : flattenContentBlocks(item.content);
            systemParts.push(content);
          } else {
            // Flush pending tool calls before user message
            if (item.role === 'user' && pendingToolCalls.length > 0) {
              messages.push({
                role: 'assistant',
                content: pendingToolCalls,
              });
              pendingToolCalls = [];
            }
            messages.push({
              role: item.role,
              content: item.content,
            });
          }
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
            messages.push({
              role: 'assistant',
              content: pendingToolCalls,
            });
            pendingToolCalls = [];
          }
          messages.push({
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
          messages.push({
            role: 'assistant',
            content: `[Reasoning]\n${item.content}`,
          });
          break;

        case 'file_content':
          messages.push({
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
      messages.push({
        role: 'assistant',
        content: pendingToolCalls,
      });
    }

    // Batch all artifacts into single message at the end
    if (artifactItems.length > 0) {
      messages.push({
        role: 'user',
        content: `[DISCOVERED ARTIFACTS: ${artifactItems.length}]\n${artifactItems.map(formatArtifactForLLM).join('\n---\n')}`,
      });
    }

    return {
      system: systemParts.join('\n\n'),
      messages,
    };
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
   * Extract message history for TUI rehydration.
   * Returns only message-type items with role, content, timestamp, and optional requestId.
   */
  getMessageHistory(): Array<{ role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }> {
    return this._items
      .filter((item): item is MessageItem => item.type === 'message')
      .map((item) => {
        // Convert content to string
        let content = '';
        if (typeof item.content === 'string') {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          // For array content, stringify appropriately
          content = item.content
            .map((block) => {
              if (typeof block === 'string') return block;
              if (block.type === 'text') return block.text;
              return '';
            })
            .join('\n');
        }

        // Map internal role to TUI role
        // ContextWindow uses 'assistant' | 'developer', TUI uses 'agent'
        let role: 'user' | 'agent' | 'system';
        if (item.role === 'user' || item.role === 'system') {
          role = item.role;
        } else {
          role = 'agent'; // assistant -> agent
        }

        return {
          role,
          content,
          timestamp: item.timestamp,
          requestId: (item as any).requestId, // requestId may be stored as metadata on item
        };
      });
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
    // Invalidate stale file content and artifacts from writes/edits
    for (const path of result.invalidatedPaths) {
      this.invalidateFileContent(path);
    }
    // Merge filesRead into global _readFiles
    for (const path of result.filesRead) {
      this._readFiles.add(path);
    }
    // Merge tool call items from localContext to preserve tool history
    if (result.localContext) {
      for (const item of result.localContext.items) {
        if (item.type === 'function_call' || item.type === 'function_call_output') {
          const callId = item.callId;
          if (callId && callId.startsWith('hook-')) {
            continue;
          }
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
