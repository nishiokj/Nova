/**
 * Core State Interfaces
 *
 * Defines the shape of state managed by the orchestrator.
 * These are read-only views passed to hooks.
 */

import type { TerminationReason } from './termination.js';
import type { ExecutionMetrics } from './events.js';

/**
 * Work item specification for creating new work.
 */
export interface WorkItemSpec {
  id?: string;
  goal: string;
  objective: string;
  agent: string;
  domain?: string;
  dependencies?: string[];
  targetPaths?: string[];
  bounds?: {
    maxToolCalls?: number;
    maxLlmCalls?: number;
    maxDurationMs?: number;
  };
  /** Semantic state for this work item (attached during watcher split/create) */
  semantic?: unknown;
}

/**
 * Planner handoff spec item produced by planning agents.
 */
export interface HandoffWorkItem {
  id: string;
  objective: string;
  delta: string;
  agent: string;
  domain?: string;
  dependencies?: string[];
  targetPaths?: string[];
}

/**
 * Planner handoff spec produced at planning → execution transition.
 */
export interface HandoffSpec {
  goal: string;
  context: string;
  workItems: HandoffWorkItem[];
}

/**
 * Work item with runtime state.
 */
export interface WorkItem extends WorkItemSpec {
  workId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  terminationReason?: TerminationReason;
  response?: string;
  filesModified?: string[];
  metrics?: ExecutionMetrics;
}

/**
 * Result of a completed work item.
 */
export interface WorkResult {
  workId: string;
  success: boolean;
  response: string;
  filesModified: string[];
  metrics: ExecutionMetrics;
  terminationReason: TerminationReason;
  completedAt: number;
}

/**
 * Context window abstraction.
 */
export interface ContextWindow {
  messages: Message[];
  percentUsed: number;
  addMessage(role: 'system' | 'user' | 'assistant', content: string): void;
  getRecentMessages(n: number): Message[];
  truncateOldest(n: number): void;
}

/**
 * A message in the conversation.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * Audit log entry for tracking state changes.
 */
export interface AuditLogEntry {
  timestamp: number;
  source: string;
  event: string;
  details: Record<string, unknown>;
}

/**
 * The orchestrator state that can be read by hooks.
 * This is a read-only view - mutations go through patches.
 */
export interface OrchestratorState {
  readonly workQueue: readonly WorkItem[];
  readonly completedWork: ReadonlyMap<string, WorkResult>;
  readonly context: Readonly<ContextWindow>;
  readonly realignCount: number;
  readonly terminationReason: TerminationReason | null;
  readonly metadata: ReadonlyMap<string, unknown>;
  readonly auditLog: readonly AuditLogEntry[];
}

/**
 * Mutable version of orchestrator state for the reducer.
 */
export interface MutableOrchestratorState {
  workQueue: WorkItem[];
  completedWork: Map<string, WorkResult>;
  context: ContextWindow;
  realignCount: number;
  terminationReason: TerminationReason | null;
  metadata: Map<string, unknown>;
  auditLog: AuditLogEntry[];
}

/**
 * Create an empty orchestrator state.
 */
export function createInitialState(context: ContextWindow): MutableOrchestratorState {
  return {
    workQueue: [],
    completedWork: new Map(),
    context,
    realignCount: 0,
    terminationReason: null,
    metadata: new Map(),
    auditLog: [],
  };
}

/**
 * Create a work item from a spec.
 */
export function createWorkItem(spec: WorkItemSpec): WorkItem {
  return {
    ...spec,
    workId: generateWorkId(),
    status: 'pending',
    createdAt: Date.now(),
  };
}

/**
 * Generate a unique work item ID.
 */
function generateWorkId(): string {
  return `work_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Get the current work item (if any).
 */
export function getCurrentWorkItem(state: OrchestratorState): WorkItem | undefined {
  return state.workQueue.find(w => w.status === 'in_progress');
}

/**
 * Get the next pending work item.
 */
export function getNextPendingWorkItem(state: OrchestratorState): WorkItem | undefined {
  return state.workQueue.find(w => w.status === 'pending');
}
