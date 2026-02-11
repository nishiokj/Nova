/**
 * Entity Resolution Types
 *
 * Types and interfaces for the entity resolution system.
 * Entity resolution matches identities to persons across platforms.
 */

import { z } from 'zod'
import { UlidSchema } from '../ids.js'

// ============ Match Scoring ============

/**
 * Individual match scores for each matching criterion.
 * Each score is weighted and combined for a total match score.
 */
export interface MatchScores {
  /** Exact email match: 0 or 100 */
  emailExact: number
  /** Same email domain: 0-30 */
  emailDomain: number
  /** Exact phone match: 0 or 100 */
  phoneExact: number
  /** Username similarity: 0-50 */
  usernameMatch: number
  /** Exact display name match: 0-40 */
  nameExact: number
  /** Fuzzy name match (Levenshtein): 0-30 */
  nameFuzzy: number
  /** Shared organizations: 0-20 */
  orgOverlap: number
}

/**
 * Weights for combining match scores.
 * Higher weights give more importance to that criterion.
 */
export interface MatchWeights {
  emailExact: number
  emailDomain: number
  phoneExact: number
  usernameMatch: number
  nameExact: number
  nameFuzzy: number
  orgOverlap: number
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  emailExact: 1.0,
  emailDomain: 1.0,
  phoneExact: 1.0,
  usernameMatch: 1.0,
  nameExact: 1.0,
  nameFuzzy: 1.0,
  orgOverlap: 1.0,
}

// ============ Thresholds ============

/** Score threshold for automatic merge (no human review needed) */
export const MERGE_THRESHOLD = 80

/** Score threshold for queuing for human review */
export const REVIEW_THRESHOLD = 50

// ============ Match Result ============

export interface MatchResult {
  /** Person ID of the candidate */
  personId: string
  /** Individual match scores */
  scores: MatchScores
  /** Total weighted score (0-100) */
  totalScore: number
  /** Which fields contributed to the match */
  matchedOn: string[]
}

// ============ Decision Types ============

export const DecisionTypeSchema = z.enum([
  'auto_merge',      // System-initiated merge above MERGE_THRESHOLD
  'human_merge',     // Human-approved merge
  'human_reject',    // Human-rejected suggested match
  'split',           // Undo a previous merge
])

export type DecisionType = z.infer<typeof DecisionTypeSchema>

// ============ Merge Decision ============

export const MergeDecisionSchema = z.object({
  id: UlidSchema,
  /** The entity that was kept (survives) */
  primary_entity_id: UlidSchema,
  /** The entity that was merged into primary */
  merged_entity_id: UlidSchema,
  /** Entity type (always 'person' for now) */
  entity_type: z.string(),
  /** Type of decision */
  decision_type: DecisionTypeSchema,
  /** Confidence score (0-1) */
  confidence: z.number().min(0).max(1),
  /** Detailed reason including match scores */
  reason: z.object({
    scores: z.record(z.string(), z.number()),
    totalScore: z.number(),
    matchedOn: z.array(z.string()),
  }).optional(),
  /** When the decision was made */
  decided_at: z.string().datetime(),
  /** Who/what made the decision ('system' or user ID) */
  decided_by: z.string().optional(),
  /** Whether this decision has been reversed */
  is_reversed: z.boolean().default(false),
  /** When the decision was reversed */
  reversed_at: z.string().datetime().optional(),
  /** Who reversed the decision */
  reversed_by: z.string().optional(),
})

export type MergeDecision = z.infer<typeof MergeDecisionSchema>

// ============ Pending Review ============

export const PendingReviewSchema = z.object({
  id: UlidSchema,
  /** Identity waiting for resolution */
  identity_id: UlidSchema,
  /** Suggested person to merge with */
  suggested_person_id: UlidSchema,
  /** Match scores for human review */
  match_scores: z.object({
    emailExact: z.number(),
    emailDomain: z.number(),
    phoneExact: z.number(),
    usernameMatch: z.number(),
    nameExact: z.number(),
    nameFuzzy: z.number(),
    orgOverlap: z.number(),
    totalScore: z.number(),
    matchedOn: z.array(z.string()),
  }),
  /** When queued for review */
  created_at: z.string().datetime(),
  /** When reviewed (null if pending) */
  reviewed_at: z.string().datetime().optional(),
  /** Decision made: 'approve' or 'reject' */
  decision: z.enum(['approve', 'reject']).optional(),
})

export type PendingReview = z.infer<typeof PendingReviewSchema>

// ============ Resolution Events ============

export type ResolutionEvent =
  | { type: 'identity:resolved'; identityId: string; personId: string; isNew: boolean }
  | { type: 'identity:queued_review'; identityId: string; suggestedPersonId: string; score: number }
  | { type: 'merge:auto'; primaryId: string; mergedId: string; score: number }
  | { type: 'merge:human'; primaryId: string; mergedId: string }
  | { type: 'merge:rejected'; identityId: string; suggestedPersonId: string }
  | { type: 'error'; identityId: string; error: string }

// ============ Engine Configuration ============

export interface ResolutionConfig {
  /** Score threshold for automatic merge (default: 80) */
  mergeThreshold?: number
  /** Score threshold for human review queue (default: 50) */
  reviewThreshold?: number
  /** Custom weights for match scoring */
  weights?: Partial<MatchWeights>
  /** Maximum candidates to evaluate per identity (default: 100) */
  maxCandidates?: number
  /** Enable fuzzy name matching (default: true) */
  enableFuzzyMatch?: boolean
}
