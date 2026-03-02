import { describe, expect, it, vi } from 'vitest';
import { ContextWindow } from 'context';
import { createWorkItem } from 'types';
import { applyPatches } from 'orchestrator/hookRunner/applyPatches.js';
import type { StatePatch } from 'orchestrator';

describe('applyPatches cancel_work semantics', () => {
  it('removes queued work when cancellation scope is queued', () => {
    const queuedA = createWorkItem({ goal: 'g', objective: 'queued-a', agent: 'standard' });
    const queuedB = createWorkItem({ goal: 'g', objective: 'queued-b', agent: 'standard' });
    const cancelInProgressWork = vi.fn(() => true);

    const patch: StatePatch = {
      op: 'cancel_work',
      workIds: [queuedA.workId],
      cancellation: {
        scope: 'queued',
        reason: 'no longer needed',
      },
    };

    const result = applyPatches({
      workQueue: [queuedA, queuedB],
      context: new ContextWindow('session-queued', 200_000),
      realignCount: 0,
      terminationReason: null,
      metadata: new Map(),
      auditLog: [],
      cancelInProgressWork,
    }, [patch], 'test:queued');

    expect(result.applied).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.state.workQueue.map(item => item.workId)).toEqual([queuedB.workId]);
    expect(cancelInProgressWork).not.toHaveBeenCalled();
  });

  it('routes in-progress cancellation through cancelInProgressWork callback', () => {
    const queued = createWorkItem({ goal: 'g', objective: 'queued', agent: 'standard' });
    const inProgressWorkId = 'in-progress-1';
    const cancelInProgressWork = vi.fn(() => true);

    const patch: StatePatch = {
      op: 'cancel_work',
      workIds: [inProgressWorkId],
      cancellation: {
        scope: 'in_progress',
        reason: 'policy requested stop',
      },
    };

    const result = applyPatches({
      workQueue: [queued],
      context: new ContextWindow('session-progress', 200_000),
      realignCount: 0,
      terminationReason: null,
      metadata: new Map(),
      auditLog: [],
      cancelInProgressWork,
    }, [patch], 'test:in-progress');

    expect(result.applied).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.state.workQueue.map(item => item.workId)).toEqual([queued.workId]);
    expect(cancelInProgressWork).toHaveBeenCalledTimes(1);
    expect(cancelInProgressWork).toHaveBeenCalledWith(inProgressWorkId, 'policy requested stop');
  });

  it('rejects in-progress cancellation patches when cancel callback is unavailable', () => {
    const patch: StatePatch = {
      op: 'cancel_work',
      workIds: ['in-progress-1'],
      cancellation: {
        scope: 'in_progress',
        reason: 'policy requested stop',
      },
    };

    const result = applyPatches({
      workQueue: [],
      context: new ContextWindow('session-missing-callback', 200_000),
      realignCount: 0,
      terminationReason: null,
      metadata: new Map(),
      auditLog: [],
    }, [patch], 'test:missing-callback');

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('cancelInProgressWork');
  });
});
