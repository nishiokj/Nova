import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { HarnessClient, type BridgeEvent, type ErrorData, type ProgressData, type ResponseData, type StreamData, type UserPromptData } from 'harness-client';
import { HarnessDaemon } from '../harness/daemon.js';

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

type ModelSelection = {
  provider: string;
  model: string;
  reasoning?: string;
  agentType: string;
};

type ProviderEnvBinding = {
  provider: string;
  envName: string;
};

type RunTrialCliOptions = {
  inputPath: string;
  outputPath: string;
  eventsPath?: string;
  workingDir: string;
  configPath?: string;
  host: string;
  port: number;
  sessionKey: string;
  timeoutMs: number;
  providerEnv: ProviderEnvBinding[];
};

type RunResult = {
  success: boolean;
  content?: string;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9555;

function failUsage(message: string): never {
  throw new Error(
    `${message}\n` +
      'Usage: rex-daemon run-trial --input <path> --output <path> [options]\n' +
      'Options:\n' +
      '  --events <path>\n' +
      '  --working-dir <path>\n' +
      '  --config <path>\n' +
      '  --host <host>\n' +
      '  --port <port>\n' +
      '  --session-key <key>\n' +
      '  --timeout-ms <ms>\n' +
      '  --provider-env <provider=ENV_NAME> (repeatable)'
  );
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    failUsage(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function parseProviderEnv(raw: string): ProviderEnvBinding {
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    failUsage(`Invalid --provider-env value "${raw}", expected provider=ENV_NAME`);
  }
  const provider = raw.slice(0, eq).trim();
  const envName = raw.slice(eq + 1).trim();
  if (!provider || !envName) {
    failUsage(`Invalid --provider-env value "${raw}", expected provider=ENV_NAME`);
  }
  return { provider, envName };
}

function parseRunTrialArgs(rawArgs: string[]): RunTrialCliOptions {
  const args = rawArgs[0] === 'run-trial' ? rawArgs.slice(1) : rawArgs;
  let inputPath = '';
  let outputPath = '';
  let eventsPath: string | undefined;
  let workingDir = '';
  let configPath: string | undefined;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let sessionKey = `trial_${Date.now().toString(36)}`;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const providerEnv: ProviderEnvBinding[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = i + 1 < args.length ? args[i + 1] : undefined;
    if (arg === '--input') {
      if (!next) failUsage('--input requires a value');
      inputPath = next;
      i += 1;
    } else if (arg === '--output') {
      if (!next) failUsage('--output requires a value');
      outputPath = next;
      i += 1;
    } else if (arg === '--events') {
      if (!next) failUsage('--events requires a value');
      eventsPath = next;
      i += 1;
    } else if (arg === '--working-dir') {
      if (!next) failUsage('--working-dir requires a value');
      workingDir = next;
      i += 1;
    } else if (arg === '--config') {
      if (!next) failUsage('--config requires a value');
      configPath = next;
      i += 1;
    } else if (arg === '--host') {
      if (!next) failUsage('--host requires a value');
      host = next;
      i += 1;
    } else if (arg === '--port') {
      if (!next) failUsage('--port requires a value');
      port = parsePositiveInt(next, '--port');
      i += 1;
    } else if (arg === '--session-key') {
      if (!next) failUsage('--session-key requires a value');
      sessionKey = next;
      i += 1;
    } else if (arg === '--timeout-ms') {
      if (!next) failUsage('--timeout-ms requires a value');
      timeoutMs = parsePositiveInt(next, '--timeout-ms');
      i += 1;
    } else if (arg === '--provider-env') {
      if (!next) failUsage('--provider-env requires a value');
      providerEnv.push(parseProviderEnv(next));
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      failUsage('Help requested');
    } else {
      failUsage(`Unknown argument: ${arg}`);
    }
  }

  if (!inputPath) failUsage('Missing required --input');
  if (!outputPath) failUsage('Missing required --output');

  const resolvedInputPath = resolve(inputPath);
  if (!existsSync(resolvedInputPath)) {
    throw new Error(`Input file not found: ${resolvedInputPath}`);
  }

  const parsed: RunTrialCliOptions = {
    inputPath: resolvedInputPath,
    outputPath: resolve(outputPath),
    eventsPath: eventsPath ? resolve(eventsPath) : undefined,
    workingDir: workingDir ? resolve(workingDir) : '/workspace',
    configPath: configPath ? resolve(configPath) : undefined,
    host,
    port,
    sessionKey,
    timeoutMs,
    providerEnv,
  };

  return parsed;
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

function readTrialInput(path: string): TrialInput {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as TrialInput;
}

function writeTrialOutput(path: string, output: TrialOutput): void {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function appendJsonl(path: string, value: Record<string, unknown>): void {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (parent) mkdirSync(parent, { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
      if (!key) return;
      if (key !== expectedSessionKey) return;
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
        return;
      }

      // Bridge errors (e.g., "No model selected") are terminal — don't wait for timeout
      if (event.type === 'error') {
        const message = asNonEmptyString((event.data ?? {}).message) ?? 'bridge error';
        cleanup();
        rejectPromise(new Error(`Bridge error: ${message}`));
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      client.off('event', onEvent);
    };

    client.on('event', onEvent);
  });
}

async function maybeSaveProviderKeys(
  client: HarnessClient,
  mappings: ProviderEnvBinding[]
): Promise<void> {
  for (const mapping of mappings) {
    const key = process.env[mapping.envName];
    if (!key) {
      throw new Error(
        `Missing env var ${mapping.envName} for --provider-env ${mapping.provider}=${mapping.envName}`
      );
    }
    const result = await client.providersSave(mapping.provider, key);
    if (!result.success) {
      throw new Error(
        `providers_save failed for ${mapping.provider}: ${result.error ?? 'unknown error'}`
      );
    }
  }
}

export async function runHarnessTrialCli(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseRunTrialArgs(rawArgs);
  const input = readTrialInput(options.inputPath);
  const ids = fallbackIds(input.ids);
  const modelSelection = extractModelSelection(input.bindings);
  const prompt = extractPrompt(input.task);

  if (!prompt) {
    throw new Error('No prompt found in trial input (expected task.input.prompt or task.prompt)');
  }

  const daemon = new HarnessDaemon({
    host: options.host,
    port: options.port,
    workingDir: options.workingDir,
    configPath: options.configPath,
    idleTimeoutMs: 0,
  });

  const startedAt = Date.now();
  let streamText = '';
  const toolResults: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let modelCallCount = 0;
  let toolCallCount = 0;
  let seq = 0;
  const stepIndex = 0;

  const appendHookEvent = (event: Record<string, unknown>) => {
    if (!options.eventsPath) return;
    const payload = {
      hooks_schema_version: 'hook_events_v1',
      ts: new Date().toISOString(),
      seq: seq++,
      ids,
      step_index: stepIndex,
      ...event,
    };
    appendJsonl(options.eventsPath, payload);
  };

  let client: HarnessClient | null = null;

  try {
    const address = await daemon.start();
    client = new HarnessClient({
      host: address.host,
      port: address.port,
      maxReconnectAttempts: 0,
      requestTimeout: options.timeoutMs,
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
        // Capture tool results for answer extraction (e.g., Skill tool outputs)
        const toolResult = asNonEmptyString(data.tool_result);
        if (toolResult) {
          toolResults.push(toolResult);
        }
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
      data: { session_key: options.sessionKey, working_dir: options.workingDir },
    });
    if (!initSent) {
      throw new Error('Failed to send init command');
    }
    await waitForReady(client, options.sessionKey, options.timeoutMs);

    const dangerousResult = await client.setDangerousMode(true);
    if (!dangerousResult.success) {
      throw new Error(
        `set_dangerous_mode failed: ${dangerousResult.error ?? 'unknown error'}`
      );
    }

    await maybeSaveProviderKeys(client, options.providerEnv);

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
    const responsePromise = waitForRunResponse(client, requestId, options.timeoutMs);
    const sent = client.send({
      type: 'send_text',
      data: {
        text: prompt,
        client_request_id: requestId,
        working_dir: options.workingDir,
      },
    });
    if (!sent) {
      throw new Error('Failed to send send_text command');
    }

    const run = await responsePromise;
    const latencyMs = Date.now() - startedAt;
    // Answer priority: streamed text > response content.
    // For multi-turn agents (e.g., Skill-based compilation), the response content
    // is often just a brief acknowledgment from the final turn. The streamed text
    // contains ALL assistant output across all turns — including the actual artifact
    // (e.g., VP JSON) produced in intermediate turns.
    const fullStreamedText = streamText.trim();
    const answer = fullStreamedText.length > (run.content?.length ?? 0)
      ? fullStreamedText
      : (run.content ?? fullStreamedText);
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

    const output: TrialOutput = {
      schema_version: 'trial_output_v1',
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
              error_type: 'harness_run_error',
              message: run.error,
            },
          }
        : {}),
      ext: {
        harness: 'harness-daemon',
        mode: 'run-trial',
      },
    };
    writeTrialOutput(options.outputPath, output);
  } catch (error) {
    appendHookEvent({
      event_type: 'error',
      error_type: 'run_trial_error',
      message: error instanceof Error ? error.message : String(error),
    });

    const output: TrialOutput = {
      schema_version: 'trial_output_v1',
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
        error_type: 'run_trial_error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      ext: {
        harness: 'harness-daemon',
        mode: 'run-trial',
      },
    };
    writeTrialOutput(options.outputPath, output);
    throw error;
  } finally {
    if (client) {
      client.close();
    }
    await daemon.stop();
  }
}
