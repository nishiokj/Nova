#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { stringify as yamlStringify } from 'yaml';

const WORKSPACE_ROOT = resolve(process.cwd());
const EXPERIMENTS_SDK_FALLBACK = resolve(
  WORKSPACE_ROOT,
  '../Experiments/sdk/dist/src/index.js',
);

function parsePositiveInt(raw, name) {
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

function loadJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadSdk() {
  try {
    return await import('@agentlab/sdk');
  } catch {
    if (!existsSync(EXPERIMENTS_SDK_FALLBACK)) {
      throw new Error(
        `SDK not found at ${EXPERIMENTS_SDK_FALLBACK}. Build it with: cd ../Experiments/sdk && npm run build`,
      );
    }
    return import(pathToFileURL(EXPERIMENTS_SDK_FALLBACK).href);
  }
}

function createExperimentBuilder(
  sdk,
  {
    experimentId,
    experimentName,
    datasetPath,
    datasetLimit,
    sandboxImage,
    baselineBindings,
    treatmentBindings,
    providerEnvMap,
  },
) {
  const { ExperimentBuilder, Metric } = sdk;

  const builder = ExperimentBuilder.create(experimentId, experimentName)
    .description(
      'SWE-bench Lite experiment using rex-daemon run-trial in one isolated trial container.',
    )
    .owner('jevinnishioka')
    .tags(['agentlab', 'swebench-lite', 'single-container', 'rex-daemon'])
    .datasetJsonl(datasetPath, {
      suiteId: 'swebench_lite_curated',
      splitId: 'test',
      limit: datasetLimit,
    })
    .harnessCli(
      [
        'bun',
        'run',
        '--cwd',
        '/opt/rex',
        'packages/infra/harness-daemon/bin/rex.js',
        'run-trial',
        '--input',
        '/out/trial_input.json',
        '--output',
        '/out/trial_output.json',
        '--events',
        '/state/harness_events.jsonl',
        '--working-dir',
        '/workspace',
        '--config',
        '/harness/config/defaults.json',
        '--provider-env',
        providerEnvMap,
      ],
      { integrationLevel: 'sdk_full' },
    )
    .harnessEnvFromHost(['OPENAI_API_KEY'])
    .benchmark({
      policy: {
        task_model: 'independent',
        scoring_lifecycle: 'predict_then_score',
        evaluator_mode: 'custom',
      },
    })
    .sanitizationProfile('hermetic_functional_v2')
    .replications(1)
    .randomSeed(42)
    .maxConcurrency(1)
    .baseline('control', baselineBindings)
    .addVariant('treatment', treatmentBindings)
    .metric(Metric.DURATION_MS)
    .metric(Metric.TOKENS_IN)
    .metric(Metric.TOKENS_OUT)
    .metric(Metric.TURN_COUNT)
    .metric(Metric.TOOL_CALL_COUNT)
    .metric(
      Metric.fromOutput('success', '/metrics/success', {
        primary: true,
        weight: 1,
        direction: 'maximize',
      }),
    )
    .metric(
      Metric.fromOutput('latency_ms', '/metrics/latency_ms', {
        direction: 'minimize',
        weight: 0,
      }),
    )
    .artifacts({
      collect: ['output/**', 'logs/**', '**/*.patch'],
      diff: true,
    })
    .networkMode('full', ['api.openai.com'])
    .sandboxImage(sandboxImage);

  return builder;
}

async function main() {
  const { values } = parseArgs({
    options: {
      experiment: {
        type: 'string',
        default: '.lab/experiments/swebench_lite_sdk_single_container.yaml',
      },
      dataset: {
        type: 'string',
        default: 'bench/agentlab/swebench_lite_smoke_1.jsonl',
      },
      limit: { type: 'string', default: '1' },
      image: { type: 'string', default: process.env.AGENTLAB_SANDBOX_IMAGE || 'rex-harness:swebench-lite-v1' },
      id: { type: 'string', default: 'swebench_lite_sdk_single_container' },
      name: { type: 'string', default: 'SWE-bench Lite SDK Single-Container' },
      'provider-env': { type: 'string', default: 'openai=OPENAI_API_KEY' },
    },
    allowPositionals: false,
  });

  const datasetAbs = resolve(WORKSPACE_ROOT, values.dataset);
  if (!existsSync(datasetAbs)) {
    throw new Error(`Dataset file not found: ${datasetAbs}`);
  }

  const experimentAbs = resolve(WORKSPACE_ROOT, values.experiment);
  mkdirSync(dirname(experimentAbs), { recursive: true });

  const datasetLimit = parsePositiveInt(values.limit, '--limit');
  const sdk = await loadSdk();

  const baselineBindings = loadJsonEnv('AGENTLAB_BASELINE_BINDINGS_JSON', {
    model_provider: 'openai',
    model: 'gpt-4o-mini',
  });
  const treatmentBindings = loadJsonEnv('AGENTLAB_TREATMENT_BINDINGS_JSON', {
    model_provider: 'openai',
    model: 'gpt-4.1-mini',
  });

  const datasetRelFromExperimentDir = relative(dirname(experimentAbs), datasetAbs);
  const builder = createExperimentBuilder(sdk, {
    experimentId: values.id,
    experimentName: values.name,
    datasetPath: datasetRelFromExperimentDir,
    datasetLimit,
    sandboxImage: values.image,
    baselineBindings,
    treatmentBindings,
    providerEnvMap: values['provider-env'],
  });

  const spec = builder.build();
  spec.experiment.workload_type = 'agent_harness';
  spec.runtime.harness.events = { path: '/state/harness_events.jsonl' };
  const yaml = yamlStringify(spec);
  writeFileSync(experimentAbs, yaml, 'utf8');

  console.log(`Wrote experiment: ${experimentAbs}`);
  console.log(`Dataset: ${datasetAbs}`);
  console.log(`Sandbox image: ${values.image}`);
  console.log(`Harness command: ${JSON.stringify(spec.runtime.harness.command)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
