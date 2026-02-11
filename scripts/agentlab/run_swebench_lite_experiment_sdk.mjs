#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

function loadJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadPositiveInt(raw, fallback, label) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; got "${raw}"`);
  }
  return parsed;
}

function loadEnum(raw, fallback, label, allowed) {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')} (got "${value}")`);
  }
  return value;
}

function countJsonlRecords(path) {
  const text = readFileSync(path, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function ensureWorkloadType(yamlText) {
  const lines = yamlText.split('\n');
  const expIdx = lines.findIndex((line) => line.trim() === 'experiment:');
  if (expIdx < 0) return yamlText;

  let blockEnd = lines.length;
  for (let i = expIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (!line.startsWith('  ')) {
      blockEnd = i;
      break;
    }
  }

  const hasWorkload = lines
    .slice(expIdx + 1, blockEnd)
    .some((line) => line.startsWith('  workload_type:'));
  if (hasWorkload) {
    return yamlText;
  }

  lines.splice(expIdx + 1, 0, '  workload_type: agent_harness');
  return lines.join('\n');
}

async function loadSdk(projectRoot) {
  try {
    return await import('@agentlab/sdk');
  } catch (_) {
    const localSdk = process.env.AGENTLAB_SDK_LOCAL_PATH
      ? resolve(process.env.AGENTLAB_SDK_LOCAL_PATH)
      : resolve(projectRoot, '../Experiments/sdk/dist/src/index.js');
    if (!existsSync(localSdk)) {
      throw new Error(
        'Cannot import @agentlab/sdk and local SDK path not found. ' +
        `Set AGENTLAB_SDK_LOCAL_PATH or build SDK at ../Experiments/sdk`,
      );
    }
    return import(localSdk);
  }
}

function parseHosts(value) {
  if (!value || value.trim().length === 0) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function loadHarnessCommand(projectRoot) {
  const override = loadJsonEnv('AGENTLAB_HARNESS_CMD_JSON', null);
  if (Array.isArray(override) && override.length > 0 && override.every((v) => typeof v === 'string')) {
    return override;
  }
  return ['bun', './scripts/agentlab/run_cli.ts'];
}

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string', default: 'bench/agentlab/swebench_lite_curated.jsonl' },
      experiment: { type: 'string', default: '.lab/experiments/swebench_lite_curated.yaml' },
      'runner-bin': { type: 'string', default: './lab' },
      'write-only': { type: 'boolean', default: false },
      'describe-only': { type: 'boolean', default: false },
      limit: { type: 'string' },
      replications: { type: 'string', default: process.env.AGENTLAB_REPLICATIONS || '1' },
      seed: { type: 'string', default: process.env.AGENTLAB_RANDOM_SEED || '42' },
      concurrency: { type: 'string', default: process.env.AGENTLAB_MAX_CONCURRENCY || '1' },
      'integration-level': {
        type: 'string',
        default: process.env.AGENTLAB_INTEGRATION_LEVEL || 'cli_events',
      },
      'container-image': {
        type: 'string',
        default: process.env.AGENTLAB_SANDBOX_IMAGE || 'oven/bun:1.2.22',
      },
      'network-mode': {
        type: 'string',
        default: process.env.AGENTLAB_NETWORK_MODE || 'allowlist_enforced',
      },
      'allowed-hosts': {
        type: 'string',
        default: process.env.AGENTLAB_ALLOWED_HOSTS || 'api.openai.com',
      },
      executor: {
        type: 'string',
        default: process.env.AGENTLAB_EXECUTOR || 'local_docker',
      },
      materialize: {
        type: 'string',
        default: process.env.AGENTLAB_MATERIALIZE || 'full',
      },
      'remote-endpoint': {
        type: 'string',
        default: process.env.AGENTLAB_REMOTE_ENDPOINT || '',
      },
      'remote-token-env': {
        type: 'string',
        default: process.env.AGENTLAB_REMOTE_TOKEN_ENV || '',
      },
    },
    allowPositionals: false,
  });

  const projectRoot = process.cwd();
  const datasetAbs = resolve(projectRoot, values.dataset);
  if (!existsSync(datasetAbs)) {
    throw new Error(
      `Dataset not found at ${values.dataset}. Generate it first:\n` +
      `  node scripts/agentlab/build_curated_swebench_lite.mjs`,
    );
  }

  const harnessCommand = loadHarnessCommand(projectRoot);
  const harnessEntrypoint = harnessCommand[harnessCommand.length - 1];
  if (typeof harnessEntrypoint === 'string' && harnessEntrypoint.startsWith('./')) {
    const harnessPath = resolve(projectRoot, harnessEntrypoint);
    if (!existsSync(harnessPath)) {
      throw new Error(`Harness entrypoint not found: ${harnessEntrypoint}`);
    }
  }

  const expAbs = resolve(projectRoot, values.experiment);
  mkdirSync(dirname(expAbs), { recursive: true });

  const replications = loadPositiveInt(values.replications, 1, '--replications');
  const randomSeed = loadPositiveInt(values.seed, 42, '--seed');
  const maxConcurrency = loadPositiveInt(values.concurrency, 1, '--concurrency');
  const datasetCount = countJsonlRecords(datasetAbs);
  const limit = loadPositiveInt(values.limit, datasetCount, '--limit');
  const safeLimit = Math.min(limit, datasetCount);
  if (safeLimit <= 0) {
    throw new Error('Dataset is empty.');
  }

  const networkMode = values['network-mode'];
  const allowedHosts = parseHosts(values['allowed-hosts']);
  const integrationLevel = loadEnum(
    values['integration-level'],
    'cli_events',
    '--integration-level',
    ['cli_basic', 'cli_events'],
  );
  const executor = loadEnum(
    values.executor,
    'local_docker',
    '--executor',
    ['local_docker', 'local_process', 'remote'],
  );
  const materialize = loadEnum(
    values.materialize,
    'full',
    '--materialize',
    ['none', 'metadata_only', 'outputs_only', 'full'],
  );
  const remoteEndpoint = (values['remote-endpoint'] || '').trim() || undefined;
  const remoteTokenEnv = (values['remote-token-env'] || '').trim() || undefined;
  if (executor === 'remote' && !remoteEndpoint) {
    throw new Error('--remote-endpoint is required when --executor=remote');
  }
  const expDirAbs = dirname(expAbs);
  const datasetRelFromExp = relative(expDirAbs, datasetAbs);

  const baselineBindings = loadJsonEnv('AGENTLAB_BASELINE_BINDINGS_JSON', {
    prompt_profile: 'baseline',
  });
  const treatmentBindings = loadJsonEnv('AGENTLAB_TREATMENT_BINDINGS_JSON', {
    prompt_profile: 'treatment',
  });

  const { ExperimentBuilder, LabClient, Metric } = await loadSdk(projectRoot);

  const builder = ExperimentBuilder.create(
    'swebench_lite_curated_rex_harness',
    'SWE-bench Lite Curated (Rex Harness)',
  )
    .description('Containerized SDK experiment against /jesus real harness (not dev mode).')
    .owner('jevinnishioka')
    .tags(['swebench-lite', 'curated', 'rex', 'container'])
    .datasetJsonl(datasetRelFromExp, {
      suiteId: 'swebench_lite_curated',
      splitId: 'test',
      limit: safeLimit,
    })
    .harnessCli(harnessCommand, { integrationLevel })
    .sanitizationProfile('hermetic_functional_v2')
    .replications(replications)
    .randomSeed(randomSeed)
    .maxConcurrency(maxConcurrency)
    .baseline('control', baselineBindings)
    .addVariant('treatment', treatmentBindings)
    .metric(Metric.DURATION_MS)
    .metric(Metric.TOKENS_IN)
    .metric(Metric.TOKENS_OUT)
    .metric(Metric.TURN_COUNT)
    .metric(Metric.fromOutput('success', '/metrics/success', {
      primary: true,
      weight: 1.0,
      direction: 'maximize',
    }))
    .metric(Metric.fromOutput('latency_ms', '/metrics/latency_ms', {
      direction: 'minimize',
    }))
    .artifacts({ collect: ['**/*.patch', 'output/**', 'logs/**'], diff: true })
    .metric(Metric.FILES_MODIFIED)
    .metric(Metric.DIFF_LINES)
    .networkMode(networkMode, allowedHosts)
    .sandboxImage(values['container-image']);

  const yaml = ensureWorkloadType(builder.toYaml());
  writeFileSync(expAbs, yaml);

  console.log(`Wrote experiment config: ${values.experiment}`);
  console.log(`Harness command: ${JSON.stringify(harnessCommand)}`);
  console.log(`Dataset tasks: ${datasetCount} (limit=${safeLimit})`);
  console.log(`Container image: ${values['container-image']}`);
  console.log(`Network: ${networkMode} [${allowedHosts.join(', ')}]`);
  console.log(`Integration: ${integrationLevel}`);
  console.log(`Executor: ${executor}`);
  console.log(`Materialize: ${materialize}`);
  if (remoteEndpoint) {
    console.log(`Remote endpoint: ${remoteEndpoint}`);
  }
  if (remoteTokenEnv) {
    console.log(`Remote token env: ${remoteTokenEnv}`);
  }

  if (values['write-only']) {
    console.log('Write only; skipping describe and run.');
    return;
  }

  const client = new LabClient({
    cwd: projectRoot,
    runnerBin: values['runner-bin'],
  });

  const describe = await client.describe({ experiment: values.experiment });
  console.log(`Planned trials: ${describe.summary.total_trials}`);

  if (values['describe-only']) {
    console.log('Describe only; skipping run.');
    return;
  }

  const run = await client.run({
    experiment: values.experiment,
    executor,
    materialize,
    remoteEndpoint,
    remoteTokenEnv,
  });
  console.log(`Run complete: ${run.run.run_id}`);
  if (run.executor) {
    console.log(`Runner executor: ${run.executor}`);
  }
  if (run.materialize) {
    console.log(`Runner materialize: ${run.materialize}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
