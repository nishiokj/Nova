/**
 * Tests for WorkItemStateManager readiness logic.
 */

import { describe, it, expect } from 'bun:test';
import { WorkItemStateManager } from './workitem-state.js';
import { createWorkItem } from '../wizard/work-item.js';

function buildWorkItems() {
  const workA = createWorkItem({
    goal: 'goal',
    objective: 'A',
    dependencies: [],
  });
  const workB = createWorkItem({
    goal: 'goal',
    objective: 'B',
    dependencies: [workA.workId],
  });
  return { workA, workB };
}

describe('WorkItemStateManager', () => {
  it('returns only dependency-free items as ready', () => {
    const { workA, workB } = buildWorkItems();
    const manager = new WorkItemStateManager();
    manager.initFromScript([workA, workB]);

    const ready = manager.getReady();
    expect(ready.length).toBe(1);
    expect(ready[0]?.workItem.workId).toBe(workA.workId);
  });

  it('promotes items when dependencies complete', () => {
    const { workA, workB } = buildWorkItems();
    const manager = new WorkItemStateManager();
    manager.initFromScript([workA, workB]);

    manager.markCompleted(workA.workId, {
      success: true,
      response: 'ok',
      metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
      filesRead: [],
      invalidatedPaths: [],
      toolErrors: [],
      terminationReason: 'final',
      needsUserInput: false,
      isRefusal: false,
    });

    const ready = manager.getReady();
    expect(ready.length).toBe(1);
    expect(ready[0]?.workItem.workId).toBe(workB.workId);
  });
});
