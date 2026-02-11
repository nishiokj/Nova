#!/usr/bin/env bun

import { createConnection } from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';
import { BridgeClient } from '../../packages/apps/tui/bridge_client.ts';

type JsonRecord = Record<string, unknown>;
type IntegrationLevel = 'cli_basic' | 'cli_events';
type TrialIds = {
  run_id: string;
  trial_id: string;
  variant_id: string;
  task_id: string;
  repl_idx: number;
};

type TrialInput = {
  ids?: Partial<TrialIds>;
  task?: JsonRecord;
  bindings?: JsonRecord;
  runtime?: {
    paths?: {
      out?: string;
      workspace?: string;
    };
    control_plane?: {
      path?: string;
    };
  };
  design?: {
    integration_level?: string;
  };
};

type HookEvent = {
  hooks_schema_version: 'hook_events_v1';
  event_type: string;
  ts: string;
  seq: number;
  ids: TrialIds;
  step_index: number;
  [k: string]: unknown;
};

const DEFAULT_BUS_HOST = process.env.EVENT_BUS_HOST || '127.0.0.1';
const DEFAULT_BUS_PORT = Number(process.env.EVENT_BUS_PORT || '9555');
const UNKNOWN_CONTROL_VERSION = `sha256:${'0'.repeat(64)}`;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function appendJsonl(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveIntegrationLevel(raw: unknown): IntegrationLevel {
  if (raw === 'cli_basic' || raw === 'cli_events') {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    throw new Error(
      `Unsupported integration_level "${raw}" for run_cli.ts; supported: cli_basic, cli_events`,
    );
  }
  return 'cli_basic';
}

function shouldEmitHooks(integration: IntegrationLevel): boolean {
  return integration === 'cli_events';
}

function pickPrompt(task?: JsonRecord): string {
  if (!task) return '';
  const input = (task.input && typeof task.input === 'object') ? (task.input as JsonRecord) : undefined;
  const candidates = [
    input?.prompt,
    input?.problem_statement,
    task.problem_statement,
    task.prompt,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

function parseModelBindings(bindings?: JsonRecord): { provider?: string; model?: string; reasoning?: string } {
  if (!bindings) return {};
  const provider =
    (typeof bindings.model_provider === 'string' && bindings.model_provider) ||
    (typeof bindings.provider === 'string' && bindings.provider) ||
    undefined;
  const model =
    (typeof bindings.model === 'string' && bindings.model) ||
    undefined;
  let reasoning: string | undefined;
  const rawReasoning = bindings.reasoning ?? bindings.reasoning_effort;
  if (typeof rawReasoning === 'string' && rawReasoning.trim().length > 0) {
    reasoning = rawReasoning.trim();
  }
  return { provider, model, reasoning };
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(host, port)) return true;
    await wait(100);
  }
  return false;
}

function startHarnessDaemon(projectRoot: string, host: string, port: number): ChildProcess {
  const daemonEntry = path.join(projectRoot, 'packages', 'infra', 'harness-daemon', 'src', 'index.ts');
  const args = ['run', daemonEntry];
  const child = spawn('bun', args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      EVENT_BUS_HOST: host,
      EVENT_BUS_PORT: String(port),
      HARNESS_CONFIG_PATH: process.env.HARNESS_CONFIG_PATH || path.join(projectRoot, 'config', 'defaults.json'),
      // Disable auth in evaluation containers for deterministic startup.
      HARNESS_AUTH_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  return child;
}

async function waitForReady(client: BridgeClient, sessionKey: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('event', onEvent);
      reject(new Error('Timed out waiting for ready event'));
    }, timeoutMs);

    const onEvent = (event: { type: string; data?: Record<string, unknown> }) => {
      if (event.type !== 'ready') return;
      const key = typeof event.data?.session_key === 'string' ? event.data.session_key : '';
      if (key !== sessionKey) return;
      clearTimeout(timer);
      client.off('event', onEvent);
      resolve();
    };

    client.on('event', onEvent);
  });
}

async function runRequest(params: {
  client: BridgeClient;
  requestId: string;
  prompt: string;
  workingDir: string;
  modelBindings: { provider?: string; model?: string; reasoning?: string };
  hookEvents: HookEvent[];
  ids: HookEvent['ids'];
  integration: IntegrationLevel;
  timeoutMs: number;
}): Promise<{ success: boolean; content: string; error?: string; durationMs: number; llmCalls: number; tokensIn: number; tokensOut: number; toolCalls: number }> {
  const {
    client,
    requestId,
    prompt,
    workingDir,
    modelBindings,
    hookEvents,
    ids,
    integration,
    timeoutMs,
  } = params;
  const startedAt = Date.now();

  if (modelBindings.provider && modelBindings.model) {
    client.send({
      type: 'set_model',
      data: {
        provider: modelBindings.provider,
        model: modelBindings.model,
        reasoning: modelBindings.reasoning,
      },
    });
  }

  let seq = hookEvents.length + 1;
  const stepIndex = 0;
  if (shouldEmitHooks(integration)) {
    hookEvents.push({
      hooks_schema_version: 'hook_events_v1',
      event_type: 'agent_step_start',
      ts: nowIso(),
      seq: seq++,
      ids,
      step_index: stepIndex,
    });
  }

  let resolved = false;
  let llmCalls = 0;
  let toolCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for harness response'));
    }, timeoutMs);

    const finish = (payload: { success: boolean; content: string; error?: string }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanup();

      if (shouldEmitHooks(integration)) {
        hookEvents.push({
          hooks_schema_version: 'hook_events_v1',
          event_type: 'agent_step_end',
          ts: nowIso(),
          seq: seq++,
          ids,
          step_index: stepIndex,
          budgets: {
            steps: 1,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            tool_calls: toolCalls,
          },
        });

        hookEvents.push({
          hooks_schema_version: 'hook_events_v1',
          event_type: 'control_ack',
          ts: nowIso(),
          seq: seq++,
          ids,
          step_index: stepIndex,
          control_version: UNKNOWN_CONTROL_VERSION,
          action_observed: 'continue',
          action_taken: 'continue',
        });
      }

      resolve({
        success: payload.success,
        content: payload.content,
        error: payload.error,
        durationMs: Date.now() - startedAt,
        llmCalls,
        tokensIn,
        tokensOut,
        toolCalls,
      });
    };

    const onEvent = (event: { type: string; data?: Record<string, unknown> }) => {
      const data = event.data ?? {};
      const eventRequestId = typeof data.request_id === 'string' ? data.request_id : '';
      const hasRequestId = eventRequestId.length > 0;
      if (hasRequestId && eventRequestId !== requestId) return;

      if (event.type === 'llm_call') {
        if (!hasRequestId || eventRequestId !== requestId) return;
        llmCalls += 1;
        const promptTokens = Number(data.prompt_tokens ?? 0);
        const completionTokens = Number(data.completion_tokens ?? 0);
        const toolCallCount = Number(data.tool_calls_count ?? 0);
        tokensIn += Number.isFinite(promptTokens) ? promptTokens : 0;
        tokensOut += Number.isFinite(completionTokens) ? completionTokens : 0;
        toolCalls += Number.isFinite(toolCallCount) ? toolCallCount : 0;

        if (shouldEmitHooks(integration)) {
          const provider = typeof data.provider === 'string' ? data.provider : undefined;
          const model = typeof data.model === 'string' ? data.model : undefined;
          const modelIdentity = provider && model ? `${provider}/${model}` : model;
          hookEvents.push({
            hooks_schema_version: 'hook_events_v1',
            event_type: 'model_call_end',
            ts: nowIso(),
            seq: seq++,
            ids,
            step_index: stepIndex,
            call_id: `model_call_${llmCalls}`,
            turn_index: llmCalls - 1,
            outcome: { status: 'ok' },
            usage: {
              tokens_in: Number.isFinite(promptTokens) ? promptTokens : 0,
              tokens_out: Number.isFinite(completionTokens) ? completionTokens : 0,
            },
            model: modelIdentity ? { identity: modelIdentity } : undefined,
            ext: {
              provider,
              model,
              tool_calls_count: Number.isFinite(toolCallCount) ? toolCallCount : 0,
            },
          });
        }
        return;
      }

      if (event.type === 'response') {
        if (!hasRequestId || eventRequestId !== requestId) return;
        const success = Boolean(data.success);
        const content =
          (typeof data.content === 'string' && data.content) ||
          (typeof data.spoken_response === 'string' && data.spoken_response) ||
          '';
        const tools = Array.isArray(data.tools_used) ? data.tools_used.length : 0;
        if (tools > 0) toolCalls = Math.max(toolCalls, tools);
        finish({ success, content, error: success ? undefined : (typeof data.error === 'string' ? data.error : 'Harness returned unsuccessful response') });
        return;
      }

      if (event.type === 'provider_key_required') {
        if (hasRequestId && eventRequestId !== requestId) return;
        finish({
          success: false,
          content: '',
          error: 'Provider key required in harness runtime',
        });
        return;
      }

      if (event.type === 'user_prompt') {
        if (hasRequestId && eventRequestId !== requestId) return;
        finish({
          success: false,
          content: '',
          error: 'Harness requested user prompt during evaluation',
        });
        return;
      }

      if (event.type === 'error') {
        if (hasRequestId && eventRequestId !== requestId) return;
        finish({
          success: false,
          content: '',
          error: typeof data.message === 'string' ? data.message : 'Harness error event',
        });
      }
    };

    const onError = (payload: { message?: string }) => {
      finish({
        success: false,
        content: '',
        error: payload?.message || 'Bridge client error',
      });
    };

    const cleanup = () => {
      client.off('event', onEvent);
      client.off('error', onError);
    };

    client.on('event', onEvent);
    client.on('error', onError);

    client.send({
      type: 'send_text',
      data: {
        text: prompt,
        client_request_id: requestId,
        working_dir: workingDir,
      },
    });
  });
}

function writeHarnessManifest(runtimeOutDir: string, integration: IntegrationLevel, controlPlanePath: string): void {
  if (integration === 'cli_basic') return;
  const manifest: JsonRecord = {
    schema_version: 'harness_manifest_v1',
    created_at: nowIso(),
    integration_level: integration,
    harness: {
      name: 'rex',
      version: '0.1.0',
      entry_command: ['bun', './scripts/agentlab/run_cli.ts'],
    },
    step: { semantics: 'decision_cycle' },
    control_plane: { mode: 'file', path: controlPlanePath },
  };
  if (shouldEmitHooks(integration)) {
    manifest.hooks = {
      schema_version: 'hook_events_v1',
      events_path: '/out/harness_events.jsonl',
      header_event_emitted: false,
    };
  }
  writeJson(path.join(runtimeOutDir, 'harness_manifest.json'), manifest);
}

function ensureHookClosure(hookEvents: HookEvent[], ids: HookEvent['ids']): void {
  const hasStart = hookEvents.some((event) => event.event_type === 'agent_step_start');
  const hasEnd = hookEvents.some((event) => event.event_type === 'agent_step_end');
  if (!hasStart || hasEnd) return;

  let seq = hookEvents.length + 1;
  const tokensIn = hookEvents
    .filter((event) => event.event_type === 'model_call_end')
    .reduce((sum, event) => sum + Number((event.usage as Record<string, unknown> | undefined)?.tokens_in ?? 0), 0);
  const tokensOut = hookEvents
    .filter((event) => event.event_type === 'model_call_end')
    .reduce((sum, event) => sum + Number((event.usage as Record<string, unknown> | undefined)?.tokens_out ?? 0), 0);

  hookEvents.push({
    hooks_schema_version: 'hook_events_v1',
    event_type: 'agent_step_end',
    ts: nowIso(),
    seq: seq++,
    ids,
    step_index: 0,
    budgets: {
      steps: 1,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tool_calls: 0,
    },
  });

  hookEvents.push({
    hooks_schema_version: 'hook_events_v1',
    event_type: 'control_ack',
    ts: nowIso(),
    seq: seq++,
    ids,
    step_index: 0,
    control_version: UNKNOWN_CONTROL_VERSION,
    action_observed: 'continue',
    action_taken: 'continue',
  });
}

function getIds(ti: TrialInput): HookEvent['ids'] {
  return {
    run_id: String(ti.ids?.run_id || 'run_unknown'),
    trial_id: String(ti.ids?.trial_id || 'trial_unknown'),
    variant_id: String(ti.ids?.variant_id || 'variant_unknown'),
    task_id: String(ti.ids?.task_id || 'task_unknown'),
    repl_idx: Number(ti.ids?.repl_idx ?? 0),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = process.env.AGENTLAB_TRIAL_INPUT || args.input || 'trial_input.json';
  const outputPath = process.env.AGENTLAB_TRIAL_OUTPUT || args.output || 'trial_output.json';

  if (!existsSync(inputPath)) {
    throw new Error(`Missing trial input: ${inputPath}`);
  }

  const ti = readJson<TrialInput>(inputPath);
  const ids = getIds(ti);
  const prompt = pickPrompt(ti.task);
  const integration = resolveIntegrationLevel(ti.design?.integration_level);
  const runtimeOutDir = ti.runtime?.paths?.out || path.dirname(outputPath);
  const workspaceDir = ti.runtime?.paths?.workspace || process.cwd();
  const controlPlanePath = ti.runtime?.control_plane?.path || '/state/lab_control.json';
  const eventsPath = path.join(runtimeOutDir, 'harness_events.jsonl');

  ensureDir(path.dirname(outputPath));
  ensureDir(runtimeOutDir);
  writeHarnessManifest(runtimeOutDir, integration, controlPlanePath);

  const hookEvents: HookEvent[] = [];
  const requestTimeoutMs = Number(process.env.AGENTLAB_REQUEST_TIMEOUT_MS || '180000');
  let daemon: ChildProcess | null = null;
  let startedDaemon = false;
  let client: BridgeClient | null = null;

  const startMs = Date.now();
  let success = false;
  let content = '';
  let errorMessage: string | undefined;
  let durationMs = 0;
  let llmCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let toolCalls = 0;

  try {
    const busOpen = await isPortOpen(DEFAULT_BUS_HOST, DEFAULT_BUS_PORT);
    if (!busOpen) {
      daemon = startHarnessDaemon(process.cwd(), DEFAULT_BUS_HOST, DEFAULT_BUS_PORT);
      startedDaemon = true;
      const ready = await waitForPort(DEFAULT_BUS_HOST, DEFAULT_BUS_PORT, 15000);
      if (!ready) {
        throw new Error('Harness daemon did not start in time');
      }
    }

    client = new BridgeClient({ host: DEFAULT_BUS_HOST, port: DEFAULT_BUS_PORT });
    await client.connect();

    const sessionKey = `agentlab_${ids.trial_id}_${Date.now()}`;
    client.send({
      type: 'init',
      data: {
        session_key: sessionKey,
        working_dir: workspaceDir,
      },
    });
    await waitForReady(client, sessionKey);

    const requestId = `agentlab_req_${Date.now()}`;
    const modelBindings = parseModelBindings(ti.bindings);
    const result = await runRequest({
      client,
      requestId,
      prompt,
      workingDir: workspaceDir,
      modelBindings,
      hookEvents,
      ids,
      integration,
      timeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 180000,
    });

    success = result.success;
    content = result.content;
    errorMessage = result.error;
    durationMs = result.durationMs;
    llmCalls = result.llmCalls;
    tokensIn = result.tokensIn;
    tokensOut = result.tokensOut;
    toolCalls = result.toolCalls;
  } catch (err) {
    success = false;
    errorMessage = err instanceof Error ? err.message : String(err);
    durationMs = Date.now() - startMs;
  } finally {
    if (client) {
      try {
        client.close();
      } catch {}
    }
    if (daemon && startedDaemon) {
      try {
        daemon.kill('SIGTERM');
      } catch {}
    }
  }

  if (shouldEmitHooks(integration)) {
    ensureHookClosure(hookEvents, ids);
    writeFileSync(eventsPath, '');
    for (const event of hookEvents) {
      appendJsonl(eventsPath, event);
    }
  }

  const out = {
    schema_version: 'trial_output_v1',
    ids,
    outcome: success ? 'success' : 'failure',
    answer: {
      content,
      error: errorMessage || null,
    },
    metrics: {
      success: success ? 1 : 0,
      latency_ms: durationMs,
      llm_calls: llmCalls,
      tool_calls: toolCalls,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      total_tokens: tokensIn + tokensOut,
    },
    objective: {
      name: 'success',
      value: success ? 1 : 0,
      direction: 'maximize',
    },
    error: success ? undefined : {
      error_type: 'harness_error',
      message: errorMessage || 'Harness returned an unknown error',
    },
  };

  writeJson(outputPath, out);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
