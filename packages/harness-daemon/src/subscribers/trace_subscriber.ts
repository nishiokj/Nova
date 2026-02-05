/**
 * TraceSubscriber - Collects file modifications and emits Agent Trace records on commit.
 *
 * Two-phase pipeline:
 * - Phase A (Collect): Quietly accumulates Write/Edit tool_call events
 * - Phase B (Emit): On git commit, finalizes line ranges and writes trace record
 *
 * Based on: https://github.com/cursor/agent-trace
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import type { EventBusProtocol } from 'comms-bus';
import type { AgentEvent, ToolCallData, GitCommitData } from 'types';
import {
  AGENT_TRACE_VERSION,
  type ConversationUrlProvider,
  type FileAttribution,
  type LineRange,
  type PendingFileModification,
  type TraceRecord,
  dummyUrlProvider,
  formatModelId,
  generateTraceId,
  rfc3339Timestamp,
} from 'types';

/** Callback invoked when a trace is emitted */
export type TraceEmittedCallback = (trace: TraceRecord) => void;

// ============================================
// CONFIGURATION
// ============================================

export interface TraceSubscriberConfig {
  /** Repository root directory */
  repoRoot: string;
  /** Directory to store trace records (relative to repoRoot) */
  traceDir?: string;
  /** Tool name for trace records */
  toolName?: string;
  /** Tool version for trace records */
  toolVersion?: string;
  /** URL provider for conversation links */
  urlProvider?: ConversationUrlProvider;
  /** Current model being used (provider/model format) */
  currentModelId?: string;
}

// ============================================
// TRACE SUBSCRIBER
// ============================================

export class TraceSubscriber {
  private config: Required<Omit<TraceSubscriberConfig, 'currentModelId'>> & { currentModelId?: string };
  private unsubscribeToolCall: (() => void) | null = null;
  private unsubscribeGitCommit: (() => void) | null = null;
  private pendingModifications: Map<string, PendingFileModification[]> = new Map();
  private traceEmittedCallbacks: TraceEmittedCallback[] = [];
  private closed = false;

  constructor(eventBus: EventBusProtocol, config: TraceSubscriberConfig) {
    this.config = {
      repoRoot: config.repoRoot,
      traceDir: config.traceDir ?? '.agent-trace',
      toolName: config.toolName ?? 'agent',
      toolVersion: config.toolVersion ?? '0.1.0',
      urlProvider: config.urlProvider ?? dummyUrlProvider,
      currentModelId: config.currentModelId,
    };

    // Subscribe to tool_call events for collecting modifications
    this.unsubscribeToolCall = eventBus.subscribe('tool_call', (event) => this.handleToolCallEvent(event));

    // Subscribe to git_commit events for auto-emitting traces
    this.unsubscribeGitCommit = eventBus.subscribe('git_commit', (event) => this.handleGitCommitEvent(event as AgentEvent<GitCommitData>));
  }

  /**
   * Register a callback to be invoked when a trace is emitted.
   * Use this for external integrations that need to react to commits.
   */
  onTraceEmitted(callback: TraceEmittedCallback): () => void {
    this.traceEmittedCallbacks.push(callback);
    return () => {
      const idx = this.traceEmittedCallbacks.indexOf(callback);
      if (idx !== -1) {
        this.traceEmittedCallbacks.splice(idx, 1);
      }
    };
  }

  /**
   * Set the current model ID for new modifications.
   */
  setCurrentModel(provider: string, model: string): void {
    this.config.currentModelId = formatModelId(provider, model);
  }

  /**
   * Handle tool_call events for collecting modifications.
   */
  private handleToolCallEvent(event: AgentEvent<ToolCallData>): void {
    if (this.closed) return;

    const data = event.data;
    if (data.phase !== 'completed') return;
    if (!data.success) return;
    if (data.toolName !== 'Write' && data.toolName !== 'Edit') return;

    this.collectModification(event, data);
  }

  /**
   * Handle git_commit events to auto-emit traces.
   */
  private handleGitCommitEvent(event: AgentEvent<GitCommitData>): void {
    if (this.closed) return;

    const { sha } = event.data;
    if (!sha || !isValidGitSha(sha)) return;

    this.emitTrace(sha);
  }

  /**
   * Collect a file modification from a tool_call event.
   */
  private collectModification(event: AgentEvent<unknown>, data: ToolCallData): void {
    const args = data.arguments as Record<string, unknown>;
    const filePath = args.file_path as string;
    if (!filePath) return;

    const modification: PendingFileModification = {
      filePath,
      relativePath: this.getRelativePath(filePath),
      toolName: data.toolName as 'Write' | 'Edit',
      sessionKey: event.sessionKey,
      modelId: this.config.currentModelId,
      timestamp: event.timestamp,
      requestId: event.requestId,
    };

    // Capture content for Write
    if (data.toolName === 'Write') {
      modification.content = args.content as string;
    }

    // Capture old/new for Edit
    if (data.toolName === 'Edit') {
      modification.oldContent = args.old_string as string;
      modification.newContent = args.new_string as string;
    }

    const existing = this.pendingModifications.get(filePath) ?? [];
    existing.push(modification);
    this.pendingModifications.set(filePath, existing);
  }

  /**
   * Get path relative to repo root.
   */
  private getRelativePath(absolutePath: string): string {
    if (absolutePath.startsWith(this.config.repoRoot)) {
      return absolutePath.slice(this.config.repoRoot.length + 1);
    }
    return absolutePath;
  }

  /**
   * Emit a trace record for a commit.
   * Call this after creating a git commit.
   */
  emitTrace(revision: string): TraceRecord | null {
    if (this.pendingModifications.size === 0) {
      return null;
    }

    // Get files in this commit
    const committedFiles = this.getCommittedFiles(revision);
    if (committedFiles.length === 0) {
      return null;
    }

    // Build file attributions for files we have modifications for
    const files: FileAttribution[] = [];
    for (const relativePath of committedFiles) {
      const absolutePath = path.join(this.config.repoRoot, relativePath);
      const modifications = this.pendingModifications.get(absolutePath);
      if (!modifications || modifications.length === 0) continue;

      const attribution = this.buildFileAttribution(relativePath, modifications, revision);
      if (attribution) {
        files.push(attribution);
      }

      // Clear processed modifications
      this.pendingModifications.delete(absolutePath);
    }

    if (files.length === 0) {
      return null;
    }

    const trace: TraceRecord = {
      version: AGENT_TRACE_VERSION,
      id: generateTraceId(),
      timestamp: rfc3339Timestamp(),
      vcs: { type: 'git', revision },
      tool: { name: this.config.toolName, version: this.config.toolVersion },
      files,
    };

    // Persist trace record
    this.persistTrace(trace);

    // Notify registered callbacks
    for (const callback of this.traceEmittedCallbacks) {
      try {
        callback(trace);
      } catch {
        // Ignore callback errors
      }
    }

    return trace;
  }

  /**
   * Get list of files changed in a commit.
   */
  private getCommittedFiles(revision: string): string[] {
    try {
      const output = execSync(`git diff-tree --no-commit-id --name-only -r ${revision}`, {
        cwd: this.config.repoRoot,
        encoding: 'utf-8',
      });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Build file attribution from modifications.
   */
  private buildFileAttribution(
    relativePath: string,
    modifications: PendingFileModification[],
    revision: string
  ): FileAttribution | null {
    // Read file content at this revision
    const content = this.getFileAtRevision(relativePath, revision);
    if (!content) {
      // Fall back to attributing entire file
      return this.buildFallbackAttribution(relativePath, modifications);
    }

    const lines = content.split('\n');
    const conversations: FileAttribution['conversations'] = [];

    // Group modifications by session
    const bySession = new Map<string, PendingFileModification[]>();
    for (const mod of modifications) {
      const key = mod.sessionKey ?? 'unknown';
      const existing = bySession.get(key) ?? [];
      existing.push(mod);
      bySession.set(key, existing);
    }

    for (const [sessionKey, mods] of bySession) {
      const ranges: LineRange[] = [];

      for (const mod of mods) {
        const range = this.computeLineRange(mod, lines, content);
        if (range) {
          ranges.push(range);
        }
      }

      if (ranges.length === 0) {
        // Fallback: attribute entire file
        ranges.push({
          start_line: 1,
          end_line: lines.length,
          content_hash: this.contentHash(content),
        });
      }

      // Merge overlapping/adjacent ranges
      const mergedRanges = this.mergeRanges(ranges);

      const modelId = mods[0]?.modelId;
      conversations.push({
        url: this.config.urlProvider.getUrl(sessionKey) ?? `session://${sessionKey}`,
        contributor: {
          type: 'ai',
          model_id: modelId,
        },
        ranges: mergedRanges,
      });
    }

    return { path: relativePath, conversations };
  }

  /**
   * Compute line range for a modification by locating content in file.
   */
  private computeLineRange(
    mod: PendingFileModification,
    lines: string[],
    fullContent: string
  ): LineRange | null {
    // For Write: attribute entire file
    if (mod.toolName === 'Write') {
      return {
        start_line: 1,
        end_line: lines.length,
        content_hash: this.contentHash(fullContent),
      };
    }

    // For Edit: try to locate newContent in file
    if (mod.toolName === 'Edit' && mod.newContent) {
      const newContentTrimmed = mod.newContent.trim();
      const index = fullContent.indexOf(newContentTrimmed);
      if (index !== -1) {
        // Count lines to this position
        const before = fullContent.slice(0, index);
        const startLine = before.split('\n').length;
        const endLine = startLine + mod.newContent.split('\n').length - 1;
        return {
          start_line: startLine,
          end_line: endLine,
          content_hash: this.contentHash(mod.newContent),
        };
      }
    }

    return null;
  }

  /**
   * Build fallback attribution when we can't compute precise ranges.
   */
  private buildFallbackAttribution(
    relativePath: string,
    modifications: PendingFileModification[]
  ): FileAttribution {
    // Group by session
    const bySession = new Map<string, PendingFileModification[]>();
    for (const mod of modifications) {
      const key = mod.sessionKey ?? 'unknown';
      const existing = bySession.get(key) ?? [];
      existing.push(mod);
      bySession.set(key, existing);
    }

    const conversations: FileAttribution['conversations'] = [];
    for (const [sessionKey, mods] of bySession) {
      const modelId = mods[0]?.modelId;
      conversations.push({
        url: this.config.urlProvider.getUrl(sessionKey) ?? `session://${sessionKey}`,
        contributor: {
          type: 'ai',
          model_id: modelId,
        },
        ranges: [
          {
            start_line: 1,
            end_line: 1, // Unknown, will be coarse
          },
        ],
      });
    }

    return { path: relativePath, conversations };
  }

  /**
   * Get file content at a specific revision.
   */
  private getFileAtRevision(relativePath: string, revision: string): string | null {
    try {
      return execSync(`git show ${revision}:${relativePath}`, {
        cwd: this.config.repoRoot,
        encoding: 'utf-8',
      });
    } catch {
      return null;
    }
  }

  /**
   * Compute content hash for tracking code movement.
   */
  private contentHash(content: string): string {
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);
    return `md5:${hash}`;
  }

  /**
   * Merge overlapping or adjacent line ranges.
   */
  private mergeRanges(ranges: LineRange[]): LineRange[] {
    if (ranges.length <= 1) return ranges;

    // Sort by start line
    const sorted = [...ranges].sort((a, b) => a.start_line - b.start_line);
    const merged: LineRange[] = [];

    let current = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      if (next.start_line <= current.end_line + 1) {
        // Overlapping or adjacent - merge
        current = {
          start_line: current.start_line,
          end_line: Math.max(current.end_line, next.end_line),
          // Drop content_hash when merging
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);

    return merged;
  }

  /**
   * Persist trace record to disk.
   */
  private persistTrace(trace: TraceRecord): void {
    const traceDir = path.join(this.config.repoRoot, this.config.traceDir);
    if (!existsSync(traceDir)) {
      mkdirSync(traceDir, { recursive: true });
    }

    const filename = `${trace.vcs.revision}.json`;
    const filepath = path.join(traceDir, filename);
    writeFileSync(filepath, JSON.stringify(trace, null, 2));
  }

  /**
   * Get count of pending modifications.
   */
  getPendingCount(): number {
    let count = 0;
    for (const mods of this.pendingModifications.values()) {
      count += mods.length;
    }
    return count;
  }

  /**
   * Get pending file paths.
   */
  getPendingFiles(): string[] {
    return Array.from(this.pendingModifications.keys());
  }

  /**
   * Clear all pending modifications without emitting.
   */
  clear(): void {
    this.pendingModifications.clear();
  }

  /**
   * Close the subscriber.
   */
  close(): void {
    if (this.unsubscribeToolCall) {
      this.unsubscribeToolCall();
      this.unsubscribeToolCall = null;
    }
    if (this.unsubscribeGitCommit) {
      this.unsubscribeGitCommit();
      this.unsubscribeGitCommit = null;
    }
    this.traceEmittedCallbacks = [];
    this.closed = true;
  }
}

// ============================================
// FACTORY
// ============================================

export function createTraceSubscriber(
  eventBus: EventBusProtocol,
  config: TraceSubscriberConfig
): TraceSubscriber {
  return new TraceSubscriber(eventBus, config);
}

// ============================================
// GIT HELPERS
// ============================================

const GIT_SHA_PATTERN = /^[a-f0-9]{7,40}$/;

/**
 * Validate a git SHA to prevent command injection.
 */
function isValidGitSha(sha: string): boolean {
  return GIT_SHA_PATTERN.test(sha);
}

/**
 * Helper to detect git commit in Bash tool output and extract SHA.
 * Use this to hook into agent-initiated commits.
 *
 * Pattern matches:
 * - "[main abc1234] Commit message"
 * - "[detached HEAD abc1234] Commit message"
 */
export function extractCommitSha(bashOutput: string): string | null {
  const match = bashOutput.match(/\[[\w\s/-]+\s+([a-f0-9]{7,40})\]/);
  return match?.[1] ?? null;
}

/**
 * Check if a bash command is a git commit.
 */
export function isGitCommitCommand(command: string): boolean {
  return /\bgit\s+commit\b/.test(command);
}
