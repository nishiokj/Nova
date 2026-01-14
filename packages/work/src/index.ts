/**
 * Work Module - Barrel Export
 *
 * Shared utilities for work items, knowledge, and ledger.
 */

// Work Item
export type { WorkBounds, WorkItem, WorkItemCriteria } from './work-item.js';
export { DEFAULT_WORK_BOUNDS, createWorkItem, createWorkItemCriteria } from './work-item.js';

// Knowledge
export { FactSource, type KnowledgeFact, createKnowledgeFact, KnowledgeStore } from './knowledge.js';

// Work Ledger
export {
  EntryStatus,
  PatchDecision,
  type PatchRecord,
  type LedgerEntry,
  WorkLedger,
} from './work-ledger.js';
