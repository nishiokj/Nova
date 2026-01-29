/**
 * WorkItem Log
 *
 * JSONL-based streaming log for individual WorkItems.
 * Each WorkItem gets its own .jsonl file with conversation, tool calls, and decisions.
 * This gives the watcher full context for the agent asking questions.
 *
 * Path: .watcher/{YYYY-MM-DD}/{sessionId}/workitems/{workId}.jsonl
 *
 * Entry types:
 * - init: WorkItem creation metadata
 * - message: Conversation turn (system/user/assistant)
 * - tool_call: Tool invocation with summarized result
 * - decision: Watcher decision scoped to this workitem
 * - status: Status change (started, completed, failed)
 * - metrics: Execution metrics snapshot
 */

import fs from 'fs/promises';
import { workitemPath, workitemsDir, workitemSummaryPath } from './session-paths.js';
import type {
  WorkItemEntry,
  WorkItemInitEntry,
  WorkItemMessageEntry,
  WorkItemToolCallEntry,
  WorkItemDecisionEntry,
  WorkItemStatusEntry,
  WorkItemMetricsEntry,
  WatcherTrigger,
  WatcherActionType,
} from './types.js';

// Re-export types for convenience
export type {
  WorkItemEntry,
  WorkItemInitEntry,
  WorkItemMessageEntry,
  WorkItemToolCallEntry,
  WorkItemDecisionEntry,
  WorkItemStatusEntry,
  WorkItemMetricsEntry,
};

// ============================================
// LEGACY TYPES (for backward compatibility)
// ============================================

export type WorkItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface WorkItemMetrics {
  toolCalls: number;
  llmCalls: number;
  contextPercentUsed: number;
}

export interface FileChange {
  path: string;
  action: 'create' | 'edit' | 'delete';
  timestamp: string;
}

// ============================================
// WORKITEM LOG INTERFACE
// ============================================

export interface WorkItemLog {
  /** Get the JSONL file path */
  filePath(): string;

  /** Get the workId */
  workId(): string;

  /** Append any entry type (low-level) */
  append(entry: WorkItemEntry): Promise<void>;

  /** Read all entries */
  readAll(): Promise<WorkItemEntry[]>;

  /** Read just message entries (for watcher context) */
  readMessages(): Promise<WorkItemMessageEntry[]>;

  /** Read just decision entries (for consistency checking) */
  readDecisions(): Promise<WorkItemDecisionEntry[]>;

  /** Read just tool call entries */
  readToolCalls(): Promise<WorkItemToolCallEntry[]>;

  // ============================================
  // Convenience methods for streaming
  // ============================================

  /** Append a conversation message */
  appendMessage(
    role: 'system' | 'user' | 'assistant',
    content: string,
    watcherInjected?: boolean
  ): Promise<void>;

  /** Append a tool call record */
  appendToolCall(
    tool: string,
    args: Record<string, unknown>,
    success: boolean,
    resultSummary?: string,
    durationMs?: number
  ): Promise<void>;

  /** Append a watcher decision (scoped to this workitem) */
  appendDecision(
    trigger: WatcherTrigger,
    action: WatcherActionType,
    rationale: string,
    question?: string,
    answer?: string
  ): Promise<void>;

  // ============================================
  // Status lifecycle methods
  // ============================================

  /** Mark as started */
  markStarted(): Promise<void>;

  /** Mark as completed with summary */
  markCompleted(
    agentSummary: string,
    metrics?: { toolCalls: number; llmCalls: number; contextPercentUsed: number; durationMs: number; filesRead: string[]; filesModified: string[] }
  ): Promise<void>;

  /** Mark as failed with error */
  markFailed(error: string): Promise<void>;

  // ============================================
  // Summary generation
  // ============================================

  /** Generate markdown summary (for human readability) */
  generateSummary(): Promise<string>;

  /** Write markdown summary to .md file */
  writeSummary(): Promise<void>;
}

// ============================================
// CONSTANTS
// ============================================

/** Max content length before truncation */
const MAX_CONTENT_LENGTH = 3000;

/** Max result summary length */
const MAX_RESULT_SUMMARY_LENGTH = 500;

// ============================================
// IMPLEMENTATION
// ============================================

/**
 * Create a new WorkItem log.
 */
export async function createWorkItemLog(
  workingDir: string,
  sessionId: string,
  initialData: {
    workId: string;
    objective: string;
    agent: string;
    domain?: string;
    dependencies?: string[];
    targetPaths?: string[];
  }
): Promise<WorkItemLog> {
  const dir = workitemsDir(workingDir, sessionId);
  await fs.mkdir(dir, { recursive: true });

  const logPath = workitemPath(workingDir, sessionId, initialData.workId);
  const summaryPath = workitemSummaryPath(workingDir, sessionId, initialData.workId);

  // Write init entry
  const initEntry: WorkItemInitEntry = {
    type: 'init',
    timestamp: new Date().toISOString(),
    workId: initialData.workId,
    objective: initialData.objective,
    agent: initialData.agent,
    domain: initialData.domain,
    dependencies: initialData.dependencies,
    targetPaths: initialData.targetPaths,
  };

  await fs.writeFile(logPath, JSON.stringify(initEntry) + '\n', 'utf-8');

  return createWorkItemLogInstance(logPath, summaryPath, initialData.workId);
}

/**
 * Get an existing WorkItem log.
 * Returns null if the file doesn't exist.
 */
export async function getWorkItemLog(
  workingDir: string,
  sessionId: string,
  workId: string
): Promise<WorkItemLog | null> {
  const logPath = workitemPath(workingDir, sessionId, workId);

  try {
    await fs.access(logPath);
  } catch {
    return null;
  }

  const summaryPath = workitemSummaryPath(workingDir, sessionId, workId);
  return createWorkItemLogInstance(logPath, summaryPath, workId);
}

/**
 * Create WorkItemLog instance with given paths.
 */
function createWorkItemLogInstance(
  logPath: string,
  summaryPath: string,
  workIdValue: string
): WorkItemLog {
  async function append(entry: WorkItemEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(logPath, line, 'utf-8');
  }

  async function readAll(): Promise<WorkItemEntry[]> {
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      return parseJsonl(content);
    } catch {
      return [];
    }
  }

  async function readMessages(): Promise<WorkItemMessageEntry[]> {
    const all = await readAll();
    return all.filter((e): e is WorkItemMessageEntry => e.type === 'message');
  }

  async function readDecisions(): Promise<WorkItemDecisionEntry[]> {
    const all = await readAll();
    return all.filter((e): e is WorkItemDecisionEntry => e.type === 'decision');
  }

  async function readToolCalls(): Promise<WorkItemToolCallEntry[]> {
    const all = await readAll();
    return all.filter((e): e is WorkItemToolCallEntry => e.type === 'tool_call');
  }

  return {
    filePath: () => logPath,
    workId: () => workIdValue,

    append,
    readAll,
    readMessages,
    readDecisions,
    readToolCalls,

    async appendMessage(
      role: 'system' | 'user' | 'assistant',
      content: string,
      watcherInjected?: boolean
    ): Promise<void> {
      const entry: WorkItemMessageEntry = {
        type: 'message',
        timestamp: new Date().toISOString(),
        role,
        content: truncate(content, MAX_CONTENT_LENGTH),
        watcherInjected,
      };
      await append(entry);
    },

    async appendToolCall(
      tool: string,
      args: Record<string, unknown>,
      success: boolean,
      resultSummary?: string,
      durationMs?: number
    ): Promise<void> {
      const entry: WorkItemToolCallEntry = {
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        tool,
        args: summarizeArgs(args),
        success,
        resultSummary: resultSummary ? truncate(resultSummary, MAX_RESULT_SUMMARY_LENGTH) : undefined,
        durationMs: durationMs ?? 0,
      };
      await append(entry);
    },

    async appendDecision(
      trigger: WatcherTrigger,
      action: WatcherActionType,
      rationale: string,
      question?: string,
      answer?: string
    ): Promise<void> {
      const entry: WorkItemDecisionEntry = {
        type: 'decision',
        timestamp: new Date().toISOString(),
        trigger,
        action,
        rationale,
        question,
        answer,
      };
      await append(entry);
    },

    async markStarted(): Promise<void> {
      const entry: WorkItemStatusEntry = {
        type: 'status',
        timestamp: new Date().toISOString(),
        status: 'in_progress',
      };
      await append(entry);
    },

    async markCompleted(
      agentSummary: string,
      metrics?: { toolCalls: number; llmCalls: number; contextPercentUsed: number; durationMs: number; filesRead: string[]; filesModified: string[] }
    ): Promise<void> {
      const statusEntry: WorkItemStatusEntry = {
        type: 'status',
        timestamp: new Date().toISOString(),
        status: 'completed',
        agentSummary: truncate(agentSummary, MAX_CONTENT_LENGTH),
      };
      await append(statusEntry);

      if (metrics) {
        const metricsEntry: WorkItemMetricsEntry = {
          type: 'metrics',
          timestamp: new Date().toISOString(),
          toolCalls: metrics.toolCalls,
          llmCalls: metrics.llmCalls,
          contextPercentUsed: metrics.contextPercentUsed,
          durationMs: metrics.durationMs,
          filesRead: metrics.filesRead,
          filesModified: metrics.filesModified,
        };
        await append(metricsEntry);
      }
    },

    async markFailed(error: string): Promise<void> {
      const entry: WorkItemStatusEntry = {
        type: 'status',
        timestamp: new Date().toISOString(),
        status: 'failed',
        error,
      };
      await append(entry);
    },

    async generateSummary(): Promise<string> {
      const entries = await readAll();
      return generateMarkdownSummary(entries);
    },

    async writeSummary(): Promise<void> {
      const summary = await this.generateSummary();
      await fs.writeFile(summaryPath, summary, 'utf-8');
    },
  };
}

// ============================================
// HELPERS
// ============================================

function parseJsonl<T>(content: string): T[] {
  const entries: T[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '... [truncated]';
}

/**
 * Summarize tool args for logging (don't include full file contents, etc.)
 */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 200) {
      summary[key] = value.slice(0, 200) + '...';
    } else if (Array.isArray(value) && value.length > 10) {
      summary[key] = [...value.slice(0, 10), `... and ${value.length - 10} more`];
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

/**
 * Generate markdown summary from entries.
 */
function generateMarkdownSummary(entries: WorkItemEntry[]): string {
  const init = entries.find((e): e is WorkItemInitEntry => e.type === 'init');
  const messages = entries.filter((e): e is WorkItemMessageEntry => e.type === 'message');
  const toolCalls = entries.filter((e): e is WorkItemToolCallEntry => e.type === 'tool_call');
  const decisions = entries.filter((e): e is WorkItemDecisionEntry => e.type === 'decision');
  const statuses = entries.filter((e): e is WorkItemStatusEntry => e.type === 'status');
  const metrics = entries.find((e): e is WorkItemMetricsEntry => e.type === 'metrics');

  const lastStatus = statuses[statuses.length - 1];
  const lines: string[] = [];

  // Header
  lines.push(`# WorkItem: ${init?.workId ?? 'unknown'}`);
  lines.push('');
  lines.push(`**Status**: ${lastStatus?.status ?? 'pending'}`);
  lines.push(`**Objective**: ${init?.objective ?? 'unknown'}`);
  lines.push(`**Agent**: ${init?.agent ?? 'unknown'}`);
  if (init?.domain) lines.push(`**Domain**: ${init.domain}`);
  if (init?.dependencies?.length) lines.push(`**Dependencies**: ${init.dependencies.join(', ')}`);
  lines.push('');

  // Metrics
  if (metrics) {
    lines.push('## Metrics');
    lines.push('');
    lines.push(`- **Tool calls**: ${metrics.toolCalls}`);
    lines.push(`- **LLM calls**: ${metrics.llmCalls}`);
    lines.push(`- **Duration**: ${(metrics.durationMs / 1000).toFixed(1)}s`);
    lines.push(`- **Context used**: ${(metrics.contextPercentUsed * 100).toFixed(1)}%`);
    if (metrics.filesModified.length > 0) {
      lines.push(`- **Files modified**: ${metrics.filesModified.join(', ')}`);
    }
    lines.push('');
  }

  // Decisions
  if (decisions.length > 0) {
    lines.push('## Watcher Decisions');
    lines.push('');
    for (const d of decisions) {
      lines.push(`### ${d.trigger} (${d.timestamp})`);
      if (d.question) lines.push(`**Q**: ${d.question}`);
      if (d.answer) lines.push(`**A**: ${d.answer}`);
      lines.push(`**Action**: ${d.action}`);
      lines.push(`**Rationale**: ${d.rationale}`);
      lines.push('');
    }
  }

  // Tool calls summary
  if (toolCalls.length > 0) {
    lines.push('## Tool Calls');
    lines.push('');
    const byTool = new Map<string, number>();
    for (const tc of toolCalls) {
      byTool.set(tc.tool, (byTool.get(tc.tool) ?? 0) + 1);
    }
    for (const [tool, count] of byTool) {
      lines.push(`- **${tool}**: ${count} calls`);
    }
    lines.push('');
  }

  // Conversation summary (last few messages)
  if (messages.length > 0) {
    lines.push('## Conversation (last 5 messages)');
    lines.push('');
    const recent = messages.slice(-5);
    for (const m of recent) {
      const roleLabel = m.watcherInjected ? `[${m.role}][watcher]` : `[${m.role}]`;
      const preview = m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content;
      lines.push(`**${roleLabel}**: ${preview}`);
      lines.push('');
    }
  }

  // Agent summary
  if (lastStatus?.agentSummary) {
    lines.push('## Agent Summary');
    lines.push('');
    lines.push(lastStatus.agentSummary);
    lines.push('');
  }

  // Error
  if (lastStatus?.status === 'failed' && lastStatus.error) {
    lines.push('## Error');
    lines.push('');
    lines.push('```');
    lines.push(lastStatus.error);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================
// LEGACY SUPPORT
// ============================================

/**
 * Generate markdown from legacy WorkItemLogData format.
 * @deprecated Use WorkItemLog.generateSummary() instead
 */
export interface WorkItemLogData {
  workId: string;
  status: WorkItemStatus;
  objective: string;
  agent: string;
  domain?: string;
  planId?: string;
  dependencies?: string[];
  targetPaths?: string[];
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  filesChanged?: FileChange[];
  agentSummary?: string;
  metrics?: WorkItemMetrics;
  error?: string;
}

/**
 * @deprecated Use WorkItemLog.generateSummary() instead
 */
export function generateWorkItemMarkdown(data: WorkItemLogData): string {
  const lines: string[] = [
    `# WorkItem: ${data.workId}`,
    '',
    `**Status**: ${data.status}`,
    `**Objective**: ${data.objective}`,
    `**Agent**: ${data.agent}`,
  ];

  if (data.domain) lines.push(`**Domain**: ${data.domain}`);
  if (data.dependencies?.length) lines.push(`**Dependencies**: ${data.dependencies.join(', ')}`);
  lines.push('');

  lines.push('## Timing');
  lines.push('');
  if (data.startedAt) lines.push(`**Started**: ${data.startedAt}`);
  if (data.completedAt) lines.push(`**Completed**: ${data.completedAt}`);
  if (data.durationMs !== undefined) lines.push(`**Duration**: ${(data.durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  lines.push('## Files Changed');
  lines.push('');
  if (data.filesChanged?.length) {
    for (const change of data.filesChanged) {
      lines.push(`- \`${change.path}\` - ${change.action} (${change.timestamp})`);
    }
  } else {
    lines.push('_No files changed yet._');
  }
  lines.push('');

  lines.push('## Metrics');
  lines.push('');
  if (data.metrics) {
    lines.push(`- **Tool calls**: ${data.metrics.toolCalls}`);
    lines.push(`- **LLM calls**: ${data.metrics.llmCalls}`);
    lines.push(`- **Context used**: ${(data.metrics.contextPercentUsed * 100).toFixed(1)}%`);
  } else {
    lines.push('_No metrics yet._');
  }
  lines.push('');

  lines.push('## Agent Summary');
  lines.push('');
  lines.push(data.agentSummary ?? '_Awaiting completion._');
  lines.push('');

  if (data.status === 'failed' && data.error) {
    lines.push('## Error');
    lines.push('');
    lines.push('```');
    lines.push(data.error);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}
