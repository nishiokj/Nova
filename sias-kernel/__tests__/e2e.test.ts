/**
 * SIAS Kernel End-to-End Tests
 *
 * These tests actually boot the kernel components and verify the system
 * can wire up and run without runtime errors.
 *
 * Requirements:
 * - Fresh GraphStore (no schema mismatch)
 * - Mocked LLM (no real API calls)
 * - Isolated file system
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Import kernel components
import { GraphStore, generateSessionKey } from '../../packages/graphd/src/index.js';
import { ToolRegistry } from '../../packages/agent-core/src/tools/registry.js';
import { builtinToolOptions } from '../../packages/agent-core/src/tools/builtins/index.js';
import { createLogger } from '../../packages/agent-core/src/shared/logger.js';

import { loadKernelConfig } from '../config.js';
import { WorktreeManager } from '../worktree.js';
import { HealthCollector, detectAnomalies, buildRecoveryPlan } from '../health.js';
import { ContextManager } from '../context.js';
import { FlipFlopDetector } from '../flipflop.js';
import { restoreCheckpoint, persistCheckpoint } from '../checkpoint.js';
import { createKernelAgentRegistry } from '../agents.js';
import { BenchmarkRunner } from '../benchmark.js';
import { shouldUpgrade } from '../upgrade.js';
import type { SIASState, IterationResult } from '../types.js';

function createMockLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

describe('E2E: Kernel Boot Sequence', () => {
  let tempDir: string;
  let dbPath: string;
  let worktreeDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sias-e2e-'));
    dbPath = join(tempDir, 'graphd.db');
    worktreeDir = join(tempDir, 'worktrees');
    mkdirSync(worktreeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('GraphStore initializes fresh database', () => {
    const store = new GraphStore(dbPath);

    expect(() => store.initialize()).not.toThrow();
    expect(existsSync(dbPath)).toBe(true);

    store.close();
  });

  test('Session can be created and retrieved', () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const sessionId = generateSessionKey('test');
    const created = store.createSiasSession(sessionId);

    expect(created).toBe(true);

    const session = store.getSiasSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(sessionId);

    store.close();
  });

  test('WorktreeManager initializes with fresh session', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const sessionId = generateSessionKey('test');
    store.createSiasSession(sessionId);

    const logger = createMockLogger();
    const manager = new WorktreeManager(store as any, sessionId, logger as any, {
      baseDir: worktreeDir,
      maxVersionsToKeep: 3,
    });

    const version = await manager.getCurrentVersion();
    expect(version).toBe('v000');

    const wipVersion = await manager.getWipVersion();
    expect(wipVersion).toBe('v001-wip');

    store.close();
  });

  test('Checkpoint can be created and restored', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const sessionId = generateSessionKey('test');
    store.createSiasSession(sessionId);

    // Restore from empty (should create default state)
    const initialState = await restoreCheckpoint(store, sessionId, 'v000');

    expect(initialState.sessionId).toBe(sessionId);
    expect(initialState.iteration).toBe(0);
    expect(initialState.currentFocus).toBe('Initialize kernel objectives');

    // Modify and persist
    const modifiedState: SIASState = {
      ...initialState,
      iteration: 5,
      currentFocus: 'Test focus',
      learnedConstraints: ['Constraint 1'],
      patchSummary: 'Test patches',
    };

    await persistCheckpoint(store, modifiedState);

    // Restore and verify
    const restoredState = await restoreCheckpoint(store, sessionId, 'v000');
    expect(restoredState.iteration).toBe(5);
    expect(restoredState.currentFocus).toBe('Test focus');
    expect(restoredState.learnedConstraints).toEqual(['Constraint 1']);

    store.close();
  });

  test('HealthCollector tracks metrics correctly', async () => {
    const logger = createMockLogger();
    const health = new HealthCollector(logger as any, 'v001');

    // Record some activity
    health.recordIteration(1000, true, true);
    health.recordAgentInvocation('coding', {
      success: true,
      tokens_in: 1000,
      tokens_out: 500,
      tool_calls: 10,
    });

    const snapshot = await health.collectSnapshot();

    expect(snapshot.process.pid).toBe(process.pid);
    expect(snapshot.iteration.total_completed).toBe(1);
    expect(snapshot.agents.coding.invocations).toBe(1);
    expect(snapshot.agents.coding.avg_tokens_in).toBe(1000);
  });

  test('ContextManager creates and manages agent contexts', () => {
    const manager = new ContextManager('test-session', 200000);

    const codingCtx = manager.getContext('coding');
    const principalCtx = manager.getContext('principal');

    expect(codingCtx).toBeDefined();
    expect(principalCtx).toBeDefined();
    expect(codingCtx).not.toBe(principalCtx);

    codingCtx.addMessage('user', 'Test message');
    expect(codingCtx.items.length).toBe(1);
    expect(principalCtx.items.length).toBe(0);
  });

  test('FlipFlopDetector stores and retrieves embeddings', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const logger = createMockLogger();
    const detector = new FlipFlopDetector(store, logger as any);

    detector.storeEmbedding('test-decision', 'We should refactor the auth module');

    const result = await detector.checkForFlipFlop('New decision', []);
    expect(result.is_flip_flop).toBe(false);

    store.close();
  });

  test('Config loads with defaults', () => {
    const config = loadKernelConfig();

    expect(config.graphdDbPath).toBeDefined();
    expect(config.log.level).toBeDefined();
    expect(config.agents.principal).toBeDefined();
    expect(config.agents.coding).toBeDefined();
    expect(config.health.thresholds).toBeDefined();
    expect(config.upgradePolicy).toBeDefined();
  });

  test('ToolRegistry loads builtin tools', () => {
    const registry = new ToolRegistry({
      enabledTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    }, process.cwd());

    for (const tool of builtinToolOptions) {
      registry.register(tool);
    }

    // Verify tools are registered
    const tools = registry.list(true); // enabledOnly = true
    expect(tools.length).toBeGreaterThan(0);
    expect(registry.get('Read')).toBeDefined();
    expect(registry.get('Write')).toBeDefined();
    expect(registry.get('Bash')).toBeDefined();
  });

  test('AgentRegistry creates kernel agents', () => {
    const config = loadKernelConfig();
    const registry = createKernelAgentRegistry(config);

    // Verify all agents are registered
    expect(() => registry.getRuntimeConfig('principal')).not.toThrow();
    expect(() => registry.getRuntimeConfig('oncall')).not.toThrow();
    expect(() => registry.getRuntimeConfig('testing')).not.toThrow();
    expect(() => registry.getRuntimeConfig('coding')).not.toThrow();

    const principalConfig = registry.getRuntimeConfig('principal');
    expect(principalConfig.config.type).toBe('principal');
    expect(principalConfig.config.tools).toEqual(['Read', 'Glob', 'Grep']);
  });
});

describe('E2E: Health & Observability Flow', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sias-health-e2e-'));
    dbPath = join(tempDir, 'graphd.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('Full health check → anomaly detection → recovery plan flow', async () => {
    const logger = createMockLogger();
    const health = new HealthCollector(logger as any, 'v001');

    // Simulate problematic conditions
    for (let i = 0; i < 5; i++) {
      health.recordIteration(60000, false, false); // Long, failed, no progress
    }

    const snapshot = await health.collectSnapshot();
    const config = loadKernelConfig();

    // Anomaly detection
    const anomalies = detectAnomalies(snapshot, config.health.thresholds);

    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies.some(a => a.type === 'consecutive_failures')).toBe(true);
    expect(anomalies.some(a => a.type === 'stalled_no_progress')).toBe(true);

    // Recovery plan
    const plan = buildRecoveryPlan(anomalies);

    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions.some(a => a.type === 'escalate_to_oncall')).toBe(true);
  });

  test('Worktree health tracking', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const sessionId = generateSessionKey('test');
    store.createSiasSession(sessionId);

    const logger = createMockLogger();
    const worktreeDir = join(tempDir, 'worktrees');
    mkdirSync(worktreeDir, { recursive: true });

    const worktreeManager = new WorktreeManager(store as any, sessionId, logger as any, {
      baseDir: worktreeDir,
      maxVersionsToKeep: 3,
    });

    const health = new HealthCollector(logger as any, 'v001');

    // Record worktree state
    const currentVersion = await worktreeManager.getCurrentVersion();
    const wipVersion = await worktreeManager.getWipVersion();
    const totalVersions = store.listSiasWorktrees().length;

    health.recordWorktree(currentVersion, wipVersion, totalVersions, 0);

    const snapshot = await health.collectSnapshot();
    expect(snapshot.worktree.current_version).toBe('v000');
    expect(snapshot.worktree.wip_version).toBe('v001-wip');

    store.close();
  });

  test('GraphD latency tracking', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const logger = createMockLogger();
    const health = new HealthCollector(logger as any, 'v001');

    // Simulate GraphD operations with timing
    const start = Date.now();
    store.createSiasSession(generateSessionKey('test'));
    const latency = Date.now() - start;

    health.recordGraphdLatency(latency, true);

    const snapshot = await health.collectSnapshot();
    expect(snapshot.persistence.graphd_latency_ms).toBe(latency);
    expect(snapshot.persistence.graphd_available).toBe(true);

    store.close();
  });
});

describe('E2E: Upgrade Decision Flow', () => {
  test('Upgrade decision with real benchmark results', () => {
    const config = loadKernelConfig();
    const policy = config.upgradePolicy;

    // Scenario: Good benchmark results
    const goodResult = {
      tier: 'smoke' as const,
      started_at: Date.now(),
      completed_at: Date.now() + 5000,
      total_duration_ms: 5000,
      results: [],
      score: 100,
      passed_count: 10,
      failed_count: 0,
      skipped_count: 0,
      baseline_score: 90,
      improvement_percent: 0.11, // 11% improvement
      regressions: [],
    };

    // Should upgrade with sufficient iterations
    expect(shouldUpgrade(goodResult, policy, 5)).toBe(true);

    // Should not upgrade too soon
    expect(shouldUpgrade(goodResult, policy, 1)).toBe(false);

    // Scenario: Test failure
    const failedResult = { ...goodResult, failed_count: 1 };
    expect(shouldUpgrade(failedResult, policy, 5)).toBe(false);

    // Scenario: Regression
    const regressionResult = { ...goodResult, improvement_percent: -0.05 };
    expect(shouldUpgrade(regressionResult, policy, 5)).toBe(false);
  });
});

describe('E2E: BenchmarkRunner Integration', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sias-bench-e2e-'));
    dbPath = join(tempDir, 'graphd.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('BenchmarkRunner initializes and stores results', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const sessionId = generateSessionKey('test');
    store.createSiasSession(sessionId); // Create session for FK constraint
    const logger = createMockLogger();

    // Create runner with minimal benchmarks
    const runner = new BenchmarkRunner(sessionId, store, logger as any, [
      {
        id: 'test-echo',
        name: 'Echo test',
        tier: 'smoke',
        category: 'correctness',
        timeout_ms: 5000,
        parallel_safe: true,
        requires: [],
        weight: 1.0,
        command: ['echo', 'hello'],
      },
    ]);

    const result = await runner.runTier('smoke');

    expect(result.tier).toBe('smoke');
    expect(result.results.length).toBe(1);
    expect(result.results[0].passed).toBe(true);
    expect(result.score).toBe(100);

    // Verify stored in GraphStore
    const runs = store.listSiasBenchmarkRuns(sessionId, 1);
    expect(runs.length).toBe(1);
    expect(runs[0].tier).toBe('smoke');

    store.close();
  });

  test('BenchmarkRunner handles failing benchmark', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const sessionId = generateSessionKey('test');
    store.createSiasSession(sessionId); // Create session for FK constraint
    const logger = createMockLogger();

    const runner = new BenchmarkRunner(sessionId, store, logger as any, [
      {
        id: 'test-fail',
        name: 'Failing test',
        tier: 'smoke',
        category: 'correctness',
        timeout_ms: 5000,
        parallel_safe: true,
        requires: [],
        weight: 1.0,
        command: ['false'], // Always exits 1
      },
    ]);

    const result = await runner.runTier('smoke');

    expect(result.results[0].passed).toBe(false);
    expect(result.failed_count).toBe(1);
    expect(result.score).toBe(0);

    store.close();
  });

  test('BenchmarkRunner respects dependencies', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const sessionId = generateSessionKey('test');
    store.createSiasSession(sessionId); // Create session for FK constraint
    const logger = createMockLogger();

    const runner = new BenchmarkRunner(sessionId, store, logger as any, [
      {
        id: 'parent',
        name: 'Parent test',
        tier: 'smoke',
        category: 'correctness',
        timeout_ms: 5000,
        parallel_safe: true,
        requires: [],
        weight: 0.5,
        command: ['false'], // Fails
      },
      {
        id: 'child',
        name: 'Child test',
        tier: 'smoke',
        category: 'correctness',
        timeout_ms: 5000,
        parallel_safe: true,
        requires: ['parent'], // Depends on parent
        weight: 0.5,
        command: ['echo', 'should not run'],
      },
    ]);

    const result = await runner.runTier('smoke');

    expect(result.results.find(r => r.benchmark_id === 'parent')?.passed).toBe(false);
    expect(result.results.find(r => r.benchmark_id === 'child')?.skipped).toBe(true);

    store.close();
  });
});

describe('E2E: Full Kernel Wire-up (Mocked LLM)', () => {
  let tempDir: string;
  let dbPath: string;
  let worktreeDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sias-kernel-e2e-'));
    dbPath = join(tempDir, 'graphd.db');
    worktreeDir = join(tempDir, 'worktrees');
    mkdirSync(worktreeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('Kernel components wire up without errors', async () => {
    // 1. Initialize GraphStore
    const store = new GraphStore(dbPath);
    store.initialize();

    // 2. Create session
    const sessionId = generateSessionKey('e2e-test');
    store.createSiasSession(sessionId);

    // 3. Load config
    const config = loadKernelConfig();

    // 4. Create logger
    const logger = createMockLogger();

    // 5. Create WorktreeManager
    const worktreeManager = new WorktreeManager(store as any, sessionId, logger as any, {
      baseDir: worktreeDir,
      maxVersionsToKeep: 5,
    });

    // 6. Restore checkpoint (creates initial state)
    const currentVersion = await worktreeManager.getCurrentVersion();
    const state = await restoreCheckpoint(store, sessionId, currentVersion);

    expect(state.sessionId).toBe(sessionId);
    expect(state.iteration).toBe(0);

    // 7. Create ToolRegistry
    const toolRegistry = new ToolRegistry({
      enabledTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    }, process.cwd());

    for (const tool of builtinToolOptions) {
      toolRegistry.register(tool);
    }

    // 8. Create AgentRegistry
    const agentRegistry = createKernelAgentRegistry(config);

    // 9. Create ContextManager
    const contextManager = new ContextManager(sessionId, 200000);

    // 10. Create HealthCollector
    const health = new HealthCollector(logger as any, currentVersion);

    // 11. Create BenchmarkRunner
    const benchmarkRunner = new BenchmarkRunner(sessionId, store, logger as any, [
      {
        id: 'e2e-smoke',
        name: 'E2E smoke test',
        tier: 'smoke',
        category: 'correctness',
        timeout_ms: 5000,
        parallel_safe: true,
        requires: [],
        weight: 1.0,
        command: ['echo', 'ok'],
      },
    ]);

    // 12. Create FlipFlopDetector
    const flipFlopDetector = new FlipFlopDetector(store, logger as any);

    // 13. Run a benchmark
    const benchmarkResult = await benchmarkRunner.runTier('smoke');
    expect(benchmarkResult.passed_count).toBe(1);

    // 14. Record health metrics
    health.recordIteration(1000, true, true);
    health.recordBenchmark(
      benchmarkResult.score,
      benchmarkResult.baseline_score,
      benchmarkResult.passed_count,
      benchmarkResult.failed_count
    );

    // 15. Collect health snapshot
    const healthSnapshot = await health.collectSnapshot();
    expect(healthSnapshot.iteration.total_completed).toBe(1);

    // 16. Check for anomalies (should be none)
    const anomalies = detectAnomalies(healthSnapshot, config.health.thresholds);
    expect(anomalies.length).toBe(0);

    // 17. Update state
    state.iteration = 1;
    state.currentFocus = 'E2E test completed';
    state.patchSummary = 'Iteration 1 completed successfully';

    // 18. Persist checkpoint
    await persistCheckpoint(store, state);

    // 19. Verify persistence
    const checkpoints = store.listSiasCheckpoints(sessionId, 1);
    expect(checkpoints.length).toBe(1);

    // 20. Store decision
    store.upsertSiasDecision({
      decisionId: `decision-${sessionId}-1`,
      sessionId,
      iteration: 1,
      agent: 'principal',
      decisionType: 'continue',
      reasoning: 'E2E test - proceeding normally',
      outcome: 'continue',
      relatedDecisionsJson: null,
      createdAt: Date.now() / 1000,
    });

    // 21. Store decision embedding
    flipFlopDetector.storeEmbedding(`decision-${sessionId}-1`, 'E2E test - proceeding normally');

    // 22. Record worktree state
    const wipVersion = await worktreeManager.getWipVersion();
    health.recordWorktree(currentVersion, wipVersion, store.listSiasWorktrees().length, 0);

    // 23. Final health check
    const finalSnapshot = await health.collectSnapshot();
    expect(finalSnapshot.worktree.current_version).toBe('v000');

    // All done - close store
    store.close();
  });

  test('Kernel handles simulated iteration failure gracefully', async () => {
    const store = new GraphStore(dbPath);
    store.initialize();

    const sessionId = generateSessionKey('fail-test');
    store.createSiasSession(sessionId);

    const config = loadKernelConfig();
    const logger = createMockLogger();

    const health = new HealthCollector(logger as any, 'v000');

    // Simulate 3 consecutive failures
    health.recordIteration(5000, false, false);
    health.recordIteration(5000, false, false);
    health.recordIteration(5000, false, false);

    const snapshot = await health.collectSnapshot();
    const anomalies = detectAnomalies(snapshot, config.health.thresholds);

    // Should detect consecutive failures
    expect(anomalies.some(a => a.type === 'consecutive_failures')).toBe(true);

    // Build recovery plan
    const plan = buildRecoveryPlan(anomalies);

    // Should include escalation
    expect(plan.actions.some(a => a.type === 'escalate_to_oncall')).toBe(true);

    store.close();
  });
});
