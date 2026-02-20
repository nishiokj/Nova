#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REQUIRED_ENV = [
  'AGENTLAB_TASK_PATH',
  'AGENTLAB_BINDINGS_PATH',
  'AGENTLAB_RESULT_PATH',
  'AGENTLAB_TRIAL_ID',
  'AGENTLAB_TIMEOUT_MS',
  'AGENTLAB_RUN_ID',
  'AGENTLAB_VARIANT_ID',
  'AGENTLAB_TASK_ID',
  'AGENTLAB_REPL_IDX',
];

const OUTCOME_VALUES = new Set(['success', 'failure', 'missing', 'error']);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`missing required env: ${name}`);
  }
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function toNumber(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeOutcome(value, fallback) {
  if (typeof value === 'string' && OUTCOME_VALUES.has(value)) {
    return value;
  }
  return fallback;
}

function buildError(errorType, message, stack) {
  const out = { error_type: errorType, message };
  if (typeof stack === 'string' && stack.length > 0) {
    out.stack = stack;
  }
  return out;
}

function main() {
  for (const key of REQUIRED_ENV) {
    requiredEnv(key);
  }

  const taskPath = requiredEnv('AGENTLAB_TASK_PATH');
  const bindingsPath = requiredEnv('AGENTLAB_BINDINGS_PATH');
  const resultPath = requiredEnv('AGENTLAB_RESULT_PATH');
  const trialId = requiredEnv('AGENTLAB_TRIAL_ID');
  const timeoutMs = requiredEnv('AGENTLAB_TIMEOUT_MS');
  const runId = requiredEnv('AGENTLAB_RUN_ID');
  const variantId = requiredEnv('AGENTLAB_VARIANT_ID');
  const taskId = requiredEnv('AGENTLAB_TASK_ID');
  const replIdx = toNumber(requiredEnv('AGENTLAB_REPL_IDX'), 0);
  const trajectoryPath = process.env.AGENTLAB_TRAJECTORY_PATH;
  const workspacePath = process.env.AGENTLAB_WORKSPACE_PATH ?? '/agentlab/workspace';
  const configPath = process.env.REX_CONFIG_PATH ?? '/opt/rex/config/defaults.agentlab.experiment.no_entity_graph.json';

  const ids = {
    run_id: runId,
    trial_id: trialId,
    variant_id: variantId,
    task_id: taskId,
    repl_idx: replIdx < 0 ? 0 : replIdx,
  };

  const task = readJson(taskPath);
  const bindings = readJson(bindingsPath);

  const compatDir = resolve(dirname(resultPath), '.agentlab_compat');
  mkdirSync(compatDir, { recursive: true });
  const trialInputPath = join(compatDir, 'trial_input.json');
  const trialOutputPath = join(compatDir, 'trial_output.json');

  writeJson(trialInputPath, { ids, task, bindings });

  const runTrialArgs = [
    '/opt/rex/packages/infra/harness-daemon/bin/rex.js',
    'run-trial',
    '--input',
    trialInputPath,
    '--output',
    trialOutputPath,
    '--working-dir',
    workspacePath,
    '--config',
    configPath,
    '--timeout-ms',
    timeoutMs,
    '--session-key',
    trialId,
  ];
  if (trajectoryPath && trajectoryPath.trim().length > 0) {
    runTrialArgs.push('--events', trajectoryPath);
  }

  const child = spawnSync('bun', runTrialArgs, {
    stdio: 'inherit',
    env: process.env,
  });

  let compatOutput = null;
  if (existsSync(trialOutputPath)) {
    compatOutput = readJson(trialOutputPath);
  }

  if (!compatOutput && child.error) {
    writeJson(resultPath, {
      schema_version: 'agent_result_v1',
      ids,
      outcome: 'error',
      error: buildError('agent_loop_adapter_error', child.error.message, child.error.stack),
    });
    process.exit(child.status ?? 1);
  }

  if (!compatOutput) {
    writeJson(resultPath, {
      schema_version: 'agent_result_v1',
      ids,
      outcome: 'error',
      error: buildError(
        'missing_trial_output',
        `compat trial output not found at ${trialOutputPath}`
      ),
    });
    process.exit(child.status ?? 1);
  }

  const fallbackOutcome = child.status === 0 ? 'success' : 'error';
  const result = {
    schema_version: 'agent_result_v1',
    ids,
    outcome: normalizeOutcome(compatOutput.outcome, fallbackOutcome),
  };

  if (compatOutput.answer !== undefined) {
    result.answer = compatOutput.answer;
  }
  if (compatOutput.metrics && typeof compatOutput.metrics === 'object' && !Array.isArray(compatOutput.metrics)) {
    result.metrics = compatOutput.metrics;
  }
  if (compatOutput.error && typeof compatOutput.error === 'object' && !Array.isArray(compatOutput.error)) {
    result.error = compatOutput.error;
  }
  writeJson(resultPath, result);

  if (child.error) {
    process.exit(child.status ?? 1);
  }
  process.exit(child.status ?? 0);
}

try {
  main();
} catch (error) {
  const resultPath = process.env.AGENTLAB_RESULT_PATH;
  if (resultPath && resultPath.trim().length > 0) {
    const ids = {
      run_id: process.env.AGENTLAB_RUN_ID ?? 'unknown_run',
      trial_id: process.env.AGENTLAB_TRIAL_ID ?? 'unknown_trial',
      variant_id: process.env.AGENTLAB_VARIANT_ID ?? 'unknown_variant',
      task_id: process.env.AGENTLAB_TASK_ID ?? 'unknown_task',
      repl_idx: toNumber(process.env.AGENTLAB_REPL_IDX, 0),
    };
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    writeJson(resultPath, {
      schema_version: 'agent_result_v1',
      ids,
      outcome: 'error',
      error: buildError('agent_loop_adapter_error', message, stack),
    });
  }
  throw error;
}
