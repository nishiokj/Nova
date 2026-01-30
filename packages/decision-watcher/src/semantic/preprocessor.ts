/**
 * Semantic Pre-processor
 *
 * Extracts deterministic facts from workItem logs before the watcher LLM call.
 * This reduces LLM work by separating data extraction from semantic interpretation.
 *
 * The preprocessor provides:
 * - Objective and init metadata
 * - Files touched with change type
 * - Tool call summary with success/failure
 * - Failure patterns (repeated failures on same target)
 * - Timeline of significant events
 * - Message contents for LLM interpretation
 */

import type { WorkItemLog, WorkItemEntry, WorkItemToolCallEntry, WorkItemMessageEntry } from '../workitem-log.js';

// ============================================
// PREPROCESSED CONTEXT
// ============================================

/**
 * Tool call summary entry.
 */
export interface ToolCallSummary {
  tool: string;
  target: string;
  success: boolean;
  timestamp: string;
  durationMs: number;
}

/**
 * Failure pattern - repeated failures on the same target.
 */
export interface FailurePattern {
  target: string;
  tool: string;
  failures: number;
  lastError: string;
  timestamps: string[];
}

/**
 * Timeline event.
 */
export interface TimelineEvent {
  event: string;
  timestamp: string;
  details?: string;
}

/**
 * Pre-processed context extracted from workItem log.
 * Contains deterministic facts that don't require LLM interpretation.
 */
export interface PreProcessedContext {
  /** Objective from init event */
  objective: string;

  /** Agent type */
  agent: string;

  /** Working directory */
  cwd: string;

  /** Domain tag if present */
  domain?: string;

  /** Files touched with operation type */
  filesTouched: Array<{
    path: string;
    operations: Array<'read' | 'edit' | 'write' | 'grep' | 'glob'>;
    lastOperation: string;
  }>;

  /** Summarized tool calls */
  toolCallSummary: ToolCallSummary[];

  /** Patterns of repeated failures */
  failurePatterns: FailurePattern[];

  /** Timeline of significant events */
  timeline: TimelineEvent[];

  /** Message contents for LLM interpretation */
  messageContents: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    reasoning?: string;
    watcherInjected?: boolean;
  }>;

  /** Position in log (events processed) */
  logPosition: number;

  /** Total events in log */
  totalEvents: number;

  /** Metrics if available */
  metrics?: {
    toolCalls: number;
    llmCalls: number;
    contextPercentUsed: number;
    durationMs: number;
    filesRead: string[];
    filesModified: string[];
  };

  /** Current status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';

  /** Error if failed */
  error?: string;
}

// ============================================
// EXTRACTION
// ============================================

/**
 * Extract pre-processed context from a workItem log.
 * This is the main entry point for the preprocessor.
 */
export async function extractPreProcessedContext(
  workItemLog: WorkItemLog
): Promise<PreProcessedContext> {
  const entries = await workItemLog.readAll();
  return extractFromEntries(entries);
}

/**
 * Extract pre-processed context from raw entries.
 * Useful for testing or when entries are already loaded.
 */
export function extractFromEntries(entries: WorkItemEntry[]): PreProcessedContext {
  // Find init entry
  const initEntry = entries.find(e => e.type === 'init');
  if (!initEntry || initEntry.type !== 'init') {
    throw new Error('WorkItem log missing init entry');
  }

  // Extract tool calls
  const toolCalls = entries.filter((e): e is WorkItemToolCallEntry => e.type === 'tool_call');

  // Extract messages
  const messages = entries.filter((e): e is WorkItemMessageEntry => e.type === 'message');

  // Find final status
  const statusEntries = entries.filter(e => e.type === 'status');
  const lastStatus = statusEntries[statusEntries.length - 1];
  const status = (lastStatus?.type === 'status' ? lastStatus.status : 'pending') as PreProcessedContext['status'];
  const error = lastStatus?.type === 'status' && lastStatus.status === 'failed' ? lastStatus.error : undefined;

  // Find metrics
  const metricsEntry = entries.find(e => e.type === 'metrics');
  const metrics = metricsEntry?.type === 'metrics' ? {
    toolCalls: metricsEntry.toolCalls,
    llmCalls: metricsEntry.llmCalls,
    contextPercentUsed: metricsEntry.contextPercentUsed,
    durationMs: metricsEntry.durationMs,
    filesRead: metricsEntry.filesRead,
    filesModified: metricsEntry.filesModified,
  } : undefined;

  return {
    objective: initEntry.objective,
    agent: initEntry.agent,
    cwd: initEntry.cwd,
    domain: initEntry.domain,
    filesTouched: extractFilesTouched(toolCalls),
    toolCallSummary: extractToolCallSummary(toolCalls),
    failurePatterns: extractFailurePatterns(toolCalls),
    timeline: extractTimeline(entries),
    messageContents: messages.map(m => ({
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      watcherInjected: m.watcherInjected,
    })),
    logPosition: entries.length,
    totalEvents: entries.length,
    metrics,
    status,
    error,
  };
}

// ============================================
// FILE EXTRACTION
// ============================================

type FileOperation = 'read' | 'edit' | 'write' | 'grep' | 'glob';

function extractFilesTouched(toolCalls: WorkItemToolCallEntry[]): PreProcessedContext['filesTouched'] {
  const fileMap = new Map<string, { operations: Set<FileOperation>; lastOp: string }>();

  for (const tc of toolCalls) {
    const paths = extractPathsFromToolCall(tc);
    const op = toolToOperation(tc.tool);

    for (const path of paths) {
      const existing = fileMap.get(path);
      if (existing) {
        existing.operations.add(op);
        existing.lastOp = tc.tool;
      } else {
        fileMap.set(path, { operations: new Set([op]), lastOp: tc.tool });
      }
    }
  }

  return Array.from(fileMap.entries()).map(([path, data]) => ({
    path,
    operations: Array.from(data.operations),
    lastOperation: data.lastOp,
  }));
}

function extractPathsFromToolCall(tc: WorkItemToolCallEntry): string[] {
  const paths: string[] = [];
  const args = tc.args;

  // Common path argument names
  const pathKeys = ['path', 'file_path', 'filePath', 'file', 'directory', 'dir'];
  for (const key of pathKeys) {
    if (typeof args[key] === 'string') {
      paths.push(args[key] as string);
    }
  }

  // Handle array paths (e.g., for batch operations)
  if (Array.isArray(args.paths)) {
    paths.push(...args.paths.filter((p): p is string => typeof p === 'string'));
  }

  return paths;
}

function toolToOperation(tool: string): FileOperation {
  const lower = tool.toLowerCase();
  if (lower.includes('read') || lower === 'cat') return 'read';
  if (lower.includes('edit') || lower === 'sed') return 'edit';
  if (lower.includes('write') || lower.includes('create')) return 'write';
  if (lower.includes('grep') || lower.includes('search')) return 'grep';
  if (lower.includes('glob') || lower.includes('find') || lower.includes('ls')) return 'glob';
  return 'read'; // Default
}

// ============================================
// TOOL CALL SUMMARY
// ============================================

function extractToolCallSummary(toolCalls: WorkItemToolCallEntry[]): ToolCallSummary[] {
  return toolCalls.map(tc => ({
    tool: tc.tool,
    target: extractTarget(tc),
    success: tc.success,
    timestamp: tc.timestamp,
    durationMs: tc.durationMs,
  }));
}

function extractTarget(tc: WorkItemToolCallEntry): string {
  const args = tc.args;

  // Try common path arguments
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    if (typeof args[key] === 'string') {
      return args[key] as string;
    }
  }

  // For grep/search, use the pattern
  if (typeof args.pattern === 'string') {
    return `pattern:${(args.pattern as string).slice(0, 50)}`;
  }

  // For commands, use the command
  if (typeof args.command === 'string') {
    return `cmd:${(args.command as string).slice(0, 50)}`;
  }

  return tc.tool;
}

// ============================================
// FAILURE PATTERNS
// ============================================

function extractFailurePatterns(toolCalls: WorkItemToolCallEntry[]): FailurePattern[] {
  const failuresByTarget = new Map<string, {
    tool: string;
    failures: number;
    lastError: string;
    timestamps: string[];
  }>();

  for (const tc of toolCalls) {
    if (tc.success) continue;

    const target = extractTarget(tc);
    const key = `${tc.tool}:${target}`;
    const existing = failuresByTarget.get(key);

    if (existing) {
      existing.failures++;
      existing.lastError = tc.resultSummary ?? 'Unknown error';
      existing.timestamps.push(tc.timestamp);
    } else {
      failuresByTarget.set(key, {
        tool: tc.tool,
        failures: 1,
        lastError: tc.resultSummary ?? 'Unknown error',
        timestamps: [tc.timestamp],
      });
    }
  }

  // Only return patterns with 2+ failures (indicates repeated issues)
  return Array.from(failuresByTarget.entries())
    .filter(([, data]) => data.failures >= 2)
    .map(([key, data]) => ({
      target: key.split(':').slice(1).join(':'),
      tool: data.tool,
      failures: data.failures,
      lastError: data.lastError,
      timestamps: data.timestamps,
    }));
}

// ============================================
// TIMELINE
// ============================================

function extractTimeline(entries: WorkItemEntry[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case 'init':
        events.push({
          event: 'workitem_started',
          timestamp: entry.timestamp,
          details: `Agent: ${entry.agent}, Objective: ${entry.objective.slice(0, 100)}`,
        });
        break;

      case 'status':
        events.push({
          event: `status_${entry.status}`,
          timestamp: entry.timestamp,
          details: entry.error ?? entry.agentSummary?.slice(0, 100),
        });
        break;

      case 'decision':
        events.push({
          event: `watcher_${entry.trigger}`,
          timestamp: entry.timestamp,
          details: `${entry.action}: ${entry.rationale.slice(0, 100)}`,
        });
        break;

      case 'tool_call':
        // Only include significant tool calls (failures, or every Nth success)
        if (!entry.success) {
          events.push({
            event: `tool_failed`,
            timestamp: entry.timestamp,
            details: `${entry.tool}: ${entry.resultSummary?.slice(0, 80) ?? 'failed'}`,
          });
        }
        break;

      case 'message':
        // Include watcher-injected messages as events
        if (entry.watcherInjected) {
          events.push({
            event: 'watcher_injection',
            timestamp: entry.timestamp,
            details: entry.content.slice(0, 100),
          });
        }
        break;
    }
  }

  return events;
}

// ============================================
// FORMATTING FOR WATCHER
// ============================================

/**
 * Format pre-processed context into a string suitable for injection into watcher prompt.
 * This provides the deterministic facts in a structured, readable format.
 */
export function formatPreProcessedContext(ctx: PreProcessedContext): string {
  const sections: string[] = [];

  // Header
  sections.push(`## Pre-Processed Facts (Deterministic)`);
  sections.push('');

  // Init info
  sections.push(`**Objective**: ${ctx.objective}`);
  sections.push(`**Agent**: ${ctx.agent}`);
  sections.push(`**Status**: ${ctx.status}`);
  if (ctx.domain) sections.push(`**Domain**: ${ctx.domain}`);
  sections.push(`**Log Position**: ${ctx.logPosition} events`);
  sections.push('');

  // Files touched
  if (ctx.filesTouched.length > 0) {
    sections.push('### Files Touched');
    sections.push('');
    for (const file of ctx.filesTouched.slice(0, 20)) {
      sections.push(`- \`${file.path}\`: ${file.operations.join(', ')} (last: ${file.lastOperation})`);
    }
    if (ctx.filesTouched.length > 20) {
      sections.push(`... and ${ctx.filesTouched.length - 20} more files`);
    }
    sections.push('');
  }

  // Failure patterns
  if (ctx.failurePatterns.length > 0) {
    sections.push('### Failure Patterns (Repeated Issues)');
    sections.push('');
    for (const pattern of ctx.failurePatterns) {
      sections.push(`- **${pattern.tool}** on \`${pattern.target}\`: ${pattern.failures} failures`);
      sections.push(`  Last error: ${pattern.lastError.slice(0, 150)}`);
    }
    sections.push('');
  }

  // Metrics
  if (ctx.metrics) {
    sections.push('### Metrics');
    sections.push('');
    sections.push(`- Tool calls: ${ctx.metrics.toolCalls}`);
    sections.push(`- LLM calls: ${ctx.metrics.llmCalls}`);
    sections.push(`- Duration: ${(ctx.metrics.durationMs / 1000).toFixed(1)}s`);
    sections.push(`- Context used: ${(ctx.metrics.contextPercentUsed * 100).toFixed(1)}%`);
    if (ctx.metrics.filesModified.length > 0) {
      sections.push(`- Files modified: ${ctx.metrics.filesModified.slice(0, 10).join(', ')}`);
    }
    sections.push('');
  }

  // Recent timeline (last 10 events)
  if (ctx.timeline.length > 0) {
    sections.push('### Timeline (Recent Events)');
    sections.push('');
    const recent = ctx.timeline.slice(-10);
    for (const event of recent) {
      const detail = event.details ? `: ${event.details}` : '';
      sections.push(`- [${event.timestamp}] ${event.event}${detail}`);
    }
    sections.push('');
  }

  // Error if present
  if (ctx.error) {
    sections.push('### Error');
    sections.push('');
    sections.push('```');
    sections.push(ctx.error);
    sections.push('```');
    sections.push('');
  }

  return sections.join('\n');
}
