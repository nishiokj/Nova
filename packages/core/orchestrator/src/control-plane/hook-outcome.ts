import type { StatePatch } from './patches.js';
import { assertNever } from 'types';

export type HookOutcome<D> =
  | SuccessOutcome<D>
  | SkipOutcome
  | DenyOutcome
  | RetryOutcome
  | TimeoutOutcome
  | FailedOutcome;

export interface SuccessOutcome<D> {
  kind: 'success';
  decision: D;
  patches?: StatePatch[];
}

export interface SkipOutcome {
  kind: 'skip';
  reason: string;
}

export interface DenyOutcome {
  kind: 'deny';
  reason: string;
}

export interface RetryOutcome {
  kind: 'retry';
  error: string;
  backoffMs: number;
}

export interface TimeoutOutcome {
  kind: 'timeout';
}

export interface FailedOutcome {
  kind: 'failed';
  error: string;
}

export function isSuccess<D>(outcome: HookOutcome<D>): outcome is SuccessOutcome<D> {
  return outcome.kind === 'success';
}

export function isSkip<D>(outcome: HookOutcome<D>): outcome is SkipOutcome {
  return outcome.kind === 'skip';
}

export function isDeny<D>(outcome: HookOutcome<D>): outcome is DenyOutcome {
  return outcome.kind === 'deny';
}

export function isRetry<D>(outcome: HookOutcome<D>): outcome is RetryOutcome {
  return outcome.kind === 'retry';
}

export function isTimeout<D>(outcome: HookOutcome<D>): outcome is TimeoutOutcome {
  return outcome.kind === 'timeout';
}

export function isFailed<D>(outcome: HookOutcome<D>): outcome is FailedOutcome {
  return outcome.kind === 'failed';
}

export function shouldRetry<D>(outcome: HookOutcome<D>): outcome is RetryOutcome {
  return outcome.kind === 'retry';
}

export function isTerminalFailure<D>(outcome: HookOutcome<D>): outcome is DenyOutcome | FailedOutcome | TimeoutOutcome {
  return outcome.kind === 'deny' || outcome.kind === 'failed' || outcome.kind === 'timeout';
}

export function success<D>(decision: D, patches?: StatePatch[]): SuccessOutcome<D> {
  return { kind: 'success', decision, patches };
}

export function skip(reason: string): SkipOutcome {
  return { kind: 'skip', reason };
}

export function deny(reason: string): DenyOutcome {
  return { kind: 'deny', reason };
}

export function retry(error: string, backoffMs: number): RetryOutcome {
  return { kind: 'retry', error, backoffMs };
}

export function timeout(): TimeoutOutcome {
  return { kind: 'timeout' };
}

export function failed(error: string): FailedOutcome {
  return { kind: 'failed', error };
}

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

export const ALL_OUTCOME_KINDS = ['success', 'skip', 'deny', 'retry', 'timeout', 'failed'] as const;
export type OutcomeKind = typeof ALL_OUTCOME_KINDS[number];
