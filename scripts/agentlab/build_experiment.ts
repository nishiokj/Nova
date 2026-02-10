#!/usr/bin/env bun
import { ExperimentBuilder } from './experiment_sdk.ts';

function main(): void {
  const builder = ExperimentBuilder.forRex(process.cwd())
    .setId('exp_rex_sdk_ab_20260210')
    .setName('Rex SDK A/B Experiment')
    .setDescription('Programmatic experiment definition for the Rex harness')
    .setReplications(3)
    .setDatasetPath('tasks.jsonl', 20)
    .setBaseline('base', {
      tier: 'standard',
      disable_memory: true,
      disable_entity_graph: true,
      disable_hooks: true,
    })
    .addVariant('treatment_simple_tier', {
      tier: 'simple',
      disable_memory: true,
      disable_entity_graph: true,
      disable_hooks: true,
    })
    .addVariant('treatment_plan_mode', {
      tier: 'standard',
      plan_mode: true,
      disable_memory: true,
      disable_entity_graph: true,
      disable_hooks: true,
    })
    .addTask('t1', {
      prompt: 'Answer in one sentence: what is the purpose of unit tests?',
    })
    .addTask('t2', {
      prompt: 'Return exactly this string: AGENTLAB_OK',
    })
    .addTask('t3', {
      prompt: 'Give one practical debugging step when a script exits non-zero.',
    });

  const written = builder.write('.lab');
  console.log(`wrote: ${written.experimentPath}`);
  console.log(`wrote: ${written.tasksPath}`);
  console.log('next: ./lab describe .lab/experiment.yaml');
  console.log('next: ./lab run-dev .lab/experiment.yaml --setup "bun install --frozen-lockfile"');
}

main();
