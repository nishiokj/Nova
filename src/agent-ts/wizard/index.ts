/**
 * Wizard Module - Barrel Export
 *
 * Provides the Worker/Wizard orchestration pattern.
 *
 * NOTE: ContextWindow and related types have been moved to types/context.ts.
 */

// Context utilities (only buildSystemMessage remains)
export { buildSystemMessage } from './context.js';

// Work items
export type { WorkBounds, WorkItemCriteria, WorkItem } from './work-item.js';
export {
  DEFAULT_WORK_BOUNDS,
  createWorkItemCriteria,
  createWorkItem,
  workItemFromStepState,
} from './work-item.js';

// Knowledge store
export { FactSource, type KnowledgeFact, createKnowledgeFact, KnowledgeStore } from './knowledge.js';

// Plan state
export type { StepDependency, StepState } from './plan-state.js';
export { stepStateFromWizardStep, PlanState } from './plan-state.js';

// Work ledger
export {
  EntryStatus,
  PatchDecision,
  type PatchRecord,
  type LedgerEntry,
  WorkLedger,
} from './work-ledger.js';

// Worker
export {
  WorkerAction,
  type ToolExchange,
  type WorkerMetrics,
  createWorkerMetrics,
  type PatchSuggestion,
  type WorkerOutcome,
  createWorkerOutcome,
  outcomeMadeProgress,
  type WorkerConfig,
  DEFAULT_WORKER_CONFIG,
  type WorkerLogger,
  type EventEmitter,
  Worker,
} from './worker.js';

// Stagnation detection
export {
  type StagnationSignal,
  noStagnation,
  StagnationDetector,
} from './stagnation.js';

// Wizard orchestrator
export {
  type WizardConfig,
  DEFAULT_WIZARD_CONFIG,
  type WizardResult,
  type WizardLogger,
  Wizard,
} from './wizard.js';
