#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { stringify as yamlStringify } from 'yaml';
import { BENCHMARK_PROFILES, DEFAULT_BENCHMARK } from './benchmark_profiles.mjs';

const WORKSPACE_ROOT = resolve(process.cwd());
const SDK_FALLBACK = resolve(WORKSPACE_ROOT, '../Experiments/sdk/dist/src/index.js');

function toPositiveInt(raw, label) {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer (got: ${raw})`);
  }
  return value;
}

function resolvePath(input) {
  return isAbsolute(input) ? input : resolve(WORKSPACE_ROOT, input);
}

function parseJsonlRows(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSON at line ${idx + 1} in ${path}: ${error.message}`);
      }
    });
}

function countJsonlRows(path) {
  return parseJsonlRows(path).length;
}

function validateDataset(datasetPath, experimentSpec) {
  const rows = parseJsonlRows(datasetPath);
  if (rows.length === 0) {
    throw new Error(`dataset is empty: ${datasetPath}`);
  }

  const imageSource = experimentSpec?.runtime?.agent?.image_source;
  const seenIds = new Map();
  let firstSchemaVersion = null;

  for (let i = 0; i < rows.length; i++) {
    const lineNum = i + 1;
    const row = rows[i];
    const taskId = row?.task?.id ?? row?.id;

    if (!taskId) {
      throw new Error(`task missing 'id' at line ${lineNum}`);
    }
    if (seenIds.has(taskId)) {
      throw new Error(`duplicate task ID '${taskId}' at lines ${seenIds.get(taskId)} and ${lineNum}`);
    }
    seenIds.set(taskId, lineNum);

    if (imageSource === 'per_task' && !row?.task?.image) {
      throw new Error(`task '${taskId}' at line ${lineNum} missing 'task.image' (required for image_source=per_task)`);
    }

    const sv = row?.schema_version ?? null;
    if (firstSchemaVersion === null) {
      firstSchemaVersion = sv;
    } else if (sv !== firstSchemaVersion) {
      throw new Error(
        `inconsistent schema_version at line ${lineNum}: expected '${firstSchemaVersion}', got '${sv}'`,
      );
    }
  }
}

function resolveBenchmarkProfile(raw) {
  const requested = String(raw ?? DEFAULT_BENCHMARK).trim();
  if (!requested) {
    throw new Error('benchmark name cannot be empty');
  }

  if (BENCHMARK_PROFILES[requested]) {
    return { key: requested, profile: BENCHMARK_PROFILES[requested] };
  }

  const lowerRequested = requested.toLowerCase();
  for (const [key, profile] of Object.entries(BENCHMARK_PROFILES)) {
    if ((profile.aliases ?? []).some((alias) => alias.toLowerCase() === lowerRequested)) {
      return { key, profile };
    }
  }

  throw new Error(`unknown benchmark '${requested}' (available: ${Object.keys(BENCHMARK_PROFILES).join(', ')})`);
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBindings(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const modelProvider = asNonEmptyString(input.model_provider) ?? asNonEmptyString(input.provider);
  const model = asNonEmptyString(input.model);
  if (!modelProvider || !model) {
    throw new Error(`${label} must include non-empty model_provider (or provider) and model`);
  }

  return {
    ...input,
    model_provider: modelProvider,
    model,
  };
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveBenchmarkAdapterCommand(profile) {
  const override = parseJsonEnv('AGENTLAB_BENCHMARK_ADAPTER_CMD_JSON', null);
  if (override !== null) {
    if (!Array.isArray(override) || override.length === 0 || override.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      throw new Error('AGENTLAB_BENCHMARK_ADAPTER_CMD_JSON must be a non-empty JSON array of strings');
    }
    return override.map((value) => value.trim());
  }

  const pythonBin = asNonEmptyString(process.env.AGENTLAB_BENCHMARK_GRADER_PYTHON) ?? 'python';
  const split = asNonEmptyString(profile?.dataset?.splitId) ?? 'test';
  const benchmarkName = asNonEmptyString(profile?.dataset?.suiteId) ?? 'swebench_lite_curated';

  return [
    pythonBin,
    '/opt/agent/scripts/agentlab/swebench_task_container_grader.py',
    '--benchmark-name',
    benchmarkName,
    '--split',
    split,
    '--workspace-repo-relpath',
    'repo',
  ];
}

function buildCredentialStaging(homeDir) {
  const candidates = [
    {
      source_from_host: resolve(homeDir, '.config/nova/master.key'),
      destination_path: '/agentlab/deps/home/.config/nova/master.key',
      required: true,
    },
    {
      source_from_host: resolve(homeDir, '.codex/auth.json'),
      destination_path: '/agentlab/deps/home/.codex/auth.json',
      required: false,
    },
    {
      source_from_host: resolve(homeDir, '.config/nova/codex-auth.json'),
      destination_path: '/agentlab/deps/home/.config/nova/codex-auth.json',
      required: false,
    },
  ];

  return candidates.filter((entry) => existsSync(entry.source_from_host));
}

async function loadSdk() {
  try {
    return await import('@agentlab/sdk');
  } catch {
    if (!existsSync(SDK_FALLBACK)) {
      throw new Error(`AgentLab SDK not found at ${SDK_FALLBACK}`);
    }
    return import(pathToFileURL(SDK_FALLBACK).href);
  }
}

function maybeEnableBuiltinAdapter(builder) {
  const candidate =
    (typeof builder.useBuiltinAdapter === 'function' && builder.useBuiltinAdapter.bind(builder)) ||
    (typeof builder.useBuiltInAdapter === 'function' && builder.useBuiltInAdapter.bind(builder));
  if (candidate) {
    candidate();
  }
  return builder;
}

function chooseSpecPath(outputAbs, targetAbs) {
  if (!targetAbs) {
    return null;
  }
  const rel = relative(dirname(outputAbs), targetAbs);
  if (!rel || rel === '.') {
    return 'agent_artifact.tar.gz';
  }
  return rel;
}

async function main() {
  const { values } = parseArgs({
    options: {
      benchmark: { type: 'string', default: DEFAULT_BENCHMARK },
      dataset: { type: 'string' },
      output: { type: 'string' },
      image: { type: 'string' },
      'agent-artifact': { type: 'string' },
      workspace: { type: 'string' },
      'agent-cmd': { type: 'string', default: '/opt/agent/bin/nova' },
      limit: { type: 'string' },
      'timeout-ms': { type: 'string' },
      replications: { type: 'string', default: '1' },
      seed: { type: 'string', default: '42' },
      'max-concurrency': { type: 'string', default: '1' },
      owner: { type: 'string', default: process.env.AGENTLAB_EXPERIMENT_OWNER ?? process.env.USER ?? 'unknown' },
      'skip-credential-staging': { type: 'boolean', default: false },
      'disable-benchmark-adapter': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const { key: benchmarkKey, profile } = resolveBenchmarkProfile(values.benchmark);
  const datasetInput = values.dataset ?? profile.defaultDataset;
  const outputInput = values.output ?? profile.defaultOutput;
  const fallbackImage = values.image ?? 'agentlab/per-task-placeholder:latest';
  const workspace = asNonEmptyString(values.workspace) ?? profile.defaultWorkspace ?? '/testbed';
  const agentCmd = asNonEmptyString(values['agent-cmd']) ?? '/opt/agent/bin/nova';
  const agentArtifactInput = values['agent-artifact'] ?? profile.defaultAgentArtifact ?? '.lab/agents/nova-current.tar.gz';

  const datasetAbs = resolvePath(datasetInput);
  if (!existsSync(datasetAbs)) {
    throw new Error(`dataset not found: ${datasetAbs}`);
  }

  const outputAbs = resolvePath(outputInput);
  mkdirSync(dirname(outputAbs), { recursive: true });

  const agentArtifactAbs = resolvePath(agentArtifactInput);
  const agentArtifactSpecPath = chooseSpecPath(outputAbs, agentArtifactAbs);

  const datasetRows = countJsonlRows(datasetAbs);
  const requestedLimit = values.limit ? toPositiveInt(values.limit, '--limit') : datasetRows;
  const effectiveLimit = Math.min(datasetRows, requestedLimit);
  const timeoutMs = values['timeout-ms']
    ? toPositiveInt(values['timeout-ms'], '--timeout-ms')
    : (typeof profile.timeoutMs === 'number' ? profile.timeoutMs : 600_000);
  const replications = toPositiveInt(values.replications, '--replications');
  const seed = toPositiveInt(values.seed, '--seed');
  const maxConcurrency = toPositiveInt(values['max-concurrency'], '--max-concurrency');

  const baselineBindings = normalizeBindings(
    parseJsonEnv('AGENTLAB_BASELINE_BINDINGS_JSON', {
      model_provider: 'z.ai-coder',
      model: 'glm-5',
      agent_type: 'standard',
    }),
    'AGENTLAB_BASELINE_BINDINGS_JSON',
  );
  const treatmentBindings = normalizeBindings(
    parseJsonEnv('AGENTLAB_TREATMENT_BINDINGS_JSON', {
      model_provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      agent_type: 'standard',
    }),
    'AGENTLAB_TREATMENT_BINDINGS_JSON',
  );

  const sdk = await loadSdk();
  const { ExperimentBuilder, ExperimentType, Metric } = sdk;

  const datasetRel = relative(dirname(outputAbs), datasetAbs);
  const datasetPath = datasetRel.startsWith('..') ? datasetAbs : datasetRel;

  const builder = ExperimentBuilder.create(profile.experiment.id, profile.experiment.name)
    .description(profile.experiment.description)
    .owner(values.owner)
    .tags(profile.experiment.tags)
    .datasetJsonl(datasetPath, {
      suiteId: profile.dataset.suiteId,
      schemaVersion: profile.dataset.schemaVersion,
      splitId: profile.dataset.splitId,
      limit: effectiveLimit,
    })
    .customAgentImage(fallbackImage, [
      agentCmd,
      'run',
      '--bindings-file',
      '${AGENTLAB_BINDINGS_PATH}',
      '--events',
      '${AGENTLAB_TRAJECTORY_PATH}',
      '--session-key',
      '${AGENTLAB_TRIAL_ID}',
      '--working-dir',
      '${WORKSPACE}',
      '--dangerous',
    ])
    .agentIo('--input-file', '--output')
    .agentEnv({
      HOME: '/agentlab/deps/home',
      AGENTLAB_SESSION_CONTEXT_ROOT: '/agentlab/state/.haiku/sessions',
    })
    .sanitizationProfile('hermetic_functional')
    .policies(ExperimentType.AB_TEST)
    .replications(replications)
    .randomSeed(seed)
    .maxConcurrency(maxConcurrency)
    .baseline('glm_5', baselineBindings)
    .addVariant('gpt_5_3_codex_spark', treatmentBindings)
    .metric(Metric.fromOutput('success', '/metrics/success', {
      primary: true,
      weight: 1,
      direction: 'maximize',
    }))
    .timeoutMs(timeoutMs)
    .networkMode('full')
    .sandboxImage(fallbackImage);
  maybeEnableBuiltinAdapter(builder);

  let benchmarkAdapterCommand = null;
  if (!values['disable-benchmark-adapter']) {
    benchmarkAdapterCommand = resolveBenchmarkAdapterCommand(profile);
    const benchmarkName = asNonEmptyString(profile?.dataset?.suiteId) ?? 'swebench_lite_curated';
    const split = asNonEmptyString(profile?.dataset?.splitId) ?? 'test';

    builder.benchmark({
      policy: {
        task_model: 'independent',
        evaluator_mode: 'custom',
        scoring_lifecycle: 'integrated_score',
        chain_failure_policy: 'continue_with_flag',
      },
      adapter: {
        command: benchmarkAdapterCommand,
        manifest: {
          schema_version: 'benchmark_adapter_manifest_v1',
          adapter_id: 'jesus.swebench_in_container',
          adapter_version: 'v2-per-task',
          benchmark: {
            name: benchmarkName,
            split,
          },
          execution_mode: 'integrated_score',
          record_schemas: {
            prediction: 'benchmark_prediction_record_v1',
            score: 'benchmark_score_record_v1',
          },
          evaluator: {
            name: 'swebench.in_container_proxy',
            mode: 'custom',
            command: benchmarkAdapterCommand,
          },
          capabilities: {
            supports_containerized_scoring: true,
            supports_official_evaluator: false,
            requires_network_for_scoring: false,
            deterministic_scoring: true,
          },
        },
      },
    });
  }

  if (!values['skip-credential-staging']) {
    const staging = buildCredentialStaging(homedir());
    if (staging.length > 0) {
      builder.dependencyFileStaging(staging);
    }
  }

  const built = builder.build();
  built.experiment.workload_type = 'agent_loop';

  built.runtime.agent.image_source = 'per_task';
  built.runtime.agent.artifact = agentArtifactSpecPath;
  delete built.runtime.agent.image;
  if (!built.runtime.policy.sandbox || typeof built.runtime.policy.sandbox !== 'object') {
    built.runtime.policy.sandbox = { mode: 'container' };
  }
  built.runtime.policy.sandbox.root_read_only = false;

  validateDataset(datasetAbs, built);

  writeFileSync(outputAbs, `${yamlStringify(built)}\n`, 'utf8');

  console.log(`wrote experiment: ${outputAbs}`);
  console.log(`benchmark: ${benchmarkKey}`);
  console.log(`dataset rows=${datasetRows}, limit=${effectiveLimit}`);
  console.log(`dataset_path: ${datasetPath}`);
  console.log(`image_source: per_task`);
  console.log('runtime.agent.image: removed (per_task mode)');
  console.log(`agent_artifact: ${agentArtifactSpecPath}`);
  console.log(`workspace: ${workspace}`);
  console.log(`agent_cmd: ${agentCmd}`);
  console.log(`timeout_ms: ${timeoutMs}`);
  if (benchmarkAdapterCommand) {
    console.log(`benchmark_adapter_cmd: ${JSON.stringify(benchmarkAdapterCommand)}`);
  } else {
    console.log('benchmark_adapter_cmd: disabled');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
