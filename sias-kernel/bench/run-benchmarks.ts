/**
 * Run benchmarks and report results.
 * Usage: bun run sias-kernel/bench/run-benchmarks.ts [tier]
 * Default tier: smoke
 */

import { BenchmarkRunner, BENCHMARK_TIERS, DEFAULT_BENCHMARK_SUITE } from '../benchmark.js';
import { GraphStore } from '../../packages/graphd/src/index.js';
import { createLogger } from '../../packages/agent-core/src/shared/logger.js';
import type { BenchmarkTier } from '../types.js';

async function main(): Promise<void> {
  const tier = (process.argv[2] as BenchmarkTier) || 'smoke';

  if (!['smoke', 'core', 'full', 'chaos'].includes(tier)) {
    console.error(`Invalid tier: ${tier}. Must be: smoke, core, full, chaos`);
    process.exit(1);
  }

  console.log(`\n=== Running ${tier.toUpperCase()} benchmarks ===\n`);

  const store = new GraphStore(':memory:');
  store.initialize();
  store.createSiasSession('bench-run', 'running');
  const logger = createLogger({ backend: 'console', format: 'pretty', level: 'warn' });
  const runner = new BenchmarkRunner('bench-run', store, logger, DEFAULT_BENCHMARK_SUITE);

  const result = await runner.runTier(tier);

  console.log('\n=== Results ===');
  console.log(`Tier: ${result.tier}`);
  console.log(`Duration: ${result.total_duration_ms}ms`);
  console.log(`Passed: ${result.passed_count}`);
  console.log(`Failed: ${result.failed_count}`);
  console.log(`Skipped: ${result.skipped_count}`);
  console.log(`Score: ${result.score.toFixed(1)}%`);

  if (result.failed_count > 0 || result.skipped_count > 0) {
    console.log('\n=== Failed/Skipped Details ===');
    for (const r of result.results) {
      if (!r.passed) {
        console.log(`\n[${r.skipped ? 'SKIPPED' : 'FAILED'}] ${r.benchmark_id}`);
        if (r.error) console.log(`  Error: ${r.error}`);
        if (r.stderr) console.log(`  Stderr: ${r.stderr.slice(0, 500)}`);
      }
    }
  }

  const tierPolicy = BENCHMARK_TIERS[tier];
  const passRate = result.results.length > 0
    ? (result.passed_count / result.results.length) * 100
    : 0;

  console.log(`\nPass rate: ${passRate.toFixed(1)}% (required: ${tierPolicy.min_passing_percent}%)`);

  store.close();

  if (passRate < tierPolicy.min_passing_percent) {
    console.log('\n❌ BENCHMARK FAILED');
    process.exit(1);
  }

  console.log('\n✅ BENCHMARK PASSED');
  process.exit(0);
}

main().catch((error) => {
  console.error('Benchmark runner crashed:', error);
  process.exit(1);
});
