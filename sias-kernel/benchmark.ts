import { spawn } from 'child_process';
import type { Logger } from '../packages/agent-core/src/shared/logger.js';
import type { GraphStore } from '../packages/graphd/src/index.js';
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  BenchmarkSuiteResult,
  BenchmarkTier,
} from './types.js';

export const BENCHMARK_TIERS: Record<BenchmarkTier, { max_duration_ms: number; min_passing_percent: number }> = {
  smoke: { max_duration_ms: 30000, min_passing_percent: 100 },
  core: { max_duration_ms: 120000, min_passing_percent: 95 },
  full: { max_duration_ms: 600000, min_passing_percent: 90 },
  chaos: { max_duration_ms: 1800000, min_passing_percent: 80 },
};

export const DEFAULT_BENCHMARK_SUITE: BenchmarkDefinition[] = [
  // Smoke tier: Quick verification that code loads and contracts hold
  {
    id: 'smoke-imports',
    name: 'Critical module imports',
    tier: 'smoke',
    category: 'correctness',
    timeout_ms: 15000,
    parallel_safe: true,
    requires: [],
    weight: 0.25,
    command: ['bun', 'run', 'sias-kernel/bench/smoke-imports.ts'],
    cwd: '.',
  },
  {
    id: 'smoke-instantiation',
    name: 'Class instantiation contracts',
    tier: 'smoke',
    category: 'correctness',
    timeout_ms: 20000,
    parallel_safe: true,
    requires: ['smoke-imports'],
    weight: 0.35,
    command: ['bun', 'run', 'sias-kernel/bench/smoke-instantiation.ts'],
    cwd: '.',
  },
  {
    id: 'smoke-lint-agent-core',
    name: 'Agent core typecheck',
    tier: 'smoke',
    category: 'correctness',
    timeout_ms: 30000,
    parallel_safe: true,
    requires: [],
    weight: 0.4,
    command: ['bun', 'run', 'lint'],
    cwd: 'packages/agent-core',
  },
  // Core tier: Build verification (self-contained, no cross-tier deps)
  {
    id: 'core-lint-agent-core',
    name: 'Agent core typecheck',
    tier: 'core',
    category: 'correctness',
    timeout_ms: 30000,
    parallel_safe: true,
    requires: [],
    weight: 0.15,
    command: ['bun', 'run', 'lint'],
    cwd: 'packages/agent-core',
  },
  {
    id: 'core-build-agent-core',
    name: 'Agent core build',
    tier: 'core',
    category: 'correctness',
    timeout_ms: 60000,
    parallel_safe: true,
    requires: ['core-lint-agent-core'],
    weight: 0.25,
    command: ['bun', 'run', 'build'],
    cwd: 'packages/agent-core',
  },
  {
    id: 'core-lint-graphd',
    name: 'GraphD typecheck',
    tier: 'core',
    category: 'correctness',
    timeout_ms: 30000,
    parallel_safe: true,
    requires: [],
    weight: 0.15,
    command: ['bun', 'run', 'lint'],
    cwd: 'packages/graphd',
  },
  {
    id: 'core-build-graphd',
    name: 'GraphD build',
    tier: 'core',
    category: 'correctness',
    timeout_ms: 60000,
    parallel_safe: true,
    requires: ['core-lint-graphd'],
    weight: 0.2,
    command: ['bun', 'run', 'build'],
    cwd: 'packages/graphd',
  },
  {
    id: 'core-lint-harness',
    name: 'Harness daemon typecheck',
    tier: 'core',
    category: 'correctness',
    timeout_ms: 30000,
    parallel_safe: true,
    requires: [],
    weight: 0.25,
    command: ['bun', 'run', 'lint'],
    cwd: 'apps/harness-daemon',
  },
];

export class BenchmarkRunner {
  private definitions: BenchmarkDefinition[];
  private logger: Logger;
  private store: GraphStore;
  private sessionId: string;

  constructor(
    sessionId: string,
    store: GraphStore,
    logger: Logger,
    definitions: BenchmarkDefinition[] = DEFAULT_BENCHMARK_SUITE
  ) {
    this.sessionId = sessionId;
    this.store = store;
    this.logger = logger;
    this.definitions = definitions;
  }

  async runTier(tier: BenchmarkTier): Promise<BenchmarkSuiteResult> {
    const startedAt = Date.now();
    const definitions = this.definitions.filter((def) => def.tier === tier);
    const results = await this.runDefinitions(definitions);
    const completedAt = Date.now();
    const score = calculateScore(results, definitions);
    const baseline = this.getBaseline(tier);
    const baselineScore = baseline?.score ?? 0;
    const improvementPercent = baselineScore > 0 ? (score - baselineScore) / baselineScore : 0;
    const regressions = calculateRegressions(results, baseline?.results ?? []);
    const tierPolicy = BENCHMARK_TIERS[tier];
    const passRate = results.length > 0 ? (results.filter((r) => r.passed).length / results.length) * 100 : 0;

    if (passRate < tierPolicy.min_passing_percent) {
      this.logger.warn('Benchmark pass rate below threshold', {
        tier,
        passRate,
        minPassingPercent: tierPolicy.min_passing_percent,
      });
    }
    if (completedAt - startedAt > tierPolicy.max_duration_ms) {
      this.logger.warn('Benchmark tier exceeded duration', {
        tier,
        duration_ms: completedAt - startedAt,
        max_duration_ms: tierPolicy.max_duration_ms,
      });
    }

    const suiteResult: BenchmarkSuiteResult = {
      tier,
      started_at: startedAt,
      completed_at: completedAt,
      total_duration_ms: completedAt - startedAt,
      results,
      score,
      passed_count: results.filter((r) => r.passed).length,
      failed_count: results.filter((r) => !r.passed && !r.skipped).length,
      skipped_count: results.filter((r) => r.skipped).length,
      baseline_score: baselineScore,
      improvement_percent: improvementPercent,
      regressions,
    };

    this.store.addSiasBenchmarkRun(
      this.sessionId,
      tier,
      startedAt / 1000,
      completedAt / 1000,
      score,
      suiteResult
    );

    return suiteResult;
  }

  private getBaseline(tier: BenchmarkTier): BenchmarkSuiteResult | null {
    const recent = this.store.listSiasBenchmarkRuns(this.sessionId, 5);
    const match = recent.find((run) => run.tier === tier && run.result);
    return match?.result as BenchmarkSuiteResult | null;
  }

  private async runDefinitions(definitions: BenchmarkDefinition[]): Promise<BenchmarkResult[]> {
    const pending = new Map(definitions.map((def) => [def.id, def]));
    const results = new Map<string, BenchmarkResult>();

    while (pending.size > 0) {
      const ready = Array.from(pending.values()).filter((def) =>
        def.requires.every((req) => {
          const res = results.get(req);
          return res ? res.passed : false;
        })
      );

      if (ready.length === 0) {
        for (const def of pending.values()) {
          results.set(def.id, this.skippedResult(def, 'dependency_failed'));
        }
        break;
      }

      const parallel = ready.filter((def) => def.parallel_safe);
      const serial = ready.filter((def) => !def.parallel_safe);

      const parallelResults = await Promise.all(parallel.map((def) => this.runBenchmark(def)));
      for (const result of parallelResults) {
        results.set(result.benchmark_id, result);
        pending.delete(result.benchmark_id);
      }

      for (const def of serial) {
        const result = await this.runBenchmark(def);
        results.set(result.benchmark_id, result);
        pending.delete(result.benchmark_id);
      }
    }

    return Array.from(results.values());
  }

  private async runBenchmark(definition: BenchmarkDefinition): Promise<BenchmarkResult> {
    const startedAt = Date.now();
    const env = {
      ...process.env,
      SIAS_BENCHMARK_ISOLATED: '1',
      SIAS_BENCHMARK_ID: definition.id,
      SIAS_BENCHMARK_TIMEOUT: String(definition.timeout_ms),
    };

    const result = await runCommand(definition.command, definition.cwd ?? process.cwd(), env, definition.timeout_ms);
    const completedAt = Date.now();
    const passed = result.exitCode === 0 && !result.timedOut;

    if (!passed) {
      this.logger.warn('Benchmark failed', { id: definition.id, error: result.error });
    }

    return {
      benchmark_id: definition.id,
      passed,
      skipped: false,
      duration_ms: completedAt - startedAt,
      started_at: startedAt,
      completed_at: completedAt,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode ?? undefined,
      error: result.error,
    };
  }

  private skippedResult(definition: BenchmarkDefinition, reason: string): BenchmarkResult {
    return {
      benchmark_id: definition.id,
      passed: false,
      skipped: true,
      duration_ms: 0,
      started_at: Date.now(),
      completed_at: Date.now(),
      error: reason,
    };
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

function runCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: null, timedOut, error: error.message });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

export function calculateScore(results: BenchmarkResult[], definitions: BenchmarkDefinition[]): number {
  let totalWeight = 0;
  let weightedScore = 0;

  for (const result of results) {
    const def = definitions.find((d) => d.id === result.benchmark_id);
    if (!def || def.weight === 0) continue;
    totalWeight += def.weight;
    if (result.passed) {
      weightedScore += def.weight;
    }
  }

  return totalWeight > 0 ? (weightedScore / totalWeight) * 100 : 0;
}

function calculateRegressions(
  results: BenchmarkResult[],
  baselineResults: BenchmarkResult[]
): Array<{ benchmark_id: string; baseline_value: number; current_value: number; regression_percent: number }> {
  const baselineMap = new Map(baselineResults.map((res) => [res.benchmark_id, res]));
  const regressions: Array<{ benchmark_id: string; baseline_value: number; current_value: number; regression_percent: number }> = [];

  for (const result of results) {
    const baseline = baselineMap.get(result.benchmark_id);
    if (!baseline) continue;
    const baselineValue = baseline.passed ? 1 : 0;
    const currentValue = result.passed ? 1 : 0;
    if (currentValue < baselineValue) {
      regressions.push({
        benchmark_id: result.benchmark_id,
        baseline_value: baselineValue,
        current_value: currentValue,
        regression_percent: baselineValue > 0 ? (baselineValue - currentValue) / baselineValue : 0,
      });
    }
  }

  return regressions;
}
