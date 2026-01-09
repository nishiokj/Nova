import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import type { Logger } from '../packages/agent-core/src/shared/logger.js';
import type { BenchmarkSuiteResult, UpgradePolicy } from './types.js';
import type { WorktreeManager } from './worktree.js';

export async function prepareUpgrade(worktreeManager: WorktreeManager): Promise<string> {
  return worktreeManager.promoteWip();
}

export async function triggerUpgrade(
  newKernelPath: string,
  upgradeSignalFile: string,
  logger: Logger
): Promise<void> {
  const tempFile = `${upgradeSignalFile}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tempFile, newKernelPath, 'utf-8');
  await fs.rename(tempFile, upgradeSignalFile);
  logger.info('[kernel] Upgrade signal sent', { path: newKernelPath });
}

export async function triggerRollback(worktreeManager: WorktreeManager, version: string): Promise<void> {
  await worktreeManager.rollbackToVersion(version);
}

export function shouldUpgrade(
  benchmarkResult: BenchmarkSuiteResult | undefined,
  policy: UpgradePolicy,
  iterationsSinceLastUpgrade: number
): boolean {
  if (iterationsSinceLastUpgrade < policy.min_iterations_between_upgrades) {
    return false;
  }

  if (!benchmarkResult) {
    return iterationsSinceLastUpgrade >= policy.max_iterations_before_checkpoint;
  }

  if (policy.require_all_tests_pass && benchmarkResult.failed_count > 0) {
    return false;
  }

  if (benchmarkResult.improvement_percent >= policy.benchmark_improvement_threshold) {
    return true;
  }

  if (benchmarkResult.improvement_percent < -policy.max_allowed_regression) {
    return false;
  }

  return iterationsSinceLastUpgrade >= policy.max_iterations_before_checkpoint;
}
