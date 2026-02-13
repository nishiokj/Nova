#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  metrics?: Record<string, string | number | boolean | null>;
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

function usage(message: string): never {
  throw new Error(
    `${message}\n` +
      'Usage: bun scripts/agentlab/run_cli.ts --input <path> --output <path> [--events <path>]',
  );
}

function parseArgs(args: string[]): CliOptions {
  let inputPath = '';
  let outputPath = '';
  let eventsPath: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = i + 1 < args.length ? args[i + 1] : undefined;
    if (arg === '--input') {
      if (!next) usage('--input requires a value');
      inputPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      if (!next) usage('--output requires a value');
      outputPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--events') {
      if (!next) usage('--events requires a value');
      eventsPath = resolve(next);
      i += 1;
      continue;
    }
    usage(`Unknown argument: ${arg}`);
  }

  if (!inputPath) usage('Missing required --input');
  if (!outputPath) usage('Missing required --output');
  if (!existsSync(inputPath)) usage(`Input path does not exist: ${inputPath}`);

  return { inputPath, outputPath, eventsPath };
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

function writeOutput(outputPath: string, output: TrialOutput): void {
  const body = JSON.stringify(output, null, 2) + '\n';
  writeFileSync(outputPath, body, 'utf8');
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

function main(): void {
  const startMs = Date.now();
  let parsedInput: TrialInput | null = null;
  let parsedArgs: CliOptions | null = null;

  try {
    parsedArgs = parseArgs(process.argv.slice(2));
    const raw = readFileSync(parsedArgs.inputPath, 'utf8');
    parsedInput = JSON.parse(raw) as TrialInput;

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
    writeOutput(parsedArgs.outputPath, output);
  } catch (error) {
    const ids = fallbackIds(parsedInput?.ids);
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    const output: TrialOutput = {
      schema_version: 'trial_output_v1',
      ids,
      outcome: 'error',
      metrics: { success: 0, latency_ms: Date.now(), total_tokens: 0 },
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
      writeOutput(parsedArgs.outputPath, output);
    } else {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
    process.stderr.write(`[run_cli] ${message}\n`);
    process.exit(1);
  }
}

main();
