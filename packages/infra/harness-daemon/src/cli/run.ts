import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
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

type ProviderEnvBinding = {
  provider: string;
  envName: string;
};

type ModelSelection = {
  provider: string;
  model: string;
  reasoning?: string;
  agentType: string;
};

type RunInputPayload = {
  ids?: Partial<AgentResultIds>;
  task?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
};

type RunResult = {
  success: boolean;
  content?: string;
  error?: string;
};

type RunCliOptions = {
  prompt?: string;
  inputFilePath?: string;
  bindingsFilePath?: string;
  outputPath?: string;
  eventsPath?: string;
  workingDir: string;
  configPath?: string;
  host: string;
  port: number;
  sessionKey: string;
  timeoutMs: number;
  dangerous: boolean;
  providerEnv: ProviderEnvBinding[];
  modelSelection?: ModelSelection;
};

type PreparedRunInput = {
  ids?: Partial<AgentResultIds>;
  task: Record<string, unknown>;
  bindings?: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;

function failUsage(message: string): never {
  throw new Error(
    `${message}\n` +
      'Usage: rex run (--input <prompt> | --input-file <path> | <input_path>) [<output_path>] [options]\n' +
      'Options:\n' +
      '  --output <path>\n' +
      '  --events <path>\n' +
      '  --working-dir <path>\n' +
      '  --config <path>\n' +
      '  --host <host>\n' +
      '  --port <port>\n' +
      '  --session-key <key>\n' +
      '  --timeout-ms <ms>\n' +
      '  --dangerous\n' +
      '  --provider <provider>\n' +
      '  --model <model>\n' +
      '  --agent-type <agent_type>\n' +
      '  --reasoning <reasoning>\n' +
      '  --bindings-file <path> (legacy)\n' +
      '  --provider-env <provider=ENV_NAME> (repeatable)\n\n' +
      'AgentLab container example:\n' +
      '  rex run \\\n' +
      '    --provider z.ai-coder \\\n' +
      '    --model glm-5 \\\n' +
      '    /in/task.json /out/result.json'
  );
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    failUsage(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function parsePortInt(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    failUsage(`${flag} must be a non-negative integer, got "${raw}"`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRunArgs(rawArgs: string[]): RunCliOptions {
  const args = rawArgs[0] === 'run' ? rawArgs.slice(1) : rawArgs;
  let prompt: string | undefined;
  let inputFilePath: string | undefined;
  let bindingsFilePath: string | undefined;
  let outputPath: string | undefined;
  let eventsPath: string | undefined;
  let workingDir = '/workspace';
  let configPath: string | undefined;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let sessionKey = `run_${Date.now().toString(36)}`;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let dangerous = false;
  let modelProvider: string | undefined;
  let model: string | undefined;
  let reasoning: string | undefined;
  let agentType = 'standard';
  const providerEnv: ProviderEnvBinding[] = [];
  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = i + 1 < args.length ? args[i + 1] : undefined;
    if (!arg.startsWith('-')) {
      positionalArgs.push(arg);
    } else if (arg === '--input') {
      if (!next) failUsage('--input requires a value');
      prompt = next;
      i += 1;
    } else if (arg === '--input-file') {
      if (!next) failUsage('--input-file requires a value');
      inputFilePath = next;
      i += 1;
    } else if (arg === '--bindings-file') {
      if (!next) failUsage('--bindings-file requires a value');
      bindingsFilePath = next;
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
      port = parsePortInt(next, '--port');
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
    } else if (arg === '--provider') {
      if (!next) failUsage('--provider requires a value');
      modelProvider = next;
      i += 1;
    } else if (arg === '--model') {
      if (!next) failUsage('--model requires a value');
      model = next;
      i += 1;
    } else if (arg === '--reasoning') {
      if (!next) failUsage('--reasoning requires a value');
      reasoning = next;
      i += 1;
    } else if (arg === '--agent-type') {
      if (!next) failUsage('--agent-type requires a value');
      const parsed = asNonEmptyString(next);
      if (!parsed) failUsage('--agent-type must be a non-empty value');
      agentType = parsed;
      i += 1;
    } else if (arg === '--dangerous') {
      dangerous = true;
    } else if (arg === '--help' || arg === '-h') {
      failUsage('Help requested');
    } else {
      failUsage(`Unknown argument: ${arg}`);
    }
  }

  if (positionalArgs.length > 2) {
    failUsage(`Too many positional arguments (expected at most 2, got ${positionalArgs.length})`);
  }

  if (prompt) {
    if (inputFilePath || positionalArgs.length > 0) {
      failUsage('Provide exactly one input source: --input, --input-file, or positional input path');
    }
  } else {
    if (inputFilePath) {
      if (positionalArgs.length > 1) {
        failUsage('When --input-file is provided, at most one positional output path is allowed');
      }
      if (positionalArgs.length === 1) {
        if (outputPath) failUsage('Output path provided both via --output and positional argument');
        outputPath = positionalArgs[0];
      }
    } else {
      if (positionalArgs.length === 0) {
        failUsage('Provide exactly one input source: --input, --input-file, or positional input path');
      }
      inputFilePath = positionalArgs[0];
      if (positionalArgs.length === 2) {
        if (outputPath) failUsage('Output path provided both via --output and positional argument');
        outputPath = positionalArgs[1];
      }
    }
  }

  if ((modelProvider && !model) || (!modelProvider && model)) {
    failUsage('Both --provider and --model are required together');
  }
  if ((reasoning || agentType !== 'standard') && (!modelProvider || !model)) {
    failUsage('--reasoning/--agent-type require --provider and --model');
  }

  const resolvedInputFilePath = inputFilePath ? resolve(inputFilePath) : undefined;
  if (resolvedInputFilePath && !existsSync(resolvedInputFilePath)) {
    throw new Error(`Input file not found: ${resolvedInputFilePath}`);
  }
  if (resolvedInputFilePath) {
    const stats = statSync(resolvedInputFilePath);
    if (!stats.isFile()) {
      throw new Error(`Input path is not a file: ${resolvedInputFilePath}`);
    }
  }
  const resolvedBindingsFilePath = bindingsFilePath ? resolve(bindingsFilePath) : undefined;
  if (resolvedBindingsFilePath && !existsSync(resolvedBindingsFilePath)) {
    throw new Error(`Bindings file not found: ${resolvedBindingsFilePath}`);
  }
  if (resolvedBindingsFilePath) {
    const stats = statSync(resolvedBindingsFilePath);
    if (!stats.isFile()) {
      throw new Error(`Bindings path is not a file: ${resolvedBindingsFilePath}`);
    }
  }

  return {
    prompt,
    inputFilePath: resolvedInputFilePath,
    bindingsFilePath: resolvedBindingsFilePath,
    outputPath: outputPath ? resolve(outputPath) : undefined,
    eventsPath: eventsPath ? resolve(eventsPath) : undefined,
    workingDir: resolve(workingDir),
    configPath: configPath ? resolve(configPath) : undefined,
    host,
    port,
    sessionKey,
    timeoutMs,
    dangerous,
    providerEnv,
    modelSelection:
      modelProvider && model
        ? {
            provider: modelProvider,
            model,
            agentType,
            ...(reasoning ? { reasoning } : {}),
          }
        : undefined,
  };
}

function extractPrompt(task?: Record<string, unknown>): string | null {
  if (!task) return null;
  const input = task.input;
  if (input && isRecord(input)) {
    const prompt = asNonEmptyString(input.prompt);
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

function parseJsonFile(path: string, label: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${label} (${path}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must contain a JSON object: ${path}`);
  }
  return value;
}

function parseInputFile(path: string): { task: Record<string, unknown>; payload?: RunInputPayload } {
  const raw = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('Input JSON must be an object');
    }
    if (isRecord(parsed.task) || isRecord(parsed.bindings) || isRecord(parsed.ids)) {
      const payload = parsed as RunInputPayload;
      if (!payload.task || !isRecord(payload.task)) {
        throw new Error('Input payload has no task object');
      }
      return { task: payload.task, payload };
    }
    const prompt = extractPrompt(parsed);
    if (!prompt) {
      throw new Error(
        'No prompt found in JSON input file (expected task.input.prompt or task.prompt)'
      );
    }
    return { task: parsed };
  } catch (jsonErr) {
    if (
      jsonErr instanceof Error &&
      jsonErr.message.startsWith('No prompt found in JSON input file')
    ) {
      throw jsonErr;
    }
    const prompt = raw.trim();
    if (!prompt) {
      throw new Error(`Input file has no prompt content: ${path}`);
    }
    return {
      task: {
        input: { prompt },
      },
    };
  }
}

function prepareRunInput(options: RunCliOptions): PreparedRunInput {
  const bindingsFromFile = options.bindingsFilePath
    ? parseJsonFile(options.bindingsFilePath, 'bindings file')
    : undefined;

  if (options.prompt) {
    return {
      task: {
        input: { prompt: options.prompt },
      },
      ...(bindingsFromFile ? { bindings: bindingsFromFile } : {}),
    };
  }

  if (!options.inputFilePath) {
    throw new Error('Missing input source');
  }

  const parsed = parseInputFile(options.inputFilePath);
  const payload = parsed.payload;

  return {
    ids: payload?.ids,
    task: parsed.task,
    bindings: bindingsFromFile ?? payload?.bindings,
  };
}

function resolveIds(inputIds: Partial<AgentResultIds> | undefined, sessionKey: string): AgentResultIds {
  const replFromInput = Number(inputIds?.repl_idx);

  return {
    run_id: inputIds?.run_id ?? 'unknown_run',
    trial_id: inputIds?.trial_id ?? sessionKey,
    variant_id: inputIds?.variant_id ?? 'unknown_variant',
    task_id: inputIds?.task_id ?? 'unknown_task',
    repl_idx: Number.isFinite(replFromInput) ? replFromInput : 0,
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
        return;
      }

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

function printAnswerFromResult(output: AgentResult): void {
  if (typeof output.answer === 'string') {
    process.stdout.write(output.answer.endsWith('\n') ? output.answer : `${output.answer}\n`);
    return;
  }
  if (output.answer !== undefined) {
    process.stdout.write(`${JSON.stringify(output.answer, null, 2)}\n`);
    return;
  }
  if (output.error?.message) {
    process.stderr.write(`${output.error.message}\n`);
  }
}

export async function runHarnessRunCli(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseRunArgs(rawArgs);
  const prepared = prepareRunInput(options);
  const prompt = extractPrompt(prepared.task);
  if (!prompt) {
    throw new Error('No prompt found in input task (expected task.input.prompt or task.prompt)');
  }

  const ids = resolveIds(prepared.ids, options.sessionKey);
  const modelSelection = options.modelSelection ?? extractModelSelection(prepared.bindings);

  const daemon = new HarnessDaemon({
    host: options.host,
    port: options.port,
    workingDir: options.workingDir,
    configPath: options.configPath,
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
  let client: HarnessClient | null = null;

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

    if (options.dangerous) {
      const dangerousResult = await client.setDangerousMode(true);
      if (!dangerousResult.success) {
        throw new Error(
          `set_dangerous_mode failed: ${dangerousResult.error ?? 'unknown error'}`
        );
      }
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

    const requestId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
              error_type: 'harness_run_error',
              message: run.error,
            },
          }
        : {}),
    };

    if (options.outputPath) {
      writeAgentResult(options.outputPath, output);
    } else {
      printAnswerFromResult(output);
    }
  } catch (error) {
    appendHookEvent({
      event_type: 'error',
      error_type: 'run_error',
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
        error_type: 'run_error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    };

    if (options.outputPath) {
      writeAgentResult(options.outputPath, output);
    } else {
      printAnswerFromResult(output);
    }
    throw error;
  } finally {
    if (client) {
      client.close();
    }
    await daemon.stop();
  }
}
