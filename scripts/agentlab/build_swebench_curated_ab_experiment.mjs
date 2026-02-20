#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULTS = {
  dataset: '.lab/experiments/data/swebench_lite_curated.task_boundary_v1.jsonl',
  output: '.lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml',
  image: 'rex-harness:swebench-lite',
  replications: 1,
  seed: 42,
  maxConcurrency: 1,
};

const LONG_DEFAULT_TIMEOUT_MS = 1_800_000;
const BENCHMARK_TIMEOUT_MS = {
  'swebench-lite': 1_800_000,
  swebench_lite: 1_800_000,
  swebench_lite_curated: 1_800_000,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--dataset') {
      out.dataset = next;
      i += 1;
      continue;
    }
    if (arg === '--output') {
      out.output = next;
      i += 1;
      continue;
    }
    if (arg === '--image') {
      out.image = next;
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      out.limit = next;
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      out.timeoutMs = next;
      i += 1;
      continue;
    }
    if (arg === '--replications') {
      out.replications = next;
      i += 1;
      continue;
    }
    if (arg === '--seed') {
      out.seed = next;
      i += 1;
      continue;
    }
    if (arg === '--max-concurrency') {
      out.maxConcurrency = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  return out;
}

function toPositiveInt(raw, label) {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer; got ${raw}`);
  }
  return n;
}

function countJsonl(path) {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function detectBenchmarkKeyFromDataset(path) {
  const raw = readFileSync(path, 'utf8');
  const first = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return null;
  try {
    const parsed = JSON.parse(first);
    if (parsed && typeof parsed === 'object' && typeof parsed.source === 'string') {
      return parsed.source;
    }
  } catch {
    // ignore parse errors and fall back to path-based detection
  }
  return null;
}

function detectBenchmarkKey(datasetPath, detectedSource) {
  if (typeof detectedSource === 'string' && detectedSource.trim().length > 0) {
    return detectedSource.trim();
  }
  const lower = datasetPath.toLowerCase();
  if (lower.includes('swebench')) {
    return 'swebench-lite';
  }
  return 'unknown';
}

function resolveTimeoutMs(explicitTimeoutRaw, benchmarkKey) {
  if (explicitTimeoutRaw !== undefined && explicitTimeoutRaw !== null) {
    return toPositiveInt(explicitTimeoutRaw, '--timeout-ms');
  }
  const benchmarkDefault = BENCHMARK_TIMEOUT_MS[benchmarkKey];
  if (typeof benchmarkDefault === 'number' && benchmarkDefault > 0) {
    return benchmarkDefault;
  }
  return LONG_DEFAULT_TIMEOUT_MS;
}

function buildCredentialStagingEntries(homeDir) {
  const candidates = [
    {
      hostPath: resolve(homeDir, '.config/rex/master.key'),
      destinationPath: '/agentlab/deps/home/.config/rex/master.key',
      required: true,
      readOnly: true,
    },
    {
      hostPath: resolve(homeDir, '.graphd/graphd.db'),
      destinationPath: '/agentlab/deps/home/.graphd/graphd.db',
      required: true,
      readOnly: false,
    },
    {
      hostPath: resolve(homeDir, '.graphd/graphd.db-wal'),
      destinationPath: '/agentlab/deps/home/.graphd/graphd.db-wal',
      required: false,
      readOnly: false,
    },
    {
      hostPath: resolve(homeDir, '.graphd/graphd.db-shm'),
      destinationPath: '/agentlab/deps/home/.graphd/graphd.db-shm',
      required: false,
      readOnly: false,
    },
    {
      hostPath: resolve(homeDir, '.config/rex/codex-auth.json'),
      destinationPath: '/agentlab/deps/home/.config/rex/codex-auth.json',
      required: false,
      readOnly: true,
    },
    {
      hostPath: resolve(homeDir, '.codex/auth.json'),
      destinationPath: '/agentlab/deps/home/.codex/auth.json',
      required: false,
      readOnly: true,
    },
  ];

  return candidates
    .filter((entry) => existsSync(entry.hostPath))
    .map((entry) => ({
      source_from_host: entry.hostPath,
      destination_path: entry.destinationPath,
      required: entry.required,
      read_only: entry.readOnly,
    }));
}

function resolvePath(input, cwd) {
  return isAbsolute(input) ? input : resolve(cwd, input);
}

function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  const datasetAbs = resolvePath(args.dataset, cwd);
  if (!existsSync(datasetAbs)) {
    throw new Error(`dataset not found: ${datasetAbs}`);
  }

  const outputAbs = resolvePath(args.output, cwd);
  mkdirSync(dirname(outputAbs), { recursive: true });

  const datasetCount = countJsonl(datasetAbs);
  const limit = args.limit ? toPositiveInt(args.limit, '--limit') : datasetCount;
  const safeLimit = Math.min(limit, datasetCount);
  const detectedSource = detectBenchmarkKeyFromDataset(datasetAbs);
  const benchmarkKey = detectBenchmarkKey(datasetAbs, detectedSource);
  const timeoutMs = resolveTimeoutMs(args.timeoutMs, benchmarkKey);
  const replications = toPositiveInt(args.replications, '--replications');
  const seed = toPositiveInt(args.seed, '--seed');
  const maxConcurrency = toPositiveInt(args.maxConcurrency, '--max-concurrency');

  const outputDir = dirname(outputAbs);
  const datasetRel = relative(outputDir, datasetAbs);

  const stagingEntries = buildCredentialStagingEntries(homedir());
  if (stagingEntries.length === 0) {
    console.warn('warning: no local credential files found to stage into the container');
  }

  const spec = {
    version: '0.5',
    experiment: {
      workload_type: 'agent_loop',
      id: 'swebench_lite_curated_glm5_vs_codex_spark',
      name: 'SWE-bench Lite Curated: GLM-5 vs GPT-5.3 Codex Spark',
      tags: ['swebench-lite', 'curated', 'ab-test', 'glm-5', 'gpt-5.3-codex-spark'],
      description: 'A/B evaluation over curated SWE-bench Lite task-boundary dataset.',
      owner: 'jevinnishioka',
    },
    dataset: {
      suite_id: 'swebench_lite_curated',
      provider: 'local_jsonl',
      path: datasetRel,
      schema_version: 'task_boundary_v1',
      split_id: 'test',
      limit: safeLimit,
    },
    design: {
      sanitization_profile: 'hermetic_functional',
      comparison: 'paired',
      replications,
      random_seed: seed,
      shuffle_tasks: true,
      max_concurrency: maxConcurrency,
    },
    metrics: [
      { id: 'duration_ms', source: 'runner', weight: 0, primary: false },
      {
        id: 'tokens_in',
        source: 'events',
        event_type: 'model_call_end',
        event_field: 'usage.tokens_in',
        aggregate: 'sum',
        weight: 0,
        primary: false,
      },
      {
        id: 'tokens_out',
        source: 'events',
        event_type: 'model_call_end',
        event_field: 'usage.tokens_out',
        aggregate: 'sum',
        weight: 0,
        primary: false,
      },
      {
        id: 'turn_count',
        source: 'events',
        event_type: 'model_call_end',
        aggregate: 'count',
        weight: 0,
        primary: false,
      },
      {
        id: 'success',
        source: 'output',
        json_pointer: '/metrics/success',
        weight: 1,
        direction: 'maximize',
        primary: true,
      },
      {
        id: 'latency_ms',
        source: 'output',
        json_pointer: '/metrics/latency_ms',
        weight: 0,
        direction: 'minimize',
        primary: false,
      },
    ],
    artifacts: {
      collect: ['artifacts/**', 'output/**', '**/*.patch'],
      diff: true,
    },
    baseline: {
      variant_id: 'glm_5',
      bindings: {
        model_provider: 'z.ai-coder',
        model: 'glm-5',
        agent_type: 'standard',
      },
    },
    variant_plan: [
      {
        variant_id: 'gpt_5_3_codex_spark',
        bindings: {
          model_provider: 'codex',
          model: 'gpt-5.3-codex-spark',
          agent_type: 'standard',
        },
      },
    ],
    runtime: {
      agent: {
        mode: 'custom_image',
        custom_image: {
          image: args.image,
          entrypoint: ['bun', '/opt/rex/packages/infra/harness-daemon/bin/rex.js', 'run-agent-loop'],
        },
        overrides: {
          env: {
            HOME: '/agentlab/deps/home',
          },
          env_from_host: [],
        },
      },
      dependencies: {
        file_staging: stagingEntries,
      },
      policy: {
        timeout_ms: timeoutMs,
        network: {
          mode: 'full',
          allowed_hosts: [],
        },
        sandbox: {
          mode: 'container',
          image: args.image,
        },
      },
    },
    validity: {
      fail_on_state_leak: true,
      fail_on_profile_invariant_violation: true,
    },
  };

  writeFileSync(outputAbs, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  console.log(`wrote experiment config: ${outputAbs}`);
  console.log(`dataset rows=${datasetCount}, limit=${safeLimit}`);
  console.log(`image=${args.image}`);
  console.log(`benchmark=${benchmarkKey}`);
  console.log(`timeout_ms=${timeoutMs}`);
  console.log(`credential staging entries=${stagingEntries.length}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
