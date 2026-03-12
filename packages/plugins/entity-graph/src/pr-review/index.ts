/**
 * PR Review — Barrel Export
 */

export { parseDiff, parseHunkHeader } from './diff.js'
export { classifyChanges } from './classifier.js'
export { scoreRisks } from './scorer.js'
export { reviewDiff } from './review.js'
export {
  COMMENT_MARKER,
  DEFAULT_GRAPH_EXCLUDE,
  buildDiff,
  formatReviewMarkdown,
  parsePositiveInt,
  runReview,
  sanitizeCell,
  shortSha,
} from './service.js'
export type {
  FileChange,
  Hunk,
  ChangeKind,
  EntityChange,
  RiskSignal,
  PRReview,
} from './types.js'
