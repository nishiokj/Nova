/**
 * PR Review — Barrel Export
 */

export { parseDiff, parseHunkHeader } from './diff.js'
export { classifyChanges } from './classifier.js'
export { scoreRisks } from './scorer.js'
export { reviewDiff } from './review.js'
export type {
  FileChange,
  Hunk,
  ChangeKind,
  EntityChange,
  RiskSignal,
  PRReview,
} from './types.js'
