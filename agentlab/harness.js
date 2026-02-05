#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function sha256Bytes(buf) { return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex'); }
function nowIso() { return new Date().toISOString(); }

function emitManifestIfNeeded(integration, entryCommand) {
  if (integration === 'cli_basic') return;
  const manifest = {
    schema_version: 'harness_manifest_v1',
    created_at: nowIso(),
    integration_level: integration,
    harness: { name: 'agentlab_ts_wrapper', version: '0.1.0', entry_command: entryCommand },
    step: { semantics: 'none' },
    control_plane: { mode: 'file', path: '/state/lab_control.json' },
  };
  if (integration === 'cli_events') {
    manifest.hooks = { schema_version: 'hook_events_v1', events_path: '/out/harness_events.jsonl', header_event_emitted: false };
  }
  writeJson('harness_manifest.json', manifest);
}

function maybeEmitMinimalHooks(ti) {
  const integration = (ti.design && ti.design.integration_level) || 'cli_basic';
  if (integration !== 'cli_events') return;
  const ids = ti.ids;
  const baseEvent = (event_type, seq, step_index) => ({
    hooks_schema_version: 'hook_events_v1',
    event_type,
    ts: nowIso(),
    seq,
    ids: {
      run_id: ids.run_id,
      trial_id: ids.trial_id,
      variant_id: ids.variant_id,
      task_id: ids.task_id,
      repl_idx: ids.repl_idx,
    },
    step_index,
  });

  const eventsPath = 'harness_events.jsonl';
  fs.appendFileSync(eventsPath, JSON.stringify(baseEvent('agent_step_start', 1, 0)) + '\n');
  fs.appendFileSync(eventsPath, JSON.stringify({
    ...baseEvent('model_call_end', 2, 0),
    call_id: 'call_1',
    outcome: { status: 'ok' },
    usage: { tokens_in: 0, tokens_out: 0 },
    timing: { duration_ms: 1 },
  }) + '\n');
  fs.appendFileSync(eventsPath, JSON.stringify(baseEvent('agent_step_end', 3, 0)) + '\n');

  const cpPath = ti.runtime && ti.runtime.control_plane && ti.runtime.control_plane.path;
  let cpBytes = Buffer.from('{"action":"continue"}');
  if (cpPath && fs.existsSync(cpPath)) cpBytes = fs.readFileSync(cpPath);

  fs.appendFileSync(eventsPath, JSON.stringify({
    ...baseEvent('control_ack', 4, 0),
    control_version: sha256Bytes(cpBytes),
    action_observed: 'continue',
    action_taken: 'continue',
  }) + '\n');
}

function runInline(ti) {
  const prompt = ti.task && ti.task.input && ti.task.input.prompt;
  return {
    schema_version: 'trial_output_v1',
    ids: ti.ids,
    outcome: prompt ? 'success' : 'failure',
    metrics: { latency_ms: 1 },
  };
}

function runSpawn(cfg, ti) {
  const start = Date.now();
  const proc = spawnSync(cfg.command[0], cfg.command.slice(1), {
    input: Buffer.from(JSON.stringify({ task: ti.task, bindings: ti.bindings, ids: ti.ids })),
    encoding: 'utf-8',
    env: { ...process.env, ...(cfg.env || {}) },
    cwd: path.resolve(__dirname, '..'),
    maxBuffer: 10 * 1024 * 1024,
  });
  const latencyMs = Math.max(0, Date.now() - start);
  if (proc.error) {
    return { schema_version: 'trial_output_v1', ids: ti.ids, outcome: 'error', metrics: { latency_ms: latencyMs }, error: { error_type: 'spawn_error', message: String(proc.error) } };
  }
  const stdout = (proc.stdout || '').toString().trim();
  if (stdout.startsWith('{')) {
    try {
      const parsed = JSON.parse(stdout);
      return { schema_version: 'trial_output_v1', ids: ti.ids, outcome: parsed.outcome || (proc.status === 0 ? 'success' : 'failure'), metrics: { latency_ms: latencyMs, ...(parsed.metrics || {}) }, answer: parsed.answer };
    } catch {}
  }
  return { schema_version: 'trial_output_v1', ids: ti.ids, outcome: proc.status === 0 ? 'success' : 'failure', metrics: { latency_ms: latencyMs }, answer: stdout || undefined };
}

function loadConfig() {
  const cfgPath = path.join(__dirname, 'agentlab.config.json');
  if (!fs.existsSync(cfgPath)) return { mode: 'inline' };
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function main() {
  const inputPath = process.env.AGENTLAB_TRIAL_INPUT || 'trial_input.json';
  const outputPath = process.env.AGENTLAB_TRIAL_OUTPUT || 'trial_output.json';
  const ti = readJson(inputPath);
  const integration = (ti.design && ti.design.integration_level) || 'cli_basic';

  emitManifestIfNeeded(integration, ['node', './agentlab/harness.js', 'run']);
  maybeEmitMinimalHooks(ti);

  let out;
  try {
    const cfg = loadConfig();
    out = cfg.mode === 'spawn' ? runSpawn(cfg, ti) : runInline(ti);
  } catch (e) {
    out = { schema_version: 'trial_output_v1', ids: ti.ids, outcome: 'error', error: { error_type: 'exception', message: String(e && e.message ? e.message : e), stack: String(e && e.stack ? e.stack : '') } };
  }
  writeJson(outputPath, out);
  process.exit(out.outcome === 'error' ? 1 : 0);
}

main();

