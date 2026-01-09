# SIAS v3 Part 2: Concrete Specifications

This document addresses the gaps in Part 1 with explicit specifications for:
1. Health metrics, tracking, anomaly detection, and recovery
2. Tiered benchmark system with parallelization and context isolation
3. Agent specifications (Principal, OnCall, Testing)
4. Context window management and compaction
5. Worktree lifecycle management
6. Anti-flip-flop mechanisms

---

## 1. Health System

### 1.1 Metrics We Track

```typescript
interface HealthMetrics {
  // === PROCESS METRICS ===
  process: {
    pid: number;
    uptime_ms: number;
    memory_rss_bytes: number;
    memory_heap_used_bytes: number;
    cpu_percent: number;  // Rolling 10s average
    restart_count: number;
    last_restart_reason?: string;
  };

  // === ITERATION METRICS ===
  iteration: {
    current: number;
    total_completed: number;
    avg_duration_ms: number;
    last_duration_ms: number;
    consecutive_failures: number;
    consecutive_no_progress: number;  // Iterations with no meaningful change
  };

  // === AGENT METRICS (per agent type) ===
  agents: Record<AgentType, {
    invocations: number;
    failures: number;
    avg_tokens_in: number;
    avg_tokens_out: number;
    avg_tool_calls: number;
    context_compactions: number;
    last_error?: string;
  }>;

  // === BENCHMARK METRICS ===
  benchmark: {
    last_run_at: number;
    last_score: number;
    baseline_score: number;
    improvement_percent: number;
    regression_count: number;
    tests_passing: number;
    tests_failing: number;
  };

  // === WORKTREE METRICS ===
  worktree: {
    current_version: string;
    wip_version: string;
    total_versions: number;
    rollback_count: number;
    disk_usage_bytes: number;
  };

  // === GRAPHD METRICS ===
  persistence: {
    last_checkpoint_at: number;
    checkpoint_count: number;
    patch_count: number;
    decision_count: number;
    graphd_latency_ms: number;  // Rolling average
    graphd_available: boolean;
  };
}

type AgentType = 'principal' | 'oncall' | 'testing' | 'coding' | 'research';
```

### 1.2 Health Collector

```typescript
class HealthCollector {
  private metrics: HealthMetrics;
  private samplingIntervalMs = 5000;  // Sample every 5s
  private historyWindowMs = 300000;   // 5 minute rolling window

  async collectSnapshot(): Promise<HealthMetrics> {
    const snapshot: HealthMetrics = {
      process: await this.collectProcessMetrics(),
      iteration: this.iterationMetrics,
      agents: this.agentMetrics,
      benchmark: this.benchmarkMetrics,
      worktree: await this.collectWorktreeMetrics(),
      persistence: await this.collectPersistenceMetrics(),
    };

    await this.persistSnapshot(snapshot);
    return snapshot;
  }

  private async collectProcessMetrics(): Promise<HealthMetrics['process']> {
    const usage = process.memoryUsage();
    return {
      pid: process.pid,
      uptime_ms: process.uptime() * 1000,
      memory_rss_bytes: usage.rss,
      memory_heap_used_bytes: usage.heapUsed,
      cpu_percent: await this.getCpuPercent(),
      restart_count: this.restartCount,
      last_restart_reason: this.lastRestartReason,
    };
  }

  recordAgentInvocation(
    agent: AgentType,
    result: {
      success: boolean;
      tokens_in: number;
      tokens_out: number;
      tool_calls: number;
      error?: string;
    }
  ): void {
    const m = this.agentMetrics[agent];
    m.invocations++;
    if (!result.success) m.failures++;
    m.avg_tokens_in = this.rollingAvg(m.avg_tokens_in, result.tokens_in, m.invocations);
    m.avg_tokens_out = this.rollingAvg(m.avg_tokens_out, result.tokens_out, m.invocations);
    m.avg_tool_calls = this.rollingAvg(m.avg_tool_calls, result.tool_calls, m.invocations);
    if (result.error) m.last_error = result.error;
  }
}
```

### 1.3 Anomaly Detection

```typescript
interface AnomalyThresholds {
  memory_heap_max_bytes: number;       // Default: 2GB
  cpu_percent_max: number;             // Default: 90%
  iteration_max_duration_ms: number;   // Default: 30min
  max_consecutive_failures: number;    // Default: 3
  max_consecutive_no_progress: number; // Default: 5
  agent_failure_rate_max: number;      // Default: 0.3 (30%)
  agent_tokens_max: number;            // Default: 100k per invocation
  max_regression_percent: number;      // Default: 0.1 (10%)
  max_consecutive_regressions: number; // Default: 2
  graphd_latency_max_ms: number;       // Default: 5000
  checkpoint_staleness_max_ms: number; // Default: 600000 (10min)
}

type AnomalyType =
  | 'memory_pressure'
  | 'cpu_pressure'
  | 'iteration_timeout'
  | 'consecutive_failures'
  | 'stalled_no_progress'
  | 'agent_failure_rate'
  | 'agent_context_explosion'
  | 'benchmark_regression'
  | 'graphd_latency'
  | 'graphd_unavailable'
  | 'checkpoint_stale';

interface Anomaly {
  type: AnomalyType;
  severity: 'warning' | 'critical';
  detected_at: number;
  metric_value: number;
  threshold_value: number;
  context: Record<string, unknown>;
}

function detectAnomalies(
  metrics: HealthMetrics,
  thresholds: AnomalyThresholds
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // Memory pressure
  if (metrics.process.memory_heap_used_bytes > thresholds.memory_heap_max_bytes) {
    anomalies.push({
      type: 'memory_pressure',
      severity: metrics.process.memory_heap_used_bytes > thresholds.memory_heap_max_bytes * 1.2
        ? 'critical' : 'warning',
      detected_at: Date.now(),
      metric_value: metrics.process.memory_heap_used_bytes,
      threshold_value: thresholds.memory_heap_max_bytes,
      context: {},
    });
  }

  // Iteration stall
  if (metrics.iteration.consecutive_no_progress >= thresholds.max_consecutive_no_progress) {
    anomalies.push({
      type: 'stalled_no_progress',
      severity: 'critical',
      detected_at: Date.now(),
      metric_value: metrics.iteration.consecutive_no_progress,
      threshold_value: thresholds.max_consecutive_no_progress,
      context: { last_iteration: metrics.iteration.current },
    });
  }

  // CPU pressure
  if (metrics.process.cpu_percent > thresholds.cpu_percent_max) {
    anomalies.push({
      type: 'cpu_pressure',
      severity: metrics.process.cpu_percent > 95 ? 'critical' : 'warning',
      detected_at: Date.now(),
      metric_value: metrics.process.cpu_percent,
      threshold_value: thresholds.cpu_percent_max,
      context: {},
    });
  }

  // Consecutive failures
  if (metrics.iteration.consecutive_failures >= thresholds.max_consecutive_failures) {
    anomalies.push({
      type: 'consecutive_failures',
      severity: metrics.iteration.consecutive_failures >= 5 ? 'critical' : 'warning',
      detected_at: Date.now(),
      metric_value: metrics.iteration.consecutive_failures,
      threshold_value: thresholds.max_consecutive_failures,
      context: {},
    });
  }

  // GraphD availability
  if (!metrics.persistence.graphd_available) {
    anomalies.push({
      type: 'graphd_unavailable',
      severity: 'critical',
      detected_at: Date.now(),
      metric_value: 0,
      threshold_value: 1,
      context: {},
    });
  }

  // Checkpoint staleness
  const checkpointAge = Date.now() - metrics.persistence.last_checkpoint_at;
  if (checkpointAge > thresholds.checkpoint_staleness_max_ms) {
    anomalies.push({
      type: 'checkpoint_stale',
      severity: checkpointAge > thresholds.checkpoint_staleness_max_ms * 2 ? 'critical' : 'warning',
      detected_at: Date.now(),
      metric_value: checkpointAge,
      threshold_value: thresholds.checkpoint_staleness_max_ms,
      context: {},
    });
  }

  return anomalies;
}
```

### 1.4 Recovery Procedures

```typescript
type RecoveryAction =
  | { type: 'gc_force' }
  | { type: 'compact_agent_context'; agent: AgentType }
  | { type: 'checkpoint_now' }
  | { type: 'restart_soft' }
  | { type: 'restart_hard_same_version' }
  | { type: 'rollback_version' }
  | { type: 'pause_iteration_loop' }
  | { type: 'escalate_to_oncall' }
  | { type: 'halt_fatal' };

interface RecoveryPlan {
  anomalies: Anomaly[];
  actions: RecoveryAction[];
  reasoning: string;
}

const RECOVERY_MATRIX: Record<AnomalyType, (anomaly: Anomaly) => RecoveryAction[]> = {
  memory_pressure: (a) => a.severity === 'critical'
    ? [{ type: 'gc_force' }, { type: 'checkpoint_now' }, { type: 'restart_soft' }]
    : [{ type: 'gc_force' }],

  cpu_pressure: (a) => a.severity === 'critical'
    ? [{ type: 'pause_iteration_loop' }]
    : [],  // Warning only, no action

  iteration_timeout: () => [
    { type: 'checkpoint_now' },
    { type: 'escalate_to_oncall' },
  ],

  consecutive_failures: (a) => [
    { type: 'escalate_to_oncall' },
    a.metric_value >= 5 ? { type: 'rollback_version' } : { type: 'checkpoint_now' },
  ],

  stalled_no_progress: () => [
    { type: 'escalate_to_oncall' },
    { type: 'checkpoint_now' },
  ],

  agent_failure_rate: (a) => [
    { type: 'compact_agent_context', agent: a.context.agent as AgentType },
    { type: 'escalate_to_oncall' },
  ],

  agent_context_explosion: (a) => [
    { type: 'compact_agent_context', agent: a.context.agent as AgentType },
  ],

  benchmark_regression: (a) => a.severity === 'critical'
    ? [{ type: 'rollback_version' }]
    : [{ type: 'escalate_to_oncall' }],

  graphd_latency: () => [
    { type: 'checkpoint_now' },  // Flush what we can
  ],

  graphd_unavailable: () => [
    { type: 'pause_iteration_loop' },
  ],

  checkpoint_stale: () => [
    { type: 'checkpoint_now' },
  ],
};

async function executeRecovery(plan: RecoveryPlan): Promise<void> {
  console.log(`[health] Executing recovery: ${plan.reasoning}`);

  for (const action of plan.actions) {
    switch (action.type) {
      case 'gc_force':
        if (global.gc) global.gc();
        break;
      case 'compact_agent_context':
        await compactAgentContext(action.agent);
        break;
      case 'checkpoint_now':
        await persistCheckpoint();
        break;
      case 'restart_soft':
        await persistCheckpoint();
        process.exit(0);  // Launcher will restart
        break;
      case 'rollback_version':
        await triggerRollback();
        break;
      case 'escalate_to_oncall':
        await escalateToOnCall(plan);
        break;
      case 'pause_iteration_loop':
        await pauseLoop();
        break;
      case 'halt_fatal':
        console.error('[health] FATAL: Halting system');
        process.exit(1);
        break;
    }
  }
}
```

---

## 2. Benchmarking System

### 2.1 Design Principles

Running full benchmarks after every iteration is too slow. We need:
- **Tiered suites**: smoke (fast) → core (medium) → full (slow) → chaos (manual)
- **Parallelization**: Run independent benchmarks concurrently
- **Context isolation**: Benchmarks run in subprocesses with no access to kernel context
- **Dependency ordering**: Some benchmarks require others to pass first

### 2.2 Benchmark Tiers

```typescript
type BenchmarkTier = 'smoke' | 'core' | 'full' | 'chaos';

interface BenchmarkDefinition {
  id: string;
  name: string;
  tier: BenchmarkTier;
  category: 'correctness' | 'performance' | 'regression' | 'chaos';
  timeout_ms: number;
  parallel_safe: boolean;
  requires: string[];  // Benchmark IDs that must pass first
  weight: number;      // Contribution to overall score (0-1)
}

const BENCHMARK_TIERS: Record<BenchmarkTier, {
  run_after: 'every_iteration' | 'every_n_iterations' | 'before_upgrade' | 'manual';
  max_duration_ms: number;
  min_passing_percent: number;
}> = {
  smoke: {
    run_after: 'every_iteration',
    max_duration_ms: 30000,     // 30s max
    min_passing_percent: 100,   // All must pass
  },
  core: {
    run_after: 'every_n_iterations',  // Every 3 iterations
    max_duration_ms: 120000,    // 2min max
    min_passing_percent: 95,
  },
  full: {
    run_after: 'before_upgrade',
    max_duration_ms: 600000,    // 10min max
    min_passing_percent: 90,
  },
  chaos: {
    run_after: 'manual',
    max_duration_ms: 1800000,   // 30min max
    min_passing_percent: 80,
  },
};
```

### 2.3 Benchmark Suite Definition

```typescript
const BENCHMARK_SUITE: BenchmarkDefinition[] = [
  // === SMOKE (run every iteration, <30s total) ===
  {
    id: 'smoke-typecheck',
    name: 'TypeScript type check',
    tier: 'smoke',
    category: 'correctness',
    timeout_ms: 10000,
    parallel_safe: true,
    requires: [],
    weight: 0.1,
  },
  {
    id: 'smoke-lint',
    name: 'ESLint check',
    tier: 'smoke',
    category: 'correctness',
    timeout_ms: 10000,
    parallel_safe: true,
    requires: [],
    weight: 0.05,
  },
  {
    id: 'smoke-unit-critical',
    name: 'Critical unit tests',
    tier: 'smoke',
    category: 'correctness',
    timeout_ms: 15000,
    parallel_safe: true,
    requires: ['smoke-typecheck'],
    weight: 0.15,
  },

  // === CORE (run every 3 iterations, <2min total) ===
  {
    id: 'core-unit-all',
    name: 'Full unit test suite',
    tier: 'core',
    category: 'correctness',
    timeout_ms: 60000,
    parallel_safe: true,
    requires: ['smoke-unit-critical'],
    weight: 0.2,
  },
  {
    id: 'core-integration',
    name: 'Integration tests',
    tier: 'core',
    category: 'correctness',
    timeout_ms: 60000,
    parallel_safe: false,  // Uses shared resources
    requires: ['core-unit-all'],
    weight: 0.15,
  },
  {
    id: 'core-perf-baseline',
    name: 'Performance baseline',
    tier: 'core',
    category: 'performance',
    timeout_ms: 30000,
    parallel_safe: true,
    requires: [],
    weight: 0.1,
  },

  // === FULL (before upgrade, <10min total) ===
  {
    id: 'full-e2e',
    name: 'End-to-end workflow tests',
    tier: 'full',
    category: 'correctness',
    timeout_ms: 180000,
    parallel_safe: false,
    requires: ['core-integration'],
    weight: 0.1,
  },
  {
    id: 'full-perf-comprehensive',
    name: 'Comprehensive perf suite',
    tier: 'full',
    category: 'performance',
    timeout_ms: 120000,
    parallel_safe: true,
    requires: ['core-perf-baseline'],
    weight: 0.1,
  },
  {
    id: 'full-regression-suite',
    name: 'Historical regression checks',
    tier: 'full',
    category: 'regression',
    timeout_ms: 120000,
    parallel_safe: true,
    requires: [],
    weight: 0.05,
  },

  // === CHAOS (manual trigger, <30min) ===
  {
    id: 'chaos-memory-pressure',
    name: 'Memory pressure test',
    tier: 'chaos',
    category: 'chaos',
    timeout_ms: 300000,
    parallel_safe: false,
    requires: ['full-e2e'],
    weight: 0,  // Not counted in score
  },
  {
    id: 'chaos-graphd-failures',
    name: 'GraphD failure injection',
    tier: 'chaos',
    category: 'chaos',
    timeout_ms: 300000,
    parallel_safe: false,
    requires: [],
    weight: 0,
  },
  {
    id: 'chaos-context-overflow',
    name: 'Context window overflow handling',
    tier: 'chaos',
    category: 'chaos',
    timeout_ms: 600000,
    parallel_safe: false,
    requires: [],
    weight: 0,
  },
];
```

### 2.4 Isolated Benchmark Runner

```typescript
class IsolatedBenchmarkRunner {
  private maxConcurrency = 4;
  private worktreePath: string;

  async runIsolated(benchmarks: BenchmarkDefinition[]): Promise<BenchmarkResult[]> {
    const parallelSafe = benchmarks.filter(b => b.parallel_safe);
    const sequential = benchmarks.filter(b => !b.parallel_safe);

    const results: BenchmarkResult[] = [];

    // Run parallel-safe benchmarks concurrently
    const parallelResults = await this.runParallel(parallelSafe);
    results.push(...parallelResults);

    // Run sequential benchmarks one at a time
    for (const bench of sequential) {
      const requiresMet = bench.requires.every(reqId =>
        results.find(r => r.benchmark_id === reqId)?.passed
      );
      if (!requiresMet) {
        results.push({
          benchmark_id: bench.id,
          passed: false,
          skipped: true,
          reason: 'Required benchmark failed',
          duration_ms: 0,
        });
        continue;
      }

      const result = await this.runSingleIsolated(bench);
      results.push(result);
    }

    return results;
  }

  private async runParallel(benchmarks: BenchmarkDefinition[]): Promise<BenchmarkResult[]> {
    const chunks: BenchmarkDefinition[][] = [];
    for (let i = 0; i < benchmarks.length; i += this.maxConcurrency) {
      chunks.push(benchmarks.slice(i, i + this.maxConcurrency));
    }

    const results: BenchmarkResult[] = [];
    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(b => this.runSingleIsolated(b))
      );
      results.push(...chunkResults);
    }
    return results;
  }

  private async runSingleIsolated(bench: BenchmarkDefinition): Promise<BenchmarkResult> {
    // Spawn subprocess with clean environment - NO kernel context access
    const proc = Bun.spawn({
      cmd: ['bun', 'run', 'benchmark-runner.ts', bench.id],
      cwd: this.worktreePath,
      env: {
        ...process.env,
        SIAS_BENCHMARK_ISOLATED: '1',
        SIAS_BENCHMARK_ID: bench.id,
        SIAS_BENCHMARK_TIMEOUT: String(bench.timeout_ms),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeout = setTimeout(() => proc.kill(), bench.timeout_ms);

    try {
      const exitCode = await proc.exited;
      clearTimeout(timeout);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      return this.parseResult(bench.id, stdout, stderr, exitCode);
    } catch (e) {
      clearTimeout(timeout);
      return {
        benchmark_id: bench.id,
        passed: false,
        skipped: false,
        reason: `Execution error: ${e}`,
        duration_ms: bench.timeout_ms,
      };
    }
  }
}
```

### 2.5 Benchmark Result Schema

```typescript
interface BenchmarkResult {
  benchmark_id: string;
  passed: boolean;
  skipped: boolean;
  reason?: string;
  duration_ms: number;

  perf?: {
    ops_per_second?: number;
    avg_latency_ms?: number;
    p95_latency_ms?: number;
    p99_latency_ms?: number;
    memory_peak_bytes?: number;
    memory_avg_bytes?: number;
  };

  correctness?: {
    assertions_passed: number;
    assertions_failed: number;
    failed_assertions: Array<{
      name: string;
      expected: string;
      actual: string;
    }>;
  };
}

interface BenchmarkSuiteResult {
  tier: BenchmarkTier;
  started_at: number;
  completed_at: number;
  total_duration_ms: number;
  results: BenchmarkResult[];
  score: number;  // 0-100 weighted
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  baseline_score: number;
  improvement_percent: number;
  regressions: Array<{
    benchmark_id: string;
    baseline_value: number;
    current_value: number;
    regression_percent: number;
  }>;
}

function calculateScore(results: BenchmarkResult[], definitions: BenchmarkDefinition[]): number {
  let totalWeight = 0;
  let weightedScore = 0;

  for (const result of results) {
    const def = definitions.find(d => d.id === result.benchmark_id);
    if (!def || def.weight === 0) continue;

    totalWeight += def.weight;
    if (result.passed) {
      weightedScore += def.weight;
    }
  }

  return totalWeight > 0 ? (weightedScore / totalWeight) * 100 : 0;
}
```

---

## 3. Agent Specifications

### 3.1 PrincipalEngineer

**Role**: Strategic decision-maker. Sets objectives, reviews results, prevents flip-flopping, maintains architectural coherence.

```typescript
interface PrincipalEngineerConfig {
  type: 'principal';
  model: 'claude-sonnet-4-20250514';

  context: {
    max_tokens: 180000;
    compaction_threshold: 0.85;
    protected_sections: [
      'session_objectives',
      'learned_constraints',
      'decision_history',
      'anti_flip_flop_embeddings',
    ];
    compaction_strategy: 'summarize_preserve_decisions';
  };

  budget: {
    max_iterations_per_session: null;  // Unlimited
    max_tokens_per_invocation: 8000;
    max_tool_calls_per_invocation: 20;
    max_duration_ms: 300000;  // 5min
  };

  tools: [
    'read_file',
    'glob',
    'grep',
    'graphd_query',
    'graphd_write',
    'request_benchmark',
    'request_oncall',
    'set_objective',
    'approve_upgrade',
    'reject_patch',
    'record_constraint',
  ];

  output_schema: PrincipalOutput;
}

interface PrincipalOutput {
  decision: {
    type: 'continue' | 'adjust_objective' | 'escalate' | 'approve_upgrade' | 'rollback' | 'pause';
    reasoning: string;
    confidence: number;
  };

  next_objective?: {
    goal: string;
    success_criteria: string[];
    target_files?: string[];
    constraints: string[];
    delegate_to: AgentType;
  };

  new_constraints?: Array<{
    constraint: string;
    learned_from: string;
  }>;

  related_decisions?: Array<{
    decision_id: string;
    similarity: number;
    should_reverse: boolean;
    reasoning: string;
  }>;
}
```

### 3.2 OnCallEngineer

**Role**: Debugger and investigator. Called when things go wrong. Diagnoses issues, proposes fixes, requests logging patches.

```typescript
interface OnCallEngineerConfig {
  type: 'oncall';
  model: 'claude-sonnet-4-20250514';

  context: {
    max_tokens: 120000;
    compaction_threshold: 0.9;
    protected_sections: [
      'current_investigation',
      'error_context',
      'hypothesis_history',
    ];
    compaction_strategy: 'preserve_recent_errors';
  };

  budget: {
    max_iterations_per_investigation: 10;
    max_tokens_per_invocation: 6000;
    max_tool_calls_per_invocation: 50;
    max_duration_ms: 600000;  // 10min
  };

  tools: [
    'read_file',
    'glob',
    'grep',
    'graphd_query',
    'read_logs',
    'search_logs',
    'read_health_metrics',
    'read_benchmark_history',
    'diff_versions',
    'request_logging_patch',
    'request_targeted_fix',
    'record_finding',
    'escalate_to_principal',
    'mark_resolved',
  ];

  output_schema: OnCallOutput;
}

interface OnCallOutput {
  investigation_status: 'ongoing' | 'resolved' | 'escalated' | 'blocked';

  diagnosis?: {
    root_cause: string;
    confidence: number;
    evidence: string[];
    hypothesis_history: Array<{
      hypothesis: string;
      tested: boolean;
      result?: 'confirmed' | 'rejected';
    }>;
  };

  actions?: Array<
    | { type: 'logging_patch'; target_file: string; location: string; what_to_log: string }
    | { type: 'targeted_fix'; file: string; issue: string; proposed_fix: string }
    | { type: 'escalate'; reason: string; context_for_principal: string }
    | { type: 'run_benchmark'; tier: BenchmarkTier; reason: string }
  >;

  resolution?: {
    summary: string;
    patches_applied: string[];
    verification: string;
  };
}
```

### 3.3 TestingAgent

**Role**: Benchmark runner and quality gate. Executes benchmarks, compares results, reports regressions.

```typescript
interface TestingAgentConfig {
  type: 'testing';
  model: 'claude-haiku-3-5';  // Fast, cheap

  context: {
    max_tokens: 60000;
    compaction_threshold: 0.9;
    protected_sections: ['benchmark_baseline'];
    compaction_strategy: 'keep_latest_results_only';
  };

  budget: {
    max_tokens_per_invocation: 2000;
    max_tool_calls_per_invocation: 10;
    max_duration_ms: 1800000;  // 30min
  };

  tools: [
    'run_benchmark_suite',
    'read_benchmark_baseline',
    'update_benchmark_baseline',
    'compare_benchmarks',
    'report_regression',
    'report_improvement',
  ];

  output_schema: TestingOutput;
}

interface TestingOutput {
  suite_result: BenchmarkSuiteResult;
  recommendation: 'proceed' | 'block' | 'investigate';
  reasoning: string;

  regressions?: Array<{
    benchmark_id: string;
    severity: 'minor' | 'major' | 'critical';
    details: string;
  }>;

  improvements?: Array<{
    benchmark_id: string;
    improvement_percent: number;
    details: string;
  }>;
}
```

### 3.4 Agent Integration Flow

```typescript
async function runIteration(state: SIASState): Promise<IterationResult> {
  // 1. Principal sets objective
  const principalResult = await invokeAgent<PrincipalOutput>({
    agent: 'principal',
    prompt: buildPrincipalPrompt(state),
    context: state.principalContext,
  });

  if (principalResult.decision.type === 'pause') {
    return { status: 'paused', reason: principalResult.decision.reasoning };
  }

  if (principalResult.decision.type === 'escalate') {
    const oncallResult = await invokeAgent<OnCallOutput>({
      agent: 'oncall',
      prompt: buildOnCallPrompt(state, principalResult),
      context: freshContext(),
    });

    for (const action of oncallResult.actions ?? []) {
      await processOnCallAction(action);
    }

    return { status: 'investigated', oncall: oncallResult };
  }

  // 2. Delegate to Coding agent
  const objective = principalResult.next_objective!;
  const codingResult = await invokeAgent({
    agent: objective.delegate_to,
    prompt: buildCodingPrompt(objective),
    context: freshContext(),
  });

  // 3. Testing agent runs benchmarks
  const tier = selectBenchmarkTier(state.iteration);
  const testingResult = await invokeAgent<TestingOutput>({
    agent: 'testing',
    prompt: buildTestingPrompt(tier, codingResult),
    context: freshContext(),
  });

  // 4. Process result
  if (testingResult.recommendation === 'block') {
    await persistFailure(state, codingResult, testingResult);
    return { status: 'blocked', testing: testingResult };
  }

  await applyChanges(codingResult);
  await persistSuccess(state, codingResult, testingResult);

  if (await shouldUpgrade(state, testingResult)) {
    await triggerUpgrade(state);
  }

  return { status: 'success', testing: testingResult };
}
```

---

## 4. Context Window Management

### 4.1 Compaction Strategy

```typescript
interface ContextCompactionConfig {
  trigger: {
    token_threshold: number;
    threshold_percent: number;
    min_iterations_between: number;
  };

  preserve: {
    protected_sections: string[];
    recent_tool_calls: number;
    recent_messages: number;
    recent_errors: number;
  };

  summarization: {
    model: 'claude-haiku-3-5';
    max_summary_tokens: number;
    include_key_facts: boolean;
    include_decisions: boolean;
  };
}

async function compactContext(
  context: AgentContext,
  config: ContextCompactionConfig
): Promise<AgentContext> {
  const preserved: string[] = [];
  const toSummarize: string[] = [];

  for (const section of context.sections) {
    if (config.preserve.protected_sections.includes(section.id)) {
      preserved.push(section.content);
    } else {
      toSummarize.push(section.content);
    }
  }

  const recentToolCalls = context.toolCalls.slice(-config.preserve.recent_tool_calls);
  const recentMessages = context.messages.slice(-config.preserve.recent_messages);
  const recentErrors = context.errors.slice(-config.preserve.recent_errors);

  const summary = await summarize({
    content: toSummarize.join('\n\n'),
    model: config.summarization.model,
    max_tokens: config.summarization.max_summary_tokens,
    instructions: `
      Summarize while preserving:
      - Key decisions made and their reasoning
      - Important facts learned
      - Errors encountered and their resolutions
      - Current state and objectives
    `,
  });

  return {
    sections: [
      { id: 'summary', content: summary },
      ...preserved.map((content, i) => ({
        id: config.preserve.protected_sections[i],
        content
      })),
    ],
    toolCalls: recentToolCalls,
    messages: recentMessages,
    errors: recentErrors,
  };
}
```

### 4.2 Per-Agent Context Policies

```typescript
const CONTEXT_POLICIES: Record<AgentType, ContextCompactionConfig> = {
  principal: {
    trigger: {
      token_threshold: 150000,
      threshold_percent: 0.85,
      min_iterations_between: 3,
    },
    preserve: {
      protected_sections: [
        'session_objectives',
        'learned_constraints',
        'decision_history',
        'anti_flip_flop_state',
      ],
      recent_tool_calls: 20,
      recent_messages: 10,
      recent_errors: 5,
    },
    summarization: {
      model: 'claude-haiku-3-5',
      max_summary_tokens: 4000,
      include_key_facts: true,
      include_decisions: true,
    },
  },

  oncall: {
    trigger: {
      token_threshold: 100000,
      threshold_percent: 0.9,
      min_iterations_between: 1,
    },
    preserve: {
      protected_sections: [
        'current_investigation',
        'hypothesis_history',
      ],
      recent_tool_calls: 50,
      recent_messages: 5,
      recent_errors: 10,
    },
    summarization: {
      model: 'claude-haiku-3-5',
      max_summary_tokens: 2000,
      include_key_facts: true,
      include_decisions: false,
    },
  },

  testing: {
    trigger: {
      token_threshold: 50000,
      threshold_percent: 0.9,
      min_iterations_between: 1,
    },
    preserve: {
      protected_sections: ['benchmark_baseline'],
      recent_tool_calls: 5,
      recent_messages: 3,
      recent_errors: 3,
    },
    summarization: {
      model: 'claude-haiku-3-5',
      max_summary_tokens: 1000,
      include_key_facts: false,
      include_decisions: false,
    },
  },

  coding: {
    // Fresh context each invocation
    trigger: {
      token_threshold: 120000,
      threshold_percent: 0.9,
      min_iterations_between: 0,
    },
    preserve: {
      protected_sections: ['objective', 'constraints'],
      recent_tool_calls: 30,
      recent_messages: 5,
      recent_errors: 5,
    },
    summarization: {
      model: 'claude-haiku-3-5',
      max_summary_tokens: 2000,
      include_key_facts: true,
      include_decisions: false,
    },
  },
};
```

---

## 5. Worktree Management

### 5.1 Worktree Lifecycle

```typescript
interface WorktreeState {
  version: string;
  path: string;
  status: 'active' | 'wip' | 'archived' | 'failed';
  created_at: number;
  promoted_at?: number;
  archived_at?: number;
  iterations_run: number;
  benchmark_score: number;
  failure_count: number;
}

class WorktreeManager {
  private baseDir: string;
  private maxVersionsToKeep = 5;

  async getCurrentVersion(): Promise<string> {
    const state = await this.loadState();
    return state.current_version;
  }

  async getWipPath(): Promise<string> {
    const current = await this.getCurrentVersion();
    const next = incrementVersion(current);
    return `${this.baseDir}/v${next}-wip`;
  }

  async createWip(): Promise<string> {
    const wipPath = await this.getWipPath();
    await exec(`git worktree add ${wipPath} HEAD`);
    await exec(`cd ${wipPath} && bun install`);
    return wipPath;
  }

  async promoteWip(): Promise<string> {
    const wipPath = await this.getWipPath();
    const version = wipPath.replace('-wip', '');

    await fs.rename(wipPath, version);

    await this.updateState({
      current_version: path.basename(version),
      status: 'active',
      promoted_at: Date.now(),
    });

    await this.createWip();
    await this.garbageCollect();

    return version;
  }

  async rollbackToVersion(version: string): Promise<void> {
    const versionPath = `${this.baseDir}/${version}`;

    if (!await fs.exists(versionPath)) {
      throw new Error(`Version ${version} not found`);
    }

    await this.updateState({
      status: 'failed',
      failure_count: (await this.getState()).failure_count + 1,
    });

    await this.updateState({
      current_version: version,
      status: 'active',
    });
  }

  async garbageCollect(): Promise<void> {
    const versions = await this.listVersions();
    const sorted = versions.sort((a, b) => b.created_at - a.created_at);

    const toKeep = new Set<string>();
    toKeep.add(await this.getCurrentVersion());
    toKeep.add(await this.getWipPath());

    for (const v of sorted.slice(0, this.maxVersionsToKeep)) {
      toKeep.add(v.path);
    }

    for (const v of versions) {
      if (!toKeep.has(v.path)) {
        if (v.status === 'failed') {
          await this.archiveVersion(v.path);
        } else {
          await exec(`git worktree remove ${v.path} --force`);
        }
      }
    }
  }
}
```

### 5.2 Worktree Persistence

```typescript
interface WorktreeRecord {
  version: string;
  path: string;
  status: 'active' | 'wip' | 'archived' | 'failed';
  created_at: number;
  promoted_at?: number;
  archived_at?: number;
  failed_at?: number;
  git_commit: string;
  patches_included: string[];
  benchmark_scores: Array<{
    tier: BenchmarkTier;
    score: number;
    timestamp: number;
  }>;
  failure_reason?: string;
  failure_iteration?: number;
}
```

---

## 6. Anti-Flip-Flop Mechanism

### 6.1 Decision Embedding and Similarity

```typescript
interface DecisionEmbedding {
  decision_id: string;
  embedding: number[];
  timestamp: number;
}

class FlipFlopDetector {
  private similarityThreshold = 0.85;
  private minIterationGap = 5;

  async checkForFlipFlop(
    newDecision: string,
    recentDecisions: DecisionRecord[]
  ): Promise<{
    is_flip_flop: boolean;
    similar_decisions: Array<{
      decision: DecisionRecord;
      similarity: number;
    }>;
    recommendation: string;
  }> {
    const newEmbedding = await this.embed(newDecision);

    const similar: Array<{ decision: DecisionRecord; similarity: number }> = [];

    for (const past of recentDecisions) {
      const pastEmbedding = await this.getEmbedding(past.decision_id);
      const similarity = cosineSimilarity(newEmbedding, pastEmbedding);

      if (similarity >= this.similarityThreshold) {
        similar.push({ decision: past, similarity });
      }
    }

    if (similar.length === 0) {
      return {
        is_flip_flop: false,
        similar_decisions: [],
        recommendation: 'No similar past decisions found. Proceed.',
      };
    }

    const mostSimilar = similar.sort((a, b) => b.similarity - a.similarity)[0];
    const iterationGap = this.currentIteration - mostSimilar.decision.iteration;

    if (iterationGap < this.minIterationGap) {
      return {
        is_flip_flop: true,
        similar_decisions: similar,
        recommendation: `
          WARNING: This decision is ${(mostSimilar.similarity * 100).toFixed(1)}% similar to a decision
          made ${iterationGap} iterations ago. If you proceed, explain why circumstances have changed.

          Previous decision: "${mostSimilar.decision.outcome}"
          Previous reasoning: "${mostSimilar.decision.reasoning}"
        `,
      };
    }

    return {
      is_flip_flop: false,
      similar_decisions: similar,
      recommendation: 'Similar decisions exist but are old enough. Proceed with awareness.',
    };
  }
}
```

### 6.2 Principal Prompt Integration

```typescript
function buildPrincipalPrompt(state: SIASState): string {
  const flipFlopContext = state.flipFlopDetector.getRecentDecisions(20);

  return `
# Principal Engineer - Session ${state.session_id}, Iteration ${state.iteration}

## Your Responsibilities
1. Set clear, measurable objectives for coding iterations
2. Maintain architectural coherence
3. AVOID FLIP-FLOPPING on decisions
4. Learn and persist constraints from failures

## Anti-Flip-Flop Rules
You MUST check your recent decisions before making new ones.
Recent decisions (last 20 iterations):

${flipFlopContext.map(d => `
- Iteration ${d.iteration}: ${d.decision_type}
  Decision: ${d.outcome}
  Reasoning: ${d.reasoning}
`).join('\n')}

If you are about to make a decision similar to one above, you MUST:
1. Acknowledge the previous decision
2. Explain what has changed
3. Justify why reversing is correct

## Learned Constraints (DO NOT VIOLATE)
${state.learnedConstraints.map(c => `- ${c}`).join('\n')}

## Current Focus
${state.currentFocus}

## Last Iteration Result
${JSON.stringify(state.lastIterationResult, null, 2)}

## Your Task
Analyze the last iteration result and decide:
1. Continue with current objective?
2. Adjust objective based on learnings?
3. Escalate to OnCall for investigation?
4. Approve upgrade if benchmarks improved?
5. Rollback if benchmarks regressed?

Respond with structured output matching PrincipalOutput schema.
`;
}
```

---

## 7. Complete Type Definitions

```typescript
// types/sias.ts

// === HEALTH ===
export type AgentType = 'principal' | 'oncall' | 'testing' | 'coding' | 'research';
export type AnomalyType = 'memory_pressure' | 'cpu_pressure' | 'iteration_timeout' |
  'consecutive_failures' | 'stalled_no_progress' | 'agent_failure_rate' |
  'agent_context_explosion' | 'benchmark_regression' | 'graphd_latency' |
  'graphd_unavailable' | 'checkpoint_stale';
export type RecoveryActionType = 'gc_force' | 'compact_agent_context' |
  'checkpoint_now' | 'restart_soft' | 'restart_hard_same_version' |
  'rollback_version' | 'pause_iteration_loop' | 'escalate_to_oncall' | 'halt_fatal';

// === BENCHMARKING ===
export type BenchmarkTier = 'smoke' | 'core' | 'full' | 'chaos';
export type BenchmarkCategory = 'correctness' | 'performance' | 'regression' | 'chaos';

// === CONTEXT ===
export type CompactionStrategy = 'summarize_preserve_decisions' |
  'preserve_recent_errors' | 'keep_latest_results_only';

// === ITERATION ===
export type IterationStatus = 'success' | 'blocked' | 'paused' | 'investigated' | 'upgraded';
export type PrincipalDecisionType = 'continue' | 'adjust_objective' | 'escalate' |
  'approve_upgrade' | 'rollback' | 'pause';
export type OnCallStatus = 'ongoing' | 'resolved' | 'escalated' | 'blocked';
export type TestingRecommendation = 'proceed' | 'block' | 'investigate';

// === WORKTREE ===
export type WorktreeStatus = 'active' | 'wip' | 'archived' | 'failed';

// === PERSISTENCE ===
export type SessionStatus = 'running' | 'paused' | 'crashed' | 'completed';
export type PatchStatus = 'applied' | 'rolled_back';
```

---

## 8. Implementation Phases

1. **Phase 1: Health System**
   - Implement HealthCollector
   - Add anomaly detection
   - Add recovery procedures
   - Wire into kernel loop

2. **Phase 2: Benchmarking**
   - Define benchmark suite
   - Implement IsolatedBenchmarkRunner
   - Add tiered execution
   - Wire into iteration flow

3. **Phase 3: Agent Specifications**
   - Implement PrincipalEngineer config/prompts
   - Implement OnCallEngineer config/prompts
   - Implement TestingAgent config/prompts
   - Add structured output validation

4. **Phase 4: Context Management**
   - Implement compaction strategies
   - Add per-agent policies
   - Wire into agent invocation

5. **Phase 5: Worktree Management**
   - Implement WorktreeManager
   - Add garbage collection
   - Add rollback support

6. **Phase 6: Anti-Flip-Flop**
   - Implement FlipFlopDetector
   - Add embedding storage
   - Integrate into Principal prompts

7. **Phase 7: Integration**
   - Wire all components together
   - End-to-end testing
   - Chaos testing
