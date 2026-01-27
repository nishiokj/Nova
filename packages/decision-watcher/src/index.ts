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

export {
  // Decision Types
  DecisionCategory,
  DecisionPriority,
  DecisionScope,
  Decision,
  Preference,
  DecisionEntry,
  isDecision,
  isPreference,

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

  // Integration Types
  WatcherIntegrationConfig,
  PromptUserHookEvent,
  PromptUserHookResult,
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
  // Engine
  DecisionEngine,

  // Factory
  createDecisionEngine,
} from './engine/index.js';

// ============================================
// WATCHER
// ============================================

export {
  // Watcher
  DecisionWatcher,
  DEFAULT_WATCHER_CONFIG,

  // Factory
  createDecisionWatcher,
} from './watcher/index.js';

// ============================================
// INTEGRATION
// ============================================

export {
  // Integration
  WatcherIntegration,
  createPromptUserHook,
  createOrchestratorHookHandler,
  createWatcherConfig,
  shouldEnableAsyncMode,

  // Default Decisions
  DEFAULT_DECISIONS,
  createSeededDatabase,
} from './integration/index.js';
