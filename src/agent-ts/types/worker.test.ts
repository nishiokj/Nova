/**
 * Comprehensive test suite for Worker Types and Utilities
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Stagnation detection algorithms
 * - Hash function edge cases
 * - Tool call loop detection
 * - Context delta operations
 */

import { describe, it, expect } from 'bun:test';
import {
  createWorkItem,
  createContextDelta,
  createWorkerMetrics,
  updateMetricsFromLLM,
  updateMetricsFromTool,
  createStagnationState,
  simpleHash,
  updateStagnation,
  isStagnating,
  getStagnationScore,
  type WorkItem,
  type ContextDelta,
  type WorkerMetrics,
  type StagnationState,
} from './worker.js';
import type { LLMResponse } from './llm.js';
import type { ToolResult } from './tools.js';

describe('createWorkItem', () => {
  it('should create work item with defaults', () => {
    const item = createWorkItem(1, 'Test objective');

    expect(item.stepNum).toBe(1);
    expect(item.objective).toBe('Test objective');
    expect(item.phase).toBe('execution');
    expect(item.maxToolCalls).toBe(10);
    expect(item.maxIterations).toBe(5);
  });

  it('should override defaults with options', () => {
    const item = createWorkItem(1, 'Test', {
      phase: 'discovery',
      maxToolCalls: 20,
      maxIterations: 10,
      toolHint: 'Grep',
      toolArgsHint: { pattern: 'test' },
      successCriteria: 'Find the file',
    });

    expect(item.phase).toBe('discovery');
    expect(item.maxToolCalls).toBe(20);
    expect(item.maxIterations).toBe(10);
    expect(item.toolHint).toBe('Grep');
    expect(item.toolArgsHint).toEqual({ pattern: 'test' });
    expect(item.successCriteria).toBe('Find the file');
  });
});

describe('createContextDelta', () => {
  it('should create empty context delta', () => {
    const delta = createContextDelta();

    expect(delta.toolResults).toEqual({});
    expect(delta.filesRead).toEqual([]);
    expect(delta.filesModified).toEqual([]);
    expect(delta.commandsExecuted).toEqual([]);
    expect(delta.discoveries).toEqual([]);
    expect(delta.knowledge).toEqual({});
  });
});

describe('createWorkerMetrics', () => {
  it('should create zero-initialized metrics', () => {
    const metrics = createWorkerMetrics();

    expect(metrics.llmCalls).toBe(0);
    expect(metrics.toolCalls).toBe(0);
    expect(metrics.toolFailures).toBe(0);
    expect(metrics.promptTokens).toBe(0);
    expect(metrics.completionTokens).toBe(0);
    expect(metrics.llmLatencyMs).toBe(0);
    expect(metrics.toolLatencyMs).toBe(0);
    expect(metrics.stagnationScore).toBe(0);
  });
});

describe('updateMetricsFromLLM', () => {
  it('should accumulate LLM metrics', () => {
    const initial = createWorkerMetrics();
    const response: LLMResponse = {
      content: 'test',
      stopReason: 'end_turn',
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
      model: 'gpt-4',
      durationMs: 500,
      toolCalls: [
        { id: 'call_1', name: 'read', arguments: {} },
      ],
    };

    const updated = updateMetricsFromLLM(initial, response);

    expect(updated.llmCalls).toBe(1);
    expect(updated.promptTokens).toBe(100);
    expect(updated.completionTokens).toBe(50);
    expect(updated.llmLatencyMs).toBe(500);
    expect(updated.toolCalls).toBe(1);
  });

  it('should accumulate across multiple calls', () => {
    let metrics = createWorkerMetrics();
    const response: LLMResponse = {
      content: 'test',
      stopReason: 'end_turn',
      usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      model: 'gpt-4',
      durationMs: 200,
    };

    metrics = updateMetricsFromLLM(metrics, response);
    metrics = updateMetricsFromLLM(metrics, response);

    expect(metrics.llmCalls).toBe(2);
    expect(metrics.promptTokens).toBe(100);
    expect(metrics.completionTokens).toBe(50);
    expect(metrics.llmLatencyMs).toBe(400);
  });

  it('should handle undefined toolCalls', () => {
    const metrics = createWorkerMetrics();
    const response: LLMResponse = {
      content: 'test',
      stopReason: 'end_turn',
      usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      model: 'gpt-4',
      durationMs: 200,
      toolCalls: undefined,
    };

    const updated = updateMetricsFromLLM(metrics, response);

    expect(updated.toolCalls).toBe(0);
  });
});

describe('updateMetricsFromTool', () => {
  it('should accumulate tool latency for successful call', () => {
    const initial = createWorkerMetrics();
    const result: ToolResult = {
      toolName: 'read',
      status: 'success',
      isSuccess: true,
      output: 'file contents',
      durationMs: 100,
    };

    const updated = updateMetricsFromTool(initial, result);

    expect(updated.toolLatencyMs).toBe(100);
    expect(updated.toolFailures).toBe(0);
  });

  it('should increment toolFailures for failed call', () => {
    const initial = createWorkerMetrics();
    const result: ToolResult = {
      toolName: 'read',
      status: 'error',
      isSuccess: false,
      output: 'error',
      error: 'File not found',
      durationMs: 50,
    };

    const updated = updateMetricsFromTool(initial, result);

    expect(updated.toolLatencyMs).toBe(50);
    expect(updated.toolFailures).toBe(1);
  });

  it('should accumulate across multiple tool calls', () => {
    let metrics = createWorkerMetrics();
    const success: ToolResult = { toolName: 'a', status: 'success', isSuccess: true, output: '', durationMs: 100 };
    const failure: ToolResult = { toolName: 'b', status: 'error', isSuccess: false, output: '', durationMs: 50 };

    metrics = updateMetricsFromTool(metrics, success);
    metrics = updateMetricsFromTool(metrics, failure);
    metrics = updateMetricsFromTool(metrics, success);

    expect(metrics.toolLatencyMs).toBe(250);
    expect(metrics.toolFailures).toBe(1);
  });
});

describe('Stagnation Detection', () => {
  describe('simpleHash', () => {
    it('should produce consistent hash for same input', () => {
      const text = 'Hello, World!';
      const hash1 = simpleHash(text);
      const hash2 = simpleHash(text);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = simpleHash('Hello');
      const hash2 = simpleHash('World');

      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = simpleHash('');
      expect(hash).toBe('0'); // Hash of empty string is 0
    });

    it('should handle very long strings', () => {
      const longText = 'a'.repeat(100000);
      const hash = simpleHash(longText);

      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });

    it('BUG CANDIDATE: hash collision possibility', () => {
      // Simple hash functions have high collision rates
      // Different strings may produce same hash
      // This test documents the behavior

      // Generate many hashes and check for collisions
      const hashes = new Map<string, string>();
      let collisions = 0;

      for (let i = 0; i < 1000; i++) {
        const text = `test-string-${i}-${Math.random()}`;
        const hash = simpleHash(text);

        if (hashes.has(hash)) {
          collisions++;
        }
        hashes.set(hash, text);
      }

      // Some collisions are expected with a simple hash
      // This documents the risk
    });

    it('should handle unicode characters', () => {
      const hash = simpleHash('🎉 Unicode test 日本語');
      expect(typeof hash).toBe('string');
    });
  });

  describe('createStagnationState', () => {
    it('should create state with defaults', () => {
      const state = createStagnationState();

      expect(state.recentToolCalls).toEqual([]);
      expect(state.recentResponseHashes).toEqual([]);
      expect(state.similarResponseCount).toBe(0);
      expect(state.maxSimilar).toBe(3);
      expect(state.windowSize).toBe(5);
    });

    it('should accept custom parameters', () => {
      const state = createStagnationState(5, 10);

      expect(state.maxSimilar).toBe(5);
      expect(state.windowSize).toBe(10);
    });
  });

  describe('updateStagnation', () => {
    it('should add response hash to history', () => {
      let state = createStagnationState();

      state = updateStagnation(state, 'Response 1', []);

      expect(state.recentResponseHashes).toHaveLength(1);
    });

    it('should add tool calls to history', () => {
      let state = createStagnationState();

      state = updateStagnation(state, 'Response', ['read', 'write']);

      expect(state.recentToolCalls).toContain('read');
      expect(state.recentToolCalls).toContain('write');
    });

    it('should increment similarResponseCount for identical responses', () => {
      let state = createStagnationState();

      state = updateStagnation(state, 'Same response', []);
      expect(state.similarResponseCount).toBe(0);

      state = updateStagnation(state, 'Same response', []);
      expect(state.similarResponseCount).toBe(1);

      state = updateStagnation(state, 'Same response', []);
      expect(state.similarResponseCount).toBe(2);
    });

    it('should reset similarResponseCount for different response', () => {
      let state = createStagnationState();

      state = updateStagnation(state, 'Response A', []);
      state = updateStagnation(state, 'Response A', []);
      expect(state.similarResponseCount).toBe(1);

      state = updateStagnation(state, 'Response B', []);
      expect(state.similarResponseCount).toBe(0);
    });

    it('should limit history to windowSize', () => {
      let state = createStagnationState(3, 3);

      for (let i = 0; i < 10; i++) {
        state = updateStagnation(state, `Response ${i}`, [`tool-${i}`]);
      }

      expect(state.recentResponseHashes.length).toBeLessThanOrEqual(3);
      // Tool calls window is 2x windowSize
      expect(state.recentToolCalls.length).toBeLessThanOrEqual(6);
    });
  });

  describe('isStagnating', () => {
    it('should return false when below threshold', () => {
      let state = createStagnationState(3, 5);

      state = updateStagnation(state, 'Same', []);
      state = updateStagnation(state, 'Same', []);

      expect(isStagnating(state)).toBe(false);
    });

    it('should return true when at or above threshold', () => {
      let state = createStagnationState(3, 5);

      state = updateStagnation(state, 'Same', []);
      state = updateStagnation(state, 'Same', []);
      state = updateStagnation(state, 'Same', []);

      expect(isStagnating(state)).toBe(true);
    });

    it('should detect stagnation after threshold consecutive matches', () => {
      let state = createStagnationState(2, 5);

      state = updateStagnation(state, 'Response A', []);
      state = updateStagnation(state, 'Response A', []); // similarCount = 1
      state = updateStagnation(state, 'Response A', []); // similarCount = 2

      expect(isStagnating(state)).toBe(true);
    });
  });

  describe('getStagnationScore', () => {
    it('should return 0 for fresh state', () => {
      const state = createStagnationState();

      expect(getStagnationScore(state)).toBe(0);
    });

    it('should increase with response repetition', () => {
      let state = createStagnationState(3, 5);

      const score0 = getStagnationScore(state);

      state = updateStagnation(state, 'Same', []);
      state = updateStagnation(state, 'Same', []);
      const score2 = getStagnationScore(state);

      expect(score2).toBeGreaterThan(score0);
    });

    it('should detect 2-element tool call loop (A, B, A, B)', () => {
      let state = createStagnationState(5, 10);

      state = updateStagnation(state, 'R1', ['read']);
      state = updateStagnation(state, 'R2', ['write']);
      state = updateStagnation(state, 'R3', ['read']);
      state = updateStagnation(state, 'R4', ['write']);

      const score = getStagnationScore(state);

      // Should detect the A-B-A-B pattern
      expect(score).toBeGreaterThanOrEqual(0.8);
    });

    it('should detect 3-element tool call loop', () => {
      let state = createStagnationState(5, 10);

      state = updateStagnation(state, 'R1', ['a']);
      state = updateStagnation(state, 'R2', ['b']);
      state = updateStagnation(state, 'R3', ['c']);
      state = updateStagnation(state, 'R4', ['a']);
      state = updateStagnation(state, 'R5', ['b']);
      state = updateStagnation(state, 'R6', ['c']);

      const score = getStagnationScore(state);

      expect(score).toBeGreaterThanOrEqual(0.9);
    });

    it('should detect same tool called repeatedly', () => {
      let state = createStagnationState(5, 10);

      state = updateStagnation(state, 'R1', ['read']);
      state = updateStagnation(state, 'R2', ['read']);
      state = updateStagnation(state, 'R3', ['read']);

      const score = getStagnationScore(state);

      expect(score).toBeGreaterThanOrEqual(0.7);
    });

    it('should return max of repetition score and loop score', () => {
      let state = createStagnationState(3, 10);

      // Both repetition (same response) and loop (same tool)
      state = updateStagnation(state, 'Same response', ['read']);
      state = updateStagnation(state, 'Same response', ['read']);
      state = updateStagnation(state, 'Same response', ['read']);

      const score = getStagnationScore(state);

      // Should be capped at 1.0
      expect(score).toBeLessThanOrEqual(1.0);
      expect(score).toBeGreaterThan(0);
    });

    it('should not detect loop with insufficient data', () => {
      let state = createStagnationState(5, 10);

      state = updateStagnation(state, 'R1', ['read']);
      state = updateStagnation(state, 'R2', ['write']);

      const score = getStagnationScore(state);

      // Not enough data to detect pattern
      expect(score).toBe(0);
    });

    it('BUG CANDIDATE: single tool call sequence detection', () => {
      // The loop detection requires at least 4 tool calls
      // But the "same tool 3x" check only looks at last 3
      let state = createStagnationState(5, 10);

      // Only 2 tool calls - should not trigger
      state = updateStagnation(state, 'R1', ['read']);
      state = updateStagnation(state, 'R2', ['read']);

      const score = getStagnationScore(state);

      // Needs 3 calls to trigger the "same tool" detection
      expect(score).toBe(0);
    });
  });
});
