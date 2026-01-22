/**
 * Entity Resolution Module
 *
 * Provides identity-to-person resolution through attribute matching.
 */

export { EntityResolutionEngine } from './engine.js'
export {
  type MatchScores,
  type MatchWeights,
  type MatchResult,
  type ResolutionConfig,
  type ResolutionEvent,
  type MergeDecision,
  type PendingReview,
  type DecisionType,
  MergeDecisionSchema,
  PendingReviewSchema,
  DecisionTypeSchema,
  MERGE_THRESHOLD,
  REVIEW_THRESHOLD,
  DEFAULT_WEIGHTS,
} from './types.js'
