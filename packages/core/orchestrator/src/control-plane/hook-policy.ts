import { assertNever } from 'types';

export type HookPolicy =
  | FireAndForgetPolicy
  | RetryThenDegradePolicy
  | RetryThenAbortPolicy
  | FailClosedPolicy
  | EscalatePolicy;

export interface FireAndForgetPolicy {
  kind: 'fire_and_forget';
}

export interface RetryThenDegradePolicy {
  kind: 'retry_then_degrade';
  maxRetries: number;
  backoffMs: number;
  degradeTo: 'skip' | 'default';
}

export interface RetryThenAbortPolicy {
  kind: 'retry_then_abort';
  maxRetries: number;
  backoffMs: number;
}

export interface FailClosedPolicy {
  kind: 'fail_closed';
}

export interface EscalatePolicy {
  kind: 'escalate';
  to: 'user' | 'ops';
  fallback?: HookPolicy;
}

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

export const DEFAULT_POLICIES: Record<string, HookPolicy> = {
  quality_gate: failClosed(),
  bounds_exceeded: retryThenDegrade(2, 1000, 'default'),
  prompt_answer: escalate('user'),
  agent_error: retryThenAbort(1, 500),
  handoff_approval: failClosed(),
  work_item_completed: retryThenDegrade(1, 500, 'default'),
  telemetry: fireAndForget(),
  logging: fireAndForget(),
};

export function getDefaultPolicy(category: string): HookPolicy {
  return DEFAULT_POLICIES[category] ?? fireAndForget();
}

export function isCriticalPolicy(policy: HookPolicy): boolean {
  switch (policy.kind) {
    case 'fail_closed':
    case 'retry_then_abort':
      return true;
    case 'fire_and_forget':
    case 'retry_then_degrade':
      return false;
    case 'escalate':
      return policy.fallback ? isCriticalPolicy(policy.fallback) : true;
    default:
      return assertNever(policy);
  }
}

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
