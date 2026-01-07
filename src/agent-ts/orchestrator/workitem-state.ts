import type { WorkItem } from '../wizard/work-item.js';
import type { AgentResult } from '../agent/types.js';

/**
 * WorkItem execution status.
 */
export type WorkItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'awaiting_user';

/**
 * Mutable state for a WorkItem during execution.
 */
export interface WorkItemState {
  /** The immutable WorkItem definition */
  workItem: WorkItem;
  /** Current status */
  status: WorkItemStatus;
  /** Agent ID executing this item (if in_progress) */
  agentId?: string;
  /** Attempt count (for retries) */
  attemptCount: number;
  /** Result from last execution (if completed/failed) */
  result?: AgentResult;
  /** Error message (if failed) */
  error?: string;
  /** Timestamp when started */
  startedAt?: number;
  /** Timestamp when completed */
  completedAt?: number;
}

/**
 * Create initial WorkItemState from WorkItem.
 */
export function createWorkItemState(workItem: WorkItem): WorkItemState {
  return {
    workItem,
    status: 'pending',
    attemptCount: 0,
  };
}

/**
 * Manager for WorkItem states during orchestration.
 * Single-writer pattern: only Orchestrator mutates.
 */
export class WorkItemStateManager {
  private states = new Map<string, WorkItemState>();

  /**
   * Initialize from RuntimeScript.
   */
  initFromScript(workItems: WorkItem[]): void {
    this.states.clear();
    for (const item of workItems) {
      this.states.set(item.workId, createWorkItemState(item));
    }
  }

  /**
   * Get state by workId.
   */
  get(workId: string): WorkItemState | undefined {
    return this.states.get(workId);
  }

  /**
   * Get all states.
   */
  getAll(): WorkItemState[] {
    return Array.from(this.states.values());
  }

  /**
   * Get WorkItems ready for execution (pending with satisfied dependencies).
   */
  getReady(): WorkItemState[] {
    return this.getAll().filter((state) => {
      if (state.status !== 'pending') return false;
      return state.workItem.dependencies.every((depId) => {
        const depState = this.states.get(depId);
        return depState && (depState.status === 'completed' || depState.status === 'skipped');
      });
    });
  }

  /**
   * Get in-progress WorkItems.
   */
  getInProgress(): WorkItemState[] {
    return this.getAll().filter((s) => s.status === 'in_progress');
  }

  /**
   * Mark WorkItem as in_progress.
   */
  markInProgress(workId: string, agentId: string): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'in_progress';
    state.agentId = agentId;
    state.attemptCount++;
    state.startedAt = Date.now();
  }

  /**
   * Mark WorkItem as completed.
   */
  markCompleted(workId: string, result: AgentResult): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'completed';
    state.result = result;
    state.completedAt = Date.now();
  }

  /**
   * Mark WorkItem as failed.
   */
  markFailed(workId: string, error: string, result?: AgentResult): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'failed';
    state.error = error;
    state.result = result;
    state.completedAt = Date.now();
  }

  /**
   * Mark WorkItem as skipped.
   */
  markSkipped(workId: string, reason: string): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'skipped';
    state.error = reason;
    state.completedAt = Date.now();
  }

  /**
   * Mark WorkItem as awaiting user input.
   */
  markAwaitingUser(workId: string): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'awaiting_user';
  }

  /**
   * Reset WorkItem for retry.
   */
  resetForRetry(workId: string): void {
    const state = this.states.get(workId);
    if (!state) throw new Error(`Unknown workId: ${workId}`);
    state.status = 'pending';
    state.agentId = undefined;
    state.result = undefined;
    state.error = undefined;
    state.startedAt = undefined;
    state.completedAt = undefined;
  }

  /**
   * Check if all WorkItems are done (completed, failed, or skipped).
   */
  isAllDone(): boolean {
    return this.getAll().every((s) =>
      s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
    );
  }

  /**
   * Get counts by status.
   */
  getCounts(): Record<WorkItemStatus, number> {
    const counts: Record<WorkItemStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      awaiting_user: 0,
    };
    for (const state of this.states.values()) {
      counts[state.status]++;
    }
    return counts;
  }
}
