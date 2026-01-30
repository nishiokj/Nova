/**
 * Semantic Module
 *
 * Provides semantic memory layer for workItems:
 * - Schemas: Zod schemas with discriminated union for state tracking
 * - Preprocessor: Deterministic fact extraction from logs
 * - Writer: Non-blocking file writer with mutex and versioning
 */

// Schemas
export {
  // Component schemas
  ComponentStatusSchema,
  ChangeEntrySchema,
  GapEntrySchema,
  TradeoffOptionSchema,
  TradeoffAnalysisSchema,
  StateAndProgressSchema,
  DecisionContextSchema,
  CrossReferencesSchema,
  SemanticMetaSchema,

  // File state schemas (discriminated union)
  ValidSemanticFileSchema,
  FailedSemanticFileSchema,
  InitialSemanticFileSchema,
  SemanticFileStateSchema,

  // Auxiliary schemas
  SalienceUpdatesSchema,
  SemanticOutputSchema,

  // Types
  type ComponentStatus,
  type ChangeEntry,
  type GapEntry,
  type TradeoffOption,
  type TradeoffAnalysis,
  type StateAndProgress,
  type DecisionContext,
  type CrossReferences,
  type SemanticMeta,
  type ValidSemanticFile,
  type FailedSemanticFile,
  type InitialSemanticFile,
  type SemanticFileState,
  type SalienceUpdates,
  type SemanticOutput,

  // Type guards
  isValidSemantic,
  isFailedSemantic,
  isInitialSemantic,
} from './schemas.js';

// Preprocessor
export {
  extractPreProcessedContext,
  extractFromEntries,
  formatPreProcessedContext,
  type PreProcessedContext,
  type ToolCallSummary,
  type FailurePattern,
  type TimelineEvent,
} from './preprocessor.js';

// Writer
export {
  writeSemanticFileAsync,
  writeInitialSemanticFile,
  readSemanticFile,
  readValidSemanticFile,
  formatSemanticForInjection,
  type SemanticWriteConfig,
} from './writer.js';
