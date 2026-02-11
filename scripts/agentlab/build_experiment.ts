#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentBuilder, LabClient } from '../../../Experiments/sdk/dist/src/index.js';

function buildExperimentObject() {
  const builder = ExperimentBuilder.create('exp_rex_sdk_smoke', 'Rex SDK Smoke')
    .description('Generated via @agentlab/sdk for the rex harness')
    .datasetJsonl('tasks.jsonl', {
      suiteId: 'local_suite',
      splitId: 'dev',
      limit: 1,
    })
    .harnessCli(['bash', './scripts/agentlab/run_cli_container.sh'], {
      integrationLevel: 'cli_events',
    })
    .sanitizationProfile('hermetic_functional_v2')
    .replications(1)
    .randomSeed(1337)
    .maxConcurrency(1)
    .baseline('base', {
      tier: 'simple',
      disable_memory: true,
      disable_entity_graph: true,
      disable_hooks: true,
    })
    .networkMode('none')
    .sandboxImage('jesus-harness:dev-arm64');

  const spec = builder.build() as Record<string, any>;
  spec.experiment.workload_type = 'agent_harness';
  spec.runtime.sandbox.engine = 'docker';
  return spec;
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '../..');
  const labDir = resolve(repoRoot, '.lab');
  const experimentPath = resolve(labDir, 'experiment.yaml');
  const tasksPath = resolve(labDir, 'tasks.jsonl');

  mkdirSync(labDir, { recursive: true });
  writeFileSync(
    tasksPath,
    `${JSON.stringify({ id: 't1', prompt: 'Return exactly this string: AGENTLAB_OK' })}\n`,
    'utf8',
  );

  const spec = buildExperimentObject();
  // JSON is valid YAML; writing JSON keeps this script dependency-light.
  writeFileSync(experimentPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  const client = new LabClient({
    runnerBin: resolve(repoRoot, 'lab'),
    cwd: repoRoot,
  });

  const summary = await client.describe({ experiment: '.lab/experiment.yaml' });
  console.log(`wrote: ${experimentPath}`);
  console.log(`wrote: ${tasksPath}`);
  console.log(`planned_trials: ${summary.summary.total_trials}`);
  console.log('next: ./lab run .lab/experiment.yaml --json');
}

await main();
