import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  HarnessClient,
  type BridgeEvent,
  type ErrorData,
  type ProgressData,
  type ResponseData,
  type StreamData,
  type UserPromptData,
} from 'harness-client';
import { HarnessDaemon } from '../harness/daemon.js';

type AgentResultIds = {
  run_id: string;
  trial_id: string;
  variant_id: string;
  task_id: string;
  repl_idx: number;
};

type AgentResult = {
  schema_version: 'agent_result_v1';
  ids: AgentResultIds;
  outcome: 'success' | 'failure' | 'missing' | 'error';
  answer?: string | Record<string, unknown> | unknown[];
  metrics?: Record<string, string | number | boolean | null>;
  error?: {
    error_type?: string;
    message?: string;
    stack?: string;
  };
};

type ModelSelection = {
  provider: string;
  model: string;
  reasoning?: string;
  agentType: string;
};

type TrialTaskPayload = {
  task?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
};

type RunResult = {
  success: boolean;
  content?: string;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9555;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function appendJsonl(path: string, value: Record<string, unknown>): void {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (parent) mkdirSync(parent, { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeAgentResult(path: string, output: AgentResult): void {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}

function resolveIdsFromEnv(): AgentResultIds {
  const repl = Number.parseInt(requiredEnv('AGENTLAB_REPL_IDX'), 10);
  return {
    run_id: requiredEnv('AGENTLAB_RUN_ID'),
    trial_id: requiredEnv('AGENTLAB_TRIAL_ID'),
    variant_id: requiredEnv('AGENTLAB_VARIANT_ID'),
    task_id: requiredEnv('AGENTLAB_TASK_ID'),
    repl_idx: Number.isFinite(repl) && repl >= 0 ? repl : 0,
  };
}

function loadTaskPayload(taskPath: string, bindingsPath: string): TrialTaskPayload {
  const taskRaw = JSON.parse(readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
  const bindingsRaw = JSON.parse(readFileSync(bindingsPath, 'utf8')) as Record<string, unknown>;
  return {
    task: taskRaw,
    bindings: bindingsRaw,
  };
}

function extractPrompt(task?: Record<string, unknown>): string | null {
  if (!task) return null;
  const input = task.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const prompt = asNonEmptyString((input as Record<string, unknown>).prompt);
    if (prompt) return prompt;
  }
  const direct = asNonEmptyString(task.prompt);
  return direct ?? null;
}

function extractModelSelection(bindings?: Record<string, unknown>): ModelSelection | null {
  if (!bindings) return null;
  const provider =
    asNonEmptyString(bindings.model_provider) ?? asNonEmptyString(bindings.provider);
  const model = asNonEmptyString(bindings.model);
  if (!provider || !model) return null;
  return {
    provider,
    model,
    reasoning: asNonEmptyString(bindings.reasoning),
    agentType: asNonEmptyString(bindings.agent_type) ?? 'standard',
  };
}

function waitForReady(
  client: HarnessClient,
  expectedSessionKey: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error('Timed out waiting for ready event after init'));
    }, timeoutMs);

    const onEvent = (event: BridgeEvent) => {
      if (event.type !== 'ready') return;
      const key = asNonEmptyString((event.data ?? {}).session_key);
      if (!key || key !== expectedSessionKey) return;
      cleanup();
      resolvePromise();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      client.off('event', onEvent);
    };

    client.on('event', onEvent);
  });
}

function waitForRunResponse(
  client: HarnessClient,
  requestId: string,
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for response for request_id=${requestId}`));
    }, timeoutMs);

    const onEvent = (event: BridgeEvent) => {
      if (event.type === 'response') {
        const data = (event.data ?? {}) as ResponseData;
        if (data.request_id !== requestId) return;
        cleanup();
        resolvePromise({
          success: data.success !== false,
          content: typeof data.content === 'string' ? data.content : undefined,
          error: typeof data.error === 'string' ? data.error : undefined,
        });
        return;
      }
      if (event.type === 'user_prompt') {
        const data = (event.data ?? {}) as UserPromptData;
        if (data.request_id !== requestId) return;
        cleanup();
        rejectPromise(new Error('Run paused for user input (user_prompt event)'));
        return;
      }
      if (event.type === 'provider_key_required') {
        const provider = asNonEmptyString((event.data ?? {}).provider) ?? 'unknown';
        cleanup();
        rejectPromise(new Error(`Provider key required for ${provider}`));
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      client.off('event', onEvent);
    };

    client.on('event', onEvent);
  });
}

export async function runHarnessAgentLoopCli(): Promise<void> {
  const ids = resolveIdsFromEnv();
  const taskPath = resolve(requiredEnv('AGENTLAB_TASK_PATH'));
  const bindingsPath = resolve(requiredEnv('AGENTLAB_BINDINGS_PATH'));
  const resultPath = resolve(requiredEnv('AGENTLAB_RESULT_PATH'));
  const timeoutMs = parsePositiveInt(process.env.AGENTLAB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const eventsPath = process.env.AGENTLAB_TRAJECTORY_PATH
    ? resolve(process.env.AGENTLAB_TRAJECTORY_PATH)
    : undefined;
  const workingDir = process.env.AGENTLAB_WORKSPACE_PATH
    ? resolve(process.env.AGENTLAB_WORKSPACE_PATH)
    : '/agentlab/workspace';
  const configPath = process.env.REX_CONFIG_PATH
    ? resolve(process.env.REX_CONFIG_PATH)
    : '/opt/rex/config/defaults.agentlab.experiment.no_entity_graph.json';
  const sessionKey = ids.trial_id;

  if (!existsSync(taskPath)) {
    throw new Error(`Task file not found: ${taskPath}`);
  }
  if (!existsSync(bindingsPath)) {
    throw new Error(`Bindings file not found: ${bindingsPath}`);
  }

  const payload = loadTaskPayload(taskPath, bindingsPath);
  const modelSelection = extractModelSelection(payload.bindings);
  const prompt = extractPrompt(payload.task);
  if (!prompt) {
    throw new Error('No prompt found in AGENTLAB task payload (expected task.input.prompt or task.prompt)');
  }

  const daemon = new HarnessDaemon({
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    workingDir,
    configPath,
    idleTimeoutMs: 0,
  });

  const startedAt = Date.now();
  let streamText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let modelCallCount = 0;
  let toolCallCount = 0;
  let seq = 0;
  const stepIndex = 0;

  const appendHookEvent = (event: Record<string, unknown>) => {
    if (!eventsPath) return;
    const payloadEvent = {
      hooks_schema_version: 'hook_events_v1',
      ts: new Date().toISOString(),
      seq: seq++,
      ids,
      step_index: stepIndex,
      ...event,
    };
    appendJsonl(eventsPath, payloadEvent);
  };

  let client: HarnessClient | null = null;
  try {
    const address = await daemon.start();
    client = new HarnessClient({
      host: address.host,
      port: address.port,
      maxReconnectAttempts: 0,
      requestTimeout: timeoutMs,
    });
    await client.connect();

    const onEvent = (event: BridgeEvent) => {
      if (event.type === 'stream') {
        const data = (event.data ?? {}) as StreamData;
        if (data.is_reasoning !== true && typeof data.chunk === 'string' && data.chunk.length > 0) {
          streamText += data.chunk;
        }
        return;
      }

      if (event.type === 'llm_call') {
        const promptTokens = Number((event.data ?? {}).promptTokens ?? 0);
        const completionTokens = Number((event.data ?? {}).completionTokens ?? 0);
        tokensIn += Number.isFinite(promptTokens) ? promptTokens : 0;
        tokensOut += Number.isFinite(completionTokens) ? completionTokens : 0;
        modelCallCount += 1;
        const provider = asNonEmptyString((event.data ?? {}).provider) ?? 'unknown';
        const model = asNonEmptyString((event.data ?? {}).model) ?? 'unknown';
        appendHookEvent({
          event_type: 'model_call_end',
          call_id: `model_${modelCallCount}`,
          turn_index: modelCallCount - 1,
          model: { identity: `${provider}/${model}` },
          usage: {
            tokens_in: Number.isFinite(promptTokens) ? promptTokens : 0,
            tokens_out: Number.isFinite(completionTokens) ? completionTokens : 0,
          },
          outcome: { status: 'ok' },
        });
        return;
      }

      if (event.type === 'progress') {
        const data = (event.data ?? {}) as ProgressData;
        const toolName = asNonEmptyString(data.tool_name);
        if (!toolName || typeof data.tool_success !== 'boolean') return;
        toolCallCount += 1;
        appendHookEvent({
          event_type: 'tool_call_end',
          call_id: `tool_${toolCallCount}`,
          tool: { name: toolName },
          outcome: { status: data.tool_success ? 'ok' : 'error' },
          timing:
            typeof data.duration_ms === 'number' && Number.isFinite(data.duration_ms)
              ? { duration_ms: data.duration_ms }
              : undefined,
        });
        return;
      }

      if (event.type === 'error') {
        const data = (event.data ?? {}) as ErrorData;
        appendHookEvent({
          event_type: 'error',
          error_type: 'bridge_error',
          message: typeof data.message === 'string' ? data.message : 'bridge error',
        });
      }
    };

    client.on('event', onEvent);
    appendHookEvent({ event_type: 'agent_step_start' });

    const initSent = client.send({
      type: 'init',
      data: { session_key: sessionKey, working_dir: workingDir },
    });
    if (!initSent) {
      throw new Error('Failed to send init command');
    }
    await waitForReady(client, sessionKey, timeoutMs);

    const dangerousResult = await client.setDangerousMode(true);
    if (!dangerousResult.success) {
      throw new Error(`set_dangerous_mode failed: ${dangerousResult.error ?? 'unknown error'}`);
    }

    if (modelSelection) {
      const setModel = await client.request<{ success?: boolean; error?: string }>('set_model', {
        agent_type: modelSelection.agentType,
        provider: modelSelection.provider,
        model: modelSelection.model,
        ...(modelSelection.reasoning ? { reasoning: modelSelection.reasoning } : {}),
      });
      if (!setModel.success) {
        throw new Error(`set_model failed: ${setModel.error ?? 'unknown error'}`);
      }
    }

    const requestId = `trial_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const responsePromise = waitForRunResponse(client, requestId, timeoutMs);
    const sent = client.send({
      type: 'send_text',
      data: {
        text: prompt,
        client_request_id: requestId,
        working_dir: workingDir,
      },
    });
    if (!sent) {
      throw new Error('Failed to send send_text command');
    }

    const run = await responsePromise;
    const latencyMs = Date.now() - startedAt;
    const answer = run.content ?? streamText.trim();
    const success = run.success;

    appendHookEvent({
      event_type: 'agent_step_end',
      budgets: {
        steps: 1,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        tool_calls: toolCallCount,
      },
    });

    const output: AgentResult = {
      schema_version: 'agent_result_v1',
      ids,
      outcome: success ? 'success' : 'failure',
      ...(answer ? { answer } : {}),
      metrics: {
        success: success ? 1 : 0,
        latency_ms: latencyMs,
        total_tokens: tokensIn + tokensOut,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        turn_count: modelCallCount,
        tool_call_count: toolCallCount,
      },
      ...(run.error
        ? {
            error: {
              error_type: 'agent_loop_run_error',
              message: run.error,
            },
          }
        : {}),
    };
    writeAgentResult(resultPath, output);
  } catch (error) {
    appendHookEvent({
      event_type: 'error',
      error_type: 'agent_loop_run_error',
      message: error instanceof Error ? error.message : String(error),
    });

    const output: AgentResult = {
      schema_version: 'agent_result_v1',
      ids,
      outcome: 'error',
      metrics: {
        success: 0,
        latency_ms: Date.now() - startedAt,
        total_tokens: tokensIn + tokensOut,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        turn_count: modelCallCount,
        tool_call_count: toolCallCount,
      },
      error: {
        error_type: 'agent_loop_run_error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
    writeAgentResult(resultPath, output);
    throw error;
  } finally {
    if (client) {
      client.close();
    }
    await daemon.stop();
  }
}
