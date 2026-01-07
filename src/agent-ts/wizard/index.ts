/**
 * Wizard Module - Barrel Export
 *
 * Shared utilities for work items, context, knowledge, and ledger.
 */

// Context utilities (NOTE: ContextWindow class is in types/context.ts)
export { buildSystemMessage } from './context.js';

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
