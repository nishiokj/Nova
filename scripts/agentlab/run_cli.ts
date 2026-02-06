#!/usr/bin/env bun
import { AgentHarness, loadConfig } from '../../packages/harness-daemon/src/harness/index.ts';
import { AgentLabEventAdapter } from './event_adapter.ts';
import { randomUUID } from 'crypto';
import { resolve } from 'path';

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function extractPrompt(input: any): string | null {
  const task = input?.task ?? {};
  const ti = task?.input ?? task?.inputs ?? {};
  const candidates = [
    ti?.prompt,
    ti?.text,
    ti?.question,
    task?.prompt,
    task?.text,
    task?.question,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function buildOutput({ ids, outcome, latencyMs, answer, error }: {
  ids: any;
  outcome: 'success' | 'failure';
  latencyMs: number;
  answer?: string;
  error?: { error_type: string; message: string };
}) {
  return {
    schema_version: 'trial_output_v1',
    ids,
    outcome,
    metrics: { latency_ms: latencyMs },
    ...(answer ? { answer } : {}),
    ...(error ? { error } : {}),
  };
}

async function main(): Promise<void> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  // Redirect stdout logging to stderr so we can emit clean JSON to stdout.
  process.stdout.write = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.warn = (...args: unknown[]) => console.error(...args);

  const raw = await readStdin();
  if (!raw) {
    const out = buildOutput({
      ids: {},
      outcome: 'failure',
      latencyMs: 0,
      error: { error_type: 'no_input', message: 'No input received on stdin' },
    });
    stdoutWrite(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }

  let input: any;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    const out = buildOutput({
      ids: {},
      outcome: 'failure',
      latencyMs: 0,
      error: { error_type: 'parse_error', message: 'Failed to parse JSON from stdin' },
    });
    stdoutWrite(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }

  const prompt = extractPrompt(input);
  const ids = input?.ids ?? {};
  const requestId = ids?.trial_id ? `req_${ids.trial_id}` : `req_${randomUUID()}`;
  const sessionKey = ids?.trial_id ? `agentlab_${ids.trial_id}` : `agentlab_${randomUUID()}`;
  const workingDir = process.cwd();

  if (!prompt) {
    const out = buildOutput({
      ids,
      outcome: 'failure',
      latencyMs: 0,
      error: { error_type: 'missing_prompt', message: 'No prompt found in trial input' },
    });
    stdoutWrite(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }

  const start = Date.now();
  let harness: AgentHarness | null = null;
  let adapter: AgentLabEventAdapter | null = null;

  try {
    const configPath = process.env.HARNESS_CONFIG_PATH;
    const config = loadConfig(configPath, workingDir);
    // Reduce overhead for one-shot CLI runs.
    config.entityGraph.enabled = false;
    config.memory.enabled = false;
    config.hooks.enabled = false;
    harness = new AgentHarness(config);
    await harness.start();

    // Derive trial paths from the input. In-container these are absolute;
    // in run-dev mode they're relative to CWD (the trial workspace).
    const runtimePaths = input?.runtime?.paths ?? {};
    const outDir = resolve(workingDir, runtimePaths.out ?? '/out');
    const stateDir = resolve(workingDir, runtimePaths.state ?? '/state');

    adapter = new AgentLabEventAdapter({
      ids: {
        run_id: ids.run_id ?? 'unknown',
        trial_id: ids.trial_id ?? 'unknown',
        variant_id: ids.variant_id ?? 'base',
        task_id: ids.task_id ?? 'unknown',
        repl_idx: ids.repl_idx ?? 0,
      },
      eventsPath: resolve(outDir, 'harness_events.jsonl'),
      manifestPath: resolve(workingDir, 'harness_manifest.json'),
      controlPath: resolve(stateDir, 'lab_control.json'),
    });

    // Subscribe to EventBus for this run. runId === requestId in the harness.
    const unsubscribe = harness.getEventBus().subscribeRun(requestId, adapter.handle);

    const handle = harness.run({
      requestId,
      inputText: prompt,
      sessionKey,
      workingDir,
    });

    const result = await handle.result;
    adapter.flush();
    unsubscribe();
    const latencyMs = Math.max(0, Date.now() - start);

    if (result.paused || result.userPrompt) {
      const out = buildOutput({
        ids,
        outcome: 'failure',
        latencyMs,
        error: { error_type: 'user_prompt', message: 'Harness requested user input' },
      });
      stdoutWrite(`${JSON.stringify(out)}\n`);
      process.exit(0);
    }

    const out = buildOutput({
      ids,
      outcome: result.success ? 'success' : 'failure',
      latencyMs,
      answer: result.finalText || undefined,
      error: result.success ? undefined : { error_type: 'run_failed', message: result.errorMessage ?? 'Run failed' },
    });
    stdoutWrite(`${JSON.stringify(out)}\n`);
    process.exit(0);
  } catch (err: any) {
    const latencyMs = Math.max(0, Date.now() - start);
    const message = err && err.message ? String(err.message) : String(err);
    adapter?.emitError('exception', message, err?.stack);
    const out = buildOutput({
      ids,
      outcome: 'failure',
      latencyMs,
      error: { error_type: 'exception', message },
    });
    stdoutWrite(`${JSON.stringify(out)}\n`);
    process.exit(0);
  } finally {
    if (harness) {
      try {
        await harness.shutdown();
      } catch {
        // ignore shutdown errors
      }
    }
  }
}

main();
