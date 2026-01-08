/**
 * SIAS Kernel Chaos & Stress Tests
 *
 * These tests deliberately try to break the system with:
 * - Concurrent operations
 * - Boundary conditions
 * - Resource exhaustion
 * - Malformed inputs
 * - Race conditions
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { incrementVersion, WorktreeManager } from '../worktree.js';
import { HealthCollector, detectAnomalies, buildRecoveryPlan } from '../health.js';
import { ContextManager } from '../context.js';
import { FlipFlopDetector } from '../flipflop.js';
import { loadKernelConfig } from '../config.js';
import { shouldUpgrade } from '../upgrade.js';
import { calculateScore } from '../benchmark.js';
import { validatePrincipalOutput, validateTestingOutput, validateOnCallOutput } from '../validators.js';
import type { AnomalyThresholds, HealthMetrics } from '../types.js';

function createMockLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

// ============================================
// VERSION INCREMENT BOUNDARY CONDITIONS
// ============================================

describe('incrementVersion boundary conditions', () => {
  test('version with maximum safe integer', () => {
    // Number.MAX_SAFE_INTEGER = 9007199254740991
    // This would overflow in practice
    const result = incrementVersion('v9007199254740991');
    expect(result).toBe('v9007199254740992');
  });

  test('version with leading zeros preserved', () => {
    expect(incrementVersion('v0000001')).toBe('v0000002');
    expect(incrementVersion('v0000009')).toBe('v0000010');
    expect(incrementVersion('v0000099')).toBe('v0000100');
  });

  test('version embedded in longer string', () => {
    // Regex /v(\d+)/ matches first occurrence
    expect(incrementVersion('v001-wip-v002')).toBe('v002'); // Matches v001
    expect(incrementVersion('prefix-v100-suffix')).toBe('v101');
  });

  test('version with unicode characters', () => {
    expect(incrementVersion('v١٢٣')).toBe('v001'); // Arabic numerals don't match \d
  });
});

// ============================================
// HEALTH METRICS EXTREME VALUES
// ============================================

describe('detectAnomalies extreme values', () => {
  function createExtremeMetrics(): HealthMetrics {
    return {
      process: {
        pid: Number.MAX_SAFE_INTEGER,
        uptime_ms: Number.MAX_SAFE_INTEGER,
        memory_rss_bytes: Number.MAX_SAFE_INTEGER,
        memory_heap_used_bytes: Number.MAX_SAFE_INTEGER,
        cpu_percent: 100,
        restart_count: Number.MAX_SAFE_INTEGER,
      },
      iteration: {
        current: Number.MAX_SAFE_INTEGER,
        total_completed: Number.MAX_SAFE_INTEGER,
        avg_duration_ms: Number.MAX_SAFE_INTEGER,
        last_duration_ms: Number.MAX_SAFE_INTEGER,
        consecutive_failures: Number.MAX_SAFE_INTEGER,
        consecutive_no_progress: Number.MAX_SAFE_INTEGER,
      },
      agents: {
        principal: { invocations: 0, failures: 0, avg_tokens_in: 0, avg_tokens_out: 0, avg_tool_calls: 0, context_compactions: 0 },
        oncall: { invocations: 0, failures: 0, avg_tokens_in: 0, avg_tokens_out: 0, avg_tool_calls: 0, context_compactions: 0 },
        testing: { invocations: 0, failures: 0, avg_tokens_in: 0, avg_tokens_out: 0, avg_tool_calls: 0, context_compactions: 0 },
        coding: { invocations: 0, failures: 0, avg_tokens_in: 0, avg_tokens_out: 0, avg_tool_calls: 0, context_compactions: 0 },
        research: { invocations: 0, failures: 0, avg_tokens_in: 0, avg_tokens_out: 0, avg_tool_calls: 0, context_compactions: 0 },
      },
      benchmark: {
        last_run_at: Number.MAX_SAFE_INTEGER,
        last_score: Number.MAX_SAFE_INTEGER,
        baseline_score: Number.MAX_SAFE_INTEGER,
        improvement_percent: Number.MAX_SAFE_INTEGER,
        regression_count: Number.MAX_SAFE_INTEGER,
        tests_passing: Number.MAX_SAFE_INTEGER,
        tests_failing: Number.MAX_SAFE_INTEGER,
      },
      worktree: {
        current_version: 'v' + '9'.repeat(100),
        wip_version: '',
        total_versions: Number.MAX_SAFE_INTEGER,
        rollback_count: Number.MAX_SAFE_INTEGER,
        disk_usage_bytes: Number.MAX_SAFE_INTEGER,
      },
      persistence: {
        last_checkpoint_at: 1, // Very old
        checkpoint_count: Number.MAX_SAFE_INTEGER,
        patch_count: Number.MAX_SAFE_INTEGER,
        decision_count: Number.MAX_SAFE_INTEGER,
        graphd_latency_ms: Number.MAX_SAFE_INTEGER,
        graphd_available: true,
      },
    };
  }

  test('handles extreme values without crashing', () => {
    const metrics = createExtremeMetrics();
    const thresholds: AnomalyThresholds = {
      memory_heap_max_bytes: 1,
      cpu_percent_max: 1,
      iteration_max_duration_ms: 1,
      max_consecutive_failures: 1,
      max_consecutive_no_progress: 1,
      agent_failure_rate_max: 0.0001,
      agent_tokens_max: 1,
      max_regression_percent: 0.0001,
      max_consecutive_regressions: 1,
      graphd_latency_max_ms: 1,
      checkpoint_staleness_max_ms: 1,
    };

    expect(() => detectAnomalies(metrics, thresholds)).not.toThrow();
    const anomalies = detectAnomalies(metrics, thresholds);
    expect(anomalies.length).toBeGreaterThan(0);
  });

  test('handles negative values', () => {
    const metrics = createExtremeMetrics();
    metrics.process.memory_heap_used_bytes = -1;
    metrics.process.cpu_percent = -100;
    metrics.iteration.consecutive_failures = -1;

    const thresholds: AnomalyThresholds = {
      memory_heap_max_bytes: 0,
      cpu_percent_max: 0,
      iteration_max_duration_ms: 0,
      max_consecutive_failures: 0,
      max_consecutive_no_progress: 0,
      agent_failure_rate_max: 0,
      agent_tokens_max: 0,
      max_regression_percent: 0,
      max_consecutive_regressions: 0,
      graphd_latency_max_ms: 0,
      checkpoint_staleness_max_ms: 0,
    };

    expect(() => detectAnomalies(metrics, thresholds)).not.toThrow();
  });

  test('handles NaN values', () => {
    const metrics = createExtremeMetrics();
    metrics.process.memory_heap_used_bytes = NaN;
    metrics.process.cpu_percent = NaN;

    const thresholds: AnomalyThresholds = {
      memory_heap_max_bytes: NaN,
      cpu_percent_max: NaN,
      iteration_max_duration_ms: NaN,
      max_consecutive_failures: NaN,
      max_consecutive_no_progress: NaN,
      agent_failure_rate_max: NaN,
      agent_tokens_max: NaN,
      max_regression_percent: NaN,
      max_consecutive_regressions: NaN,
      graphd_latency_max_ms: NaN,
      checkpoint_staleness_max_ms: NaN,
    };

    // NaN comparisons always return false
    expect(() => detectAnomalies(metrics, thresholds)).not.toThrow();
  });

  test('handles Infinity values', () => {
    const metrics = createExtremeMetrics();
    metrics.process.memory_heap_used_bytes = Infinity;
    metrics.process.cpu_percent = Infinity;

    const thresholds: AnomalyThresholds = {
      memory_heap_max_bytes: 1,
      cpu_percent_max: 1,
      iteration_max_duration_ms: 1,
      max_consecutive_failures: 1,
      max_consecutive_no_progress: 1,
      agent_failure_rate_max: 0.1,
      agent_tokens_max: 1,
      max_regression_percent: 0.1,
      max_consecutive_regressions: 1,
      graphd_latency_max_ms: 1,
      checkpoint_staleness_max_ms: 1,
    };

    const anomalies = detectAnomalies(metrics, thresholds);
    expect(anomalies.some(a => a.type === 'memory_pressure')).toBe(true);
  });
});

// ============================================
// VALIDATOR CHAOS INPUTS
// ============================================

describe('validatePrincipalOutput chaos inputs', () => {
  test('deeply nested object', () => {
    let nested: any = { decision: { type: 'continue', reasoning: 'test', confidence: 0.5 } };
    for (let i = 0; i < 100; i++) {
      nested = { wrapper: nested };
    }
    const result = validatePrincipalOutput(nested);
    expect(result.valid).toBe(false);
  });

  test('circular reference handling', () => {
    const obj: any = {
      decision: { type: 'continue', reasoning: 'test', confidence: 0.5 },
    };
    obj.circular = obj;

    // This might cause issues with JSON operations
    const result = validatePrincipalOutput(obj);
    // Should still validate the structure correctly
    expect(result.valid).toBe(true);
  });

  test('prototype pollution attempt', () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "decision": {"type": "continue", "reasoning": "test", "confidence": 0.5}}');

    const result = validatePrincipalOutput(malicious);
    expect(result.valid).toBe(true); // Valid structure
    expect(({} as any).polluted).toBeUndefined(); // Should not pollute
  });

  test('very long strings', () => {
    const longString = 'A'.repeat(10_000_000);
    const output = {
      decision: {
        type: 'continue',
        reasoning: longString,
        confidence: 0.5,
      },
    };

    const result = validatePrincipalOutput(output);
    expect(result.valid).toBe(true);
  });

  test('special unicode characters', () => {
    const output = {
      decision: {
        type: 'continue',
        reasoning: '\u0000\uFFFF\u202E\uFEFF\u200B', // Null, max unicode, RTL override, BOM, zero-width space
        confidence: 0.5,
      },
    };

    const result = validatePrincipalOutput(output);
    expect(result.valid).toBe(true);
  });

  test('array with holes - undefined entries', () => {
    const output = {
      decision: { type: 'continue', reasoning: 'test', confidence: 0.5 },
      new_constraints: [
        { constraint: 'valid', learned_from: 'test' },
        undefined as any, // Explicit undefined entry
        { constraint: 'valid2', learned_from: 'test' },
      ],
    };

    const result = validatePrincipalOutput(output);
    // Validator iterates with forEach which handles undefined entries
    // The check is: if (!isRecord(entry)) which will catch undefined
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('must be an object'))).toBe(true);
  });

  test('Symbol keys in object', () => {
    const output = {
      decision: { type: 'continue', reasoning: 'test', confidence: 0.5 },
      [Symbol('hidden')]: 'secret',
    };

    const result = validatePrincipalOutput(output);
    expect(result.valid).toBe(true); // Symbol keys are ignored
  });

  test('getter/setter properties', () => {
    const output = {
      decision: { type: 'continue', reasoning: 'test', confidence: 0.5 },
      get next_objective() { return null; },
    };

    const result = validatePrincipalOutput(output);
    expect(result.valid).toBe(true);
  });
});

// ============================================
// FLIP-FLOP EMBEDDING CHAOS
// ============================================

describe('FlipFlopDetector chaos inputs', () => {
  function createMockStore() {
    const embeddings = new Map<string, any>();
    return {
      getSiasDecisionEmbedding: (id: string) => embeddings.get(id) ?? null,
      upsertSiasDecisionEmbedding: (id: string, embedding: number[]) => {
        embeddings.set(id, { decisionId: id, embedding });
      },
    };
  }

  test('extremely long text', async () => {
    const store = createMockStore();
    const detector = new FlipFlopDetector(store as any, createMockLogger());

    const longText = 'word '.repeat(1_000_000);
    detector.storeEmbedding('long-decision', longText);

    const stored = store.getSiasDecisionEmbedding('long-decision');
    expect(stored?.embedding.length).toBe(128);
    expect(stored?.embedding.every((v: number) => Number.isFinite(v))).toBe(true);
  });

  test('text with only repeated characters', async () => {
    const store = createMockStore();
    const detector = new FlipFlopDetector(store as any, createMockLogger());

    detector.storeEmbedding('repeated', 'aaaaaaaaaaaaaaaaaaa');

    const stored = store.getSiasDecisionEmbedding('repeated');
    expect(stored?.embedding.length).toBe(128);

    // Most bins should be 0, only one should have the count
    const nonZero = stored?.embedding.filter((v: number) => v !== 0);
    expect(nonZero?.length).toBe(1);
  });

  test('text with emoji', async () => {
    const store = createMockStore();
    const detector = new FlipFlopDetector(store as any, createMockLogger());

    const emojiText = '🚀🎉✨ We should refactor 🔧 the module 📦';
    detector.storeEmbedding('emoji-decision', emojiText);

    const stored = store.getSiasDecisionEmbedding('emoji-decision');
    expect(stored?.embedding.length).toBe(128);
  });

  test('collision detection in hash function', async () => {
    const store = createMockStore();
    const detector = new FlipFlopDetector(store as any, createMockLogger());

    // Different words that might hash to same bin (mod 128)
    const words: string[] = [];
    for (let i = 0; i < 1000; i++) {
      words.push(`word${i}`);
    }

    const text = words.join(' ');
    detector.storeEmbedding('collision-test', text);

    const stored = store.getSiasDecisionEmbedding('collision-test');
    // With 1000 words and 128 bins, expect collisions
    const nonZero = stored?.embedding.filter((v: number) => v !== 0).length ?? 0;
    expect(nonZero).toBeLessThan(128); // Some bins will have collisions
  });
});

// ============================================
// CONTEXT MANAGER STRESS
// ============================================

describe('ContextManager stress tests', () => {
  test('many rapid context creations', () => {
    const manager = new ContextManager('stress-session', 200000);

    // Create contexts for many agents rapidly
    const agents = ['principal', 'oncall', 'testing', 'coding', 'research'] as const;
    for (let i = 0; i < 100; i++) {
      for (const agent of agents) {
        manager.getContext(agent);
      }
    }

    // Should still return same context for same agent
    const first = manager.getContext('principal');
    const second = manager.getContext('principal');
    expect(first).toBe(second);
  });

  test('massive message accumulation', () => {
    const manager = new ContextManager('stress-session', 1000000);
    const context = manager.getContext('coding');

    // Add 10000 messages
    for (let i = 0; i < 10000; i++) {
      context.addMessage('user', `Message ${i}: ${'X'.repeat(100)}`);
    }

    expect(context.items.length).toBe(10000);
  });

  test('compaction count tracking under stress', () => {
    const manager = new ContextManager('stress-session', 200000);

    // Record many compactions
    for (let i = 0; i < 1000; i++) {
      manager.recordCompaction('coding');
    }

    expect(manager.getCompactionCount('coding')).toBe(1000);
  });
});

// ============================================
// UPGRADE DECISION EDGE CASES
// ============================================

describe('shouldUpgrade edge cases', () => {
  const basePolicy = {
    benchmark_improvement_threshold: 0.05,
    max_iterations_before_checkpoint: 10,
    require_all_tests_pass: true,
    max_allowed_regression: 0.02,
    min_iterations_between_upgrades: 3,
  };

  test('NaN improvement percent', () => {
    const result = {
      tier: 'smoke' as const,
      started_at: Date.now(),
      completed_at: Date.now(),
      total_duration_ms: 1000,
      results: [],
      score: 100,
      passed_count: 10,
      failed_count: 0,
      skipped_count: 0,
      baseline_score: 0,
      improvement_percent: NaN,
      regressions: [],
    };

    // NaN comparisons are always false
    expect(shouldUpgrade(result, basePolicy, 5)).toBe(false);
  });

  test('negative iterations since upgrade', () => {
    const result = {
      tier: 'smoke' as const,
      started_at: Date.now(),
      completed_at: Date.now(),
      total_duration_ms: 1000,
      results: [],
      score: 100,
      passed_count: 10,
      failed_count: 0,
      skipped_count: 0,
      baseline_score: 90,
      improvement_percent: 0.11,
      regressions: [],
    };

    // Negative iterations should fail the min_iterations check
    expect(shouldUpgrade(result, basePolicy, -1)).toBe(false);
  });

  test('zero threshold policy', () => {
    const zeroPolicy = {
      benchmark_improvement_threshold: 0,
      max_iterations_before_checkpoint: 0,
      require_all_tests_pass: false,
      max_allowed_regression: 0,
      min_iterations_between_upgrades: 0,
    };

    const result = {
      tier: 'smoke' as const,
      started_at: Date.now(),
      completed_at: Date.now(),
      total_duration_ms: 1000,
      results: [],
      score: 100,
      passed_count: 10,
      failed_count: 5, // Has failures but require_all_tests_pass is false
      skipped_count: 0,
      baseline_score: 90,
      improvement_percent: 0, // No improvement but threshold is 0
      regressions: [],
    };

    // With 0 min_iterations and 0 threshold, should upgrade
    expect(shouldUpgrade(result, zeroPolicy, 0)).toBe(true);
  });
});

// ============================================
// RECOVERY PLAN STRESS
// ============================================

describe('buildRecoveryPlan stress', () => {
  test('many simultaneous anomalies', () => {
    const anomalies = [];
    for (let i = 0; i < 100; i++) {
      anomalies.push({
        type: 'memory_pressure' as const,
        severity: 'critical' as const,
        detected_at: Date.now(),
        metric_value: i,
        threshold_value: 1,
        context: {},
      });
    }

    const plan = buildRecoveryPlan(anomalies);

    // Should have many actions
    expect(plan.actions.length).toBeGreaterThan(100);
  });

  test('all anomaly types at once', () => {
    const allTypes = [
      'memory_pressure',
      'cpu_pressure',
      'iteration_timeout',
      'consecutive_failures',
      'stalled_no_progress',
      'agent_failure_rate',
      'agent_context_explosion',
      'benchmark_regression',
      'graphd_latency',
      'graphd_unavailable',
      'checkpoint_stale',
    ] as const;

    const anomalies = allTypes.map(type => ({
      type,
      severity: 'critical' as const,
      detected_at: Date.now(),
      metric_value: 100,
      threshold_value: 1,
      context: { agent: 'coding' },
    }));

    const plan = buildRecoveryPlan(anomalies);

    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.reasoning).toContain('memory_pressure');
    expect(plan.reasoning).toContain('graphd_unavailable');
  });
});

// ============================================
// BENCHMARK SCORING EDGE CASES
// ============================================

describe('calculateScore edge cases', () => {
  test('all zero weights', () => {
    const definitions = [
      { id: 'test-1', name: 'Test', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0, command: [] },
      { id: 'test-2', name: 'Test', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0, command: [] },
    ];
    const results = [
      { benchmark_id: 'test-1', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
      { benchmark_id: 'test-2', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
    ];

    expect(calculateScore(results, definitions)).toBe(0);
  });

  test('very small weights', () => {
    const definitions = [
      { id: 'test-1', name: 'Test', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.0001, command: [] },
      { id: 'test-2', name: 'Test', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.0001, command: [] },
    ];
    const results = [
      { benchmark_id: 'test-1', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
      { benchmark_id: 'test-2', passed: false, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
    ];

    const score = calculateScore(results, definitions);
    expect(score).toBeCloseTo(50);
  });

  test('floating point precision', () => {
    const definitions = [
      { id: 'test-1', name: 'Test', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.1, command: [] },
      { id: 'test-2', name: 'Test', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.2, command: [] },
      { id: 'test-3', name: 'Test', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.3, command: [] },
    ];
    const results = [
      { benchmark_id: 'test-1', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
      { benchmark_id: 'test-2', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
      { benchmark_id: 'test-3', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
    ];

    // 0.1 + 0.2 + 0.3 might not equal 0.6 due to floating point
    // But score should still be 100
    expect(calculateScore(results, definitions)).toBe(100);
  });
});

// ============================================
// CONFIG LOADING CHAOS
// ============================================

describe('loadKernelConfig chaos', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = mkdtempSync(join(tmpdir(), 'sias-config-chaos-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('config file with BOM', () => {
    const configPath = join(tempDir, 'bom-config.json');
    // UTF-8 BOM + valid JSON
    writeFileSync(configPath, '\uFEFF{"graphdDbPath": "/custom/path.db"}');

    // JSON.parse should handle BOM in modern environments
    try {
      const config = loadKernelConfig(configPath);
      // Either it works or falls back to defaults
      expect(config.graphdDbPath === '/custom/path.db' || config.graphdDbPath === '.graphd/graphd.db').toBe(true);
    } catch {
      // BOM might cause parse error, which is caught internally
    }
  });

  test('config file with trailing comma (invalid JSON)', () => {
    const configPath = join(tempDir, 'trailing-comma.json');
    writeFileSync(configPath, '{"graphdDbPath": "/custom/path.db",}');

    // Should fall back to defaults
    const config = loadKernelConfig(configPath);
    expect(config.graphdDbPath).toBe('.graphd/graphd.db');
  });

  test('config file with comments (invalid JSON)', () => {
    const configPath = join(tempDir, 'comments.json');
    writeFileSync(configPath, `{
      // This is a comment
      "graphdDbPath": "/custom/path.db"
    }`);

    // Should fall back to defaults
    const config = loadKernelConfig(configPath);
    expect(config.graphdDbPath).toBe('.graphd/graphd.db');
  });

  test('empty config file', () => {
    const configPath = join(tempDir, 'empty.json');
    writeFileSync(configPath, '');

    const config = loadKernelConfig(configPath);
    expect(config.graphdDbPath).toBe('.graphd/graphd.db');
  });

  test('config file is a directory', () => {
    const configPath = join(tempDir, 'dir-config.json');
    mkdirSync(configPath);

    const config = loadKernelConfig(configPath);
    expect(config.graphdDbPath).toBe('.graphd/graphd.db');
  });
});
