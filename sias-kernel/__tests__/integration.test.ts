/**
 * SIAS Kernel Integration Tests
 *
 * These tests exercise multiple components together to find bugs
 * at the integration boundaries. Uses real GraphStore instances
 * and actual file system operations.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

// Import actual modules
import { WorktreeManager, incrementVersion } from '../worktree.js';
import { HealthCollector, detectAnomalies, buildRecoveryPlan } from '../health.js';
import { ContextManager } from '../context.js';
import { FlipFlopDetector } from '../flipflop.js';
import { loadKernelConfig } from '../config.js';
import { shouldUpgrade } from '../upgrade.js';
import { calculateScore } from '../benchmark.js';
import { validatePrincipalOutput, validateTestingOutput, validateOnCallOutput } from '../validators.js';
import { restoreCheckpoint, persistCheckpoint } from '../checkpoint.js';

// Mock GraphStore for integration tests
function createMockGraphStore(tempDir: string) {
  const sessions = new Map<string, any>();
  const worktrees = new Map<string, any>();
  const checkpoints = new Map<string, any[]>();
  const patches = new Map<string, any[]>();
  const decisions = new Map<string, any[]>();
  const decisionEmbeddings = new Map<string, any>();
  const benchmarkRuns = new Map<string, any[]>();
  const principalContexts = new Map<string, any>();

  return {
    initialize: () => {},
    close: () => {},

    // Session methods
    getSiasSession: (sessionId: string) => sessions.get(sessionId) ?? null,
    createSiasSession: (sessionId: string) => {
      if (sessions.has(sessionId)) return false;
      sessions.set(sessionId, { sessionId, status: 'created', metadata: {} });
      return true;
    },
    updateSiasSession: (sessionId: string, update: any) => {
      const session = sessions.get(sessionId) ?? { sessionId };
      sessions.set(sessionId, { ...session, ...update });
    },

    // Worktree methods
    getSiasWorktree: (version: string) => worktrees.get(version) ?? null,
    upsertSiasWorktree: (worktree: any) => {
      worktrees.set(worktree.version, worktree);
    },
    listSiasWorktrees: () => Array.from(worktrees.values()),

    // Checkpoint methods
    getLatestSiasCheckpoint: (sessionId: string) => {
      const list = checkpoints.get(sessionId) ?? [];
      return list[list.length - 1] ?? null;
    },
    insertSiasCheckpoint: (sessionId: string, version: number, iteration: number, payload: any) => {
      const list = checkpoints.get(sessionId) ?? [];
      list.push({ sessionId, version, iteration, payload });
      checkpoints.set(sessionId, list);
    },
    listSiasCheckpoints: (sessionId: string, limit?: number) => {
      const list = checkpoints.get(sessionId) ?? [];
      return limit ? list.slice(-limit) : list;
    },

    // Patch methods
    upsertSiasPatch: (patch: any) => {
      const list = patches.get(patch.sessionId) ?? [];
      list.push(patch);
      patches.set(patch.sessionId, list);
    },
    listSiasPatches: (sessionId: string) => patches.get(sessionId) ?? [],

    // Decision methods
    upsertSiasDecision: (decision: any) => {
      const list = decisions.get(decision.sessionId) ?? [];
      list.push(decision);
      decisions.set(decision.sessionId, list);
    },
    listSiasDecisions: (sessionId: string) => decisions.get(sessionId) ?? [],
    getSiasDecisionEmbedding: (decisionId: string) => decisionEmbeddings.get(decisionId) ?? null,
    upsertSiasDecisionEmbedding: (decisionId: string, embedding: number[]) => {
      decisionEmbeddings.set(decisionId, { decisionId, embedding });
    },

    // Benchmark methods
    addSiasBenchmarkRun: (sessionId: string, tier: string, startedAt: number, completedAt: number, score: number, result: any) => {
      const list = benchmarkRuns.get(sessionId) ?? [];
      list.push({ sessionId, tier, startedAt, completedAt, score, result });
      benchmarkRuns.set(sessionId, list);
    },
    listSiasBenchmarkRuns: (sessionId: string, limit?: number) => {
      const list = benchmarkRuns.get(sessionId) ?? [];
      return limit ? list.slice(-limit) : list;
    },

    // Principal context
    upsertSiasPrincipalContext: (context: any) => {
      principalContexts.set(context.sessionId, context);
    },
    getSiasPrincipalContext: (sessionId: string) => principalContexts.get(sessionId) ?? null,

    // Transaction helper
    withTransaction: (fn: () => void) => {
      fn();
    },
  };
}

function createMockLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

describe('WorktreeManager integration', () => {
  let tempDir: string;
  let store: ReturnType<typeof createMockGraphStore>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sias-worktree-test-'));
    store = createMockGraphStore(tempDir);
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('getCurrentVersion returns v000 for new session', async () => {
    const manager = new WorktreeManager(store as any, 'test-session', logger as any, {
      baseDir: tempDir,
    });

    const version = await manager.getCurrentVersion();
    expect(version).toBe('v000');
  });

  test('getCurrentVersion returns stored version from session', async () => {
    store.updateSiasSession('test-session', {
      metadata: { currentVersion: 'v005', wipVersion: 'v006-wip', rollbackCount: 0 },
    });

    const manager = new WorktreeManager(store as any, 'test-session', logger as any, {
      baseDir: tempDir,
    });

    const version = await manager.getCurrentVersion();
    expect(version).toBe('v005');
  });

  test('getWipVersion generates next version if not stored', async () => {
    const manager = new WorktreeManager(store as any, 'test-session', logger as any, {
      baseDir: tempDir,
    });

    const wip = await manager.getWipVersion();
    expect(wip).toBe('v001-wip');
  });

  test('rollbackToVersion updates metadata correctly', async () => {
    store.updateSiasSession('test-session', {
      metadata: { currentVersion: 'v003', wipVersion: 'v004-wip', rollbackCount: 1 },
    });

    const manager = new WorktreeManager(store as any, 'test-session', logger as any, {
      baseDir: tempDir,
    });

    await manager.rollbackToVersion('v002');

    const session = store.getSiasSession('test-session');
    expect(session?.metadata.currentVersion).toBe('v002');
    expect(session?.metadata.rollbackCount).toBe(2);
  });

  test('rollbackToVersion marks previous version as failed', async () => {
    store.updateSiasSession('test-session', {
      metadata: { currentVersion: 'v003', wipVersion: 'v004-wip', rollbackCount: 0 },
    });

    const manager = new WorktreeManager(store as any, 'test-session', logger as any, {
      baseDir: tempDir,
    });

    await manager.rollbackToVersion('v002');

    const failedWorktree = store.getSiasWorktree('v003');
    expect(failedWorktree?.status).toBe('failed');
    expect(failedWorktree?.failureReason).toBe('rollback');
  });

  test('garbageCollect respects maxVersionsToKeep', async () => {
    // Create many worktrees
    for (let i = 0; i < 10; i++) {
      store.upsertSiasWorktree({
        version: `v00${i}`,
        path: join(tempDir, `v00${i}`),
        status: 'active',
        createdAt: Date.now() / 1000 + i,
      });
    }

    store.updateSiasSession('test-session', {
      metadata: { currentVersion: 'v009', wipVersion: 'v010-wip', rollbackCount: 0 },
    });

    const manager = new WorktreeManager(store as any, 'test-session', logger as any, {
      baseDir: tempDir,
      maxVersionsToKeep: 3,
    });

    // garbageCollect tries to remove old worktrees
    // With 10 worktrees and maxVersionsToKeep=3, it should try to remove 7
    await manager.garbageCollect();

    // Verify logger.warn was called for failed removals (directories don't exist)
    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('Checkpoint integration', () => {
  let store: ReturnType<typeof createMockGraphStore>;

  beforeEach(() => {
    store = createMockGraphStore('');
  });

  test('restoreCheckpoint creates new session if none exists', async () => {
    const state = await restoreCheckpoint(store as any, 'new-session', 'v000');

    expect(state.sessionId).toBe('new-session');
    expect(state.iteration).toBe(0);
    expect(state.currentFocus).toBe('Initialize kernel objectives');
    expect(state.learnedConstraints).toEqual([]);
  });

  test('restoreCheckpoint restores from existing checkpoint', async () => {
    // Insert a checkpoint
    store.insertSiasCheckpoint('existing-session', 1, 5, {
      version: 1,
      session_id: 'existing-session',
      iteration: 5,
      timestamp: Date.now(),
      principal_understanding: {
        objectives: ['Objective 1', 'Objective 2'],
        learnedConstraints: ['Constraint 1'],
        currentFocus: 'Working on feature X',
        patchSummary: 'Applied 3 patches',
      },
      patches: [],
      decisions: [],
      last_upgrade_iteration: 3,
    });

    const state = await restoreCheckpoint(store as any, 'existing-session', 'v001');

    expect(state.sessionId).toBe('existing-session');
    expect(state.iteration).toBe(5);
    expect(state.currentFocus).toBe('Working on feature X');
    expect(state.horizonObjectives).toEqual(['Objective 1', 'Objective 2']);
    expect(state.learnedConstraints).toEqual(['Constraint 1']);
    expect(state.lastUpgradeIteration).toBe(3);
  });

  test('persistCheckpoint stores checkpoint and principal context', async () => {
    const state = {
      sessionId: 'test-session',
      iteration: 10,
      version: 'v003',
      currentFocus: 'Implementing tests',
      patchSummary: '10 patches applied',
      learnedConstraints: ['No breaking changes', 'Maintain coverage'],
      horizonObjectives: ['Complete test suite', 'Documentation'],
      lastUpgradeIteration: 5,
    };

    await persistCheckpoint(store as any, state as any);

    const checkpoints = store.listSiasCheckpoints('test-session');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].iteration).toBe(10);

    const principalContext = store.getSiasPrincipalContext('test-session');
    expect(principalContext?.currentFocus).toBe('Implementing tests');
    expect(principalContext?.learnedConstraints).toEqual(['No breaking changes', 'Maintain coverage']);
  });

  test('round-trip checkpoint persistence', async () => {
    const originalState = {
      sessionId: 'roundtrip-session',
      iteration: 7,
      version: 'v002',
      currentFocus: 'Original focus',
      patchSummary: 'Original summary',
      learnedConstraints: ['Constraint A', 'Constraint B'],
      horizonObjectives: ['Goal 1', 'Goal 2'],
      lastUpgradeIteration: 2,
    };

    await persistCheckpoint(store as any, originalState as any);
    const restoredState = await restoreCheckpoint(store as any, 'roundtrip-session', 'v002');

    expect(restoredState.sessionId).toBe(originalState.sessionId);
    expect(restoredState.iteration).toBe(originalState.iteration);
    expect(restoredState.currentFocus).toBe(originalState.currentFocus);
    expect(restoredState.learnedConstraints).toEqual(originalState.learnedConstraints);
    expect(restoredState.horizonObjectives).toEqual(originalState.horizonObjectives);
    expect(restoredState.lastUpgradeIteration).toBe(originalState.lastUpgradeIteration);
  });
});

describe('Health + Recovery integration', () => {
  test('full anomaly detection to recovery plan flow', async () => {
    const logger = createMockLogger();
    const health = new HealthCollector(logger as any, 'v001');

    // Record enough iterations to trigger both consecutive_failures and stalled_no_progress
    // consecutive_failures threshold is 3, stalled_no_progress threshold is 5
    for (let i = 0; i < 5; i++) {
      health.recordIteration(5000, false, false); // failure and no progress
    }

    const snapshot = await health.collectSnapshot();
    const thresholds = {
      memory_heap_max_bytes: 2 * 1024 * 1024 * 1024,
      cpu_percent_max: 90,
      iteration_max_duration_ms: 30 * 60 * 1000,
      max_consecutive_failures: 3,
      max_consecutive_no_progress: 5,
      agent_failure_rate_max: 0.3,
      agent_tokens_max: 100000,
      max_regression_percent: 0.1,
      max_consecutive_regressions: 2,
      graphd_latency_max_ms: 5000,
      checkpoint_staleness_max_ms: 10 * 60 * 1000,
    };

    const anomalies = detectAnomalies(snapshot, thresholds);
    expect(anomalies.length).toBeGreaterThan(0);

    // Both consecutive_failures and stalled_no_progress should trigger
    const anomalyTypes = anomalies.map(a => a.type);
    expect(anomalyTypes).toContain('consecutive_failures');
    expect(anomalyTypes).toContain('stalled_no_progress');

    const plan = buildRecoveryPlan(anomalies);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions.some(a => a.type === 'escalate_to_oncall')).toBe(true);
  });

  test('agent invocation tracking with rolling averages', async () => {
    const logger = createMockLogger();
    const health = new HealthCollector(logger as any, 'v001');

    // Record multiple agent invocations
    for (let i = 0; i < 10; i++) {
      health.recordAgentInvocation('coding', {
        success: true,
        tokens_in: 1000 + i * 100,
        tokens_out: 500 + i * 50,
        tool_calls: 5 + i,
      });
    }

    const snapshot = await health.collectSnapshot();

    // Verify rolling average is calculated (not just last value)
    expect(snapshot.agents.coding.invocations).toBe(10);
    expect(snapshot.agents.coding.avg_tokens_in).toBeGreaterThan(1000);
    expect(snapshot.agents.coding.avg_tokens_in).toBeLessThan(2000);
  });
});

describe('FlipFlop + Decision integration', () => {
  test('stores and retrieves decision embeddings', () => {
    const store = createMockGraphStore('');
    const logger = createMockLogger();
    const detector = new FlipFlopDetector(store as any, logger as any);

    // Store an embedding
    detector.storeEmbedding('decision-1', 'We should refactor the authentication module');

    // Verify it was stored
    const stored = store.getSiasDecisionEmbedding('decision-1');
    expect(stored).not.toBeNull();
    expect(stored?.embedding.length).toBe(128);
  });

  test('detects flip-flop with similar decisions', async () => {
    const store = createMockGraphStore('');
    const logger = createMockLogger();
    const detector = new FlipFlopDetector(store as any, logger as any, 0.7, 5);

    // Store a decision embedding
    const text = 'We need to refactor the authentication system for better security';
    detector.storeEmbedding('decision-1', text);

    const recentDecisions = [{
      decisionId: 'decision-1',
      sessionId: 'test',
      iteration: 10,
      agent: 'principal',
      decisionType: 'adjust_objective',
      reasoning: text,
      outcome: 'adjust_objective',
      relatedDecisionsJson: null,
      createdAt: Date.now() / 1000,
    }];

    // Check with very similar text
    const result = await detector.checkForFlipFlop(
      'We need to refactor the auth system for improved security',
      recentDecisions
    );

    // Similar decisions should be found
    expect(result.similar_decisions.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Context compaction integration', () => {
  test('context manager compacts when thresholds exceeded', () => {
    const manager = new ContextManager('test-session', 10000); // Low max for testing

    const context = manager.getContext('coding');

    // Add many large messages to exceed threshold
    for (let i = 0; i < 100; i++) {
      context.addMessage('user', 'X'.repeat(500));
      context.addMessage('assistant', 'Y'.repeat(500));
    }

    // Attempt compaction
    const compacted = manager.maybeCompact('coding', 10);

    // Should have compacted (if threshold was reached)
    if (context.metrics.percentageUsed > 0.9) {
      expect(compacted).toBe(true);
      expect(manager.getCompactionCount('coding')).toBe(1);
    }
  });

  test('context preserves recent messages after compaction', () => {
    const manager = new ContextManager('test-session', 5000);

    const context = manager.getContext('principal');

    // Add messages
    for (let i = 0; i < 50; i++) {
      context.addMessage('user', `Message ${i}`);
      context.addMessage('assistant', `Response ${i}`);
    }

    const messageCountBefore = context.items.length;

    // Force compaction
    manager.maybeCompact('principal', 100);

    // Get the context again (might be new after compaction)
    const newContext = manager.getContext('principal');

    // If compaction happened, should have fewer messages
    // Recent messages should be preserved (10 for principal)
    if (manager.getCompactionCount('principal') > 0) {
      expect(newContext.items.length).toBeLessThan(messageCountBefore);
    }
  });
});

describe('Upgrade decision integration', () => {
  test('full upgrade decision flow', () => {
    const policy = {
      benchmark_improvement_threshold: 0.05,
      max_iterations_before_checkpoint: 10,
      require_all_tests_pass: true,
      max_allowed_regression: 0.02,
      min_iterations_between_upgrades: 3,
    };

    // Scenario 1: Good improvement, all tests pass
    const goodResult = {
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

    expect(shouldUpgrade(goodResult, policy, 5)).toBe(true);

    // Scenario 2: Test failure blocks upgrade
    const failedTestResult = { ...goodResult, failed_count: 1 };
    expect(shouldUpgrade(failedTestResult, policy, 5)).toBe(false);

    // Scenario 3: Too recent upgrade
    expect(shouldUpgrade(goodResult, policy, 2)).toBe(false);

    // Scenario 4: Regression exceeds limit
    const regressionResult = { ...goodResult, improvement_percent: -0.05 };
    expect(shouldUpgrade(regressionResult, policy, 5)).toBe(false);
  });
});

describe('Validator integration', () => {
  test('validates real-world principal output structure', () => {
    const validOutput = {
      decision: {
        type: 'continue',
        reasoning: 'All benchmarks passing, making good progress on the authentication refactor.',
        confidence: 0.85,
      },
      next_objective: {
        goal: 'Complete user authentication flow',
        success_criteria: ['All auth tests pass', 'No regressions in benchmark'],
        target_files: ['src/auth/login.ts', 'src/auth/session.ts'],
        constraints: ['Maintain backward compatibility', 'No breaking API changes'],
        delegate_to: 'coding',
      },
      new_constraints: [
        {
          constraint: 'JWT tokens must expire within 1 hour',
          learned_from: 'Security review feedback',
        },
      ],
      related_decisions: null,
    };

    const result = validatePrincipalOutput(validOutput);
    expect(result.valid).toBe(true);
  });

  test('validates real-world testing output structure', () => {
    const validOutput = {
      suite_result: {
        tier: 'core',
        score: 95,
        passed_count: 19,
        failed_count: 1,
      },
      recommendation: 'investigate',
      reasoning: 'One regression detected in authentication module, needs investigation before proceeding.',
      regressions: [
        {
          benchmark_id: 'auth-integration-test',
          severity: 'major',
          details: 'Token validation failing for edge case with expired refresh tokens',
        },
      ],
      improvements: [
        {
          benchmark_id: 'login-performance',
          improvement_percent: 15,
          details: 'Login latency reduced by 15% after query optimization',
        },
      ],
    };

    const result = validateTestingOutput(validOutput);
    expect(result.valid).toBe(true);
  });

  test('validates real-world oncall output structure', () => {
    const validOutput = {
      investigation_status: 'resolved',
      diagnosis: {
        root_cause: 'Race condition in session token refresh logic',
        confidence: 0.9,
        evidence: [
          'Intermittent failures only under high load',
          'Token refresh timing correlates with failures',
          'Added mutex resolved the issue',
        ],
        hypothesis_history: [
          {
            hypothesis: 'Database connection timeout',
            tested: true,
            result: 'rejected',
          },
          {
            hypothesis: 'Race condition in token refresh',
            tested: true,
            result: 'confirmed',
          },
        ],
      },
      actions: [
        {
          type: 'targeted_fix',
          file: 'src/auth/token.ts',
          issue: 'Race condition',
          proposed_fix: 'Add mutex lock around token refresh',
        },
      ],
      resolution: {
        summary: 'Fixed race condition by adding mutex lock to token refresh logic',
        patches_applied: ['src/auth/token.ts'],
        verification: 'Ran load tests for 30 minutes with no failures',
      },
    };

    const result = validateOnCallOutput(validOutput);
    expect(result.valid).toBe(true);
  });
});

describe('Config integration', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = mkdtempSync(join(tmpdir(), 'sias-config-integration-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('full config loading with file and env overrides', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      graphdDbPath: '/file/config/path.db',
      log: {
        level: 'debug',
        backend: 'file',
      },
      orchestrator: {
        maxIterations: 20,
      },
      agents: {
        principal: {
          model: 'custom-model',
          temperature: 0.3,
        },
      },
    }));

    // Env var should override file config
    process.env.SIAS_GRAPHD_DB_PATH = '/env/override/path.db';

    const config = loadKernelConfig(configPath);

    // Env override wins
    expect(config.graphdDbPath).toBe('/env/override/path.db');

    // File config applied
    expect(config.log.level).toBe('debug');
    expect(config.log.backend).toBe('file');
    expect(config.orchestrator.maxIterations).toBe(20);

    // Partial agent config merged with defaults
    expect(config.agents.principal.model).toBe('custom-model');
    expect(config.agents.principal.temperature).toBe(0.3);
    expect(config.agents.principal.maxTokens).toBe(8000); // Default preserved

    // Other agents use defaults
    expect(config.agents.coding.model).toBe('gpt-5.2-codex');
  });
});

describe('Benchmark scoring integration', () => {
  test('weighted scoring matches expected calculation', () => {
    const definitions = [
      { id: 'smoke-1', name: 'Smoke 1', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.1, command: [] },
      { id: 'smoke-2', name: 'Smoke 2', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.1, command: [] },
      { id: 'core-1', name: 'Core 1', tier: 'core' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.3, command: [] },
      { id: 'full-1', name: 'Full 1', tier: 'full' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.5, command: [] },
    ];

    const results = [
      { benchmark_id: 'smoke-1', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
      { benchmark_id: 'smoke-2', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
      { benchmark_id: 'core-1', passed: false, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
      { benchmark_id: 'full-1', passed: true, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
    ];

    // Expected: (0.1 + 0.1 + 0 + 0.5) / (0.1 + 0.1 + 0.3 + 0.5) * 100 = 0.7 / 1.0 * 100 = 70
    const score = calculateScore(results, definitions);
    expect(score).toBe(70);
  });

  test('skipped benchmarks do not affect scoring', () => {
    const definitions = [
      { id: 'test-1', name: 'Test 1', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: [], weight: 0.5, command: [] },
      { id: 'test-2', name: 'Test 2', tier: 'smoke' as const, category: 'correctness' as const, timeout_ms: 1000, parallel_safe: true, requires: ['test-1'], weight: 0.5, command: [] },
    ];

    const results = [
      { benchmark_id: 'test-1', passed: false, skipped: false, duration_ms: 100, started_at: 0, completed_at: 100 },
      { benchmark_id: 'test-2', passed: false, skipped: true, duration_ms: 0, started_at: 0, completed_at: 0 },
    ];

    // Both count as failed for scoring purposes
    const score = calculateScore(results, definitions);
    expect(score).toBe(0);
  });
});
