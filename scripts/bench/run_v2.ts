import { BridgeClient } from '../../packages/tui/bridge_client.ts';
import { GraphStore } from '../../packages/graphd/src/store.ts';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

type ModelOverride = {
  provider: string;
  model?: string;
  reasoning?: string;
};

type RunConfig = {
  id?: string;
  model?: ModelOverride;
  prompt_variant_id?: string;
  context_strategy_id?: string;
  sys_prompt_id?: string;
  context_window_id?: string;
  temperature?: number;
  working_dir?: string;
  branch_name?: string;
  metadata?: Record<string, unknown>;
};

type RunsFile = {
  experiment_id?: string;
  question_set_id?: string;
  runs: RunConfig[];
};

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
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

function resolveDbPath(rawPath: string, rootDir: string) {
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve(rootDir, rawPath);
}

function getGitInfo() {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    return { sha, branch, dirty: status.length > 0 };
  } catch {
    return {};
  }
}

function parseQuestionsFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === 'string');
    }
    if (parsed && Array.isArray(parsed.questions)) {
      return parsed.questions.filter((item: unknown) => typeof item === 'string');
    }
  } catch {
    // fall through to line parsing
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function runGitCommand(command: string, cwd: string) {
  return execSync(command, { encoding: 'utf-8', cwd }).trim();
}

function sanitizeBranchSegment(segment: string) {
  const trimmed = segment.trim();
  if (!trimmed) return 'default';
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'default';
}

function buildBranchName(runIndex: number, run: RunConfig, defaultModelLabel: string) {
  const sysPrompt = sanitizeBranchSegment(run.sys_prompt_id ?? 'default');
  const contextWindow = sanitizeBranchSegment(run.context_window_id ?? 'default');
  const modelLabel = sanitizeBranchSegment(defaultModelLabel);
  return `bench${runIndex}_${sysPrompt}_${contextWindow}_${modelLabel}`;
}

function ensureBranchForRun(
  cwd: string,
  branchName: string,
  baseRef: string,
  forceBranch: boolean
) {
  try {
    runGitCommand('git rev-parse --is-inside-work-tree', cwd);
  } catch {
    throw new Error(`Not a git repo: ${cwd}`);
  }

  let branchExists = false;
  try {
    runGitCommand(`git show-ref --verify refs/heads/${branchName}`, cwd);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists && !forceBranch) {
    throw new Error(`Branch already exists: ${branchName}`);
  }

  runGitCommand(`git checkout -B ${branchName} ${baseRef}`, cwd);
}

async function waitForReady(client: BridgeClient, sessionKey: string, timeoutMs = 10000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('event', handler);
      reject(new Error('Timed out waiting for ready event'));
    }, timeoutMs);

    const handler = (event: { type: string; data?: Record<string, unknown> }) => {
      if (event.type !== 'ready') return;
      const data = event.data ?? {};
      if (data.session_key === sessionKey) {
        clearTimeout(timer);
        client.off('event', handler);
        resolve();
      }
    };

    client.on('event', handler);
  });
}

async function waitForCompletion(client: BridgeClient, requestId: string, timeoutMs = 300000) {
  return new Promise<{ success: boolean; durationMs: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('event', handler);
      reject(new Error('Timed out waiting for run completion'));
    }, timeoutMs);

    const handler = (event: { type: string; data?: Record<string, unknown> }) => {
      if (event.type === 'response') {
        const data = event.data ?? {};
        if (data.request_id === requestId) {
          clearTimeout(timer);
          client.off('event', handler);
          resolve({ success: Boolean(data.success), durationMs: Number(data.duration_ms ?? 0) });
        }
      }

      if (event.type === 'error') {
        clearTimeout(timer);
        client.off('event', handler);
        resolve({ success: false, durationMs: 0 });
      }

      if (event.type === 'user_prompt') {
        clearTimeout(timer);
        client.off('event', handler);
        resolve({ success: false, durationMs: 0 });
      }
    };

    client.on('event', handler);
  });
}

async function sendAuthCommand<T extends Record<string, unknown>>(
  client: BridgeClient,
  kind: string,
  data: Record<string, unknown>
): Promise<T> {
  return new Promise((resolve) => {
    const handler = (event: { type: string; data?: Record<string, unknown> }) => {
      if (event.type === 'response') {
        const responseData = event.data ?? {};
        const metadata = responseData.metadata as { kind?: string; payload?: unknown } | undefined;
        if (metadata?.kind === kind) {
          client.off('event', handler);
          resolve((metadata.payload ?? { success: false }) as T);
        }
      }
    };

    client.on('event', handler);

    setTimeout(() => {
      client.off('event', handler);
      resolve({ success: false, error: 'Request timeout' } as T);
    }, 30000);

    client.send({ type: kind, data });
  });
}

function aggregateMetrics(events: Array<{ type: string; data?: Record<string, unknown> }>) {
  const llmEvents = events.filter((event) => event.type === 'llm_call');
  const toolNames = new Set<string>();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let totalToolCalls = 0;

  for (const event of llmEvents) {
    const data = event.data ?? {};
    promptTokens += Number(data.prompt_tokens ?? 0);
    completionTokens += Number(data.completion_tokens ?? 0);
    totalTokens += Number(data.total_tokens ?? 0);
    totalToolCalls += Number(data.tool_calls_count ?? 0);

    const tools = Array.isArray(data.tool_names) ? data.tool_names : [];
    for (const tool of tools) {
      if (typeof tool === 'string') toolNames.add(tool);
    }
  }

  return {
    total_llm_calls: llmEvents.length,
    total_tool_calls: totalToolCalls,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    tool_names: Array.from(toolNames),
  };
}

async function loadSessionEvents(dbPath: string, sessionKey: string, requestIds: string[]) {
  const store = new GraphStore(dbPath);
  try {
    const session = store.getSession(sessionKey);
    if (!session || !session.metadata) return { session: null, events: [] as Array<{ type: string; data?: Record<string, unknown> }> };
    const events = Array.isArray(session.metadata.agent_events)
      ? session.metadata.agent_events
      : [];
    const requestIdSet = new Set(requestIds);
    const requestEvents = events.filter((event) => requestIdSet.has(event.request_id));
    return { session, events: requestEvents };
  } finally {
    store.close();
  }
}

async function pollForEvents(dbPath: string, sessionKey: string, requestIds: string[]) {
  const maxAttempts = 20;
  const delayMs = 500;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { session, events } = await loadSessionEvents(dbPath, sessionKey, requestIds);
    const hasAllRequests = requestIds.every((requestId) =>
      events.some((event) => event.request_id === requestId)
    );
    if (session && events.length > 0 && hasAllRequests) {
      return { session, events };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { session: null, events: [] };
}

function ensureUniqueWorkingDirs(runs: RunConfig[], fallbackWorkingDir: string) {
  const dirs = runs.map((run) => run.working_dir ?? fallbackWorkingDir);
  const unique = new Set(dirs);
  if (unique.size !== dirs.length) {
    throw new Error('Parallel runs require unique working_dir per run.');
  }
}

async function runSession(params: {
  run: RunConfig;
  runId: string;
  runIndex: number;
  sessionKey: string;
  questions: string[];
  questionSetId: string;
  baseWorkingDir: string;
  host: string;
  port: number;
  dbPath: string;
  experimentId?: string;
  baseRef: string;
  forceBranch: boolean;
  defaultModelLabel: string;
}) {
  const {
    run,
    runId,
    runIndex,
    sessionKey,
    questions,
    questionSetId,
    baseWorkingDir,
    host,
    port,
    dbPath,
    experimentId,
    baseRef,
    forceBranch,
    defaultModelLabel,
  } = params;
  const workingDir = run.working_dir ?? baseWorkingDir;
  const branchName = run.branch_name ?? buildBranchName(runIndex, run, defaultModelLabel);
  ensureBranchForRun(workingDir, branchName, baseRef, forceBranch);
  const client = new BridgeClient({ host, port });
  await client.connect();

  client.send({
    type: 'init',
    data: {
      session_key: sessionKey,
      working_dir: workingDir,
    },
  });

  await waitForReady(client, sessionKey);

  let modelOverride: ModelOverride | null = null;
  let modelOverrideError: string | undefined;
  if (run.model?.provider) {
    const result = await sendAuthCommand<{
      success: boolean;
      model_override?: ModelOverride | null;
      error?: string;
    }>(client, 'set_model', {
      provider: run.model.provider,
      model: run.model.model,
      reasoning: run.model.reasoning,
    });
    if (!result.success) {
      modelOverrideError = result.error ?? 'Failed to set model';
    } else {
      modelOverride = result.model_override ?? null;
    }
  }

  const requestIds: string[] = [];
  let durationMs = 0;
  let success = modelOverrideError ? false : true;

  if (!modelOverrideError) {
    for (let i = 0; i < questions.length; i += 1) {
      const requestId = `req_${runId}_${i}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      requestIds.push(requestId);
      client.send({
        type: 'send_text',
        data: {
          text: questions[i],
          client_request_id: requestId,
          working_dir: workingDir,
        },
      });
      const completion = await waitForCompletion(client, requestId);
      durationMs += completion.durationMs;
      if (!completion.success) success = false;
    }
  }

  client.close();

  const { session, events } =
    requestIds.length > 0
      ? await pollForEvents(dbPath, sessionKey, requestIds)
      : { session: null, events: [] };
  const metrics = aggregateMetrics(events);
  const gitInfo = getGitInfo();
  const sessionMetadata = session?.metadata ?? {};
  const modelOverrideMeta = sessionMetadata.model_override as ModelOverride | null | undefined;

  return {
    experiment_id: experimentId,
    run_id: runId,
    session_key: sessionKey,
    request_ids: requestIds,
    provider:
      typeof modelOverrideMeta?.provider === 'string'
        ? modelOverrideMeta.provider
        : typeof sessionMetadata.provider === 'string'
          ? sessionMetadata.provider
          : undefined,
    model:
      typeof modelOverrideMeta?.model === 'string'
        ? modelOverrideMeta.model
        : typeof sessionMetadata.model === 'string'
          ? sessionMetadata.model
          : undefined,
    prompt_variant_id: run.prompt_variant_id,
    context_strategy_id: run.context_strategy_id,
    sys_prompt_id: run.sys_prompt_id,
    context_window_id: run.context_window_id,
    temperature: run.temperature,
    question_set_id: questionSetId,
    questions_count: questions.length,
    working_dir: workingDir,
    branch_name: branchName,
    total_llm_calls: metrics.total_llm_calls,
    total_tool_calls: metrics.total_tool_calls,
    prompt_tokens: metrics.prompt_tokens,
    completion_tokens: metrics.completion_tokens,
    total_tokens: metrics.total_tokens,
    duration_ms: durationMs,
    tool_names: metrics.tool_names,
    success,
    error: modelOverrideError,
    git_sha: gitInfo.sha,
    git_branch: gitInfo.branch,
    git_dirty: gitInfo.dirty,
    metadata: run.metadata,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = args.out ?? 'bench/results.jsonl';
  const baseWorkingDir = args.working_dir ?? process.cwd();
  const seedPrompt = args.seed_prompt;
  const questionSetId = args.question_set_id ?? 'v2_default';
  const parallel = args.parallel === 'true';
  const baseRef = args.base_ref ?? 'HEAD';
  const forceBranch = args.force_branch === 'true';

  const defaultModelProvider = args.model_provider;
  const defaultModelName = args.model;
  const defaultModelReasoning = args.model_reasoning;
  const defaultModelLabel = defaultModelName ?? defaultModelProvider ?? 'default';

  const runsPath = args.runs;
  const questionsPath = args.questions;
  const defaultPrompt = args.prompt ?? 'Benchmark v2: hello';

  const runsConfig: RunsFile = runsPath
    ? JSON.parse(fs.readFileSync(runsPath, 'utf-8'))
    : { runs: [{ id: 'run_default' }] };

  const runs = Array.isArray(runsConfig.runs) ? runsConfig.runs : [];
  if (runs.length === 0) {
    throw new Error('No runs provided. Provide a runs file with at least one run.');
  }

  for (const run of runs) {
    if (!run.model && defaultModelProvider) {
      run.model = {
        provider: defaultModelProvider,
        model: defaultModelName,
        reasoning: defaultModelReasoning,
      };
    }
  }

  const questions = questionsPath ? parseQuestionsFile(questionsPath) : [defaultPrompt];
  if (questions.length === 0) {
    throw new Error('No questions provided for benchmark run.');
  }

  if (parallel) {
    ensureUniqueWorkingDirs(runs, baseWorkingDir);
  }

  const host = process.env.EVENT_BUS_HOST ?? '127.0.0.1';
  const port = Number(process.env.EVENT_BUS_PORT ?? '9555');

  const configPath = path.resolve(process.cwd(), 'config/harness_config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (!config.graphd?.enabled || !config.graphd.db_path) {
    throw new Error('GraphD is not enabled in config; cannot validate run in DB');
  }

  const dbPath = resolveDbPath(config.graphd.db_path, process.cwd());

  const baseClient = new BridgeClient({ host, port });
  await baseClient.connect();

  const baseSessionKey = args.base_session_key ?? `bench_base_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  baseClient.send({
    type: 'init',
    data: {
      session_key: baseSessionKey,
      working_dir: baseWorkingDir,
    },
  });

  await waitForReady(baseClient, baseSessionKey);

  if (seedPrompt) {
    const seedRequestId = `seed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    baseClient.send({
      type: 'send_text',
      data: {
        text: seedPrompt,
        client_request_id: seedRequestId,
        working_dir: baseWorkingDir,
      },
    });
    await waitForCompletion(baseClient, seedRequestId);
  }

  const forks = [];
  for (const run of runs) {
    const fork = await baseClient.sessionFork();
    if (!fork.success || !fork.newSessionKey) {
      throw new Error(`Failed to fork session: ${fork.error ?? 'unknown error'}`);
    }
    forks.push({
      run,
      sessionKey: fork.newSessionKey,
    });
  }

  baseClient.close();

  const experimentId = runsConfig.experiment_id ?? args.experiment_id;
  const runTasks = forks.map(({ run, sessionKey }, index) => {
    const runId = run.id ?? `run_${index + 1}`;
    return () =>
      runSession({
        run,
        runId,
        runIndex: index + 1,
        sessionKey,
        questions,
        questionSetId: runsConfig.question_set_id ?? questionSetId,
        baseWorkingDir,
        host,
        port,
        dbPath,
        experimentId,
        baseRef,
        forceBranch,
        defaultModelLabel: run.model?.model ?? run.model?.provider ?? defaultModelLabel,
      });
  });

  const results = parallel ? await Promise.all(runTasks.map((task) => task())) : [];
  if (!parallel) {
    for (const task of runTasks) {
      results.push(await task());
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  for (const result of results) {
    fs.appendFileSync(outPath, `${JSON.stringify(result)}\n`);
    if (result.total_llm_calls === 0) {
      console.warn(`Warning: no llm_call events found in GraphD for run ${result.run_id}.`);
    }
  }

  console.log(`Wrote ${results.length} benchmark results to ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
