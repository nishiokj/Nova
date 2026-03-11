/**
 * TraceSubscriber - Persists Write/Edit tool call traces to GraphD immediately.
 *
 * Subscribes to tool_call events on the EventBus, extracts file modification
 * data from completed Write/Edit calls, and writes them to the GraphD
 * file_traces table via the manager. Failed writes are retried with
 * exponential backoff from a bounded in-memory queue.
 */

import { createHash } from 'crypto';
import path from 'path';
import type { EventBusProtocol } from 'comms-bus';
import type { AgentEvent, ToolCallData } from 'types';
import { formatModelId } from 'types';
import type { GraphDManager } from 'graphd';

// ============================================
// RETRY QUEUE
// ============================================

interface RetryEntry {
  sessionKey: string;
  trace: {
    filePath: string;
    toolName: string;
    modelId?: string;
    requestId?: string;
    oldContent?: string;
    newContent: string;
    contentHash: string;
    createdAt: number;
  };
  attempts: number;
  nextRetryAt: number;
}

const MAX_RETRY_QUEUE = 1000;
const MAX_RETRY_ATTEMPTS = 5;
const BASE_RETRY_MS = 1000;

// ============================================
// TRACE SUBSCRIBER
// ============================================

export class TraceSubscriber {
  private readonly repoRoot: string;
  private readonly graphd: GraphDManager;
  private unsubscribeToolCall: (() => void) | null = null;
  private currentModelId?: string;
  private closed = false;
  private retryQueue: RetryEntry[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(eventBus: EventBusProtocol, graphd: GraphDManager, repoRoot: string) {
    this.graphd = graphd;
    this.repoRoot = repoRoot;

    this.unsubscribeToolCall = eventBus.subscribe('tool_call', (event) =>
      this.handleToolCallEvent(event as AgentEvent<ToolCallData>)
    );
  }

  /**
   * Set the current model ID for new traces.
   */
  setCurrentModel(provider: string, model: string): void {
    this.currentModelId = formatModelId(provider, model);
  }

  /**
   * Close the subscriber and stop retries.
   */
  close(): void {
    if (this.unsubscribeToolCall) {
      this.unsubscribeToolCall();
      this.unsubscribeToolCall = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryQueue = [];
    this.closed = true;
  }

  // ============================================
  // EVENT HANDLING
  // ============================================

  private handleToolCallEvent(event: AgentEvent<ToolCallData>): void {
    if (this.closed) return;

    const data = event.data;
    if (data.phase !== 'completed' || !data.success) return;

    const toolName = typeof data.toolName === 'string' ? data.toolName.toLowerCase() : '';
    if (toolName !== 'write' && toolName !== 'edit') return;

    this.persistModification(event, data, toolName === 'write' ? 'Write' : 'Edit');
  }

  private persistModification(
    event: AgentEvent<unknown>,
    data: ToolCallData,
    normalizedToolName: 'Write' | 'Edit'
  ): void {
    const args = data.arguments;
    const filePath = this.resolveRelativePath(args);
    if (!filePath) return;

    let newContent: string;
    let oldContent: string | undefined;

    if (normalizedToolName === 'Write') {
      newContent = typeof args.content === 'string' ? args.content : '';
    } else {
      const rawOld = args.old_string ?? args.oldString;
      oldContent = typeof rawOld === 'string' ? rawOld : undefined;
      const rawNew = args.new_string ?? args.newString;
      newContent = typeof rawNew === 'string' ? rawNew : '';
    }

    const contentHash = createHash('sha256').update(newContent).digest('hex');

    const sessionKey = event.sessionKey;
    if (!sessionKey) return;

    const trace = {
      filePath,
      toolName: normalizedToolName,
      modelId: this.currentModelId,
      requestId: event.requestId,
      oldContent,
      newContent,
      contentHash,
      createdAt: Date.now(),
    };

    const result = this.graphd.fileTraceAdd(sessionKey, trace);
    if ((result as { success?: boolean }).success !== true) {
      this.enqueueRetry(sessionKey, trace);
    }
  }

  // ============================================
  // PATH RESOLUTION
  // ============================================

  private resolveRelativePath(args: Record<string, unknown>): string | null {
    const candidate = (args.path ?? args.file_path ?? args.filePath ?? args.absolute_path) as string | undefined;
    if (!candidate || typeof candidate !== 'string') return null;

    // Convert to relative path
    if (path.isAbsolute(candidate)) {
      if (candidate.startsWith(this.repoRoot)) {
        return candidate.slice(this.repoRoot.length + 1);
      }
      return candidate;
    }
    return candidate;
  }

  // ============================================
  // RETRY QUEUE
  // ============================================

  private enqueueRetry(sessionKey: string, trace: RetryEntry['trace']): void {
    if (this.retryQueue.length >= MAX_RETRY_QUEUE) {
      // Drop newest when full
      console.warn('TraceSubscriber: retry queue full, dropping trace', { filePath: trace.filePath });
      return;
    }

    this.retryQueue.push({
      sessionKey,
      trace,
      attempts: 0,
      nextRetryAt: Date.now() + BASE_RETRY_MS,
    });

    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed || this.retryQueue.length === 0) return;

    const nextAt = Math.min(...this.retryQueue.map((e) => e.nextRetryAt));
    const delay = Math.max(0, nextAt - Date.now());

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.processRetries();
    }, delay);
  }

  private processRetries(): void {
    if (this.closed) return;

    const now = Date.now();
    const remaining: RetryEntry[] = [];

    for (const entry of this.retryQueue) {
      if (entry.nextRetryAt > now) {
        remaining.push(entry);
        continue;
      }

      entry.attempts++;
      const result = this.graphd.fileTraceAdd(entry.sessionKey, entry.trace);

      if ((result as { success?: boolean }).success !== true) {
        if (entry.attempts < MAX_RETRY_ATTEMPTS) {
          entry.nextRetryAt = now + BASE_RETRY_MS * Math.pow(2, entry.attempts);
          remaining.push(entry);
        } else {
          console.warn('TraceSubscriber: retry exhausted, dropping trace', {
            filePath: entry.trace.filePath,
            attempts: entry.attempts,
          });
        }
      }
    }

    this.retryQueue = remaining;
    this.scheduleRetry();
  }
}

// ============================================
// FACTORY
// ============================================

export function createTraceSubscriber(
  eventBus: EventBusProtocol,
  graphd: GraphDManager,
  repoRoot: string
): TraceSubscriber {
  return new TraceSubscriber(eventBus, graphd, repoRoot);
}

// ============================================
// GIT HELPERS (kept for harness git commit detection)
// ============================================

/**
 * Helper to detect git commit in Bash tool output and extract SHA.
 * Pattern matches:
 * - "[main abc1234] Commit message"
 * - "[detached HEAD abc1234] Commit message"
 */
export function extractCommitSha(bashOutput: string): string | null {
  const match = /\[[\w\s/-]+\s+([a-f0-9]{7,40})\]/.exec(bashOutput);
  return match?.[1] ?? null;
}

/**
 * Check if a bash command is a git commit.
 */
export function isGitCommitCommand(command: string): boolean {
  return /\bgit\s+commit\b/.test(command);
}
