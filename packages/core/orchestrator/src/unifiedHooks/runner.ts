import {
  failed,
  getBackoffMs,
  getMaxRetries,
  isCriticalPolicy,
  isDeny,
  isFailed,
  isSkip,
  isSuccess,
  isTimeout,
  timeout,
  type DecisionFor,
  type EventFor,
  type HookContext,
  type HookOutcome,
  type HookPolicy,
  type StatePatch,
} from '../control-plane/index.js';
import { Effect } from 'effect';
import { isBlockableEffectEvent, type DecisionEventType, type EffectEventType } from './catalog.js';
import type {
  EffectOutcomeFor,
  RegisteredUnifiedHook,
  UnifiedDecisionHookRegistration,
  UnifiedEffectContext,
  UnifiedEffectHookRegistration,
} from './contracts.js';
import type { SessionScopedUnifiedHookRegistry, UnifiedHookRegistry } from './registry.js';

const HOOK_TIMEOUT_SENTINEL = '__unified_hook_timeout__';

export interface UnifiedHookFailure {
  hookId: string;
  source: string;
  error: string;
  policy: HookPolicy;
}

export interface UnifiedDecisionAuditEntry {
  hookId: string;
  source: string;
  priority: number;
  retriesAttempted: number;
  startedAt: number;
  completedAt: number;
  outcome: HookOutcome<unknown>;
}

export type UnifiedDecisionExecutionResult<D> =
  | {
      status: 'no_hooks' | 'no_decision';
      decision: null;
      patches: StatePatch[];
      failures: UnifiedHookFailure[];
      hasCriticalFailure: boolean;
      audit: UnifiedDecisionAuditEntry[];
    }
  | {
      status: 'decision';
      decision: D;
      patches: StatePatch[];
      failures: UnifiedHookFailure[];
      hasCriticalFailure: boolean;
      audit: UnifiedDecisionAuditEntry[];
    };

export interface UnifiedEffectAuditEntry {
  hookId: string;
  source: string;
  priority: number;
  retriesAttempted: number;
  startedAt: number;
  completedAt: number;
  status: 'ok' | 'failed';
  outcomeKind?: string;
  error?: string;
}

export interface UnifiedEffectExecutionResult<E extends EffectEventType> {
  status: 'completed' | 'blocked';
  outcomes: {
    hookId: string;
    source: string;
    outcome: EffectOutcomeFor<E>;
  }[];
  blockedBy?: {
    hookId: string;
    source: string;
    reason: string;
  };
  failures: UnifiedHookFailure[];
  audit: UnifiedEffectAuditEntry[];
}

export function runUnifiedDecisionHooks<E extends DecisionEventType>(
  event: EventFor<E>,
  context: HookContext,
  registry: UnifiedHookRegistry
): Effect.Effect<UnifiedDecisionExecutionResult<DecisionFor<E>>> {
  const hooks = registry.getDecisionHooks(event.type);
  if (hooks.length === 0) {
    return Effect.succeed({
      status: 'no_hooks',
      decision: null,
      patches: [],
      failures: [],
      hasCriticalFailure: false,
      audit: [],
    });
  }

  const groups = groupByPriority(hooks);
  const priorities = Array.from(groups.keys()).sort((a, b) => a - b);

  return Effect.gen(function* () {
    let decision: DecisionFor<E> | null = null;
    const patches: StatePatch[] = [];
    const failures: UnifiedHookFailure[] = [];
    const audit: UnifiedDecisionAuditEntry[] = [];
    let hasCriticalFailure = false;

    for (const priority of priorities) {
      const group = groups.get(priority)!;
      const results = yield* Effect.forEach(
        group,
        (hook) => executeDecisionHookWithPolicy(hook, event, context),
        { concurrency: 'unbounded' }
      );

      for (const result of results) {
        audit.push(result.audit);

        if (isSuccess(result.outcome)) {
          if (decision === null) {
            decision = result.outcome.decision;
          }
          if (result.outcome.patches) {
            patches.push(...result.outcome.patches);
          }
          continue;
        }

        if (isSkip(result.outcome)) {
          continue;
        }

        if (isDeny(result.outcome) || isFailed(result.outcome) || isTimeout(result.outcome)) {
          const error = isDeny(result.outcome)
            ? result.outcome.reason
            : isFailed(result.outcome)
              ? result.outcome.error
              : 'timeout';

          failures.push({
            hookId: result.hook.id,
            source: result.hook.source,
            error,
            policy: result.hook.policy,
          });

          if (result.hook.criticality === 'critical' || isCriticalPolicy(result.hook.policy)) {
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
        status: 'decision' as const,
        decision,
        patches,
        failures,
        hasCriticalFailure,
        audit,
      };
    }

    return {
      status: 'no_decision' as const,
      decision: null,
      patches,
      failures,
      hasCriticalFailure,
      audit,
    };
  });
}

export function runUnifiedDecisionHooksForSession<E extends DecisionEventType>(
  sessionKey: string,
  event: EventFor<E>,
  context: HookContext,
  sessionRegistry: SessionScopedUnifiedHookRegistry
): Effect.Effect<UnifiedDecisionExecutionResult<DecisionFor<E>>> {
  const registry = sessionRegistry.getSessionRegistry(sessionKey);
  if (!registry) {
    return Effect.succeed({
      status: 'no_hooks',
      decision: null,
      patches: [],
      failures: [],
      hasCriticalFailure: false,
      audit: [],
    });
  }

  return runUnifiedDecisionHooks(event, context, registry);
}

export function runUnifiedEffectHooks<E extends EffectEventType>(
  event: { type: E } & Record<string, unknown>,
  context: UnifiedEffectContext,
  registry: UnifiedHookRegistry
): Effect.Effect<UnifiedEffectExecutionResult<E>> {
  const hooks = registry.getEffectHooks(event.type);
  if (hooks.length === 0) {
    return Effect.succeed({
      status: 'completed',
      outcomes: [],
      failures: [],
      audit: [],
    });
  }

  const groups = groupByPriority(hooks);
  const priorities = Array.from(groups.keys()).sort((a, b) => a - b);

  return Effect.gen(function* () {
    const outcomes: UnifiedEffectExecutionResult<E>['outcomes'] = [];
    const failures: UnifiedHookFailure[] = [];
    const audit: UnifiedEffectAuditEntry[] = [];
    let blockedBy: UnifiedEffectExecutionResult<E>['blockedBy'];

    for (const priority of priorities) {
      const group = groups.get(priority)!;
      const results = yield* Effect.forEach(
        group,
        (hook) => executeEffectHookWithPolicy(hook, event, context),
        { concurrency: 'unbounded' }
      );

      for (const result of results) {
        audit.push(result.audit);

        if (result.error) {
          failures.push({
            hookId: result.hook.id,
            source: result.hook.source,
            error: result.error,
            policy: result.policy,
          });

          if (!blockedBy && isCriticalPolicy(result.policy)) {
            blockedBy = {
              hookId: result.hook.id,
              source: result.hook.source,
              reason: result.error,
            };
          }
          continue;
        }

        outcomes.push({
          hookId: result.hook.id,
          source: result.hook.source,
          outcome: result.outcome,
        });

        if (
          !blockedBy
          && isBlockableEffectEvent(event.type)
          && result.outcome.kind === 'block'
        ) {
          blockedBy = {
            hookId: result.hook.id,
            source: result.hook.source,
            reason: result.outcome.reason,
          };
        }
      }

      if (blockedBy) {
        break;
      }
    }

    return {
      status: blockedBy ? 'blocked' : 'completed',
      outcomes,
      blockedBy,
      failures,
      audit,
    };
  });
}

export function runUnifiedEffectHooksForSession<E extends EffectEventType>(
  sessionKey: string,
  event: { type: E } & Record<string, unknown>,
  context: UnifiedEffectContext,
  sessionRegistry: SessionScopedUnifiedHookRegistry
): Effect.Effect<UnifiedEffectExecutionResult<E>> {
  const registry = sessionRegistry.getSessionRegistry(sessionKey);
  if (!registry) {
    return Effect.succeed({
      status: 'completed',
      outcomes: [],
      failures: [],
      audit: [],
    });
  }

  return runUnifiedEffectHooks(event, context, registry);
}

function executeDecisionHookWithPolicy<E extends DecisionEventType>(
  hook: RegisteredUnifiedHook<UnifiedDecisionHookRegistration<E>>,
  event: EventFor<E>,
  context: HookContext
): Effect.Effect<{
  hook: RegisteredUnifiedHook<UnifiedDecisionHookRegistration<E>>;
  outcome: HookOutcome<DecisionFor<E>>;
  audit: UnifiedDecisionAuditEntry;
}> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const maxRetries = hook.idempotency === 'idempotent' ? getMaxRetries(hook.policy) : 0;
    const policyBackoffMs = getBackoffMs(hook.policy);

    let retriesAttempted = 0;
    let outcome: HookOutcome<DecisionFor<E>> = failed('unknown error');

    while (true) {
      outcome = yield* executeDecisionHookAttemptEffect(hook, event, context);

      if (isSuccess(outcome) || isSkip(outcome)) {
        break;
      }

      if (retriesAttempted < maxRetries) {
        retriesAttempted += 1;
        const backoff =
          'backoffMs' in outcome
            ? outcome.backoffMs
            : policyBackoffMs * retriesAttempted;
        yield* Effect.sleep(backoff);
        continue;
      }

      break;
    }

    return {
      hook,
      outcome,
      audit: {
        hookId: hook.id,
        source: hook.source,
        priority: hook.priority,
        retriesAttempted,
        startedAt,
        completedAt: Date.now(),
        outcome,
      },
    };
  });
}

function executeEffectHookWithPolicy<E extends EffectEventType>(
  hook: RegisteredUnifiedHook<UnifiedEffectHookRegistration<E>>,
  event: { type: E } & Record<string, unknown>,
  context: UnifiedEffectContext
): Effect.Effect<{
  hook: RegisteredUnifiedHook<UnifiedEffectHookRegistration<E>>;
  outcome: EffectOutcomeFor<E>;
  policy: HookPolicy;
  error?: string;
  audit: UnifiedEffectAuditEntry;
}> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const policy = hook.policy ?? { kind: 'fire_and_forget' };
    const maxRetries = getMaxRetries(policy);
    const backoffMs = getBackoffMs(policy);

    let retriesAttempted = 0;

    while (true) {
      const attempt = yield* executeEffectHookAttemptEffect(hook, event, context);
      if (!attempt.error) {
        const outcome = attempt.outcome;

        return {
          hook,
          outcome,
          policy,
          audit: {
            hookId: hook.id,
            source: hook.source,
            priority: hook.priority,
            retriesAttempted,
            startedAt,
            completedAt: Date.now(),
            status: 'ok',
            outcomeKind: outcome.kind,
          },
        };
      }

      const message = attempt.error;
      if (retriesAttempted < maxRetries) {
        retriesAttempted += 1;
        yield* Effect.sleep(backoffMs * retriesAttempted);
        continue;
      }

      return {
        hook,
        outcome: { kind: 'skip', reason: message } as EffectOutcomeFor<E>,
        policy,
        error: message,
        audit: {
          hookId: hook.id,
          source: hook.source,
          priority: hook.priority,
          retriesAttempted,
          startedAt,
          completedAt: Date.now(),
          status: 'failed',
          error: message,
        },
      };
    }
  });
}

function groupByPriority<T extends { priority: number }>(items: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const item of items) {
    if (!grouped.has(item.priority)) {
      grouped.set(item.priority, []);
    }
    grouped.get(item.priority)!.push(item);
  }
  return grouped;
}

function executeDecisionHookAttemptEffect<E extends DecisionEventType>(
  hook: RegisteredUnifiedHook<UnifiedDecisionHookRegistration<E>>,
  event: EventFor<E>,
  context: HookContext
): Effect.Effect<HookOutcome<DecisionFor<E>>> {
  const runEffect: Effect.Effect<HookOutcome<DecisionFor<E>>, Error> = Effect.suspend(() =>
    hook.callback(event, context).pipe(Effect.mapError(toError))
  ).pipe(
    Effect.catchAllDefect((defect) => Effect.fail(toError(defect)))
  );

  return runEffect.pipe(
    Effect.timeoutFail({
      duration: hook.timeoutMs,
      onTimeout: () => new Error(HOOK_TIMEOUT_SENTINEL),
    }),
    Effect.catchAll((error): Effect.Effect<HookOutcome<DecisionFor<E>>> => {
      if (error.message === HOOK_TIMEOUT_SENTINEL) {
        return Effect.succeed(timeout() as HookOutcome<DecisionFor<E>>);
      }
      return Effect.succeed(failed(error.message));
    })
  );
}

function executeEffectHookAttemptEffect<E extends EffectEventType>(
  hook: RegisteredUnifiedHook<UnifiedEffectHookRegistration<E>>,
  event: { type: E } & Record<string, unknown>,
  context: UnifiedEffectContext
): Effect.Effect<{ outcome: EffectOutcomeFor<E>; error?: string }> {
  const runEffect: Effect.Effect<EffectOutcomeFor<E>, Error> = Effect.suspend(() =>
    hook.callback(event as never, context).pipe(Effect.mapError(toError))
  ).pipe(
    Effect.catchAllDefect((defect) => Effect.fail(toError(defect)))
  );

  return runEffect.pipe(
    Effect.timeoutFail({
      duration: hook.timeoutMs,
      onTimeout: () => new Error(HOOK_TIMEOUT_SENTINEL),
    }),
    Effect.map((outcome) => ({ outcome })),
    Effect.catchAll((error): Effect.Effect<{ outcome: EffectOutcomeFor<E>; error?: string }> => {
      if (error.message === HOOK_TIMEOUT_SENTINEL) {
        return Effect.succeed({ outcome: { kind: 'skip', reason: 'timeout' } as EffectOutcomeFor<E> });
      }
      return Effect.succeed({
        outcome: { kind: 'skip', reason: error.message } as EffectOutcomeFor<E>,
        error: error.message,
      });
    })
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
