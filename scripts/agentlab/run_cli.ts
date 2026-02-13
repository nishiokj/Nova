#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type JsonPrimitive = string | number | boolean | null;
type MetricsMap = Record<string, JsonPrimitive>;

type TrialIds = {
  run_id: string;
  trial_id: string;
  variant_id: string;
  task_id: string;
  repl_idx: number;
};

type TrialInput = {
  ids?: Partial<TrialIds>;
  task?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  runtime?: {
    paths?: {
      state?: string;
    };
  };
};

type TrialOutput = {
  schema_version: 'trial_output_v1';
  ids: TrialIds;
  outcome: 'success' | 'failure' | 'missing' | 'error';
  answer?: string | Record<string, unknown> | unknown[];
  metrics?: MetricsMap;
  error?: {
    error_type?: string;
    message?: string;
    stack?: string;
  };
  ext?: Record<string, unknown>;
};

type CliOptions = {
  inputPath: string;
  outputPath: string;
  eventsPath?: string;
};

type EvidenceRecord = {
  ids?: Partial<TrialIds>;
  evidence?: Record<string, unknown>;
  paths?: {
    trial_input?: string;
    trial_output?: string;
  };
};

const ARTIFACT_REF_RE = /^artifact:\/\/sha256\/[0-9a-f]{64}$/;

const BENCHMARK_IDENTITY = {
  adapter_id: 'jesus_swebench_lite_adapter',
  adapter_version: '1.0.0',
  benchmark_name: 'swebench_lite_curated',
  benchmark_version: 'lite',
  benchmark_split: 'test',
  evaluator_name: 'jesus_swebench_custom_eval',
  evaluator_version: '1.0.0',
} as const;

function usageHarness(message: string): never {
  throw new Error(
    `${message}\n` +
      'Harness usage: bun scripts/agentlab/run_cli.ts --input <path> --output <path> [--events <path>]\n' +
      'Adapter usage: bun scripts/agentlab/run_cli.ts benchmark-adapter',
  );
}

function parseHarnessArgs(args: string[]): CliOptions {
  let inputPath = '';
  let outputPath = '';
  let eventsPath: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = i + 1 < args.length ? args[i + 1] : undefined;
    if (arg === '--input') {
      if (!next) usageHarness('--input requires a value');
      inputPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      if (!next) usageHarness('--output requires a value');
      outputPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--events') {
      if (!next) usageHarness('--events requires a value');
      eventsPath = resolve(next);
      i += 1;
      continue;
    }
    usageHarness(`Unknown argument: ${arg}`);
  }

  if (!inputPath) usageHarness('Missing required --input');
  if (!outputPath) usageHarness('Missing required --output');
  if (!existsSync(inputPath)) usageHarness(`Input path does not exist: ${inputPath}`);

  return { inputPath, outputPath, eventsPath };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function fallbackIds(partial?: Partial<TrialIds>): TrialIds {
  return {
    run_id: partial?.run_id || 'unknown_run',
    trial_id: partial?.trial_id || 'unknown_trial',
    variant_id: partial?.variant_id || 'unknown_variant',
    task_id: partial?.task_id || 'unknown_task',
    repl_idx: Number.isFinite(partial?.repl_idx) ? Number(partial?.repl_idx) : 0,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, body.length > 0 ? `${body}\n` : '', 'utf8');
}

function readJson<T>(path: string): T {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as T;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function resolveEventsPath(input: TrialInput, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const stateDir = input.runtime?.paths?.state;
  if (!stateDir || !existsSync(stateDir)) return undefined;
  return `${stateDir}/harness_events.jsonl`;
}

function maybeWriteEvents(eventsPath: string | undefined, ids: TrialIds, text: string): void {
  if (!eventsPath) return;
  const event = {
    ts: new Date().toISOString(),
    ids,
    event_type: 'response',
    content: text,
  };
  writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
}

function extractPrompt(task?: Record<string, unknown>): string | null {
  const input = task?.input;
  if (input && typeof input === 'object') {
    const prompt = (input as Record<string, unknown>).prompt;
    if (typeof prompt === 'string' && prompt.length > 0) return prompt;
  }
  const direct = task?.prompt;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return null;
}

function normalizeMetricValue(value: unknown): JsonPrimitive | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function normalizeMetrics(value: unknown): MetricsMap {
  const obj = asObject(value);
  if (!obj) return {};
  const out: MetricsMap = {};
  for (const [key, raw] of Object.entries(obj)) {
    const metric = normalizeMetricValue(raw);
    if (metric !== undefined) {
      out[key] = metric;
    }
  }
  return out;
}

function outcomeToVerdict(outcome: unknown): 'pass' | 'fail' | 'missing' | 'error' {
  if (outcome === 'success') return 'pass';
  if (outcome === 'failure') return 'fail';
  if (outcome === 'missing') return 'missing';
  if (outcome === 'error') return 'error';
  return 'error';
}

function firstArtifactRef(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && ARTIFACT_REF_RE.test(value)) {
      return value;
    }
  }
  return null;
}

function collectArtifactRefs(record: EvidenceRecord): Array<{ ref: string; logical_name: string }> {
  const evidence = asObject(record.evidence) ?? {};
  const refs: Array<{ ref: string; logical_name: string }> = [];
  const keys = [
    'trial_output_ref',
    'patch_cumulative_ref',
    'patch_incremental_ref',
    'diff_cumulative_ref',
    'diff_incremental_ref',
  ];
  for (const key of keys) {
    const candidate = evidence[key];
    if (typeof candidate === 'string' && ARTIFACT_REF_RE.test(candidate)) {
      refs.push({ ref: candidate, logical_name: key });
    }
  }
  return refs;
}

function resolveRunScopedPath(runDir: string, pathValue: unknown): string | null {
  if (typeof pathValue !== 'string' || !pathValue.trim()) return null;
  const fullPath = resolve(runDir, pathValue);
  if (!existsSync(fullPath)) return null;
  return fullPath;
}

function runBenchmarkAdapter(): void {
  const runId = requireEnv('AGENTLAB_RUN_ID');
  const runDir = requireEnv('AGENTLAB_RUN_DIR');
  const evidencePath = requireEnv('AGENTLAB_EVIDENCE_RECORDS_PATH');
  const manifestPath = requireEnv('AGENTLAB_ADAPTER_MANIFEST_PATH');
  const predictionsPath = requireEnv('AGENTLAB_PREDICTIONS_PATH');
  const scoresPath = requireEnv('AGENTLAB_SCORES_PATH');
  const tasksPath = process.env.AGENTLAB_BENCHMARK_TASKS_PATH;

  const evidenceRows = readJsonl(evidencePath) as EvidenceRecord[];
  const createdAt = new Date().toISOString();
  const adapterCommand = ['bun', 'scripts/agentlab/run_cli.ts', 'benchmark-adapter'];

  const manifest = {
    schema_version: 'benchmark_adapter_manifest_v1',
    created_at: createdAt,
    adapter_id: BENCHMARK_IDENTITY.adapter_id,
    adapter_version: BENCHMARK_IDENTITY.adapter_version,
    benchmark: {
      name: BENCHMARK_IDENTITY.benchmark_name,
      version: BENCHMARK_IDENTITY.benchmark_version,
      split: BENCHMARK_IDENTITY.benchmark_split,
      source: 'SWE-bench Lite curated task set',
      license: 'SWE-bench dataset terms',
    },
    execution_mode: 'predict_then_score',
    record_schemas: {
      prediction: 'benchmark_prediction_record_v1',
      score: 'benchmark_score_record_v1',
    },
    evaluator: {
      name: BENCHMARK_IDENTITY.evaluator_name,
      version: BENCHMARK_IDENTITY.evaluator_version,
      mode: 'custom',
      command: adapterCommand,
    },
    capabilities: {
      supports_containerized_scoring: false,
      supports_official_evaluator: false,
      requires_network_for_scoring: false,
      deterministic_scoring: true,
    },
    ext: {
      run_id: runId,
      scoring_policy: 'trial_output_success_metric',
    },
  } as const;

  const predictions: Array<Record<string, unknown>> = [];
  const scores: Array<Record<string, unknown>> = [];
  const tasks: Array<Record<string, unknown>> = [];

  for (const row of evidenceRows) {
    const ids = fallbackIds(row.ids);
    const paths = asObject(row.paths) ?? {};
    const evidence = asObject(row.evidence) ?? {};
    const trialOutputPath = resolveRunScopedPath(runDir, paths.trial_output);
    const trialInputPath = resolveRunScopedPath(runDir, paths.trial_input);

    const trialOutput = trialOutputPath ? readJson<TrialOutput>(trialOutputPath) : null;
    const metrics = normalizeMetrics(trialOutput?.metrics);
    const outcome = trialOutput?.outcome ?? 'missing';
    const verdict = outcomeToVerdict(outcome);
    const successMetric = metrics.success;
    const primaryMetricValue =
      typeof successMetric === 'number' && Number.isFinite(successMetric)
        ? successMetric
        : verdict === 'pass'
          ? 1
          : 0;
    const answer = trialOutput?.answer;

    let prediction: Record<string, unknown>;
    if (typeof answer === 'string') {
      prediction = { kind: 'text', value: answer };
    } else if (Array.isArray(answer) || (answer && typeof answer === 'object')) {
      prediction = { kind: 'json', value: answer };
    } else {
      const artifactRef = firstArtifactRef(
        evidence.patch_cumulative_ref,
        evidence.patch_incremental_ref,
        evidence.trial_output_ref,
      );
      prediction = artifactRef
        ? { kind: 'artifact_ref', artifact_ref: artifactRef }
        : {
            kind: 'json',
            value: {
              outcome,
              metrics,
            },
          };
    }

    predictions.push({
      schema_version: 'benchmark_prediction_record_v1',
      ts: createdAt,
      ids,
      benchmark: {
        adapter_id: BENCHMARK_IDENTITY.adapter_id,
        name: BENCHMARK_IDENTITY.benchmark_name,
        version: BENCHMARK_IDENTITY.benchmark_version,
        split: BENCHMARK_IDENTITY.benchmark_split,
      },
      prediction,
      metrics,
      ext: {
        trial_output_path: trialOutputPath,
      },
    });

    const scoreRow: Record<string, unknown> = {
      schema_version: 'benchmark_score_record_v1',
      ts: createdAt,
      ids,
      benchmark: {
        adapter_id: BENCHMARK_IDENTITY.adapter_id,
        name: BENCHMARK_IDENTITY.benchmark_name,
        version: BENCHMARK_IDENTITY.benchmark_version,
        split: BENCHMARK_IDENTITY.benchmark_split,
      },
      verdict,
      primary_metric_name: 'resolved',
      primary_metric_value: primaryMetricValue,
      metrics: {
        ...metrics,
        harness_outcome: outcome,
      },
      evaluator: {
        name: BENCHMARK_IDENTITY.evaluator_name,
        version: BENCHMARK_IDENTITY.evaluator_version,
        mode: 'custom',
        command: adapterCommand,
      },
      artifacts: collectArtifactRefs(row),
      ext: {
        trial_output_path: trialOutputPath,
      },
    };

    if (!trialOutputPath) {
      scoreRow.error = {
        error_type: 'missing_trial_output',
        message: `Missing trial output for ${ids.trial_id}`,
      };
    } else if (trialOutput?.error) {
      scoreRow.error = trialOutput.error;
    }

    scores.push(scoreRow);

    if (tasksPath && trialInputPath) {
      const trialInput = readJson<TrialInput>(trialInputPath);
      tasks.push({
        ids,
        task: trialInput.task ?? null,
        bindings: trialInput.bindings ?? null,
      });
    }
  }

  writeJson(manifestPath, manifest);
  writeJsonl(predictionsPath, predictions);
  writeJsonl(scoresPath, scores);
  if (tasksPath) {
    writeJsonl(tasksPath, tasks);
  }
}

function runHarness(args: string[]): void {
  const startMs = Date.now();
  let parsedInput: TrialInput | null = null;
  let parsedArgs: CliOptions | null = null;

  try {
    parsedArgs = parseHarnessArgs(args);
    parsedInput = readJson<TrialInput>(parsedArgs.inputPath);

    const ids = fallbackIds(parsedInput.ids);
    const prompt = extractPrompt(parsedInput.task);
    const latencyMs = Date.now() - startMs;

    const output: TrialOutput = {
      schema_version: 'trial_output_v1',
      ids,
      outcome: 'success',
      answer: prompt
        ? `Runner smoke harness received prompt (${prompt.length} chars).`
        : 'Runner smoke harness executed successfully.',
      metrics: {
        success: 1,
        latency_ms: latencyMs,
        total_tokens: 0,
      },
      ext: {
        harness: 'scripts/agentlab/run_cli.ts',
        smoke_mode: true,
      },
    };

    const eventsPath = resolveEventsPath(parsedInput, parsedArgs.eventsPath);
    maybeWriteEvents(eventsPath, ids, String(output.answer ?? ''));
    writeJson(parsedArgs.outputPath, output);
  } catch (error) {
    const ids = fallbackIds(parsedInput?.ids);
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    const output: TrialOutput = {
      schema_version: 'trial_output_v1',
      ids,
      outcome: 'error',
      metrics: { success: 0, latency_ms: Date.now() - startMs, total_tokens: 0 },
      error: {
        error_type: 'harness_runtime_error',
        message,
        stack,
      },
      ext: {
        harness: 'scripts/agentlab/run_cli.ts',
        smoke_mode: true,
      },
    };

    if (parsedArgs?.outputPath) {
      writeJson(parsedArgs.outputPath, output);
    } else {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
    process.stderr.write(`[run_cli] ${message}\n`);
    process.exit(1);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === 'benchmark-adapter') {
    try {
      runBenchmarkAdapter();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[benchmark-adapter] ${message}\n`);
      process.exit(1);
    }
    return;
  }
  runHarness(args);
}

main();
