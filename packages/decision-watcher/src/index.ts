/**
 * Decision Watcher
 *
 * Async decision watcher for agent orchestration.
 *
 * The watcher intercepts PromptUser events and auto-answers questions
 * using a curated database of decisions and preferences. This enables
 * fully async agent execution by surfacing uncertainty, reducing hand-waving,
 * and maintaining consistency across the project.
 *
 * @module decision-watcher
 */

// ============================================
// CORE TYPES
// ============================================

export type {
  // Decision Types
  DecisionCategory,
  DecisionPriority,
  DecisionScope,
  Decision,
  Preference,
  DecisionEntry,

  // Watcher Response Types
  WatcherAnswerSource,
  ConfidenceLevel,
  WatcherResponse,
  PromptUserAnswer,

  // State & Memory
  DecisionMemory,
  WatcherContext,

  // Configuration
  DecisionWatcherConfig,
  DecisionDatabase,

  // Watcher Action Types (LLM-backed watcher)
  WatcherTrigger,
  WatcherActionType,
  WatcherAction,
  DecisionLogEntry,

  // Work Log Types
  WorkLogEntryType,
  WorkLogEntry,

  // Watcher Work Item (with bounds)
  WatcherWorkItem,
} from './types.js';

export {
  isDecision,
  isPreference,
} from './types.js';

// ============================================
// DATABASE LAYER
// ============================================

export {
  // Database Implementations
  InMemoryDecisionDatabase,
  FileDecisionDatabase,

  // Factory Functions
  createInMemoryDatabase,
  createFileDatabase,
} from './db/index.js';

// ============================================
// DECISION ENGINE
// ============================================

export {
  DecisionEngine,
  createDecisionEngine,
} from './engine/index.js';

// ============================================
// INTEGRATION
// ============================================

export {
  createWatcherConfig,
  shouldEnableAsyncMode,
  DEFAULT_DECISIONS,
  createSeededDatabase,
} from './integration/index.js';

// ============================================
// SALIENCE & DECISION LOG
// ============================================

export {
  salienceDir,
  salienceFilePath,
  createSalienceContent,
  writeSalienceFile,
} from './salience.js';
export type { SalienceParams } from './salience.js';

export {
  createDecisionLog,
} from './decision-log.js';
export type { DecisionLog } from './decision-log.js';

export {
  createWorkLog,
} from './work-log.js';
export type { WorkLog } from './work-log.js';

// ============================================
// WATCHER AGENT (LLM-backed StopHook)
// ============================================

export {
  createWatcherStopHook,
} from './watcher-agent.js';
export type { WatcherAgentConfig } from './watcher-agent.js';

// ============================================
// SESSION INIT (Async session bootstrap)
// ============================================

export {
  initAsyncSession,
  buildPlanningObjective,
} from './session-init.js';
export type { AsyncSessionConfig, AsyncSessionResult } from './session-init.js';
