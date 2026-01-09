import { createWorkItem } from '../packages/agent-core/src/wizard/work-item.js';
import { Agent } from '../packages/agent-core/src/agent/agent.js';
import { Orchestrator } from '../packages/agent-core/src/orchestrator/orchestrator.js';
import { noopEmit } from '../packages/agent-core/src/agent/types.js';
import type { AgentResult, AgentRunParams } from '../packages/agent-core/src/agent/types.js';
import type { Logger } from '../packages/agent-core/src/shared/logger.js';
import type { LLMAdapter } from '../packages/agent-core/src/llm/index.js';
import type { ToolRegistry } from '../packages/agent-core/src/tools/registry.js';
import type { AgentRegistry } from '../packages/agent-core/src/agent/agent-registry.js';
import type { GraphStore } from '../packages/graphd/src/index.js';
import type { KernelConfig } from './config.js';
import { BenchmarkRunner } from './benchmark.js';
import type { ContextManager } from './context.js';
import type { FlipFlopDetector } from './flipflop.js';
import { buildRecoveryPlan, detectAnomalies, executeRecovery, type HealthCollector } from './health.js';
import type {
  BenchmarkTier,
  BenchmarkSuiteResult,
  IterationResult,
  OnCallOutput,
  PrincipalOutput,
  SIASState,
  TestingOutput,
} from './types.js';
import { shouldUpgrade } from './upgrade.js';
import { validateOnCallOutput, validatePrincipalOutput, validateTestingOutput } from './validators.js';

interface KernelDependencies {
  config: KernelConfig;
  store: GraphStore;
  logger: Logger;
  llm: LLMAdapter;
  toolRegistry: ToolRegistry;
  agentRegistry: AgentRegistry;
  contextManager: ContextManager;
  health: HealthCollector;
  benchmarkRunner: BenchmarkRunner;
  flipFlopDetector: FlipFlopDetector;
  oncallHandler: (output: OnCallOutput) => Promise<void>;
  checkpointHandler: () => Promise<void>;
  rollbackHandler: () => Promise<void>;
  pauseHandler: () => Promise<void>;
  rotateLogsHandler: () => Promise<void>;
}

export async function runIteration(state: SIASState, deps: KernelDependencies): Promise<IterationResult> {
  const iterationNumber = state.iteration + 1;
  const startTime = Date.now();
  const currentObjective = state.currentFocus;
  const pendingState = {
    learnedConstraints: [...state.learnedConstraints],
    currentFocus: state.currentFocus,
    horizonObjectives: [...state.horizonObjectives],
  };

  const healthSnapshot = await deps.health.collectSnapshot();
  const anomalies = detectAnomalies(healthSnapshot, deps.config.health.thresholds);
  if (anomalies.length > 0) {
    const plan = buildRecoveryPlan(anomalies);
    await executeRecovery(
      plan,
      {
        compactAgentContext: async (agent) => {
          deps.contextManager.maybeCompact(agent, iterationNumber);
          deps.health.recordContextCompaction(agent);
        },
        checkpointNow: deps.checkpointHandler,
        restartSoft: deps.pauseHandler,
        rollbackVersion: deps.rollbackHandler,
        pauseIterationLoop: deps.pauseHandler,
        escalateToOnCall: async () => {
          const oncallOutput = await runOnCall(deps, state, anomalies);
          if (oncallOutput) {
            await deps.oncallHandler(oncallOutput);
          }
        },
        haltFatal: deps.pauseHandler,
        rotateLogs: deps.rotateLogsHandler,
      },
      deps.logger
    );
  }

  const codingResult = await runCoding(deps, state, iterationNumber);
  const benchmarkTier = selectBenchmarkTier(iterationNumber);
  const benchmarkResult = await deps.benchmarkRunner.runTier(benchmarkTier);

  deps.health.recordBenchmark(
    benchmarkResult.score,
    benchmarkResult.baseline_score,
    benchmarkResult.passed_count,
    benchmarkResult.failed_count
  );

  const testingOutput = await runTesting(deps, benchmarkResult, iterationNumber);
  let principalOutput = await runPrincipal(deps, state, benchmarkResult, testingOutput, iterationNumber);

  if (principalOutput?.new_constraints) {
    pendingState.learnedConstraints.push(...principalOutput.new_constraints.map((c) => c.constraint));
  }

  if (principalOutput?.next_objective) {
    pendingState.currentFocus = principalOutput.next_objective.goal;
    if (!pendingState.horizonObjectives.includes(principalOutput.next_objective.goal)) {
      pendingState.horizonObjectives.push(principalOutput.next_objective.goal);
    }
  }

  if (principalOutput) {
    const recentDecisions = deps.store.listSiasDecisions(state.sessionId).slice(-20);
    const flipFlopResult = await deps.flipFlopDetector.checkForFlipFlop(
      principalOutput.decision.reasoning,
      recentDecisions
    );

    if (flipFlopResult.is_flip_flop) {
      deps.logger.warn('[kernel] Flip-flop detected, blocking decision', {
        similar: flipFlopResult.similar_decisions.map((entry) => ({
          decision_id: entry.decision.decisionId,
          similarity: entry.similarity,
        })),
      });

      if (principalOutput.decision.confidence < 0.9) {
        principalOutput = {
          ...principalOutput,
          decision: {
            ...principalOutput.decision,
            type: 'pause',
            reasoning: `Blocked: ${flipFlopResult.recommendation}. Original: ${principalOutput.decision.reasoning}`,
          },
        };
      }
    }
  }

  const shouldUpgradeNow =
    principalOutput?.decision.type === 'approve_upgrade' ||
    shouldUpgrade(benchmarkResult, deps.config.upgradePolicy, iterationNumber - state.lastUpgradeIteration);

  const iterationResult: IterationResult = {
    iteration: iterationNumber,
    coding_response: codingResult?.response,
    coding_success: codingResult?.success,
    benchmark_result: benchmarkResult,
    testing_output: testingOutput ?? undefined,
    principal_output: principalOutput ?? undefined,
    status: shouldUpgradeNow ? 'upgraded' : 'success',
  };

  if (principalOutput?.decision.type === 'escalate') {
    const oncallOutput = await runOnCall(deps, state, anomalies);
    if (oncallOutput) {
      await deps.oncallHandler(oncallOutput);
      iterationResult.oncall_output = oncallOutput;
    }
  }

  const duration = Date.now() - startTime;
  deps.health.recordIteration(duration, Boolean(codingResult?.success), Boolean(codingResult?.response));

  const decisionId = recordDecision(deps.store, state, principalOutput, iterationNumber);
  if (decisionId && principalOutput) {
    deps.flipFlopDetector.storeEmbedding(decisionId, principalOutput.decision.reasoning);
  }

  deps.store.upsertSiasPatch({
    patchId: `patch-${state.sessionId}-${iterationNumber}`,
    sessionId: state.sessionId,
    iteration: iterationNumber,
    timestamp: Date.now() / 1000,
    objective: currentObjective,
    reasoning: codingResult?.response ?? '',
    filesChanged: [],
    diffSummary: '',
    status: codingResult?.success ? 'applied' : 'rolled_back',
    rollbackReason: codingResult?.success ? null : codingResult?.error ?? 'failed',
    benchmarkBefore: { score: benchmarkResult.baseline_score },
    benchmarkAfter: { score: benchmarkResult.score },
    testSummary: { passed: benchmarkResult.passed_count, failed: benchmarkResult.failed_count },
    filesChangedJson: null,
    benchmarkBeforeJson: null,
    benchmarkAfterJson: null,
    testSummaryJson: null,
  });

  state.learnedConstraints = pendingState.learnedConstraints;
  state.currentFocus = pendingState.currentFocus;
  state.horizonObjectives = pendingState.horizonObjectives;
  state.lastIterationResult = iterationResult;
  state.patchSummary = `Iteration ${iterationNumber}: ${codingResult?.success ? 'applied' : 'failed'} - ${currentObjective}`;

  return iterationResult;
}

function selectBenchmarkTier(iteration: number): BenchmarkTier {
  if (iteration % 5 === 0) {
    return 'full';
  }
  if (iteration % 3 === 0) {
    return 'core';
  }
  return 'smoke';
}

async function runCoding(deps: KernelDependencies, state: SIASState, iteration: number) {
  const context = deps.contextManager.getContext('coding');
  context.addMessage('user', buildCodingPrompt(state));
  deps.contextManager.maybeCompact('coding', iteration);

  const orchestratorLogger = {
    info: deps.logger.info.bind(deps.logger),
    debug: deps.logger.debug.bind(deps.logger),
    warning: deps.logger.warn.bind(deps.logger),
    error: deps.logger.error.bind(deps.logger),
  };

  const orchestrator = new Orchestrator(
    deps.config.orchestrator,
    deps.toolRegistry,
    deps.llm,
    noopEmit,
    `coding-${state.sessionId}-${iteration}`,
    orchestratorLogger,
    deps.agentRegistry
  );

  const result = await orchestrator.execute(context, state.currentFocus, 'coding');
  deps.health.recordAgentInvocation('coding', {
    success: result.success,
    tokens_in: 0,
    tokens_out: 0,
    tool_calls: result.metrics.totalToolCalls,
    error: result.error,
  });

  return result;
}

async function runTesting(
  deps: KernelDependencies,
  benchmarkResult: BenchmarkSuiteResult,
  iteration: number
): Promise<TestingOutput | null> {
  const runtime = deps.agentRegistry.getRuntimeConfig('testing');
  const agent = new Agent(runtime.config, deps.llm, deps.toolRegistry, noopEmit, `testing-${iteration}`, deps.agentRegistry, runtime.llm);
  const context = deps.contextManager.getContext('testing');
  context.addMessage('user', buildTestingPrompt(benchmarkResult));
  deps.contextManager.maybeCompact('testing', iteration);

  const result = await runAgentWithTimeout(
    agent,
    {
      context,
      workItem: createWorkItem({
        goal: 'Assess benchmark results',
        objective: 'Analyze benchmark suite results and recommend proceed/block/investigate.',
        agent: 'testing',
      }),
    },
    runtime.config.budget.maxDurationMs
  );

  if (!result) {
    deps.logger.warn('[kernel] Testing agent timed out', { iteration });
    deps.health.recordAgentInvocation('testing', {
      success: false,
      tokens_in: 0,
      tokens_out: 0,
      tool_calls: 0,
      error: 'timeout',
    });
    return null;
  }

  deps.health.recordAgentInvocation('testing', {
    success: result.success,
    tokens_in: 0,
    tokens_out: 0,
    tool_calls: result.metrics.toolCallsMade,
    error: result.error,
  });

  const validation = validateTestingOutput(result.structuredOutput);
  if (!validation.valid) {
    deps.logger.error('[kernel] Invalid testing output', {
      errors: validation.errors,
      output: result.structuredOutput,
    });
    return null;
  }

  return validation.value;
}

async function runPrincipal(
  deps: KernelDependencies,
  state: SIASState,
  benchmarkResult: BenchmarkSuiteResult,
  testingOutput: TestingOutput | null,
  iteration: number
): Promise<PrincipalOutput | null> {
  const runtime = deps.agentRegistry.getRuntimeConfig('principal');
  const agent = new Agent(runtime.config, deps.llm, deps.toolRegistry, noopEmit, `principal-${iteration}`, deps.agentRegistry, runtime.llm);
  const context = deps.contextManager.getContext('principal');

  const recentDecisions = deps.store.listSiasDecisions(state.sessionId).slice(-20);
  context.addMessage('user', buildPrincipalPrompt(state, benchmarkResult, testingOutput, recentDecisions));
  deps.contextManager.maybeCompact('principal', iteration);

  const result = await runAgentWithTimeout(
    agent,
    {
      context,
      workItem: createWorkItem({
        goal: 'Decide next kernel action',
        objective: 'Review iteration results and decide next action.',
        agent: 'principal',
      }),
    },
    runtime.config.budget.maxDurationMs
  );

  if (!result) {
    deps.logger.warn('[kernel] Principal agent timed out', { iteration });
    deps.health.recordAgentInvocation('principal', {
      success: false,
      tokens_in: 0,
      tokens_out: 0,
      tool_calls: 0,
      error: 'timeout',
    });
    return null;
  }

  deps.health.recordAgentInvocation('principal', {
    success: result.success,
    tokens_in: 0,
    tokens_out: 0,
    tool_calls: result.metrics.toolCallsMade,
    error: result.error,
  });

  const validation = validatePrincipalOutput(result.structuredOutput);
  if (!validation.valid) {
    deps.logger.error('[kernel] Invalid principal output', {
      errors: validation.errors,
      output: result.structuredOutput,
    });
    return null;
  }

  return validation.value;
}

async function runOnCall(
  deps: KernelDependencies,
  state: SIASState,
  anomalies: ReturnType<typeof detectAnomalies>
): Promise<OnCallOutput | null> {
  const runtime = deps.agentRegistry.getRuntimeConfig('oncall');
  const agent = new Agent(runtime.config, deps.llm, deps.toolRegistry, noopEmit, `oncall-${state.iteration}`, deps.agentRegistry, runtime.llm);
  const context = deps.contextManager.getContext('oncall');
  context.addMessage('user', buildOnCallPrompt(state, anomalies));
  deps.contextManager.maybeCompact('oncall', state.iteration);

  const result = await runAgentWithTimeout(
    agent,
    {
      context,
      workItem: createWorkItem({
        goal: 'Investigate anomalies',
        objective: 'Analyze failures and propose fixes.',
        agent: 'oncall',
      }),
    },
    runtime.config.budget.maxDurationMs
  );

  if (!result) {
    deps.logger.warn('[kernel] OnCall agent timed out', { iteration: state.iteration });
    deps.health.recordAgentInvocation('oncall', {
      success: false,
      tokens_in: 0,
      tokens_out: 0,
      tool_calls: 0,
      error: 'timeout',
    });
    return null;
  }

  deps.health.recordAgentInvocation('oncall', {
    success: result.success,
    tokens_in: 0,
    tokens_out: 0,
    tool_calls: result.metrics.toolCallsMade,
    error: result.error,
  });

  const validation = validateOnCallOutput(result.structuredOutput);
  if (!validation.valid) {
    deps.logger.error('[kernel] Invalid oncall output', {
      errors: validation.errors,
      output: result.structuredOutput,
    });
    return null;
  }

  return validation.value;
}

async function runAgentWithTimeout(
  agent: Agent,
  params: AgentRunParams,
  timeoutMs: number
): Promise<AgentResult | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<AgentResult>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Agent timeout')), timeoutMs);
  });

  try {
    return await Promise.race([agent.run(params), timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent timeout') {
      return null;
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildCodingPrompt(state: SIASState): string {
  return `Current objective: ${state.currentFocus}\n\nConstraints:\n${state.learnedConstraints.map((c) => `- ${c}`).join('\n')}`;
}

function buildTestingPrompt(result: BenchmarkSuiteResult): string {
  return `Benchmark tier: ${result.tier}\nScore: ${result.score.toFixed(2)}\nPassed: ${result.passed_count}\nFailed: ${result.failed_count}\nImprovement: ${(result.improvement_percent * 100).toFixed(2)}%\n\nResults JSON:\n${JSON.stringify(result, null, 2)}`;
}

function buildPrincipalPrompt(
  state: SIASState,
  benchmarkResult: BenchmarkSuiteResult,
  testingOutput: TestingOutput | null,
  recentDecisions: ReturnType<GraphStore['listSiasDecisions']>
): string {
  const decisionsText = recentDecisions
    .map(
      (decision) =>
        `- Iteration ${decision.iteration}: ${decision.decisionType}\n  Outcome: ${decision.outcome ?? ''}\n  Reasoning: ${decision.reasoning ?? ''}`
    )
    .join('\n');

  return `Session ${state.sessionId} Iteration ${state.iteration + 1}

Current focus: ${state.currentFocus}

Learned constraints:
${state.learnedConstraints.map((c) => `- ${c}`).join('\n')}

Recent decisions:
${decisionsText}

Benchmark summary:
- Score: ${benchmarkResult.score.toFixed(2)}
- Passed: ${benchmarkResult.passed_count}
- Failed: ${benchmarkResult.failed_count}
- Improvement: ${(benchmarkResult.improvement_percent * 100).toFixed(2)}%

Testing agent recommendation:
${testingOutput ? testingOutput.recommendation : 'n/a'}

Last iteration result:
${state.lastIterationResult ? JSON.stringify(state.lastIterationResult, null, 2) : 'none'}

Decide next action and respond with PrincipalOutput JSON.`;
}

function buildOnCallPrompt(state: SIASState, anomalies: ReturnType<typeof detectAnomalies>): string {
  return `Session ${state.sessionId} requires investigation.

Anomalies:
${anomalies.map((a) => `- ${a.type} (${a.severity}): ${a.metric_value}`).join('\n')}

Last iteration:
${state.lastIterationResult ? JSON.stringify(state.lastIterationResult, null, 2) : 'none'}

Provide diagnosis and next actions in OnCallOutput JSON.`;
}

function recordDecision(
  store: GraphStore,
  state: SIASState,
  output: PrincipalOutput | null,
  iteration: number
): string | null {
  if (!output) return null;
  const decisionId = `decision-${state.sessionId}-${iteration}`;
  store.upsertSiasDecision({
    decisionId,
    sessionId: state.sessionId,
    iteration,
    agent: 'principal',
    decisionType: output.decision.type,
    reasoning: output.decision.reasoning,
    outcome: output.decision.type,
    relatedDecisionsJson: JSON.stringify(output.related_decisions ?? []),
    createdAt: Date.now() / 1000,
  });
  return decisionId;
}
