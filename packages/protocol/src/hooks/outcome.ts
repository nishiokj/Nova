/**
 * Hook Outcome - Discriminated Union
 *
 * The result of executing a hook.
 * Discriminates how the hook execution went (success/failure modes).
 */

import type { StatePatch } from '../effects/patches.js';
import { assertNever } from '../assertNever.js';

// ============================================
// HOOK OUTCOME UNION
// ============================================

/**
 * The result of executing a hook.
 *
 * @typeParam D - The domain-specific decision type (must be a discriminated union)
 */
export type HookOutcome<D> =
  | SuccessOutcome<D>
  | SkipOutcome
  | DenyOutcome
  | RetryOutcome
  | TimeoutOutcome
  | FailedOutcome;

// ============================================
// OUTCOME DEFINITIONS
// ============================================

/**
 * Hook executed successfully and produced a decision.
 */
export interface SuccessOutcome<D> {
  kind: 'success';
  decision: D;
  patches?: StatePatch[];
}

/**
 * Hook was skipped (not applicable).
 */
export interface SkipOutcome {
  kind: 'skip';
  reason: string;
}

/**
 * Hook denied the operation.
 */
export interface DenyOutcome {
  kind: 'deny';
  reason: string;
}

/**
 * Hook requests retry after backoff.
 */
export interface RetryOutcome {
  kind: 'retry';
  error: string;
  backoffMs: number;
}

/**
 * Hook timed out.
 */
export interface TimeoutOutcome {
  kind: 'timeout';
}

/**
 * Hook failed with an error.
 */
export interface FailedOutcome {
  kind: 'failed';
  error: string;
}

// ============================================
// TYPE GUARDS
// ============================================

/**
 * Type guard for successful outcomes.
 */
export function isSuccess<D>(outcome: HookOutcome<D>): outcome is SuccessOutcome<D> {
  return outcome.kind === 'success';
}

/**
 * Type guard for skip outcomes.
 */
export function isSkip<D>(outcome: HookOutcome<D>): outcome is SkipOutcome {
  return outcome.kind === 'skip';
}

/**
 * Type guard for deny outcomes.
 */
export function isDeny<D>(outcome: HookOutcome<D>): outcome is DenyOutcome {
  return outcome.kind === 'deny';
}

/**
 * Type guard for retry outcomes.
 */
export function isRetry<D>(outcome: HookOutcome<D>): outcome is RetryOutcome {
  return outcome.kind === 'retry';
}

/**
 * Type guard for timeout outcomes.
 */
export function isTimeout<D>(outcome: HookOutcome<D>): outcome is TimeoutOutcome {
  return outcome.kind === 'timeout';
}

/**
 * Type guard for failed outcomes.
 */
export function isFailed<D>(outcome: HookOutcome<D>): outcome is FailedOutcome {
  return outcome.kind === 'failed';
}

/**
 * Type guard for outcomes that should trigger retry.
 */
export function shouldRetry<D>(outcome: HookOutcome<D>): outcome is RetryOutcome {
  return outcome.kind === 'retry';
}

/**
 * Type guard for terminal failure outcomes (no retry).
 */
export function isTerminalFailure<D>(outcome: HookOutcome<D>): outcome is DenyOutcome | FailedOutcome | TimeoutOutcome {
  return outcome.kind === 'deny' || outcome.kind === 'failed' || outcome.kind === 'timeout';
}

// ============================================
// OUTCOME FACTORIES
// ============================================

/**
 * Create a success outcome.
 */
export function success<D>(decision: D, patches?: StatePatch[]): SuccessOutcome<D> {
  return { kind: 'success', decision, patches };
}

/**
 * Create a skip outcome.
 */
export function skip(reason: string): SkipOutcome {
  return { kind: 'skip', reason };
}

/**
 * Create a deny outcome.
 */
export function deny(reason: string): DenyOutcome {
  return { kind: 'deny', reason };
}

/**
 * Create a retry outcome.
 */
export function retry(error: string, backoffMs: number): RetryOutcome {
  return { kind: 'retry', error, backoffMs };
}

/**
 * Create a timeout outcome.
 */
export function timeout(): TimeoutOutcome {
  return { kind: 'timeout' };
}

/**
 * Create a failed outcome.
 */
export function failed(error: string): FailedOutcome {
  return { kind: 'failed', error };
}

// ============================================
// OUTCOME UTILITIES
// ============================================

/**
 * Get a human-readable summary of an outcome.
 */
export function summarizeOutcome<D>(outcome: HookOutcome<D>): string {
  switch (outcome.kind) {
    case 'success':
      return `Success with ${outcome.patches?.length ?? 0} patches`;
    case 'skip':
      return `Skipped: ${outcome.reason}`;
    case 'deny':
      return `Denied: ${outcome.reason}`;
    case 'retry':
      return `Retry after ${outcome.backoffMs}ms: ${outcome.error}`;
    case 'timeout':
      return 'Timeout';
    case 'failed':
      return `Failed: ${outcome.error}`;
    default:
      return assertNever(outcome);
  }
}

/**
 * All outcome kinds as an array.
 */
export const ALL_OUTCOME_KINDS = ['success', 'skip', 'deny', 'retry', 'timeout', 'failed'] as const;
export type OutcomeKind = typeof ALL_OUTCOME_KINDS[number];
