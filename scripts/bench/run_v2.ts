import { Orchestrator, DEFAULT_ORCHESTRATOR_CONFIG, OrchestratorResult } from 'orchestrator';
import { ContextWindow } from 'context';
import { Agent, AgentRegistry, buildAgentConfig, type OrchestratorLogger } from 'agent';
import { ToolRegistry, builtinToolOptions } from 'tools';
import { createAdapter } from 'llm';
import { isOpenAICompatProvider, createEvent } from 'types';
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
  agent_type?: string;  // 'standard', 'explorer', 'coding', etc.
};

type RunsFile = {
  experiment_id?: string;
  question_set_id?: string;
  runs: RunConfig[];
};

type BenchmarkResult = {
  experiment_id?: string;
  run_id: string;
  question_set_id: string;
  provider?: string;
  model?: string;
  agent_type: string;
  prompt_variant_id?: string;
  context_strategy_id?: string;
  sys_prompt_id?: string;
  context_window_id?: string;
  temperature?: number;
  questions_count: number;
  working_dir: string;
  branch_name: string;
  total_llm_calls: number;
  total_tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  tool_names: string[];
  success: boolean;
  error?: string;
  git_sha?: string;
  git_branch?: string;
  git_dirty?: boolean;
  metadata?: Record<string, unknown>;
};

export function parseArgs(argv: string[]) {
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

export function getGitInfo() {
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

export function sanitizeBranchSegment(segment: string) {
  const trimmed = segment.trim();
  if (!trimmed) return 'default';
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'default';
}

export function buildBranchName(runIndex: number, run: RunConfig, defaultModelLabel: string) {
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

// Simple logger for benchmarks (no output)
export class BenchmarkLogger implements OrchestratorLogger {
  info(msg: string, meta?: Record<string, unknown>): void {}
  debug(msg: string, meta?: Record<string, unknown>): void {}
  warning(msg: string, meta?: Record<string, unknown>): void {}
  error(msg: string, meta?: Record<string, unknown>): void {}
}

// Simple in-memory provider key service for benchmarks
export class BenchmarkProviderKeyService {
  private keys: Map<string, string> = new Map();

  constructor(keys: Record<string, string>) {
    for (const [provider, key] of Object.entries(keys)) {
      this.keys.set(provider, key);
    }
  }

  async getApiKey(provider: string): Promise<string | null> {
    return this.keys.get(provider) ?? null;
  }

  hasApiKey(provider: string): boolean {
    return this.keys.has(provider);
  }
}

function loadConfig(): Record<string, unknown> {
  // Try defaults.json in config directory
  const configPath = path.resolve(process.cwd(), 'config/defaults.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  throw new Error(`Missing config file: ${configPath}`);
}

/**
 * Collect metrics from all orchestrator executions for a benchmark run
 */
export function aggregateMetrics(allResults: OrchestratorResult[], allEvents: Array<{ type: string; data?: Record<string, unknown> }>): {
  total_llm_calls: number;
  total_tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  tool_names: Set<string>;
} {
  const toolNames = new Set<string>();
  let totalLlmCalls = 0;
  let totalToolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let durationMs = 0;

  // Collect tool names from events
  for (const event of allEvents) {
    if (event.type === 'tool_call') {
      const data = event.data ?? {};
      const toolName = typeof data.tool === 'string' ? data.tool : undefined;
      if (toolName) {
        toolNames.add(toolName);
      }
    }
  }

  for (const result of allResults) {
    totalLlmCalls += result.metrics.totalLlmCalls;
    totalToolCalls += result.metrics.totalToolCalls;
    // Token counts aren't currently in OrchestratorMetrics, but we'll keep the fields
    // for backward compatibility - they'll be 0 unless we hook into LLM events
    durationMs += result.metrics.durationMs;
  }

  return {
    total_llm_calls: totalLlmCalls,
    total_tool_calls: totalToolCalls,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    duration_ms: durationMs,
    tool_names: toolNames,
  };
}

function ensureUniqueWorkingDirs(runs: RunConfig[], fallbackWorkingDir: string) {
  const dirs = runs.map((run) => run.working_dir ?? fallbackWorkingDir);
  const unique = new Set(dirs);
  if (unique.size !== dirs.length) {
    throw new Error('Parallel runs require unique working_dir per run.');
  }
}

async function runSingleBenchmark(params: {
  run: RunConfig;
  runId: string;
  runIndex: number;
  questions: string[];
  questionSetId: string;
  baseWorkingDir: string;
  experimentId?: string;
  baseRef: string;
  forceBranch: boolean;
  defaultModelLabel: string;
  config: Record<string, unknown>;
  apiKeys: Record<string, string>;
}): Promise<BenchmarkResult> {
  const {
    run,
    runId,
    runIndex,
    questions,
    questionSetId,
    baseWorkingDir,
    experimentId,
    baseRef,
    forceBranch,
    defaultModelLabel,
    config,
    apiKeys,
  } = params;

  const workingDir = run.working_dir ?? baseWorkingDir;
  const branchName = run.branch_name ?? buildBranchName(runIndex, run, defaultModelLabel);
  const agentType = run.agent_type ?? 'standard';

  // Set up git branch
  ensureBranchForRun(workingDir, branchName, baseRef, forceBranch);

  // Load agent config from defaults.json
  const agents = config.agents as Record<string, unknown> ?? {};
  if (!agents[agentType]) {
    throw new Error(`Agent type '${agentType}' not found in config. Available: ${Object.keys(agents).join(', ')}`);
  }

  const agentConfig = agents[agentType] as Record<string, unknown>;

  // Set up orchestrator config
  const orchestratorConfig = {
    ...DEFAULT_ORCHESTRATOR_CONFIG,
    maxIterations: (agentConfig.budget as Record<string, unknown>)?.max_iterations ?? 50,
    maxToolCalls: (agentConfig.budget as Record<string, unknown>)?.max_tool_calls ?? 225,
    maxDurationMs: (agentConfig.budget as Record<string, unknown>)?.max_duration_ms ?? 1000000,
  };

  // Create a simple event emit callback that captures events for metrics
  const capturedEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const emit = (event: { type: string; data?: Record<string, unknown> }) => {
    capturedEvents.push(event);
  };

  const orchestrator = new Orchestrator(
    orchestratorConfig,
    toolRegistry,
    llmAdapter,
    emit,
    `bench_${runId}_${Date.now()}`,
    new BenchmarkLogger(),
    undefined, // agentRegistry - will register below
    undefined, // hooks
    undefined, // planModeOptions
    undefined, // eventBus
    undefined  // getModelSelection
  );

  // Set up provider key service
  const providerKeyService = new BenchmarkProviderKeyService(apiKeys);

  // Create tool registry with working dir
  const toolRegistry = new ToolRegistry({
    ...builtinToolOptions,
    workingDir,
    repoRoot: workingDir,
  });

  // Get model configuration
  const llmConfig = agentConfig.llm as Record<string, unknown>;
  const provider = run.model?.provider ?? (llmConfig.provider as string) ?? 'openai';
  const model = run.model?.model ?? (llmConfig.model as string);
  const reasoning = run.model?.reasoning ?? (llmConfig.reasoning as string);

  if (!model) {
    throw new Error(`No model specified. Either provide --model or have a default in config for agent '${agentType}'`);
  }

  // Map provider to canonical form for adapter
  const canonicalProvider = isOpenAICompatProvider(provider) ? 'openai-compat' : provider as any;

  // Create LLM adapter
  const llmAdapter = createAdapter({
    provider: canonicalProvider,
    model,
    temperature: run.temperature ?? (llmConfig.temperature as number) ?? 0.7,
    maxTokens: (llmConfig.max_tokens as number) ?? 128000,
    reasoning: typeof reasoning === 'string' ? reasoning : (typeof reasoning === 'object' ? (reasoning as any).effort : undefined),
    providerKeyService,
  });

  // Create agent
  const agent = new Agent({
    llm: llmAdapter,
    tools: toolRegistry,
    config: buildAgentConfig(agentType as any, agentConfig),
    workingDir,
  });

  // Register agent with agent type
  AgentRegistry.register(agentType, {
    create: () => agent,
    config: agentConfig,
  });

  // Run each question
  const allResults: OrchestratorResult[] = [];
  let success = true;
  let error: string | undefined;

  for (const question of questions) {
    // Create a fresh context for each question
    const context = new ContextWindow({
      maxTokens: (config.context as Record<string, unknown>)?.max_tokens as number ?? 200000,
    });

    try {
      const result = await orchestrator.execute(context, question, agentType, workingDir);
      allResults.push(result);

      if (!result.success) {
        success = false;
        error = result.error ?? 'Unknown error';
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
      allResults.push({
        success: false,
        response: '',
        error,
        paused: false,
        userPrompt: undefined,
        handoffSpec: undefined,
        terminationReason: 'error',
        metrics: {
          iterations: 0,
          totalLlmCalls: 0,
          totalToolCalls: 0,
          durationMs: 0,
        },
      });
    }
  }

  // Aggregate metrics
  const metrics = aggregateMetrics(allResults, capturedEvents);
  const gitInfo = getGitInfo();

  return {
    experiment_id: experimentId,
    run_id: runId,
    question_set_id: questionSetId,
    provider,
    model,
    agent_type: agentType,
    prompt_variant_id: run.prompt_variant_id,
    context_strategy_id: run.context_strategy_id,
    sys_prompt_id: run.sys_prompt_id,
    context_window_id: run.context_window_id,
    temperature: run.temperature,
    questions_count: questions.length,
    working_dir: workingDir,
    branch_name: branchName,
    total_llm_calls: metrics.total_llm_calls,
    total_tool_calls: metrics.total_tool_calls,
    prompt_tokens: metrics.prompt_tokens,
    completion_tokens: metrics.completion_tokens,
    total_tokens: metrics.total_tokens,
    duration_ms: metrics.duration_ms,
    tool_names: Array.from(metrics.tool_names),
    success,
    error,
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
  const questionSetId = args.question_set_id ?? 'v2_default';
  const parallel = args.parallel === 'true';
  const baseRef = args.base_ref ?? 'HEAD';
  const forceBranch = args.force_branch === 'true';

  const defaultModelProvider = args.model_provider;
  const defaultModelName = args.model;
  const defaultModelReasoning = args.model_reasoning;
  const defaultModelLabel = defaultModelName ?? defaultModelProvider ?? 'default';
  const defaultAgentType = args.agent_type ?? 'standard';

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

  // Apply default model and agent type to runs
  for (const run of runs) {
    if (!run.model && defaultModelProvider) {
      run.model = {
        provider: defaultModelProvider,
        model: defaultModelName,
        reasoning: defaultModelReasoning,
      };
    }
    if (!run.agent_type && defaultAgentType) {
      run.agent_type = defaultAgentType;
    }
  }

  const questions = questionsPath ? parseQuestionsFile(questionsPath) : [defaultPrompt];
  if (questions.length === 0) {
    throw new Error('No questions provided for benchmark run.');
  }

  if (parallel) {
    ensureUniqueWorkingDirs(runs, baseWorkingDir);
  }

  // Load config
  const config = loadConfig();

  // Get API keys from environment variables
  const apiKeys: Record<string, string> = {};
  
  // Common provider names
  const providerNames = ['openai', 'anthropic', 'openai-compat', 'cerebras', 'deepseek', 'xai', 'ollama', 'groq', 'openrouter'];
  
  for (const provider of providerNames) {
    const envVar = `${provider.toUpperCase()}_API_KEY`;
    if (process.env[envVar]) {
      apiKeys[provider] = process.env[envVar]!;
    }
  }

  // Check if required API keys are available
  const missingProviders = new Set<string>();
  for (const run of runs) {
    const provider = run.model?.provider;
    if (provider && !apiKeys[provider]) {
      missingProviders.add(provider);
    }
  }

  if (missingProviders.size > 0) {
    console.error(`Missing API keys for providers: ${Array.from(missingProviders).join(', ')}`);
    console.error('Set environment variables like OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.');
    process.exit(1);
  }

  const experimentId = runsConfig.experiment_id ?? args.experiment_id;

  // Create run tasks
  const runTasks = runs.map((run, index) => {
    const runId = run.id ?? `run_${index + 1}`;
    return () =>
      runSingleBenchmark({
        run,
        runId,
        runIndex: index + 1,
        questions,
        questionSetId: runsConfig.question_set_id ?? questionSetId,
        baseWorkingDir,
        experimentId,
        baseRef,
        forceBranch,
        defaultModelLabel: run.model?.model ?? run.model?.provider ?? defaultModelLabel,
        config,
        apiKeys,
      });
  });

  // Execute runs (parallel or sequential)
  const results = parallel ? await Promise.all(runTasks.map((task) => task())) : [];
  if (!parallel) {
    for (const task of runTasks) {
      results.push(await task());
    }
  }

  // Write results
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  for (const result of results) {
    fs.appendFileSync(outPath, `${JSON.stringify(result)}\n`);
    if (result.total_llm_calls === 0) {
      console.warn(`Warning: no LLM calls for run ${result.run_id}.`);
    }
  }

  console.log(`Wrote ${results.length} benchmark results to ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
