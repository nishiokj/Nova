/**
 * Hook Policy - Discriminated Union
 *
 * Defines how failures are handled for each hook.
 * Each policy type has different failure handling semantics.
 */

import { assertNever } from '../assertNever.js';

// ============================================
// HOOK POLICY UNION
// ============================================

/**
 * A hook's failure handling policy.
 */
export type HookPolicy =
  | FireAndForgetPolicy
  | RetryThenDegradePolicy
  | RetryThenAbortPolicy
  | FailClosedPolicy
  | EscalatePolicy;

// ============================================
// POLICY DEFINITIONS
// ============================================

/**
 * Fire and forget - failures are logged but ignored.
 * Use for telemetry, logging, and non-critical hooks.
 */
export interface FireAndForgetPolicy {
  kind: 'fire_and_forget';
}

/**
 * Retry then degrade - retry on failure, then use fallback behavior.
 * Use for optional functionality that can gracefully degrade.
 */
export interface RetryThenDegradePolicy {
  kind: 'retry_then_degrade';
  maxRetries: number;
  backoffMs: number;
  /** What to do when all retries fail */
  degradeTo: 'skip' | 'default';
}

/**
 * Retry then abort - retry on failure, then abort the operation.
 * Use for required functionality that cannot degrade.
 */
export interface RetryThenAbortPolicy {
  kind: 'retry_then_abort';
  maxRetries: number;
  backoffMs: number;
}

/**
 * Fail closed - any failure aborts the operation immediately.
 * Use for security-critical hooks (quality gates, auth checks).
 */
export interface FailClosedPolicy {
  kind: 'fail_closed';
}

/**
 * Escalate - failures are escalated to a human or ops.
 * Use for ambiguous situations requiring human judgment.
 */
export interface EscalatePolicy {
  kind: 'escalate';
  to: 'user' | 'ops';
  /** Fallback policy if escalation is not possible */
  fallback?: HookPolicy;
}

// ============================================
// TYPE GUARDS
// ============================================

export function isFireAndForget(policy: HookPolicy): policy is FireAndForgetPolicy {
  return policy.kind === 'fire_and_forget';
}

export function isRetryThenDegrade(policy: HookPolicy): policy is RetryThenDegradePolicy {
  return policy.kind === 'retry_then_degrade';
}

export function isRetryThenAbort(policy: HookPolicy): policy is RetryThenAbortPolicy {
  return policy.kind === 'retry_then_abort';
}

export function isFailClosed(policy: HookPolicy): policy is FailClosedPolicy {
  return policy.kind === 'fail_closed';
}

export function isEscalate(policy: HookPolicy): policy is EscalatePolicy {
  return policy.kind === 'escalate';
}

// ============================================
// POLICY FACTORIES
// ============================================

export function fireAndForget(): FireAndForgetPolicy {
  return { kind: 'fire_and_forget' };
}

export function retryThenDegrade(
  maxRetries: number,
  backoffMs: number,
  degradeTo: 'skip' | 'default' = 'skip'
): RetryThenDegradePolicy {
  return { kind: 'retry_then_degrade', maxRetries, backoffMs, degradeTo };
}

export function retryThenAbort(maxRetries: number, backoffMs: number): RetryThenAbortPolicy {
  return { kind: 'retry_then_abort', maxRetries, backoffMs };
}

export function failClosed(): FailClosedPolicy {
  return { kind: 'fail_closed' };
}

export function escalate(to: 'user' | 'ops', fallback?: HookPolicy): EscalatePolicy {
  return { kind: 'escalate', to, fallback };
}

// ============================================
// DEFAULT POLICIES
// ============================================

/**
 * Default policies by hook category.
 */
export const DEFAULT_POLICIES: Record<string, HookPolicy> = {
  'quality_gate': failClosed(),
  'bounds_exceeded': retryThenDegrade(2, 1000, 'default'),
  'prompt_answer': escalate('user'),
  'cadence_audit': fireAndForget(),
  'agent_error': retryThenAbort(1, 500),
  'handoff_approval': failClosed(),
  'work_item_completed': retryThenDegrade(1, 500, 'default'),
  'telemetry': fireAndForget(),
  'logging': fireAndForget(),
};

/**
 * Get the default policy for a hook category.
 */
export function getDefaultPolicy(category: string): HookPolicy {
  return DEFAULT_POLICIES[category] ?? fireAndForget();
}

// ============================================
// POLICY ANALYSIS
// ============================================

/**
 * Is this a critical policy (failure aborts operation)?
 */
export function isCriticalPolicy(policy: HookPolicy): boolean {
  switch (policy.kind) {
    case 'fail_closed':
    case 'retry_then_abort':
      return true;
    case 'fire_and_forget':
    case 'retry_then_degrade':
      return false;
    case 'escalate':
      // Escalate is critical if fallback is critical
      return policy.fallback ? isCriticalPolicy(policy.fallback) : true;
    default:
      return assertNever(policy);
  }
}

/**
 * Get maximum retries for a policy.
 */
export function getMaxRetries(policy: HookPolicy): number {
  switch (policy.kind) {
    case 'retry_then_degrade':
    case 'retry_then_abort':
      return policy.maxRetries;
    case 'fail_closed':
    case 'fire_and_forget':
    case 'escalate':
      return 0;
    default:
      return assertNever(policy);
  }
}

/**
 * Get backoff time for a policy.
 */
export function getBackoffMs(policy: HookPolicy): number {
  switch (policy.kind) {
    case 'retry_then_degrade':
    case 'retry_then_abort':
      return policy.backoffMs;
    case 'fail_closed':
    case 'fire_and_forget':
    case 'escalate':
      return 0;
    default:
      return assertNever(policy);
  }
}
