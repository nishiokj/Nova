/**
 * Hook Runner - Orchestrator Execution Semantics
 *
 * Executes hooks with ordering, timeout, retries, and policy enforcement.
 */

import { Effect, Fiber } from 'effect';
import {
  assertNever,
  getBackoffMs,
  getMaxRetries,
  isCriticalPolicy,
  isDeny,
  isFailed,
  isRetry,
  isSkip,
  isSuccess,
  isTimeout,
  timeout,
  type ControlEvent,
  type ControlEventType,
  type DecisionFor,
  type EventFor,
  type Hook,
  type HookCriticality,
  type HookContext,
  type HookOutcome,
  type HookPolicy,
  type StatePatch,
} from 'protocol';
import type { HookRegistry, RegisteredHook } from '../hookRegistry/index.js';

// ============================================
// RESULT TYPES
// ============================================

export type HookExecutionResult<D> =
  | {
      status: 'decision';
      decision: D;
      patches: StatePatch[];
      failures: Array<{
        hookId: string;
        outcome: HookOutcome<never>;
        policy: HookPolicy;
        criticality: HookCriticality;
        source: string;
      }>;
      hasCriticalFailure: boolean;
      audit: HookAuditEntry[];
    }
  | {
      status: Exclude<HookExecutionStatus, 'decision'>;
      decision: null;
      patches: StatePatch[];
      failures: Array<{
        hookId: string;
        outcome: HookOutcome<never>;
        policy: HookPolicy;
        criticality: HookCriticality;
        source: string;
      }>;
      hasCriticalFailure: boolean;
      audit: HookAuditEntry[];
    };

export type HookExecutionStatus =
  | 'no_registry'
  | 'no_hooks'
  | 'all_skipped'
  | 'no_decision'
  | 'decision';

export interface HookAuditEntry {
  hookId: string;
  source: string;
  priority: number;
  startedAt: number;
  completedAt: number;
  outcome: HookOutcome<unknown>;
  policyApplied?: string;
  retriesAttempted: number;
}

// ============================================
// EXECUTOR
// ============================================

export async function runHooksForEvent<E extends ControlEventType>(
  event: EventFor<E>,
  ctx: HookContext,
  registry: HookRegistry
): Promise<HookExecutionResult<DecisionFor<E>>> {
  const hooks = registry.getHooks<ControlEvent>(event.type) as unknown as Array<RegisteredHook<EventFor<E>, DecisionFor<E>>>;
  if (hooks.length === 0) {
    return {
      status: 'no_hooks',
      decision: null,
      patches: [],
      failures: [],
      hasCriticalFailure: false,
      audit: [],
    };
  }

  // Group by priority
  const byPriority = groupByPriority(hooks);
  const priorities = Array.from(byPriority.keys()).sort((a, b) => a - b);

  const audit: HookAuditEntry[] = [];
  const failures: HookExecutionResult<DecisionFor<E>>['failures'] = [];
  let decision: DecisionFor<E> | null = null;
  const patches: StatePatch[] = [];
  let hasCriticalFailure = false;
  let sawSkip = false;
  let sawNonSkip = false;

  for (const priority of priorities) {
    const group = byPriority.get(priority)!;
    const results = await executePriorityGroup(
      group as unknown as Array<RegisteredHook<ControlEvent, DecisionFor<E>>>,
      event,
      ctx
    );

    for (const result of results) {
      audit.push(result.audit);

      if (isSuccess(result.outcome)) {
        sawNonSkip = true;
        if (decision === null) {
          decision = result.outcome.decision as DecisionFor<E>;
        }
        if (result.outcome.patches) {
          patches.push(...result.outcome.patches);
        }
      } else if (isSkip(result.outcome)) {
        sawSkip = true;
      } else if (isFailed(result.outcome) || isTimeout(result.outcome) || isDeny(result.outcome) || isRetry(result.outcome)) {
        sawNonSkip = true;
        failures.push({
          hookId: result.hookId,
          outcome: result.outcome as HookOutcome<never>,
          policy: result.policy,
          criticality: result.criticality,
          source: result.source,
        });

        if (result.criticality === 'critical' || isCriticalPolicy(result.policy)) {
          hasCriticalFailure = true;
        }
      }
    }

    if (hasCriticalFailure) {
      break;
    }
  }

  if (decision !== null) {
    return {
      status: 'decision',
      decision,
      patches,
      failures,
      hasCriticalFailure,
      audit,
    };
  }

  const status: Exclude<HookExecutionStatus, 'decision'> =
    !sawNonSkip && sawSkip ? 'all_skipped' : 'no_decision';

  return {
    status,
    decision: null,
    patches,
    failures,
    hasCriticalFailure,
    audit,
  };
}

// ============================================
// HELPERS
// ============================================

const HOOK_TIMEOUT_SENTINEL = '__hook_timeout__';

function groupByPriority<Evt extends ControlEvent, D>(
  hooks: Array<RegisteredHook<Evt, D>>
): Map<number, Array<RegisteredHook<Evt, D>>> {
  const groups = new Map<number, Array<RegisteredHook<Evt, D>>>();
  for (const hook of hooks) {
    if (!groups.has(hook.priority)) {
      groups.set(hook.priority, []);
    }
    groups.get(hook.priority)!.push(hook);
  }
  return groups;
}

async function executePriorityGroup<D>(
  hooks: Array<RegisteredHook<ControlEvent, D>>,
  event: ControlEvent,
  ctx: HookContext
): Promise<Array<{
  hookId: string;
  source: string;
  criticality: 'critical' | 'non_critical';
  outcome: HookOutcome<D>;
  policy: HookPolicy;
  audit: HookAuditEntry;
}>> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fibers = yield* Effect.forEach(
          hooks,
          (hook) => Effect.forkScoped(executeHookWithPolicyEffect(hook, event, ctx)),
          { concurrency: 'unbounded' }
        );
        return yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber), {
          concurrency: 'unbounded',
        });
      })
    )
  );
}

function executeHookWithPolicyEffect<D>(
  hook: RegisteredHook<ControlEvent, D>,
  event: ControlEvent,
  ctx: HookContext
): Effect.Effect<{
  hookId: string;
  source: string;
  criticality: 'critical' | 'non_critical';
  outcome: HookOutcome<D>;
  policy: HookPolicy;
  audit: HookAuditEntry;
}, never> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    let retriesAttempted = 0;
    let outcome: HookOutcome<D> = {
      kind: 'failed',
      error: 'Hook execution did not start',
    };
    let policyApplied: string | undefined;

    const maxRetries = hook.idempotency === 'idempotent' ? getMaxRetries(hook.policy) : 0;
    const backoffMs = getBackoffMs(hook.policy);

    while (true) {
      outcome = yield* executeWithTimeoutEffect(hook, event, ctx);

      if (isSuccess(outcome) || outcome.kind === 'skip') {
        break;
      }

      if (retriesAttempted < maxRetries) {
        retriesAttempted++;
        policyApplied = `retry_${retriesAttempted}`;
        yield* Effect.sleep(backoffMs * retriesAttempted);
        continue;
      }

      policyApplied = applyFailurePolicy(hook.policy);
      break;
    }

    return {
      hookId: hook.id,
      source: hook.source,
      criticality: hook.criticality,
      outcome,
      policy: hook.policy,
      audit: {
        hookId: hook.id,
        source: hook.source,
        priority: hook.priority,
        startedAt,
        completedAt: Date.now(),
        outcome,
        policyApplied,
        retriesAttempted,
      },
    };
  });
}

function executeWithTimeoutEffect<Evt extends ControlEvent, D>(
  hook: Hook<Evt, D>,
  event: ControlEvent,
  ctx: HookContext
): Effect.Effect<HookOutcome<D>, never> {
  const runEffect: Effect.Effect<HookOutcome<D>, Error> = Effect.tryPromise({
    try: () => hook.run(event as Evt, ctx),
    catch: (error) =>
      error instanceof Error
        ? error
        : new Error(String(error)),
  });

  return runEffect.pipe(
    Effect.timeoutFail({
      duration: hook.timeoutMs,
      onTimeout: () => new Error(HOOK_TIMEOUT_SENTINEL),
    }),
    Effect.catchAll((error): Effect.Effect<HookOutcome<D>, never> => {
      if (error instanceof Error && error.message === HOOK_TIMEOUT_SENTINEL) {
        return Effect.succeed(timeout());
      }
      return Effect.succeed({
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    })
  );
}

function applyFailurePolicy(policy: HookPolicy): string {
  switch (policy.kind) {
    case 'fire_and_forget':
      return 'fire_and_forget_ignored';
    case 'retry_then_degrade':
      return `degraded_to_${policy.degradeTo}`;
    case 'retry_then_abort':
      return 'aborted';
    case 'fail_closed':
      return 'fail_closed';
    case 'escalate':
      return `escalated_to_${policy.to}`;
    default:
      return assertNever(policy);
  }
}
