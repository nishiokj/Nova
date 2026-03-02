import { failClosed, fireAndForget, success, type EventFor, type HookContext } from 'orchestrator';
import { Effect } from 'effect';
import type { UnifiedDecisionHookRegistration, UnifiedEffectHookRegistration } from 'orchestrator/unifiedHooks/contracts.js';
import { createSessionScopedUnifiedHookRegistry, createUnifiedHookRegistry } from 'orchestrator/unifiedHooks/registry.js';
import {
  runUnifiedDecisionHooks,
  runUnifiedDecisionHooksForSession,
  runUnifiedEffectHooks,
  runUnifiedEffectHooksForSession,
} from 'orchestrator/unifiedHooks/runner.js';

function createHookContext(): HookContext {
  return {
    sessionKey: 'session-1',
    workId: 'work-1',
    agentType: 'standard',
    iteration: 1,
    objective: 'test objective',
    realignCount: 0,
    filesModified: [],
    recentMessages: [],
    metrics: {
      toolCallsMade: 0,
      llmCalls: 0,
      contextPercentUsed: 0,
      durationMs: 0,
      filesRead: [],
      filesModified: [],
      iterationCount: 1,
    },
  };
}

function createCadenceEvent(): EventFor<'cadence_audit'> {
  return {
    type: 'cadence_audit',
    timestamp: Date.now(),
    sessionKey: 'session-1',
    workId: 'work-1',
    elapsedMs: 10,
    toolCallsSinceLastAudit: 0,
    recentActivity: 'none',
    metrics: {
      toolCallsMade: 0,
      llmCalls: 0,
      contextPercentUsed: 0,
      durationMs: 0,
      filesRead: [],
      filesModified: [],
      iterationCount: 1,
    },
  };
}

describe('unified hooks registry', () => {
  it('registers decision and effect hooks with deterministic ordering', () => {
    const registry = createUnifiedHookRegistry();

    const decision: UnifiedDecisionHookRegistration<'cadence_audit'> = {
      id: 'decision-1',
      event: 'cadence_audit',
      mode: 'decision',
      scope: 'orchestrator',
      source: 'test',
      priority: 20,
      timeoutMs: 500,
      policy: fireAndForget(),
      criticality: 'non_critical',
      idempotency: 'idempotent',
      callback: () => Effect.succeed(success({ action: 'continue' })),
    };

    const effect: UnifiedEffectHookRegistration<'pre_tool_use'> = {
      id: 'effect-1',
      event: 'pre_tool_use',
      mode: 'effect',
      scope: 'harness',
      source: 'test',
      priority: 10,
      timeoutMs: 500,
      policy: fireAndForget(),
      callback: () => Effect.succeed({ kind: 'allow' as const }),
    };

    registry.register(decision);
    registry.register(effect);

    const decisionHooks = registry.getDecisionHooks('cadence_audit');
    const effectHooks = registry.getEffectHooks('pre_tool_use');

    expect(decisionHooks).toHaveLength(1);
    expect(effectHooks).toHaveLength(1);
    expect(decisionHooks[0]?.id).toBe('decision-1');
    expect(effectHooks[0]?.id).toBe('effect-1');
  });

  it('rejects invalid scope for event ownership', () => {
    const registry = createUnifiedHookRegistry();

    const invalid: UnifiedDecisionHookRegistration<'cadence_audit'> = {
      id: 'invalid-scope',
      event: 'cadence_audit',
      mode: 'decision',
      scope: 'harness',
      source: 'test',
      priority: 0,
      timeoutMs: 100,
      policy: fireAndForget(),
      criticality: 'non_critical',
      idempotency: 'idempotent',
      callback: () => Effect.succeed(success({ action: 'continue' })),
    };

    expect(() => registry.register(invalid)).toThrow('scope harness is not allowed');
  });
});

describe('unified decision runner', () => {
  it('returns the first decision by priority and registration order', async () => {
    const registry = createUnifiedHookRegistry();

    const early: UnifiedDecisionHookRegistration<'cadence_audit'> = {
      id: 'early',
      event: 'cadence_audit',
      mode: 'decision',
      scope: 'orchestrator',
      source: 'test',
      priority: 0,
      timeoutMs: 100,
      policy: fireAndForget(),
      criticality: 'non_critical',
      idempotency: 'idempotent',
      callback: () => Effect.succeed(success({ action: 'inject_guidance', message: 'use tests' })),
    };

    const late: UnifiedDecisionHookRegistration<'cadence_audit'> = {
      id: 'late',
      event: 'cadence_audit',
      mode: 'decision',
      scope: 'orchestrator',
      source: 'test',
      priority: 0,
      timeoutMs: 100,
      policy: fireAndForget(),
      criticality: 'non_critical',
      idempotency: 'idempotent',
      callback: () => Effect.succeed(success({ action: 'continue' })),
    };

    registry.register(early);
    registry.register(late);

    const result = await Effect.runPromise(
      runUnifiedDecisionHooks(createCadenceEvent(), createHookContext(), registry)
    );

    expect(result.status).toBe('decision');
    if (result.status === 'decision') {
      expect(result.decision.action).toBe('inject_guidance');
    }
  });

  it('marks critical failures and stops after the priority group', async () => {
    const registry = createUnifiedHookRegistry();

    const criticalFailing: UnifiedDecisionHookRegistration<'cadence_audit'> = {
      id: 'critical-fail',
      event: 'cadence_audit',
      mode: 'decision',
      scope: 'orchestrator',
      source: 'test',
      priority: 0,
      timeoutMs: 100,
      policy: failClosed(),
      criticality: 'critical',
      idempotency: 'idempotent',
      callback: () => Effect.fail(new Error('boom')),
    };

    const neverRuns: UnifiedDecisionHookRegistration<'cadence_audit'> = {
      id: 'never-runs',
      event: 'cadence_audit',
      mode: 'decision',
      scope: 'orchestrator',
      source: 'test',
      priority: 10,
      timeoutMs: 100,
      policy: fireAndForget(),
      criticality: 'non_critical',
      idempotency: 'idempotent',
      callback: () => Effect.succeed(success({ action: 'continue' })),
    };

    registry.register(criticalFailing);
    registry.register(neverRuns);

    const result = await Effect.runPromise(
      runUnifiedDecisionHooks(createCadenceEvent(), createHookContext(), registry)
    );

    expect(result.status).toBe('no_decision');
    expect(result.hasCriticalFailure).toBe(true);
    expect(result.failures).toHaveLength(1);
  });
});

describe('unified effect runner', () => {
  it('supports lifecycle block outcomes for blockable events', async () => {
    const registry = createUnifiedHookRegistry();

    const blocker: UnifiedEffectHookRegistration<'pre_tool_use'> = {
      id: 'blocker',
      event: 'pre_tool_use',
      mode: 'effect',
      scope: 'harness',
      source: 'test',
      priority: 0,
      timeoutMs: 100,
      policy: fireAndForget(),
      callback: () => Effect.succeed({ kind: 'block' as const, reason: 'policy violation' }),
    };

    registry.register(blocker);

    const result = await Effect.runPromise(
      runUnifiedEffectHooks(
        {
          type: 'pre_tool_use',
          toolName: 'exec_command',
          args: { cmd: 'rm -rf /' },
        },
        {
          sessionKey: 'session-1',
          requestId: 'req-1',
        },
        registry
      )
    );

    expect(result.status).toBe('blocked');
    expect(result.blockedBy?.hookId).toBe('blocker');
  });
});

describe('session-scoped unified hooks', () => {
  it('isolates registration by session and allows same hook id across sessions', async () => {
    const sessionRegistry = createSessionScopedUnifiedHookRegistry();

    const hookA: UnifiedDecisionHookRegistration<'cadence_audit'> = {
      id: 'shared-id',
      event: 'cadence_audit',
      mode: 'decision',
      scope: 'orchestrator',
      source: 'test',
      priority: 0,
      timeoutMs: 100,
      policy: fireAndForget(),
      criticality: 'non_critical',
      idempotency: 'idempotent',
      callback: () => Effect.succeed(success({ action: 'inject_guidance', message: 'from session A' })),
    };

    const hookB: UnifiedDecisionHookRegistration<'cadence_audit'> = {
      id: 'shared-id',
      event: 'cadence_audit',
      mode: 'decision',
      scope: 'orchestrator',
      source: 'test',
      priority: 0,
      timeoutMs: 100,
      policy: fireAndForget(),
      criticality: 'non_critical',
      idempotency: 'idempotent',
      callback: () => Effect.succeed(success({ action: 'inject_guidance', message: 'from session B' })),
    };

    sessionRegistry.register('session-a', hookA);
    sessionRegistry.register('session-b', hookB);

    const resultA = await Effect.runPromise(
      runUnifiedDecisionHooksForSession(
        'session-a',
        createCadenceEvent(),
        createHookContext(),
        sessionRegistry
      )
    );

    const resultB = await Effect.runPromise(
      runUnifiedDecisionHooksForSession(
        'session-b',
        createCadenceEvent(),
        createHookContext(),
        sessionRegistry
      )
    );

    expect(resultA.status).toBe('decision');
    expect(resultB.status).toBe('decision');

    if (resultA.status === 'decision') {
      expect(resultA.decision.action).toBe('inject_guidance');
      if (resultA.decision.action === 'inject_guidance') {
        expect(resultA.decision.message).toBe('from session A');
      }
    }

    if (resultB.status === 'decision') {
      expect(resultB.decision.action).toBe('inject_guidance');
      if (resultB.decision.action === 'inject_guidance') {
        expect(resultB.decision.message).toBe('from session B');
      }
    }
  });

  it('returns no hooks for sessions without registrations', async () => {
    const sessionRegistry = createSessionScopedUnifiedHookRegistry();

    const decisionResult = await Effect.runPromise(
      runUnifiedDecisionHooksForSession(
        'missing-session',
        createCadenceEvent(),
        createHookContext(),
        sessionRegistry
      )
    );
    expect(decisionResult.status).toBe('no_hooks');

    const effectResult = await Effect.runPromise(
      runUnifiedEffectHooksForSession(
        'missing-session',
        {
          type: 'pre_tool_use',
          toolName: 'exec_command',
          args: { cmd: 'echo hi' },
        },
        {
          sessionKey: 'missing-session',
          requestId: 'req-1',
        },
        sessionRegistry
      )
    );
    expect(effectResult.status).toBe('completed');
    expect(effectResult.outcomes).toHaveLength(0);
  });
});
