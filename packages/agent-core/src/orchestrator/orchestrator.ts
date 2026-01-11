/**
 * Orchestrator - Loop Governor for goal-driven agent execution.
 *
 * Replaces the DAG-based task coordinator with a simple loop-until-goal model:
 * - Agent decides what to do
 * - Orchestrator decides when to stop (bounds exceeded, goal reached, user input needed)
 * - Context is truth - no separate state machine
 */

import type { LLMAdapter } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContextWindow } from '../context/index.js';
import type { EventEmitCallback, UserPromptInfo } from '../agent/types.js';
import { Agent } from '../agent/agent.js';
import type { AgentRegistry } from '../agent/agent-registry.js';
import { createWorkItem, type WorkItem } from '../wizard/work-item.js';
import { createEvent } from '../types/events.js';

// --- Types ---

/**
 * Orchestrator configuration.
 */
export interface OrchestratorConfig {
  /** Maximum iterations in execution loop */
  maxIterations: number;
  /** Maximum total tool calls across all iterations */
  maxToolCalls: number;
  /** Maximum duration in milliseconds */
  maxDurationMs: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxIterations: 50,
  maxToolCalls: 200,
  maxDurationMs: 300_000, // 5 minutes
};

/**
 * Why orchestration terminated.
 */
export type TerminationReason =
  | 'goal_state_reached'
  | 'max_iterations_exceeded'
  | 'max_tool_calls_exceeded'
  | 'max_duration_exceeded'
  | 'user_input_required'
  | 'agent_error'
  | 'refusal';

/**
 * Orchestrator execution metrics.
 */
export interface OrchestratorMetrics {
  iterations: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  durationMs: number;
}

/**
 * Result from Orchestrator.execute().
 */
export interface OrchestratorResult {
  success: boolean;
  response: string;
  error?: string;
  paused: boolean;
  userPrompt?: UserPromptInfo;
  terminationReason: TerminationReason;
  metrics: OrchestratorMetrics;
}

/**
 * Logger protocol.
 */
export interface OrchestratorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// --- Orchestrator ---

/**
 * Loop Governor - executes an agent until goal is reached or bounds exceeded.
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private toolRegistry: ToolRegistry;
  private llm: LLMAdapter;
  private emit: EventEmitCallback;
  private requestId: string;
  private logger?: OrchestratorLogger;
  private agentRegistry?: AgentRegistry;

  // State for resume
  private goal: string = '';
  private agentType: string = 'standard';

  constructor(
    config: Partial<OrchestratorConfig>,
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    emit: EventEmitCallback,
    requestId: string,
    logger?: OrchestratorLogger,
    agentRegistry?: AgentRegistry
  ) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.emit = emit;
    this.requestId = requestId;
    this.logger = logger;
    this.agentRegistry = agentRegistry;
  }

  /**
   * Main entry point: Execute until goal is reached or bounds exceeded.
   */
  async execute(
    context: ContextWindow,
    goal: string,
    agentType: string = 'standard'
  ): Promise<OrchestratorResult> {
    this.goal = goal;
    this.agentType = agentType;

    const startTime = Date.now();
    let iteration = 0;
    let totalLlmCalls = 0;
    let totalToolCalls = 0;

    // Hysteresis gate for compaction: compact at 80%, don't compact again until below 70%
    let compactedRecently = false;

    // Create agent for this goal
    const agent = this.createAgent(agentType);
    if (!agent) {
      return this.createResult({
        success: false,
        response: '',
        error: `Unknown agent type: ${agentType}`,
        terminationReason: 'agent_error',
        metrics: { iterations: 0, totalLlmCalls: 0, totalToolCalls: 0, durationMs: 0 },
      });
    }

    // Create work item representing the goal
    const workItem = this.createWorkItem(goal);

    // Local helper to emit goal_not_achieved events (reduces duplication)
    const emitGoalNotAchieved = (reason: string, failed = 0) =>
      this.emit(createEvent('goal_not_achieved', { goal, reason, completed: 0, failed, skipped: 0 }));

    this.log('info', 'Starting orchestration', { goal, agentType });
    this.emit(createEvent('orchestration_started', { goal, agentType, requestId: this.requestId }));

    while (true) {
      iteration++;
      // Cache timestamp once per iteration for consistent metrics
      const now = Date.now();
      const elapsed = now - startTime;

      // AUTO-COMPACT with hysteresis: compact at 80%, don't re-compact until below 70%
      const percentUsed = context.metrics.percentageUsed;
      if (percentUsed < 0.7) {
        compactedRecently = false;
      }
      if (!compactedRecently && percentUsed >= 0.8) {
        const compactResult = context.compact({
          deduplicateByPath: true,
          maxFileContentCount: 20,
          truncateOutputsTo: 5000,
        });
        compactedRecently = true;
        this.log('info', 'Auto-compacted context', {
          percentUsed,
          itemsRemoved: compactResult.itemsRemoved,
          bytesRecovered: compactResult.bytesRecovered,
        });
      }

      // BOUND CHECK: Iterations
      if (iteration > this.config.maxIterations) {
        this.log('warning', 'Max iterations exceeded', { iteration });
        emitGoalNotAchieved('max_iterations_exceeded');
        return this.createResult({
          success: false,
          response: '',
          terminationReason: 'max_iterations_exceeded',
          metrics: { iterations: iteration - 1, totalLlmCalls, totalToolCalls, durationMs: elapsed },
        });
      }

      // BOUND CHECK: Duration
      if (elapsed > this.config.maxDurationMs) {
        this.log('warning', 'Max duration exceeded', { elapsed });
        emitGoalNotAchieved('max_duration_exceeded');
        return this.createResult({
          success: false,
          response: '',
          terminationReason: 'max_duration_exceeded',
          metrics: { iterations: iteration - 1, totalLlmCalls, totalToolCalls, durationMs: elapsed },
        });
      }

      this.log('info', `Iteration ${iteration}`, { totalToolCalls, totalLlmCalls });
      this.emit(createEvent('iteration_started', { iteration, goal, requestId: this.requestId }));

      // AGENT EXECUTION - agent reads from global context, writes to its own local context
      const result = await agent.run({ globalContext: context, workItem });

      totalLlmCalls += result.metrics.llmCallsMade;
      totalToolCalls += result.metrics.toolCallsMade;

      // Merge token metrics from agent's local context into global context
      const localMetrics = result.localContext.metrics;
      context.updateMetrics(localMetrics.inputTokens, localMetrics.outputTokens);

      // BOUND CHECK: Total tool calls (moved earlier for cheaper early exit)
      if (totalToolCalls >= this.config.maxToolCalls) {
        this.log('warning', 'Max tool calls exceeded', { totalToolCalls });
        emitGoalNotAchieved('max_tool_calls_exceeded');
        context.addAgentResultContext(result);
        return this.createResult({
          success: false,
          response: result.response,
          terminationReason: 'max_tool_calls_exceeded',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        });
      }

      // Emit iteration_completed with optimized slicing (only slice if needed)
      const responsePreview = result.response && result.response.length > 200
        ? result.response.slice(0, 200)
        : result.response;
      this.emit(createEvent('iteration_completed', {
        iteration,
        result: {
          success: result.success,
          response: responsePreview,
          toolCalls: result.metrics.toolCallsMade,
          llmCalls: result.metrics.llmCallsMade,
        },
        requestId: this.requestId,
      }));

      // TERMINAL CHECK: User input needed
      if (result.needsUserInput && result.userPrompt) {
        this.log('info', 'Pausing for user input', { question: result.userPrompt.question });
        // Merge agent's localContext so the question is preserved for resume
        context.addAgentResultContext(result);
        return this.createResult({
          success: false,
          response: '',
          paused: true,
          userPrompt: result.userPrompt,
          terminationReason: 'user_input_required',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        });
      }

      // TERMINAL CHECK: Goal state reached (config-defined schema)
      const structured = result.structuredOutput;
      const goalStateReached = structured?.goalStateReached === true;
      if (goalStateReached || result.terminationReason === 'goal_state_reached') {
        this.log('info', 'Goal state reached', { response: result.response?.slice(0, 100) });
        this.emit(createEvent('goal_achieved', {
          goal,
          completed: 1,
          skipped: 0,
        }));
        context.addAgentResultContext(result);
        return this.createResult({
          success: true,
          response: result.response,
          terminationReason: 'goal_state_reached',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        });
      }

      // TERMINAL CHECK: Agent refusal
      if (result.isRefusal) {
        this.log('warning', 'Agent refused', { response: result.response });
        emitGoalNotAchieved('refusal', 1);
        context.addAgentResultContext(result);
        return this.createResult({
          success: false,
          response: result.response,
          error: result.response,
          terminationReason: 'refusal',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        });
      }

      // TERMINAL CHECK: Hard agent error (not recoverable)
      const actionIsContinue = structured?.action === 'continue';
      if (result.error && !result.success && !actionIsContinue) {
        this.log('error', 'Agent error', { error: result.error });
        emitGoalNotAchieved(result.error, 1);
        return this.createResult({
          success: false,
          response: result.response,
          error: result.error,
          terminationReason: 'agent_error',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        });
      }

      // Continue loop - merge agent result for next iteration
      context.addAgentResultContext(result);
      this.log('info', `Continuing to iteration ${iteration + 1}`);
    }
  }

  /**
   * Resume after user input pause.
   */
  async resume(context: ContextWindow, userResponse: string): Promise<OrchestratorResult> {
    // Inject user response into context
    context.addMessage('user', userResponse);
    this.log('info', 'Resuming after user input');

    // Re-enter loop with stored goal and agent type
    return this.execute(context, this.goal, this.agentType);
  }

  // --- Private helpers ---

  private createAgent(agentType: string): Agent | null {
    // Try requested type first, then fallback to 'standard' if different
    let runtime = this.agentRegistry?.getRuntimeConfig(agentType);
    if (!runtime && agentType !== 'standard') {
      runtime = this.agentRegistry?.getRuntimeConfig('standard');
    }
    if (!runtime) return null;

    return new Agent(
      runtime.config,
      this.llm,
      this.toolRegistry,
      this.emit,
      this.requestId,
      this.agentRegistry,
      runtime.llm
    );
  }

  private createWorkItem(goal: string): WorkItem {
    // Get agent's budget from registry, fallback to orchestrator config
    let agentBudget: { maxIterations: number; maxToolCalls: number; maxDurationMs: number } | undefined;
    try {
      agentBudget = this.agentRegistry?.getRuntimeConfig(this.agentType)?.config.budget;
    } catch {
      // Agent not in registry, use orchestrator defaults
    }

    return createWorkItem({
      goal,
      objective: goal,
      agent: this.agentType,
      bounds: {
        maxToolCalls: agentBudget?.maxToolCalls ?? this.config.maxToolCalls,
        maxDurationMs: agentBudget?.maxDurationMs ?? this.config.maxDurationMs,
        maxLlmCalls: agentBudget?.maxIterations ?? this.config.maxIterations,
      },
    });
  }

  private createResult(
    partial: Partial<OrchestratorResult> & { terminationReason: TerminationReason; metrics: OrchestratorMetrics }
  ): OrchestratorResult {
    return {
      success: partial.success ?? false,
      response: partial.response ?? '',
      error: partial.error,
      paused: partial.paused ?? false,
      userPrompt: partial.userPrompt,
      terminationReason: partial.terminationReason,
      metrics: partial.metrics,
    };
  }

  private log(level: keyof OrchestratorLogger, msg: string, meta?: Record<string, unknown>): void {
    this.logger?.[level](msg, { component: 'orchestrator', requestId: this.requestId, ...meta });
  }
}
