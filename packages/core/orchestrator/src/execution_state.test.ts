/**
 * ExecutionState — state management invariant tests.
 */

import { describe, it, expect } from 'bun:test';
import {
  createExecutionState,
  getElapsedMs,
  nextIteration,
  updateMetrics,
  updateRunControl,
} from './execution_state.js';
import type { AgentResult } from 'agent';

// Minimal mock: only metrics are read by updateMetrics
function mockResult(llm: number, tools: number): AgentResult {
  return {
    metrics: { llmCallsMade: llm, toolCallsMade: tools, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
  } as unknown as AgentResult;
}

describe('createExecutionState', () => {
  it('initializes counters to zero', () => {
    const s = createExecutionState('w1');
    expect(s.iteration).toBe(0);
    expect(s.totalLlmCalls).toBe(0);
    expect(s.totalToolCalls).toBe(0);
  });

  it('stores initialWorkId', () => {
    expect(createExecutionState('abc').initialWorkId).toBe('abc');
  });

  it('initialWork starts incomplete', () => {
    const s = createExecutionState('w1');
    expect(s.initialWorkCompleted).toBe(false);
    expect(s.initialWorkResponse).toBe('');
    expect(s.initialWorkResult).toBeUndefined();
  });

  it('compactedRecently starts false', () => {
    expect(createExecutionState('w1').compactedRecently).toBe(false);
  });

  it('inProgress starts empty', () => {
    const s = createExecutionState('w1');
    expect(s.inProgress).toBeInstanceOf(Map);
    expect(s.inProgress.size).toBe(0);
  });

  it('defaults runControl to running', () => {
    expect(createExecutionState('w1').runControl).toEqual({ state: 'running' });
  });

  it('accepts custom runControl', () => {
    const rc = { state: 'cancelling' as const, cancellation: { requestedAt: 42 } };
    expect(createExecutionState('w1', rc).runControl).toEqual(rc);
  });

  it('captures startTime from Date.now()', () => {
    const before = Date.now();
    const s = createExecutionState('w1');
    expect(s.startTime).toBeGreaterThanOrEqual(before);
    expect(s.startTime).toBeLessThanOrEqual(Date.now());
  });
});

describe('getElapsedMs', () => {
  it('returns elapsed time since startTime', () => {
    const orig = Date.now;
    let t = 10_000;
    Date.now = () => t;
    try {
      const s = createExecutionState('w1');
      t = 10_500;
      expect(getElapsedMs(s)).toBe(500);
      t = 15_000;
      expect(getElapsedMs(s)).toBe(5000);
    } finally {
      Date.now = orig;
    }
  });

  it('returns 0 immediately after creation', () => {
    const orig = Date.now;
    Date.now = () => 5000;
    try {
      expect(getElapsedMs(createExecutionState('w1'))).toBe(0);
    } finally {
      Date.now = orig;
    }
  });
});

describe('nextIteration', () => {
  it('increments by 1 each call', () => {
    const s = createExecutionState('w1');
    expect(nextIteration(s)).toBe(1);
    expect(nextIteration(s)).toBe(2);
    expect(nextIteration(s)).toBe(3);
  });

  it('returns the new value (same as s.iteration)', () => {
    const s = createExecutionState('w1');
    const v = nextIteration(s);
    expect(v).toBe(s.iteration);
  });
});

describe('updateMetrics', () => {
  it('accumulates LLM calls', () => {
    const s = createExecutionState('w1');
    updateMetrics(s, mockResult(3, 0));
    expect(s.totalLlmCalls).toBe(3);
    updateMetrics(s, mockResult(2, 0));
    expect(s.totalLlmCalls).toBe(5);
  });

  it('accumulates tool calls', () => {
    const s = createExecutionState('w1');
    updateMetrics(s, mockResult(0, 5));
    expect(s.totalToolCalls).toBe(5);
    updateMetrics(s, mockResult(0, 3));
    expect(s.totalToolCalls).toBe(8);
  });

  it('zero-metric result is a no-op', () => {
    const s = createExecutionState('w1');
    s.totalLlmCalls = 10;
    s.totalToolCalls = 20;
    updateMetrics(s, mockResult(0, 0));
    expect(s.totalLlmCalls).toBe(10);
    expect(s.totalToolCalls).toBe(20);
  });
});

describe('updateRunControl', () => {
  it('replaces entire runControl (not merge)', () => {
    const s = createExecutionState('w1', { state: 'running', cancellation: { requestedAt: 1, reason: 'old' } });
    updateRunControl(s, { state: 'running' });
    expect(s.runControl.cancellation).toBeUndefined();
  });

  it('sets new state', () => {
    const s = createExecutionState('w1');
    updateRunControl(s, { state: 'cancelling' });
    expect(s.runControl.state).toBe('cancelling');
  });
});
