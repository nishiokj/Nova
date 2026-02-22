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

function countJsonlRows(path) {
  const content = readFileSync(path, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
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

  const pythonBin = asNonEmptyString(process.env.AGENTLAB_SWEBENCH_PYTHON) ?? 'python3';
  const datasetName = asNonEmptyString(profile?.evaluator?.datasetName) ?? 'princeton-nlp/SWE-bench_Lite';
  const split = asNonEmptyString(profile?.dataset?.splitId) ?? 'test';
  const benchmarkName = asNonEmptyString(profile?.dataset?.suiteId) ?? 'swebench_lite_curated';

  return [
    pythonBin,
    'scripts/agentlab/swebench_official_benchmark_adapter.py',
    '--benchmark-name',
    benchmarkName,
    '--dataset-name',
    datasetName,
    '--split',
    split,
  ];
}

function buildCredentialStaging(homeDir) {
  const candidates = [
    {
      source_from_host: resolve(homeDir, '.config/rex/master.key'),
      destination_path: '/agentlab/deps/home/.config/rex/master.key',
      required: true,
    },
    {
      source_from_host: resolve(homeDir, '.graphd/graphd.db'),
      destination_path: '/agentlab/deps/home/.graphd/graphd.db',
      required: true,
    },
    {
      source_from_host: resolve(homeDir, '.graphd/graphd.db-wal'),
      destination_path: '/agentlab/deps/home/.graphd/graphd.db-wal',
      required: false,
    },
    {
      source_from_host: resolve(homeDir, '.graphd/graphd.db-shm'),
      destination_path: '/agentlab/deps/home/.graphd/graphd.db-shm',
      required: false,
    },
    {
      source_from_host: resolve(homeDir, '.codex/auth.json'),
      destination_path: '/agentlab/deps/home/.codex/auth.json',
      required: false,
    },
    {
      source_from_host: resolve(homeDir, '.config/rex/codex-auth.json'),
      destination_path: '/agentlab/deps/home/.config/rex/codex-auth.json',
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

function pruneSpec(spec) {
  const out = JSON.parse(JSON.stringify(spec));

  if (Array.isArray(out.runtime?.dependencies?.file_staging) && out.runtime.dependencies.file_staging.length === 0) {
    delete out.runtime.dependencies.file_staging;
  }
  if (Array.isArray(out.runtime?.dependencies?.services) && out.runtime.dependencies.services.length === 0) {
    delete out.runtime.dependencies.services;
  }
  if (
    out.runtime?.dependencies &&
    Object.keys(out.runtime.dependencies).length === 0
  ) {
    delete out.runtime.dependencies;
  }

  const overrides = out.runtime?.agent?.overrides;
  if (overrides) {
    if (Array.isArray(overrides.args) && overrides.args.length === 0) {
      delete overrides.args;
    }
    if (Array.isArray(overrides.env_from_host) && overrides.env_from_host.length === 0) {
      delete overrides.env_from_host;
    }
    if (overrides.env && Object.keys(overrides.env).length === 0) {
      delete overrides.env;
    }
    if (Object.keys(overrides).length === 0) {
      delete out.runtime.agent.overrides;
    }
  }

  return out;
}

function sanitizeStringArray(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function stripLegacyInputOutputTokens(command) {
  const stripped = [];
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index];
    const next = command[index + 1];
    const isLegacyInputPair = token === '--input-file' && next === '${AGENTLAB_TASK_PATH}';
    const isLegacyOutputPair = token === '--output' && next === '${AGENTLAB_RESULT_PATH}';
    if (isLegacyInputPair || isLegacyOutputPair) {
      index += 1;
      continue;
    }
    stripped.push(token);
  }
  return stripped;
}

function migrateRuntimeAgentToHardCut(spec) {
  const out = spec;
  const runtime = out?.runtime;
  const legacyAgent = runtime?.agent;
  if (!runtime || !legacyAgent || typeof legacyAgent !== 'object' || Array.isArray(legacyAgent)) {
    return out;
  }

  const legacyCustomImage =
    legacyAgent.custom_image && typeof legacyAgent.custom_image === 'object' && !Array.isArray(legacyAgent.custom_image)
      ? legacyAgent.custom_image
      : null;
  const legacyEntry = sanitizeStringArray(legacyCustomImage?.entrypoint);
  const migratedCommand = stripLegacyInputOutputTokens(legacyEntry);
  const command = migratedCommand.length > 0 ? migratedCommand : legacyEntry;
  if (command.length === 0) {
    return out;
  }

  const image =
    asNonEmptyString(legacyCustomImage?.image) ??
    asNonEmptyString(runtime?.policy?.sandbox?.image);
  const overrides =
    legacyAgent.overrides && typeof legacyAgent.overrides === 'object' && !Array.isArray(legacyAgent.overrides)
      ? legacyAgent.overrides
      : null;
  const env =
    overrides?.env && typeof overrides.env === 'object' && !Array.isArray(overrides.env)
      ? Object.fromEntries(
        Object.entries(overrides.env).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
      )
      : {};
  const envFromHost = sanitizeStringArray(overrides?.env_from_host);

  const migratedAgent = {
    command,
    io: {
      input_arg: '--input-file',
      output_arg: '--output',
    },
  };
  if (image) {
    migratedAgent.image = image;
  }
  if (Object.keys(env).length > 0) {
    migratedAgent.env = env;
  }
  if (envFromHost.length > 0) {
    migratedAgent.env_from_host = envFromHost;
  }

  runtime.agent = migratedAgent;
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      benchmark: { type: 'string', default: DEFAULT_BENCHMARK },
      dataset: { type: 'string' },
      output: { type: 'string' },
      image: { type: 'string' },
      'agent-cmd': { type: 'string', default: 'rex' },
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
  const image = values.image ?? profile.defaultImage;
  const agentCmd = asNonEmptyString(values['agent-cmd']) ?? 'rex';

  const datasetAbs = resolvePath(datasetInput);
  if (!existsSync(datasetAbs)) {
    throw new Error(`dataset not found: ${datasetAbs}`);
  }

  const outputAbs = resolvePath(outputInput);
  mkdirSync(dirname(outputAbs), { recursive: true });

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
  const { ExperimentBuilder, Metric } = sdk;

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
    .customAgentImage(image, [
      agentCmd,
      'run',
      '--input-file',
      '${AGENTLAB_TASK_PATH}',
      '--bindings-file',
      '${AGENTLAB_BINDINGS_PATH}',
      '--output',
      '${AGENTLAB_RESULT_PATH}',
      '--events',
      '${AGENTLAB_TRAJECTORY_PATH}',
      '--session-key',
      '${AGENTLAB_TRIAL_ID}',
      '--working-dir',
      '/agentlab/workspace/repo',
      '--dangerous',
    ])
    .useBuiltinAdapter()
    .agentEnv({ HOME: '/agentlab/deps/home' })
    .sanitizationProfile('hermetic_functional')
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
    .sandboxImage(image);

  let benchmarkAdapterCommand = null;
  if (!values['disable-benchmark-adapter']) {
    benchmarkAdapterCommand = resolveBenchmarkAdapterCommand(profile);
    builder.benchmark({
      policy: {
        task_model: 'independent',
        evaluator_mode: 'official',
        scoring_lifecycle: 'predict_then_score',
        chain_failure_policy: 'continue_with_flag',
      },
      adapter: {
        command: benchmarkAdapterCommand,
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
  const spec = pruneSpec(migrateRuntimeAgentToHardCut(built));
  writeFileSync(outputAbs, `${yamlStringify(spec)}\n`, 'utf8');

  console.log(`wrote experiment: ${outputAbs}`);
  console.log(`benchmark: ${benchmarkKey}`);
  console.log(`dataset rows=${datasetRows}, limit=${effectiveLimit}`);
  console.log(`image: ${image}`);
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
