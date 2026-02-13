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

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModelBindings(bindings, label) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new Error(`${label} must be an object with model_provider + model`);
  }
  const model = asNonEmptyString(bindings.model);
  const provider =
    asNonEmptyString(bindings.model_provider) ?? asNonEmptyString(bindings.provider);
  if (!provider || !model) {
    throw new Error(
      `${label} must include non-empty model_provider (or provider) and model`,
    );
  }
  return {
    ...bindings,
    model_provider: provider,
    model,
  };
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
    trialTimeoutMs,
    providerDbPathFromHost,
    providerMasterKeyPathFromHost,
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
        '--timeout-ms',
        String(trialTimeoutMs),
      ],
      { integrationLevel: 'sdk_full' },
    )
    .harnessControlPlane('file', '/state/lab_control.json')
    .harnessEnv({ HOME: '/state' })
    .benchmark({
      policy: {
        task_model: 'independent',
        scoring_lifecycle: 'predict_then_score',
        evaluator_mode: 'custom',
        required_evidence_classes: ['trial_output_ref'],
      },
      adapter: {
        command: ['bun', 'scripts/agentlab/run_cli.ts', 'benchmark-adapter'],
        manifest: {
          schema_version: 'benchmark_adapter_manifest_v1',
          adapter_id: 'jesus_swebench_lite_adapter',
          adapter_version: '1.0.0',
          benchmark: {
            name: 'swebench_lite_curated',
            version: 'lite',
            split: 'test',
            source: 'SWE-bench Lite curated task set',
            license: 'SWE-bench dataset terms',
          },
          execution_mode: 'predict_then_score',
          record_schemas: {
            prediction: 'benchmark_prediction_record_v1',
            score: 'benchmark_score_record_v1',
          },
          evaluator: {
            name: 'jesus_swebench_custom_eval',
            version: '1.0.0',
            mode: 'custom',
            command: ['bun', 'scripts/agentlab/run_cli.ts', 'benchmark-adapter'],
          },
        },
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

  builder.harnessHostFileStaging([
    {
      source_from_host: providerDbPathFromHost,
      destination_path: '/state/.graphd/graphd.db',
      required: true,
    },
    {
      source_from_host: `${providerDbPathFromHost}-wal`,
      destination_path: '/state/.graphd/graphd.db-wal',
      required: false,
    },
    {
      source_from_host: `${providerDbPathFromHost}-shm`,
      destination_path: '/state/.graphd/graphd.db-shm',
      required: false,
    },
    {
      source_from_host: providerMasterKeyPathFromHost,
      destination_path: '/state/.config/rex/master.key',
      required: true,
    },
  ]);

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
      'provider-db-path': {
        type: 'string',
        default: process.env.AGENTLAB_PROVIDER_DB_PATH || '~/.graphd/graphd.db',
      },
      'provider-master-key-path': {
        type: 'string',
        default: process.env.AGENTLAB_PROVIDER_MASTER_KEY_PATH || '~/.config/rex/master.key',
      },
      'timeout-ms': {
        type: 'string',
        default: process.env.AGENTLAB_TRIAL_TIMEOUT_MS || '600000',
      },
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
  const trialTimeoutMs = parsePositiveInt(values['timeout-ms'], '--timeout-ms');
  const sdk = await loadSdk();

  const baselineBindings = normalizeModelBindings(
    loadJsonEnv('AGENTLAB_BASELINE_BINDINGS_JSON', {
      model_provider: 'z.ai-coder',
      model: 'glm-5',
    }),
    'AGENTLAB_BASELINE_BINDINGS_JSON',
  );
  const treatmentBindings = normalizeModelBindings(
    loadJsonEnv('AGENTLAB_TREATMENT_BINDINGS_JSON', {
      model_provider: 'z.ai-coder',
      model: 'glm-5',
    }),
    'AGENTLAB_TREATMENT_BINDINGS_JSON',
  );

  const datasetRelFromExperimentDir = relative(dirname(experimentAbs), datasetAbs);
  const builder = createExperimentBuilder(sdk, {
    experimentId: values.id,
    experimentName: values.name,
    datasetPath: datasetRelFromExperimentDir,
    datasetLimit,
    sandboxImage: values.image,
    baselineBindings,
    treatmentBindings,
    trialTimeoutMs,
    providerDbPathFromHost: values['provider-db-path'],
    providerMasterKeyPathFromHost: values['provider-master-key-path'],
  });

  const spec = builder.build();
  spec.experiment.workload_type = 'agent_harness';
  spec.runtime.harness.events = { path: '/state/harness_events.jsonl' };
  const yaml = yamlStringify(spec);
  writeFileSync(experimentAbs, yaml, 'utf8');

  console.log(`Wrote experiment: ${experimentAbs}`);
  console.log(`Dataset: ${datasetAbs}`);
  console.log(`Sandbox image: ${values.image}`);
  console.log(`Per-trial timeout ms: ${trialTimeoutMs}`);
  console.log(`Harness command: ${JSON.stringify(spec.runtime.harness.command)}`);
  console.log(
    `Provider DB source: ${values['provider-db-path']}`,
  );
  console.log(
    `Provider master key source: ${values['provider-master-key-path']}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
