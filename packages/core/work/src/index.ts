/**
 * Work Module - Barrel Export
 *
 * Shared utilities for work items, knowledge, and ledger.
 */

// Work Item
export type { WorkBounds, WorkItem, WorkItemCriteria } from './work-item.js';
export { DEFAULT_WORK_BOUNDS, createWorkItem, createWorkItemCriteria, cloneWorkItemWithDependencies } from './work-item.js';

// Knowledge
export { FactSource, type KnowledgeFact, createKnowledgeFact, KnowledgeStore } from './knowledge.js';
