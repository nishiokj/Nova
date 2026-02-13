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
} from 'protocol';
import { isBlockableEffectEvent, type DecisionEventType, type EffectEventType } from './catalog.js';
import type {
  EffectOutcomeFor,
  RegisteredUnifiedHook,
  UnifiedDecisionHookRegistration,
  UnifiedEffectContext,
  UnifiedEffectHookRegistration,
} from './contracts.js';
import type { SessionScopedUnifiedHookRegistry, UnifiedHookRegistry } from './registry.js';

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
  outcomes: Array<{
    hookId: string;
    source: string;
    outcome: EffectOutcomeFor<E>;
  }>;
  blockedBy?: {
    hookId: string;
    source: string;
    reason: string;
  };
  failures: UnifiedHookFailure[];
  audit: UnifiedEffectAuditEntry[];
}

export async function runUnifiedDecisionHooks<E extends DecisionEventType>(
  event: EventFor<E>,
  context: HookContext,
  registry: UnifiedHookRegistry
): Promise<UnifiedDecisionExecutionResult<DecisionFor<E>>> {
  const hooks = registry.getDecisionHooks(event.type as E);
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

  const groups = groupByPriority(hooks);
  const priorities = Array.from(groups.keys()).sort((a, b) => a - b);

  let decision: DecisionFor<E> | null = null;
  const patches: StatePatch[] = [];
  const failures: UnifiedHookFailure[] = [];
  const audit: UnifiedDecisionAuditEntry[] = [];
  let hasCriticalFailure = false;

  for (const priority of priorities) {
    const group = groups.get(priority)!;
    const results = await Promise.all(
      group.map((hook) => executeDecisionHookWithPolicy(hook, event, context))
    );

    for (const result of results) {
      audit.push(result.audit);

      if (isSuccess(result.outcome)) {
        if (decision === null) {
          decision = result.outcome.decision as DecisionFor<E>;
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
      status: 'decision',
      decision,
      patches,
      failures,
      hasCriticalFailure,
      audit,
    };
  }

  return {
    status: 'no_decision',
    decision: null,
    patches,
    failures,
    hasCriticalFailure,
    audit,
  };
}

export async function runUnifiedDecisionHooksForSession<E extends DecisionEventType>(
  sessionKey: string,
  event: EventFor<E>,
  context: HookContext,
  sessionRegistry: SessionScopedUnifiedHookRegistry
): Promise<UnifiedDecisionExecutionResult<DecisionFor<E>>> {
  const registry = sessionRegistry.getSessionRegistry(sessionKey);
  if (!registry) {
    return {
      status: 'no_hooks',
      decision: null,
      patches: [],
      failures: [],
      hasCriticalFailure: false,
      audit: [],
    };
  }
  return runUnifiedDecisionHooks(event, context, registry);
}

export async function runUnifiedEffectHooks<E extends EffectEventType>(
  event: { type: E } & Record<string, unknown>,
  context: UnifiedEffectContext,
  registry: UnifiedHookRegistry
): Promise<UnifiedEffectExecutionResult<E>> {
  const hooks = registry.getEffectHooks(event.type);
  if (hooks.length === 0) {
    return {
      status: 'completed',
      outcomes: [],
      failures: [],
      audit: [],
    };
  }

  const groups = groupByPriority(hooks);
  const priorities = Array.from(groups.keys()).sort((a, b) => a - b);

  const outcomes: UnifiedEffectExecutionResult<E>['outcomes'] = [];
  const failures: UnifiedHookFailure[] = [];
  const audit: UnifiedEffectAuditEntry[] = [];
  let blockedBy: UnifiedEffectExecutionResult<E>['blockedBy'];

  for (const priority of priorities) {
    const group = groups.get(priority)!;
    const results = await Promise.all(
      group.map((hook) => executeEffectHookWithPolicy(hook, event, context))
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
}

export async function runUnifiedEffectHooksForSession<E extends EffectEventType>(
  sessionKey: string,
  event: { type: E } & Record<string, unknown>,
  context: UnifiedEffectContext,
  sessionRegistry: SessionScopedUnifiedHookRegistry
): Promise<UnifiedEffectExecutionResult<E>> {
  const registry = sessionRegistry.getSessionRegistry(sessionKey);
  if (!registry) {
    return {
      status: 'completed',
      outcomes: [],
      failures: [],
      audit: [],
    };
  }
  return runUnifiedEffectHooks(event, context, registry);
}

async function executeDecisionHookWithPolicy<E extends DecisionEventType>(
  hook: RegisteredUnifiedHook<UnifiedDecisionHookRegistration<E>>,
  event: EventFor<E>,
  context: HookContext
): Promise<{
  hook: RegisteredUnifiedHook<UnifiedDecisionHookRegistration<E>>;
  outcome: HookOutcome<DecisionFor<E>>;
  audit: UnifiedDecisionAuditEntry;
}> {
  const startedAt = Date.now();
  const maxRetries = hook.idempotency === 'idempotent' ? getMaxRetries(hook.policy) : 0;
  const policyBackoffMs = getBackoffMs(hook.policy);

  let retriesAttempted = 0;
  let outcome: HookOutcome<DecisionFor<E>> = failed('unknown error');

  while (true) {
    try {
      outcome = await withTimeout(
        hook.callback(event, context),
        hook.timeoutMs,
        () => timeout() as HookOutcome<DecisionFor<E>>
      );
    } catch (error) {
      outcome = failed(error instanceof Error ? error.message : String(error));
    }

    if (isSuccess(outcome) || isSkip(outcome)) {
      break;
    }

    if (retriesAttempted < maxRetries) {
      retriesAttempted += 1;
      const backoff = 'backoffMs' in outcome ? outcome.backoffMs : policyBackoffMs * retriesAttempted;
      await sleep(backoff);
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
}

async function executeEffectHookWithPolicy<E extends EffectEventType>(
  hook: RegisteredUnifiedHook<UnifiedEffectHookRegistration<E>>,
  event: { type: E } & Record<string, unknown>,
  context: UnifiedEffectContext
): Promise<{
  hook: RegisteredUnifiedHook<UnifiedEffectHookRegistration<E>>;
  outcome: EffectOutcomeFor<E>;
  policy: HookPolicy;
  error?: string;
  audit: UnifiedEffectAuditEntry;
}> {
  const startedAt = Date.now();
  const policy = hook.policy ?? { kind: 'fire_and_forget' };
  const maxRetries = getMaxRetries(policy);
  const backoffMs = getBackoffMs(policy);

  let retriesAttempted = 0;

  while (true) {
    try {
      const outcome = await withTimeout(
        hook.callback(event as never, context),
        hook.timeoutMs,
        () => ({ kind: 'skip', reason: 'timeout' } as EffectOutcomeFor<E>)
      );

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (retriesAttempted < maxRetries) {
        retriesAttempted += 1;
        await sleep(backoffMs * retriesAttempted);
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
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => resolve(onTimeout()), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}
