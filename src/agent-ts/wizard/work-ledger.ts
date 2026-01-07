/**
 * Append-only work ledger for audit trail and debugging.
 * All worker dispatches and outcomes are recorded permanently.
 *
 * Ported from: src/harness/agent/wizard/work_ledger.py
 */

import { v4 as uuidv4 } from 'uuid';
import type { WorkItem } from './work-item.js';
import type { AgentResult } from '../agent/types.js';

/**
 * Status of a ledger entry.
 */
export enum EntryStatus {
  PENDING = 'pending',
  DISPATCHED = 'dispatched',
  COMPLETED = 'completed',
  FAILED = 'failed',
  AWAITING_USER = 'awaiting_user',
}

/**
 * Decision made on a patch.
 */
export enum PatchDecision {
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * Record of a patch lifecycle: propose -> decision -> apply.
 */
export interface PatchRecord {
  patchId: string;
  proposedAt: number;
  source: string; // "worker", "user"
  patchType: string; // "insert", "remove", "replace", etc.
  targetSteps: number[];
  justification: string;
  // Decision phase
  decision?: PatchDecision;
  decisionAt?: number;
  rejectionReason?: string;
  // Apply phase
  applied: boolean;
  appliedAt?: number;
  resultingVersion?: number;
}

/**
 * Single entry in the append-only work ledger.
 */
export interface LedgerEntry {
  entryId: string;
  stepNum: number;
  workerId: string;
  workItemSummary: string;
  dispatchedAt: number;
  // Filled on completion
  completedAt?: number;
  status: EntryStatus;
  outcomeSummary?: string;
  // Extracted observations
  observations: string[];
  entityRefs: string[];
  // Metrics
  toolCallsMade: number;
  llmCallsMade: number;
  durationMs: number;
}

/**
 * Create a ledger entry.
 */
function createLedgerEntry(params: {
  stepNum: number;
  workerId: string;
  workItemSummary: string;
}): LedgerEntry {
  return {
    entryId: uuidv4().slice(0, 8),
    stepNum: params.stepNum,
    workerId: params.workerId,
    workItemSummary: params.workItemSummary,
    dispatchedAt: Date.now(),
    status: EntryStatus.DISPATCHED,
    observations: [],
    entityRefs: [],
    toolCallsMade: 0,
    llmCallsMade: 0,
    durationMs: 0,
  };
}

/**
 * Append-only work history owned by Wizard.
 *
 * INVARIANTS:
 * - Entries can only be appended, never removed or modified
 * - Exception: completion data can be added to a DISPATCHED entry
 */
export class WorkLedger {
  private entries: LedgerEntry[] = [];
  private byStep = new Map<number, string[]>(); // stepNum -> [entryIds]
  private byId = new Map<string, LedgerEntry>();
  private maxEntries: number;

  // Patch tracking (lazily initialized)
  private patches: PatchRecord[] = [];
  private patchesById = new Map<string, PatchRecord>();

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Record work dispatch. Returns entryId.
   */
  recordDispatch(workItem: WorkItem, workerId: string): string {
    const stepNum = typeof workItem.stepNum === 'number' ? workItem.stepNum : 0;
    const summary = typeof workItem.objective === 'string'
      ? workItem.objective.slice(0, 100)
      : '';
    const entry = createLedgerEntry({
      stepNum,
      workerId,
      workItemSummary: summary,
    });

    this.entries.push(entry);
    this.byId.set(entry.entryId, entry);

    const stepEntries = this.byStep.get(stepNum) ?? [];
    stepEntries.push(entry.entryId);
    this.byStep.set(stepNum, stepEntries);

    // Enforce maxEntries by evicting oldest completed entries
    if (this.entries.length > this.maxEntries) {
      this.evictOldestCompleted();
    }

    return entry.entryId;
  }

  /**
   * Evict oldest completed entries to stay within maxEntries.
   */
  private evictOldestCompleted(): void {
    const evictableStatuses = new Set([
      EntryStatus.COMPLETED,
      EntryStatus.FAILED,
      EntryStatus.AWAITING_USER,
    ]);

    const evictableIndices: number[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      if (evictableStatuses.has(this.entries[i].status)) {
        evictableIndices.push(i);
      }
    }

    const entriesToRemove = this.entries.length - this.maxEntries;
    if (entriesToRemove <= 0) return;

    const indicesToRemove = evictableIndices.slice(0, entriesToRemove);
    if (indicesToRemove.length === 0) return;

    // Remove in reverse order to preserve indices
    for (const idx of indicesToRemove.reverse()) {
      const entry = this.entries[idx];
      this.byId.delete(entry.entryId);

      const stepEntries = this.byStep.get(entry.stepNum);
      if (stepEntries) {
        const pos = stepEntries.indexOf(entry.entryId);
        if (pos !== -1) stepEntries.splice(pos, 1);
      }

      this.entries.splice(idx, 1);
    }
  }

  /**
   * Record completion of a dispatched work item.
   */
  recordCompletion(entryId: string, outcome: AgentResult): void {
    const entry = this.byId.get(entryId);
    if (!entry || entry.status !== EntryStatus.DISPATCHED) return;

    const toolErrors = Array.isArray(outcome.toolErrors) ? outcome.toolErrors : [];
    const summarySource = outcome.success
      ? outcome.response
      : outcome.error ?? outcome.terminationReason ?? outcome.response;
    const metrics = outcome.metrics ?? { toolCallsMade: 0, llmCallsMade: 0, durationMs: 0 };

    entry.completedAt = Date.now();
    entry.status = outcome.success ? EntryStatus.COMPLETED : EntryStatus.FAILED;
    entry.outcomeSummary = summarySource ? summarySource.slice(0, 200) : undefined;
    entry.observations = toolErrors.slice(0, 10);
    entry.entityRefs = Array.isArray((outcome as { entityRefs?: string[] }).entityRefs)
      ? [...(outcome as { entityRefs: string[] }).entityRefs]
      : [];
    entry.toolCallsMade = metrics.toolCallsMade ?? 0;
    entry.llmCallsMade = metrics.llmCallsMade ?? 0;
    entry.durationMs = metrics.durationMs ?? 0;
  }

  /**
   * Record that the step is awaiting user input.
   */
  recordAwaitingUser(entryId: string, prompt?: Record<string, unknown>): void {
    const entry = this.byId.get(entryId);
    if (!entry || entry.status !== EntryStatus.DISPATCHED) return;

    entry.completedAt = Date.now();
    entry.status = EntryStatus.AWAITING_USER;

    let summary = 'Awaiting user input';
    if (prompt?.question) {
      summary = `${summary}: ${String(prompt.question).slice(0, 200)}`;
    }
    entry.outcomeSummary = summary;
  }

  /**
   * Get all entries for a step in chronological order.
   */
  getStepHistory(stepNum: number): LedgerEntry[] {
    const entryIds = this.byStep.get(stepNum) ?? [];
    return entryIds.map((id) => this.byId.get(id)).filter((e): e is LedgerEntry => !!e);
  }

  /**
   * Get N most recent entries.
   */
  getRecentEntries(n = 10): LedgerEntry[] {
    return this.entries.slice(-n);
  }

  /**
   * Compact summary for context injection (~200 tokens max).
   */
  summarizeTail(n = 5): string {
    const entries = this.getRecentEntries(n);
    if (entries.length === 0) return 'RECENT WORK: None';

    const lines = ['RECENT WORK:'];
    for (const entry of entries) {
      const status = entry.status === EntryStatus.COMPLETED ? 'OK' : entry.status.toUpperCase();
      const summary = entry.workItemSummary.slice(0, 50);
      lines.push(`- Step ${entry.stepNum}: ${summary} [${status}]`);
    }

    return lines.join('\n');
  }

  get totalEntries(): number {
    return this.entries.length;
  }

  // ========== PATCH LIFECYCLE TRACKING ==========

  /**
   * Record a patch being proposed (phase 1 of lifecycle).
   */
  recordPatchProposed(params: {
    patchId: string;
    source: string;
    patchType: string;
    targetSteps: number[];
    justification: string;
  }): PatchRecord {
    const record: PatchRecord = {
      patchId: params.patchId,
      proposedAt: Date.now(),
      source: params.source,
      patchType: params.patchType,
      targetSteps: params.targetSteps,
      justification: params.justification,
      applied: false,
    };
    this.patches.push(record);
    this.patchesById.set(params.patchId, record);
    return record;
  }

  /**
   * Record the decision on a patch (phase 2 of lifecycle).
   */
  recordPatchDecision(patchId: string, approved: boolean, rejectionReason?: string): void {
    const record = this.patchesById.get(patchId);
    if (record) {
      record.decision = approved ? PatchDecision.APPROVED : PatchDecision.REJECTED;
      record.decisionAt = Date.now();
      record.rejectionReason = rejectionReason;
    }
  }

  /**
   * Record a patch being applied (phase 3 of lifecycle).
   */
  recordPatchApplied(patchId: string, resultingVersion: number): void {
    const record = this.patchesById.get(patchId);
    if (record) {
      record.applied = true;
      record.appliedAt = Date.now();
      record.resultingVersion = resultingVersion;
    }
  }

  /**
   * Get recent patch records for debugging.
   */
  getPatchHistory(limit = 20): PatchRecord[] {
    return this.patches.slice(-limit);
  }

  /**
   * Get recently rejected patches for thrash debugging.
   */
  getRejectedPatches(limit = 10): PatchRecord[] {
    return this.patches.filter((p) => p.decision === PatchDecision.REJECTED).slice(-limit);
  }

  /**
   * Summarize recent patch activity for debugging.
   */
  summarizePatchActivity(): string {
    if (this.patches.length === 0) return 'PATCH ACTIVITY: None';

    const recent = this.patches.slice(-10);
    const approved = recent.filter((p) => p.decision === PatchDecision.APPROVED).length;
    const rejected = recent.filter((p) => p.decision === PatchDecision.REJECTED).length;

    const lines = [
      `PATCH ACTIVITY (last ${recent.length}):`,
      `  Approved: ${approved}, Rejected: ${rejected}`,
    ];

    for (const p of recent.slice(-3)) {
      const status = p.decision ?? 'pending';
      lines.push(`  - ${p.patchType} on steps ${p.targetSteps.join(',')}: ${status}`);
    }

    return lines.join('\n');
  }
}
