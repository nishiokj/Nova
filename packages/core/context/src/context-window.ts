/**
 * ContextWindow - Manages conversation state for a session.
 *
 * Key design principles:
 * - items[] directly maps to OpenAI Responses API input format
 * - Mutations increment _version for optimistic concurrency
 * - getItemsForLLM() handles provider-specific conversion
 * - Optional disk backing: pass filePath to constructor for disk-authoritative persistence
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'fs';
import nodePath from 'path';
import type {
  ContentBlock,
  ContextWindowMetrics,
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
  FunctionCallItem,
  FunctionCallOutputItem,
  ReasoningItem,
  EjectResult,
  CompactOptions,
  CompactResult,
  LLMItem,
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

// =========================================================================
// Markdown Serialization (for disk-backed mode)
// =========================================================================

/** Regex matching item header lines — used to split body into blocks */
const HEADER_RE = /^### (?:message:\w+|function_call_output|function_call|reasoning|file_content|artifact)/gm;

interface Frontmatter {
  session: string;
  created: string;
  maxTokens: number;
  fileContentCounter?: number;
  artifactCounter?: number;
}

function serializeFrontmatter(fm: Frontmatter): string {
  const lines = [
    '---',
    `session: ${fm.session}`,
    `created: ${fm.created}`,
    `maxTokens: ${fm.maxTokens}`,
  ];
  if (fm.fileContentCounter !== undefined) {
    lines.push(`fileContentCounter: ${fm.fileContentCounter}`);
  }
  if (fm.artifactCounter !== undefined) {
    lines.push(`artifactCounter: ${fm.artifactCounter}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; bodyStart: number } | null {
  if (!content.startsWith('---\n')) return null;

  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) return null;

  const yamlBlock = content.slice(4, endIdx);
  const lines = yamlBlock.split('\n');
  const fm: Record<string, string> = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      fm[key] = value;
    }
  }

  if (!fm.session || !fm.created || !fm.maxTokens) return null;

  return {
    frontmatter: {
      session: fm.session,
      created: fm.created,
      maxTokens: parseInt(fm.maxTokens, 10),
      fileContentCounter: fm.fileContentCounter ? parseInt(fm.fileContentCounter, 10) : undefined,
      artifactCounter: fm.artifactCounter ? parseInt(fm.artifactCounter, 10) : undefined,
    },
    bodyStart: endIdx + 5, // Skip '\n---\n'
  };
}

function serializeItem(item: ContextItem): string {
  const lines: string[] = [];

  switch (item.type) {
    case 'message': {
      lines.push(`### message:${item.role}`);
      lines.push(`@ts ${item.timestamp}`);
      if (item.workItemId) lines.push(`@workItemId ${item.workItemId}`);
      if (typeof item.content === 'string') {
        lines.push(item.content);
      } else {
        lines.push(`@contentBlocks`);
        lines.push(JSON.stringify(item.content));
      }
      break;
    }

    case 'function_call': {
      lines.push(`### function_call`);
      lines.push(`@callId ${item.callId}`);
      lines.push(`@name ${item.name}`);
      lines.push(`@ts ${item.timestamp}`);
      if (item.workItemId) lines.push(`@workItemId ${item.workItemId}`);
      lines.push(JSON.stringify(item.arguments));
      break;
    }

    case 'function_call_output': {
      lines.push(`### function_call_output`);
      lines.push(`@callId ${item.callId}`);
      lines.push(`@ts ${item.timestamp}`);
      if (item.isError) lines.push(`@isError true`);
      if (item.workItemId) lines.push(`@workItemId ${item.workItemId}`);
      lines.push(item.output);
      break;
    }

    case 'reasoning': {
      lines.push(`### reasoning`);
      lines.push(`@ts ${item.timestamp}`);
      if (item.workItemId) lines.push(`@workItemId ${item.workItemId}`);
      lines.push(item.content);
      break;
    }

    case 'file_content': {
      lines.push(`### file_content`);
      lines.push(`@id ${item.id}`);
      lines.push(`@path ${item.path}`);
      lines.push(`@ts ${item.timestamp}`);
      if (item.language) lines.push(`@language ${item.language}`);
      if (item.workItemId) lines.push(`@workItemId ${item.workItemId}`);
      lines.push(item.content);
      break;
    }

    case 'artifact': {
      lines.push(`### artifact`);
      lines.push(`@id ${item.id}`);
      lines.push(`@kind ${item.kind}`);
      lines.push(`@name ${item.name}`);
      lines.push(`@sourcePath ${item.sourcePath}`);
      lines.push(`@ts ${item.timestamp}`);
      lines.push(`@discoveredBy ${item.discoveredBy}`);
      if (item.line !== undefined) lines.push(`@line ${item.line}`);
      if (item.signature) lines.push(`@signature ${item.signature}`);
      if (item.modifies?.length) lines.push(`@modifies ${item.modifies.join(',')}`);
      if (item.calls?.length) lines.push(`@calls ${item.calls.join(',')}`);
      if (item.insight) lines.push(`@insight ${item.insight}`);
      if (item.reduces) lines.push(`@reduces ${item.reduces}`);
      if (item.relevance !== undefined) lines.push(`@relevance ${item.relevance}`);
      if (item.workItemId) lines.push(`@workItemId ${item.workItemId}`);
      break;
    }
  }

  return lines.join('\n');
}

/** Known metadata keys — any @-prefixed line with an unknown key is content, not metadata. */
const KNOWN_META_KEYS = new Set([
  'ts', 'workItemId', 'callId', 'name', 'isError', 'durationMs',
  'id', 'path', 'language', 'kind', 'sourcePath', 'discoveredBy',
  'line', 'signature', 'modifies', 'calls', 'insight', 'reduces',
  'relevance', 'contentBlocks',
]);

function parseItem(block: string): ContextItem | null {
  const lines = block.trim().split('\n');
  if (lines.length === 0) return null;

  const headerLine = lines[0];
  if (!headerLine.startsWith('### ')) return null;

  const headerContent = headerLine.slice(4);

  // Parse metadata lines (start with @knownKey)
  const meta: Record<string, string> = {};
  let contentStartIdx = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@')) {
      const spaceIdx = line.indexOf(' ');
      const key = spaceIdx > 0 ? line.slice(1, spaceIdx) : line.slice(1);
      if (!KNOWN_META_KEYS.has(key)) {
        break; // Not a known metadata key — this is content
      }
      if (spaceIdx > 0) {
        meta[key] = line.slice(spaceIdx + 1);
      } else {
        // Flag with no value (e.g., @contentBlocks)
        meta[key] = 'true';
      }
      contentStartIdx = i + 1;
    } else {
      break;
    }
  }

  const contentLines = lines.slice(contentStartIdx);
  const content = contentLines.join('\n');

  if (headerContent.startsWith('message:')) {
    const role = headerContent.slice(8) as MessageItem['role'];
    const hasContentBlocks = meta.contentBlocks === 'true';

    return {
      type: 'message',
      role,
      content: hasContentBlocks ? JSON.parse(content) : content,
      timestamp: parseInt(meta.ts, 10),
      workItemId: meta.workItemId,
    } as MessageItem;
  }

  if (headerContent === 'function_call') {
    return {
      type: 'function_call',
      callId: meta.callId,
      name: meta.name,
      arguments: JSON.parse(content),
      timestamp: parseInt(meta.ts, 10),
      workItemId: meta.workItemId,
    } as FunctionCallItem;
  }

  if (headerContent === 'function_call_output') {
    return {
      type: 'function_call_output',
      callId: meta.callId,
      output: content,
      isError: meta.isError === 'true',
      durationMs: meta.durationMs ? parseInt(meta.durationMs, 10) : undefined,
      timestamp: parseInt(meta.ts, 10),
      workItemId: meta.workItemId,
    } as FunctionCallOutputItem;
  }

  if (headerContent === 'reasoning') {
    return {
      type: 'reasoning',
      content,
      timestamp: parseInt(meta.ts, 10),
      workItemId: meta.workItemId,
    } as ReasoningItem;
  }

  if (headerContent === 'file_content') {
    return {
      type: 'file_content',
      id: meta.id,
      path: meta.path,
      content,
      language: meta.language,
      timestamp: parseInt(meta.ts, 10),
      workItemId: meta.workItemId,
    } as FileContentItem;
  }

  if (headerContent === 'artifact') {
    return {
      type: 'artifact',
      id: meta.id,
      kind: meta.kind as ArtifactItem['kind'],
      name: meta.name,
      sourcePath: meta.sourcePath,
      discoveredBy: meta.discoveredBy,
      timestamp: parseInt(meta.ts, 10),
      line: meta.line ? parseInt(meta.line, 10) : undefined,
      signature: meta.signature,
      modifies: meta.modifies ? meta.modifies.split(',') : undefined,
      calls: meta.calls ? meta.calls.split(',') : undefined,
      insight: meta.insight,
      reduces: meta.reduces as ArtifactItem['reduces'],
      relevance: meta.relevance ? parseFloat(meta.relevance) : undefined,
      workItemId: meta.workItemId,
    } as ArtifactItem;
  }

  return null;
}

/**
 * Parse body into item blocks using header-based splitting.
 * Unlike `---` delimiter splitting, this is immune to content containing `---`.
 */
function parseItemBlocks(body: string): ContextItem[] {
  const matches = [...body.matchAll(HEADER_RE)];
  if (matches.length === 0) return [];

  const items: ContextItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : body.length;
    const block = body.slice(start, end).trim();
    if (block.length === 0) continue;
    const item = parseItem(block);
    if (item) items.push(item);
  }
  return items;
}

// =========================================================================
// System Message Builder
// =========================================================================

/**
 * Build system prompt components, separating static (cacheable) from dynamic content.
 *
 * For optimal caching, API calls should be structured as:
 *   system (static) → tools (static) → messages (dynamic)
 *
 * Action/schema instructions live in agent prompts (completionRules in prompts.ts).
 * Do NOT duplicate them here — that causes prompt/schema drift.
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
  const system = behavioralRules || '';

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
  readonly filePath: string | null;

  private _items: ContextItem[] = [];
  private _metrics: ContextWindowMetrics;
  private _version = 0;
  private _readFiles: Set<string> = new Set();
  private _fileContentCounter = 0;
  private _artifactCounter = 0;
  private _created: string;
  private _compactionCount = 0;

  constructor(sessionKey: string, maxTokens = 200_000, filePath?: string) {
    this.sessionKey = sessionKey;
    this.maxTokens = maxTokens;
    this.filePath = filePath ?? null;
    this._created = new Date().toISOString();
    this._metrics = createContextWindowMetrics(maxTokens);

    if (this.filePath) {
      mkdirSync(nodePath.dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath)) {
        this._loadFromDisk();
      } else {
        this._writeDisk();
      }
    }
  }

  /**
   * Factory method to create from session directory path.
   */
  static fromSessionDir(workingDir: string, sessionId: string, maxTokens?: number): ContextWindow {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0];
    const sessionDir = nodePath.join(workingDir, '.haiku', 'sessions', dateStr, sessionId);
    const fp = nodePath.join(sessionDir, 'context.md');
    return new ContextWindow(sessionId, maxTokens, fp);
  }

  // =========================================================================
  // Disk I/O (disk-authoritative model with in-memory cache)
  // =========================================================================

  /**
   * Sync in-memory cache from disk when file-backed.
   * This prevents stale in-memory state from overwriting newer persisted context.
   */
  private _syncFromDiskIfBacked(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    this._loadFromDisk();
  }

  private _renderFrontmatter(): string {
    return serializeFrontmatter({
      session: this.sessionKey,
      created: this._created,
      maxTokens: this.maxTokens,
      fileContentCounter: this._fileContentCounter,
      artifactCounter: this._artifactCounter,
    });
  }

  private _loadFromDisk(): void {
    const content = readFileSync(this.filePath!, 'utf-8');
    const parsed = parseFrontmatter(content);
    if (!parsed) return;

    this._created = parsed.frontmatter.created;
    this._fileContentCounter = parsed.frontmatter.fileContentCounter ?? 0;
    this._artifactCounter = parsed.frontmatter.artifactCounter ?? 0;

    const body = content.slice(parsed.bodyStart);
    this._items = parseItemBlocks(body);
    this._readFiles = new Set<string>();

    // Rebuild _readFiles from file_content items
    for (const item of this._items) {
      if (item.type === 'file_content') {
        this._readFiles.add(item.path);
      }
    }

    this._metrics = {
      ...this._metrics,
      messageCount: this._items.filter(i => i.type === 'message').length,
    };
  }

  private _writeDisk(): void {
    if (!this.filePath) return;
    let content = this._renderFrontmatter();
    for (const item of this._items) {
      content += '\n' + serializeItem(item) + '\n';
    }
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, this.filePath);
  }

  /**
   * Snapshot the current context file before compaction destroys items.
   * Copies context.md → context.v{N}.md, caps at 10 versions.
   */
  private _snapshotBeforeCompact(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;

    const dir = nodePath.dirname(this.filePath);
    const versionedFiles = readdirSync(dir)
      .filter(f => /^context\.v(\d+)\.md$/.test(f))
      .map(f => ({
        name: f,
        version: parseInt(f.match(/^context\.v(\d+)\.md$/)![1], 10),
      }))
      .sort((a, b) => a.version - b.version);

    // Ensure monotonic versioning across process restarts by deriving from disk.
    const maxVersionOnDisk = versionedFiles.length > 0
      ? versionedFiles[versionedFiles.length - 1].version
      : 0;
    this._compactionCount = Math.max(this._compactionCount, maxVersionOnDisk) + 1;

    const snapshotName = `context.v${this._compactionCount}.md`;
    const snapshotPath = nodePath.join(dir, snapshotName);
    copyFileSync(this.filePath, snapshotPath);
    versionedFiles.push({ name: snapshotName, version: this._compactionCount });

    // Prune oldest versions if we exceed 10
    versionedFiles.sort((a, b) => a.version - b.version);

    while (versionedFiles.length > 10) {
      const oldest = versionedFiles.shift()!;
      unlinkSync(nodePath.join(dir, oldest.name));
    }
  }

  // =========================================================================
  // Auto-Compaction
  // =========================================================================

  /**
   * Auto-compact when context is near full.
   * Deduplicates file_content by path and truncates long outputs.
   */
  private _maybeAutoCompact(): void {
    if (!this.isNearFull(0.5)) return;
    this.compact({
      deduplicateByPath: true,
      maxFileContentCount: 30,
      maxFunctionCallCount: 220,
      maxFunctionCallOutputCount: 220,
      truncateOutputsTo: 3_000,
    });
  }

  // =========================================================================
  // Mutation Methods (increment _version, write-through to disk)
  // =========================================================================

  /**
   * Add a message to the context window.
   */
  addMessage(role: MessageItem['role'], content: string | ContentBlock[], workItemId?: string): void {
    this._syncFromDiskIfBacked();
    this._items.push({
      type: 'message',
      role,
      content,
      timestamp: Date.now(),
      workItemId,
    });
    this._version++;
    this._metrics = {
      ...this._metrics,
      messageCount: this._items.filter(i => i.type === 'message').length,
    };
    this._writeDisk();
    this._maybeAutoCompact();
  }

  /**
   * Add a function call (tool invocation by model).
   */
  addFunctionCall(callId: string, name: string, args: Record<string, unknown>, workItemId?: string): void {
    this._syncFromDiskIfBacked();
    this._items.push({
      type: 'function_call',
      callId,
      name,
      arguments: args,
      timestamp: Date.now(),
      workItemId,
    });
    this._version++;
    this._writeDisk();
  }

  /**
   * Add function call output (result from tool execution).
   */
  addFunctionCallOutput(
    callId: string,
    output: string,
    isError?: boolean,
    durationMs?: number,
    workItemId?: string
  ): void {
    this._syncFromDiskIfBacked();
    this._items.push({
      type: 'function_call_output',
      callId,
      output,
      isError,
      durationMs,
      timestamp: Date.now(),
      workItemId,
    });
    this._version++;
    this._writeDisk();
    this._maybeAutoCompact();
  }

  /**
   * Add reasoning content (chain of thought).
   */
  addReasoning(content: string, workItemId?: string): void {
    this._syncFromDiskIfBacked();
    this._items.push({
      type: 'reasoning',
      content,
      timestamp: Date.now(),
      workItemId,
    });
    this._version++;
    this._writeDisk();
  }

  /**
   * Add file content to context. Returns the generated ID.
   */
  addFileContent(path: string, content: string, language?: string, workItemId?: string): string {
    this._syncFromDiskIfBacked();
    const id = `fc_${this.sessionKey.slice(0, 4)}_${++this._fileContentCounter}`;
    this._items.push({
      type: 'file_content',
      id,
      path,
      content,
      language,
      timestamp: Date.now(),
      workItemId,
    });
    this._readFiles.add(path);
    this._version++;
    this._writeDisk();
    this._maybeAutoCompact();
    return id;
  }

  /**
   * Add a semantic artifact to context. Returns the generated ID.
   */
  addArtifact(
    artifact: Omit<ArtifactItem, 'type' | 'id' | 'timestamp'>,
    workItemId?: string
  ): string {
    this._syncFromDiskIfBacked();
    const id = `art_${this.sessionKey.slice(0, 4)}_${++this._artifactCounter}`;
    this._items.push({
      type: 'artifact',
      id,
      ...artifact,
      timestamp: Date.now(),
      workItemId: artifact.workItemId ?? workItemId,
    });
    this._version++;
    this._writeDisk();
    return id;
  }

  /**
   * Add multiple artifacts at once.
   */
  addArtifacts(
    artifacts: Array<Omit<ArtifactItem, 'type' | 'id' | 'timestamp'>>,
    workItemId?: string
  ): string[] {
    this._syncFromDiskIfBacked();
    return artifacts.map(a => this.addArtifact(a, workItemId));
  }

  /**
   * Get all artifacts in context.
   */
  getArtifacts(): ArtifactItem[] {
    return this._items.filter((i): i is ArtifactItem => i.type === 'artifact');
  }

  /**
   * Get artifacts for a specific source path.
   */
  getArtifactsByPath(sourcePath: string): ArtifactItem[] {
    return this.getArtifacts().filter(a => a.sourcePath === sourcePath);
  }

  /**
   * Get artifacts by kind (function, class, etc.).
   */
  getArtifactsByKind(kind: import('types').ArtifactKind): ArtifactItem[] {
    return this.getArtifacts().filter(a => a.kind === kind);
  }

  /**
   * Update metrics after an LLM response.
   */
  updateMetrics(promptTokens: number, completionTokens: number, cachedTokens?: number): void {
    this._syncFromDiskIfBacked();
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
    this._syncFromDiskIfBacked();
    this._readFiles.add(path);
  }

  /**
   * Append a pre-built context item (used by Orchestrator to merge Agent results).
   */
  appendItem(item: ContextItem): void {
    this._syncFromDiskIfBacked();
    this._items.push(item);
    this._version++;
    this._writeDisk();
  }

  /**
   * Filter items in-place using a predicate.
   * Items for which the predicate returns false are removed.
   */
  filterItems(predicate: (item: ContextItem) => boolean): void {
    this._syncFromDiskIfBacked();
    this._items = this._items.filter(predicate);
    this._version++;
    this._writeDisk();
  }

  /**
   * Get read files as array (for Agent tracking).
   */
  getReadFilesArray(): string[] {
    this._syncFromDiskIfBacked();
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
    this._syncFromDiskIfBacked();
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
      this._writeDisk();
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
      this._writeDisk();
    }

    return removed;
  }

  /**
   * Eject a specific file_content item by ID.
   */
  ejectFileContentById(id: string): EjectResult {
    this._syncFromDiskIfBacked();
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
      this._writeDisk();
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
    this._syncFromDiskIfBacked();
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
    this._syncFromDiskIfBacked();
    this._snapshotBeforeCompact();
    const {
      maxFileContentAgeMs,
      maxFileContentCount,
      maxFunctionCallCount,
      maxFunctionCallOutputCount,
      deduplicateByPath = false,
      truncateOutputsTo,
    } = options;

    let itemsRemoved = 0;
    let fileContentRemoved = 0;
    let functionCallsRemoved = 0;
    let functionCallOutputsRemoved = 0;
    let outputsTruncated = 0;
    let bytesRecovered = 0;
    const now = Date.now();
    const pathsRemoved = new Set<string>();

    // Track newest file_content per path for deduplication
    const newestByPath = new Map<string, { item: FileContentItem; index: number }>();

    // First pass: identify items to remove
    const toRemove = new Set<number>();
    const markForRemoval = (
      index: number,
      kind: 'file_content' | 'function_call' | 'function_call_output',
      bytes: number,
      path?: string
    ): void => {
      if (toRemove.has(index)) return;
      toRemove.add(index);
      bytesRecovered += bytes;
      if (kind === 'file_content') {
        fileContentRemoved++;
        if (path) pathsRemoved.add(path);
      } else if (kind === 'function_call') {
        functionCallsRemoved++;
      } else {
        functionCallOutputsRemoved++;
      }
    };

    this._items.forEach((item, index) => {
      if (item.type === 'file_content') {
        // Age-based removal
        if (maxFileContentAgeMs && now - item.timestamp > maxFileContentAgeMs) {
          markForRemoval(index, 'file_content', item.content.length, item.path);
          return;
        }

        // Track for deduplication
        if (deduplicateByPath) {
          const existing = newestByPath.get(item.path);
          if (existing) {
            if (item.timestamp >= existing.item.timestamp) {
              markForRemoval(existing.index, 'file_content', existing.item.content.length, existing.item.path);
              newestByPath.set(item.path, { item, index });
            } else {
              markForRemoval(index, 'file_content', item.content.length, item.path);
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
          const fileItem = item as FileContentItem;
          markForRemoval(index, 'file_content', fileItem.content.length, fileItem.path);
        }
      }
    }

    // Keep recent function call history; older tool traces are high-volume and low-value.
    if (typeof maxFunctionCallCount === 'number') {
      const callItems = this._items
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item, index }) => item.type === 'function_call' && !toRemove.has(index)
        )
        .sort((a, b) => a.item.timestamp - b.item.timestamp);

      const excess = callItems.length - Math.max(0, maxFunctionCallCount);
      if (excess > 0) {
        for (let i = 0; i < excess; i++) {
          const { item, index } = callItems[i];
          const call = item as FunctionCallItem;
          const argsSize = (() => {
            try {
              return JSON.stringify(call.arguments).length;
            } catch {
              return 0;
            }
          })();
          markForRemoval(index, 'function_call', call.name.length + argsSize);
        }
      }
    }

    if (typeof maxFunctionCallOutputCount === 'number') {
      const outputItems = this._items
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item, index }) => item.type === 'function_call_output' && !toRemove.has(index)
        )
        .sort((a, b) => a.item.timestamp - b.item.timestamp);

      const excess = outputItems.length - Math.max(0, maxFunctionCallOutputCount);
      if (excess > 0) {
        for (let i = 0; i < excess; i++) {
          const { item, index } = outputItems[i];
          const output = item as FunctionCallOutputItem;
          markForRemoval(index, 'function_call_output', output.output.length);
        }
      }
    }

    // Apply removals
    if (toRemove.size > 0) {
      this._items = this._items.filter((_, index) => !toRemove.has(index));
      itemsRemoved = toRemove.size;
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

    if (toRemove.size > 0 || outputsTruncated > 0) {
      this._writeDisk();
    }

    return {
      itemsRemoved,
      fileContentRemoved,
      functionCallsRemoved,
      functionCallOutputsRemoved,
      outputsTruncated,
      bytesRecovered,
    };
  }

  /**
   * Clear all items and reset state.
   */
  clear(): void {
    this._syncFromDiskIfBacked();
    this._items = [];
    this._readFiles.clear();
    this._version++;
    this._metrics = createContextWindowMetrics(this.maxTokens);
    this._writeDisk();
  }

  // =========================================================================
  // Query Methods
  // =========================================================================

  get items(): readonly ContextItem[] {
    this._syncFromDiskIfBacked();
    return this._items;
  }

  get metrics(): Readonly<ContextWindowMetrics> {
    this._syncFromDiskIfBacked();
    return this._metrics;
  }

  get version(): number {
    this._syncFromDiskIfBacked();
    return this._version;
  }

  get readFiles(): ReadonlySet<string> {
    this._syncFromDiskIfBacked();
    return this._readFiles;
  }

  /**
   * Rebuild readFiles from current file_content items.
   * Useful when creating filtered context views.
   */
  rebuildReadFilesFromItems(): void {
    this._syncFromDiskIfBacked();
    const next = new Set<string>();
    for (const item of this._items) {
      if (item.type === 'file_content') {
        next.add(item.path);
      }
    }
    this._readFiles = next;
    this._version++;
  }

  /**
   * Check if a file has been read in this session.
   */
  hasReadFile(path: string): boolean {
    this._syncFromDiskIfBacked();
    return this._readFiles.has(path);
  }

  /**
   * Build a context summary showing what's already available.
   * Helps the model avoid re-reading files or re-discovering artifacts.
   */
  buildContextSummary(): string | null {
    this._syncFromDiskIfBacked();
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
    this._syncFromDiskIfBacked();
    return this._items.filter(item => item.type === type) as T[];
  }

  /**
   * Get the last N items.
   */
  getRecentItems(count: number): readonly ContextItem[] {
    this._syncFromDiskIfBacked();
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
  getItemsForLLM(): LLMItem[] {
    this._syncFromDiskIfBacked();
    const result: LLMItem[] = [];
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
    this._syncFromDiskIfBacked();
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
    this._syncFromDiskIfBacked();
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
   * Pass filePath to enable disk-backed mode (writes snapshot to disk on restore).
   */
  static deserialize(snapshot: ContextWindowSnapshot, filePath?: string): ContextWindow {
    const context = new ContextWindow(snapshot.sessionKey, snapshot.maxTokens);
    // Bypass disk I/O during restore — set filePath after populating RAM
    context._items = [...snapshot.items];
    context._metrics = { ...snapshot.metrics };
    context._version = snapshot.version;
    context._readFiles = new Set(snapshot.readFiles);
    context._fileContentCounter = snapshot.fileContentCounter ?? 0;

    if (filePath) {
      (context as { filePath: string | null }).filePath = filePath;
      mkdirSync(nodePath.dirname(filePath), { recursive: true });
      context._writeDisk();
    }

    return context;
  }

  /**
   * Extract message history for TUI rehydration.
   * Returns only message-type items with role, content, timestamp, and optional requestId.
   */
  getMessageHistory(): Array<{ role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }> {
    this._syncFromDiskIfBacked();
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
    this._syncFromDiskIfBacked();
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
    this._syncFromDiskIfBacked();
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
    this._syncFromDiskIfBacked();
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
