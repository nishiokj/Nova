/**
 * Semantic File Schemas
 *
 * Zod schemas for semantic workItem files. Uses discriminated union on `_state`
 * to represent valid, failed, and initial states with compile-time safety.
 *
 * Semantic files are the watcher's understanding of workItem state - produced
 * during cadence audits as a non-blocking side effect.
 */

import { z } from 'zod';

// ============================================
// COMPONENT SCHEMAS
// ============================================

/**
 * Status of a single component within a workItem.
 * Tracks what exists, what's done, what's blocked.
 */
export const ComponentStatusSchema = z.object({
  component: z.string().describe('Name of the component being tracked'),
  status: z.enum(['complete', 'partial', 'not_started', 'blocked']),
  location: z.string().optional().describe('File:line or description of where this lives'),
});

/**
 * A change made during the workItem.
 */
export const ChangeEntrySchema = z.object({
  file: z.string().describe('File path that was modified'),
  summary: z.string().describe('What changed'),
  rationale: z.string().describe('Why this change was made'),
});

/**
 * Gap between required state and current state.
 */
export const GapEntrySchema = z.object({
  required: z.string().describe('What is required (from objective)'),
  current: z.string().describe('Current state'),
  blocker: z.string().optional().describe('What is preventing progress'),
});

/**
 * A trade-off option.
 */
export const TradeoffOptionSchema = z.object({
  id: z.string().describe('Option identifier (A, B, etc.)'),
  description: z.string().describe('What this option entails'),
});

/**
 * Trade-off analysis for a decision point.
 */
export const TradeoffAnalysisSchema = z.object({
  title: z.string().describe('Title of the trade-off'),
  options: z.array(TradeoffOptionSchema).min(2),
  considerations: z.array(z.string()).describe('Factors to consider'),
  relevantPreferences: z.array(z.string()).describe('Preference keys that apply'),
  precedent: z.string().optional().describe('Precedent from sibling workItems'),
  assessment: z.string().optional().describe('Watcher assessment of best path'),
});

// ============================================
// STATE & PROGRESS SCHEMA
// ============================================

export const StateAndProgressSchema = z.object({
  objective: z.string().describe('Full objective text from init event'),
  currentState: z.array(ComponentStatusSchema).describe('Status of each component'),
  changesMade: z.array(ChangeEntrySchema).describe('Files modified and why'),
  gapAnalysis: z.array(GapEntrySchema).describe('What is required vs what exists'),
  reasoningTrace: z.array(z.string()).describe('Numbered steps of agent decision-making'),
  blockers: z.array(z.string()).describe('What is preventing progress'),
});

// ============================================
// DECISION CONTEXT SCHEMA
// ============================================

export const DecisionContextSchema = z.object({
  pendingQuestions: z.array(z.string()).describe('Questions awaiting response'),
  tradeoffs: z.array(TradeoffAnalysisSchema).describe('Pre-articulated trade-offs'),
});

// ============================================
// CROSS-REFERENCES SCHEMA
// ============================================

export const CrossReferencesSchema = z.object({
  sessionSalience: z.string().optional().describe('Section anchor in salience.md'),
  preferences: z.array(z.string()).describe('Relevant preference keys'),
  siblingWorkItems: z.array(z.string()).describe('Related workItem IDs'),
  decisions: z.array(z.string()).describe('Related decision keys'),
});

// ============================================
// SEMANTIC META SCHEMA
// ============================================

export const SemanticMetaSchema = z.object({
  workId: z.string(),
  created: z.string().describe('ISO timestamp of workItem creation'),
  lastAudit: z.string().describe('ISO timestamp of last audit'),
  auditSequence: z.number().int().min(0).describe('Monotonic audit counter'),
  logPosition: z.number().int().min(0).describe('Events processed from log'),
  totalEvents: z.number().int().min(0).describe('Total events in log at audit time'),
});

// ============================================
// VALID SEMANTIC FILE SCHEMA
// ============================================

export const ValidSemanticFileSchema = z.object({
  _state: z.literal('valid'),
  meta: SemanticMetaSchema,
  stateAndProgress: StateAndProgressSchema,
  decisionContext: DecisionContextSchema,
  crossReferences: CrossReferencesSchema,
});

// ============================================
// FAILED SEMANTIC FILE SCHEMA
// ============================================

export const FailedSemanticFileSchema = z.object({
  _state: z.literal('failed'),
  meta: z.object({
    workId: z.string(),
    auditSequence: z.number().int().min(0),
    timestamp: z.string(),
  }),
  error: z.string().describe('Error message explaining what went wrong'),
  previousValidVersion: z.number().int().min(0).optional().describe('Last valid auditSequence'),
});

// ============================================
// INITIAL SEMANTIC FILE SCHEMA
// ============================================

export const InitialSemanticFileSchema = z.object({
  _state: z.literal('initial'),
  meta: z.object({
    workId: z.string(),
    created: z.string(),
    objective: z.string(),
  }),
});

// ============================================
// DISCRIMINATED UNION
// ============================================

/**
 * Semantic file state - discriminated union on `_state`.
 *
 * - `valid`: Complete semantic content from a successful audit
 * - `failed`: Audit failed, contains error info
 * - `initial`: Newly created workItem, not yet audited
 */
export const SemanticFileStateSchema = z.discriminatedUnion('_state', [
  ValidSemanticFileSchema,
  FailedSemanticFileSchema,
  InitialSemanticFileSchema,
]);

// ============================================
// INFERRED TYPES
// ============================================

export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;
export type GapEntry = z.infer<typeof GapEntrySchema>;
export type TradeoffOption = z.infer<typeof TradeoffOptionSchema>;
export type TradeoffAnalysis = z.infer<typeof TradeoffAnalysisSchema>;
export type StateAndProgress = z.infer<typeof StateAndProgressSchema>;
export type DecisionContext = z.infer<typeof DecisionContextSchema>;
export type CrossReferences = z.infer<typeof CrossReferencesSchema>;
export type SemanticMeta = z.infer<typeof SemanticMetaSchema>;
export type ValidSemanticFile = z.infer<typeof ValidSemanticFileSchema>;
export type FailedSemanticFile = z.infer<typeof FailedSemanticFileSchema>;
export type InitialSemanticFile = z.infer<typeof InitialSemanticFileSchema>;
export type SemanticFileState = z.infer<typeof SemanticFileStateSchema>;

// ============================================
// TYPE GUARDS
// ============================================

export function isValidSemantic(state: SemanticFileState): state is ValidSemanticFile {
  return state._state === 'valid';
}

export function isFailedSemantic(state: SemanticFileState): state is FailedSemanticFile {
  return state._state === 'failed';
}

export function isInitialSemantic(state: SemanticFileState): state is InitialSemanticFile {
  return state._state === 'initial';
}

// ============================================
// SALIENCE UPDATES SCHEMA
// ============================================

/**
 * Updates to salience.md extracted during semantic generation.
 */
export const SalienceUpdatesSchema = z.object({
  workItemStatus: z.string().describe('Status update for workItem table'),
  patterns: z.array(z.string()).optional().describe('New cross-cutting patterns'),
  abstractionsInPlay: z.array(z.string()).optional().describe('Key abstractions discovered'),
});

export type SalienceUpdates = z.infer<typeof SalienceUpdatesSchema>;

// ============================================
// SEMANTIC OUTPUT (from watcher LLM)
// ============================================

/**
 * Output schema for semantic generation - what the watcher LLM produces
 * alongside its decision during cadence audits.
 */
export const SemanticOutputSchema = z.object({
  meta: z.object({
    auditSequence: z.number().int().min(0),
    logPosition: z.number().int().min(0),
    totalEvents: z.number().int().min(0),
  }),
  stateAndProgress: StateAndProgressSchema,
  decisionContext: DecisionContextSchema,
  crossReferences: CrossReferencesSchema,
  salienceUpdates: SalienceUpdatesSchema.optional(),
});

export type SemanticOutput = z.infer<typeof SemanticOutputSchema>;
