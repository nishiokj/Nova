/**
 * Decision Mappers — pure function edge-case tests.
 *
 * Each mapper must handle every variant of its discriminated union input.
 * Tests verify both the decision type and the content of the result.
 */

import { describe, it, expect } from 'bun:test';
import {
  mapQualityDecisionToStopResult,
  mapBoundsDecisionToStopResult,
  mapPromptDecisionToStopResult,
  mapAgentErrorDecisionToStopResult,
  mapWorkItemDecisionToStopResult,
} from './decision_mappers.js';

describe('mapQualityDecisionToStopResult', () => {
  it('passed → allow', () => {
    expect(mapQualityDecisionToStopResult({ verdict: 'passed' } as any).decision).toBe('allow');
  });

  it('failed → block with joined issues', () => {
    const r = mapQualityDecisionToStopResult({ verdict: 'failed', issues: ['a', 'b'] } as any);
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.reason).toBe('a\nb');
    }
  });

  it('failed with empty issues → fallback message', () => {
    const r = mapQualityDecisionToStopResult({ verdict: 'failed', issues: [] } as any);
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.reason).toBe('Quality gate failed');
    }
  });

  it('needs_human → block with joined concerns', () => {
    const r = mapQualityDecisionToStopResult({ verdict: 'needs_human', concerns: ['x'] } as any);
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.reason).toBe('x');
    }
  });

  it('needs_human with empty concerns → fallback', () => {
    const r = mapQualityDecisionToStopResult({ verdict: 'needs_human', concerns: [] } as any);
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.reason).toBe('Quality gate requires human review');
    }
  });
});

describe('mapBoundsDecisionToStopResult', () => {
  it('realign → block with guidance', () => {
    const r = mapBoundsDecisionToStopResult({ action: 'realign', guidance: 'Focus' } as any);
    expect(r).toEqual({ decision: 'block', reason: 'Focus' });
  });

  it('split → allow with deferred work', () => {
    const r = mapBoundsDecisionToStopResult({
      action: 'split',
      workItems: [{ goal: 'g', objective: 'o', agent: 'a' }],
    } as any);
    expect(r.decision).toBe('allow');
    expect(r.deferredWork).toHaveLength(1);
    expect(r.deferredWork![0].background).toBe(true);
  });

  it('wrap_up → allow with systemMessage', () => {
    const r = mapBoundsDecisionToStopResult({ action: 'wrap_up', summary: 'Done' } as any);
    expect(r).toEqual({ decision: 'allow', systemMessage: 'Done' });
  });

  it('abort → allow with reason as systemMessage', () => {
    const r = mapBoundsDecisionToStopResult({ action: 'abort', reason: 'Cost' } as any);
    expect(r).toEqual({ decision: 'allow', systemMessage: 'Cost' });
  });
});

describe('mapPromptDecisionToStopResult', () => {
  it('answer → block with text and contextAddendum', () => {
    const r = mapPromptDecisionToStopResult({ action: 'answer', text: 'yes', contextAddendum: 'ctx' } as any);
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.reason).toBe('yes');
    }
    expect(r.systemMessage).toBe('ctx');
  });

  it('escalate → allow', () => {
    expect(mapPromptDecisionToStopResult({ action: 'escalate' } as any).decision).toBe('allow');
  });

  it('defer → allow', () => {
    expect(mapPromptDecisionToStopResult({ action: 'defer' } as any).decision).toBe('allow');
  });
});

describe('mapAgentErrorDecisionToStopResult', () => {
  it('retry → block with guidance', () => {
    const r = mapAgentErrorDecisionToStopResult({ action: 'retry', guidance: 'Try again' } as any);
    expect(r).toEqual({ decision: 'block', reason: 'Try again' });
  });

  it('abort → allow', () => {
    expect(mapAgentErrorDecisionToStopResult({ action: 'abort' } as any).decision).toBe('allow');
  });

  it('escalate → allow', () => {
    expect(mapAgentErrorDecisionToStopResult({ action: 'escalate' } as any).decision).toBe('allow');
  });
});

describe('mapWorkItemDecisionToStopResult', () => {
  it('accept → allow', () => {
    expect(mapWorkItemDecisionToStopResult({ action: 'accept' } as any).decision).toBe('allow');
  });

  it('retry → block with guidance', () => {
    const r = mapWorkItemDecisionToStopResult({ action: 'retry', guidance: 'Add tests' } as any);
    expect(r).toEqual({ decision: 'block', reason: 'Add tests' });
  });

  it('split → allow with deferred work', () => {
    const r = mapWorkItemDecisionToStopResult({
      action: 'split',
      workItems: [
        { goal: 'a', objective: 'a', agent: 'x' },
        { goal: 'b', objective: 'b', agent: 'y' },
      ],
    } as any);
    expect(r.decision).toBe('allow');
    expect(r.deferredWork).toHaveLength(2);
  });

  it('escalate → allow', () => {
    expect(mapWorkItemDecisionToStopResult({ action: 'escalate' } as any).decision).toBe('allow');
  });
});

describe('deferred work invariants', () => {
  it('background is always true', () => {
    const items = [
      ...mapBoundsDecisionToStopResult({
        action: 'split', workItems: [{ goal: 'x', objective: 'x', agent: 'a' }],
      } as any).deferredWork!,
      ...mapWorkItemDecisionToStopResult({
        action: 'split', workItems: [{ goal: 'y', objective: 'y', agent: 'b' }],
      } as any).deferredWork!,
    ];
    for (const item of items) {
      expect(item.background).toBe(true);
    }
  });

  it('preserves optional fields', () => {
    const r = mapBoundsDecisionToStopResult({
      action: 'split',
      workItems: [{
        id: 'custom', goal: 'g', objective: 'o', agent: 'a',
        dependencies: ['d1'], targetPaths: ['/src/x.ts'],
        bounds: { maxToolCalls: 10 }, semantic: { kind: 'refactor' },
      }],
    } as any);
    const item = r.deferredWork![0];
    expect(item.id).toBe('custom');
    expect(item.dependencies).toEqual(['d1']);
    expect(item.targetPaths).toEqual(['/src/x.ts']);
    expect(item.bounds).toEqual({ maxToolCalls: 10 });
    expect(item.semantic).toEqual({ kind: 'refactor' });
  });
});
