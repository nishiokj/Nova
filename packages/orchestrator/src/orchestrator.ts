/**
 * Orchestrator - Loop Governor for goal-driven agent execution.
 *
 * Replaces the DAG-based task coordinator with a simple loop-until-goal model:
 * - Agent decides what to do
 * - Orchestrator decides when to stop (bounds exceeded, goal reached, user input needed)
 * - Context is truth - no separate state machine
 */

import type { LLMAdapter } from 'llm';
import type { ToolRegistry } from 'tools';
import type { ContextWindow } from 'context';
import type { EventEmitCallback, UserPromptInfo, AgentHooks, AgentResult } from 'agent';
import { Agent } from 'agent';
import type { AgentRegistry } from 'agent';
import { createWorkItem, type WorkItem } from 'work';
import { createEvent } from 'types';
import type { ArtifactKind, ArtifactDiscoveredData } from 'types';
import type { EventBusProtocol } from 'comms-bus';

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
  /** Percent context usage that triggers compaction (default 0.8) */
  compactTriggerPercent: number;
  /** Percent context usage to reset compaction hysteresis (default 0.7) */
  compactResetPercent: number;
  /** Max file content items to keep during compaction */
  compactMaxFileCount: number;
  /** Max chars per tool output during compaction */
  compactTruncateTo: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxIterations: 50,
  maxToolCalls: 200,
  maxDurationMs: 300_000, // 5 minutes
  compactTriggerPercent: 0.8,
  compactResetPercent: 0.7,
  compactMaxFileCount: 20,
  compactTruncateTo: 5000,
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

/**
 * Plan mode options for read-only exploration.
 */
export interface PlanModeOptions {
  enabled: boolean;
  promptAddendum: string;
  toolFilter: (tools: string[]) => string[];
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
  private hooks?: AgentHooks;
  private planModeOptions?: PlanModeOptions;
  private eventBus?: EventBusProtocol;

  // Work queue state for DAG-based execution
  private workQueue: WorkItem[] = [];
  private completedWork: Map<string, AgentResult> = new Map();
  private initialWorkId: string = '';

  constructor(
    config: Partial<OrchestratorConfig>,
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    emit: EventEmitCallback,
    requestId: string,
    logger?: OrchestratorLogger,
    agentRegistry?: AgentRegistry,
    hooks?: AgentHooks,
    planModeOptions?: PlanModeOptions,
    eventBus?: EventBusProtocol
  ) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.emit = emit;
    this.requestId = requestId;
    this.logger = logger;
    this.agentRegistry = agentRegistry;
    this.hooks = hooks;
    this.planModeOptions = planModeOptions;
    this.eventBus = eventBus;
  }

  /**
   * Enqueue a work item for processing.
   * Items with dependencies will wait until all dependencies are completed.
   *
   * @param item - The work item to enqueue
   * @returns The work item's ID
   */
  enqueue(item: WorkItem): string {
    this.workQueue.push(item);
    return item.workId;
  }

  /**
   * Main entry point: Execute until goal is reached or bounds exceeded.
   *
   * @param context - The context window for the session
   * @param goal - The goal to achieve
   * @param agentType - The type of agent to use
   * @param cwd - Working directory for tool execution (required for concurrent-safe operation)
   */
  async execute(
    context: ContextWindow,
    goal: string,
    agentType: string = 'standard',
    cwd: string
  ): Promise<OrchestratorResult> {
    // Subscribe to artifact events for real-time stitching into global context
    // Dedupe is handled internally by addArtifact() - O(1)
    const unsubscribe = this.eventBus?.subscribe('artifact_discovered', (event) => {
      const data = event.data as ArtifactDiscoveredData;
      context.addArtifact({
        sourcePath: data.artifact.sourcePath,
        line: data.artifact.line,
        kind: data.artifact.kind as ArtifactKind,
        name: data.artifact.name,
        signature: data.artifact.signature,
        insight: data.artifact.insight,
        relevance: data.artifact.relevance,
        discoveredBy: data.agentType,
      });
    });

    try {
      return await this.executeInner(context, goal, agentType, cwd);
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * Inner execution logic, wrapped by execute() for cleanup.
   */
  private async executeInner(
    context: ContextWindow,
    goal: string,
    agentType: string,
    cwd: string
  ): Promise<OrchestratorResult> {
    // Clear work queue state for fresh execution
    this.workQueue = [];
    this.completedWork.clear();

    // Enqueue initial work item
    const initialItem = this.createWorkItem(goal, agentType);
    this.initialWorkId = initialItem.workId;
    this.enqueue(initialItem);

    const startTime = Date.now();
    let iteration = 0;
    let totalLlmCalls = 0;
    let totalToolCalls = 0;

    // Hysteresis gate for compaction: compact at 80%, don't compact again until below 70%
    let compactedRecently = false;

    // Local helper to emit goal_not_achieved events (reduces duplication)
    const emitGoalNotAchieved = (reason: string, failed = 0) =>
      this.emit(createEvent('goal_not_achieved', { goal, reason, completed: 0, failed, skipped: 0 }));

    this.log('info', 'Starting orchestration', { goal, agentType });
    this.emit(createEvent('orchestration_started', { goal, agentType, requestId: this.requestId }));

    // Track in-progress work items (for multi-iteration execution)
    const inProgress: Map<string, { item: WorkItem; agent: Agent }> = new Map();

    // Process work queue with parallel execution for independent items
    while (this.workQueue.length > 0 || inProgress.size > 0) {
      // Dequeue all ready items (dependencies satisfied)
      const readyItems = this.dequeueAllReady();

      // Create agents for new ready items
      for (const item of readyItems) {
        const agent = this.createAgent(item.agent);
        if (!agent) {
          // Mark as failed with synthetic error
          const errorResult: AgentResult = {
            success: false,
            response: '',
            error: `Unknown agent type: ${item.agent}`,
            metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
            filesRead: [],
            invalidatedPaths: [],
            toolErrors: [],
            terminationReason: 'agent_error',
            needsUserInput: false,
            isRefusal: false,
            localContext: context,
          };
          this.completedWork.set(item.workId, errorResult);

          // If this was the initial item, return error immediately
          if (item.workId === this.initialWorkId) {
            return this.createResult({
              success: false,
              response: '',
              error: `Unknown agent type: ${item.agent}`,
              terminationReason: 'agent_error',
              metrics: { iterations: 0, totalLlmCalls: 0, totalToolCalls: 0, durationMs: 0 },
            });
          }
          continue;
        }
        inProgress.set(item.workId, { item, agent });
      }

      // No work to do - deadlock or all blocked
      if (inProgress.size === 0) {
        if (this.workQueue.length > 0) {
          this.log('warning', 'Work queue deadlock - all items blocked on dependencies');
        }
        break;
      }

      iteration++;
      const now = Date.now();
      const elapsed = now - startTime;

      // AUTO-COMPACT with hysteresis
      const percentUsed = context.metrics.percentageUsed;
      if (percentUsed < this.config.compactResetPercent) {
        compactedRecently = false;
      }
      if (!compactedRecently && percentUsed >= this.config.compactTriggerPercent) {
        const compactResult = context.compact({
          deduplicateByPath: true,
          maxFileContentCount: this.config.compactMaxFileCount,
          truncateOutputsTo: this.config.compactTruncateTo,
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
        this.log('warning', 'Max iterations exceeded', { iteration, completedWork: this.completedWork.size });
        emitGoalNotAchieved('max_iterations_exceeded');
        const harvestedResponse = this.harvestCompletedWork(inProgress, 'max_iterations_exceeded');
        const hasContent = this.completedWork.size > 0;
        return this.createResult({
          success: hasContent, // Partial success if we have any completed work
          response: harvestedResponse,
          terminationReason: 'max_iterations_exceeded',
          metrics: { iterations: iteration - 1, totalLlmCalls, totalToolCalls, durationMs: elapsed },
        });
      }

      // BOUND CHECK: Duration
      if (elapsed > this.config.maxDurationMs) {
        this.log('warning', 'Max duration exceeded', { elapsed, completedWork: this.completedWork.size });
        emitGoalNotAchieved('max_duration_exceeded');
        const harvestedResponse = this.harvestCompletedWork(inProgress, 'max_duration_exceeded');
        const hasContent = this.completedWork.size > 0;
        return this.createResult({
          success: hasContent, // Partial success if we have any completed work
          response: harvestedResponse,
          terminationReason: 'max_duration_exceeded',
          metrics: { iterations: iteration - 1, totalLlmCalls, totalToolCalls, durationMs: elapsed },
        });
      }

      const itemIds = Array.from(inProgress.keys());
      const isParallel = inProgress.size > 1;
      this.log('info', `Iteration ${iteration}${isParallel ? ` (parallel: ${inProgress.size} items)` : ''}`, {
        totalToolCalls,
        totalLlmCalls,
        workItems: itemIds,
      });

      // Emit iteration_started for each work item
      for (const [workId, { item }] of inProgress) {
        this.emit(createEvent('iteration_started', { iteration, goal: item.goal, requestId: this.requestId, workId }));
      }

      // AGENT EXECUTION - run all in-progress items in parallel
      const executions = Array.from(inProgress.entries()).map(async ([workId, { item, agent }]) => {
        const result = await agent.run({ globalContext: context, workItem: item, cwd });
        return { workId, item, result };
      });

      const results = await Promise.all(executions);

      // Process results and check for terminal conditions
      let terminalResult: OrchestratorResult | null = null;

      for (const { workId, item, result } of results) {
        totalLlmCalls += result.metrics.llmCallsMade;
        totalToolCalls += result.metrics.toolCallsMade;

        // Merge token metrics
        const localMetrics = result.localContext.metrics;
        context.updateMetrics(localMetrics.inputTokens, localMetrics.outputTokens);

        // Emit iteration_completed
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
          workId,
        }));

        // Check terminal conditions (first terminal condition wins)
        if (!terminalResult) {
          // TERMINAL: User input needed
          if (result.needsUserInput && result.userPrompt) {
            this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question });
            context.addAgentResultContext(result);
            terminalResult = this.createResult({
              success: false,
              response: '',
              paused: true,
              userPrompt: result.userPrompt,
              terminationReason: 'user_input_required',
              metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
            });
            continue;
          }

          // TERMINAL: Refusal
          if (result.isRefusal) {
            this.log('warning', 'Agent refused', { workId, response: result.response });
            emitGoalNotAchieved('refusal', 1);
            context.addAgentResultContext(result);
            terminalResult = this.createResult({
              success: false,
              response: result.response,
              error: result.response,
              terminationReason: 'refusal',
              metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
            });
            continue;
          }

          // TERMINAL: Hard error
          const structured = result.structuredOutput;
          const actionIsContinue = structured?.action === 'continue';
          if (result.error && !result.success && !actionIsContinue) {
            this.log('error', 'Agent error', { workId, error: result.error });
            emitGoalNotAchieved(result.error, 1);
            context.addAgentResultContext(result);
            terminalResult = this.createResult({
              success: false,
              response: result.response,
              error: result.error,
              terminationReason: 'agent_error',
              metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
            });
            continue;
          }

          // BOUND CHECK: Total tool calls
          if (totalToolCalls >= this.config.maxToolCalls) {
            this.log('warning', 'Max tool calls exceeded', { totalToolCalls, completedWork: this.completedWork.size });
            emitGoalNotAchieved('max_tool_calls_exceeded');
            context.addAgentResultContext(result);
            // Use result.response if available, otherwise harvest completed work
            const response = result.response || this.harvestCompletedWork(inProgress, 'max_tool_calls_exceeded');
            const hasContent = !!result.response || this.completedWork.size > 0;
            terminalResult = this.createResult({
              success: hasContent, // Partial success if we have any content
              response,
              terminationReason: 'max_tool_calls_exceeded',
              metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
            });
            continue;
          }
        }

        // Check if goal reached for this work item
        const structured = result.structuredOutput;
        const goalStateReached = structured?.goalStateReached === true || result.terminationReason === 'goal_state_reached';

        if (goalStateReached) {
          this.log('info', 'Goal state reached', { workId, response: result.response?.slice(0, 100) });
          this.completedWork.set(workId, result);
          context.addAgentResultContext(result);
          inProgress.delete(workId);

          // If initial item completed and no more work, return success
          if (workId === this.initialWorkId && this.workQueue.length === 0 && inProgress.size === 0) {
            this.emit(createEvent('goal_achieved', {
              goal,
              completed: this.completedWork.size,
              skipped: 0,
            }));
            return this.createResult({
              success: true,
              response: result.response,
              terminationReason: 'goal_state_reached',
              metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
            });
          }
        } else {
          // Item needs more iterations - keep in progress, merge context
          context.addAgentResultContext(result);
        }
      }

      // If we hit a terminal condition, return it
      if (terminalResult) {
        return terminalResult;
      }

      this.log('info', `Continuing to iteration ${iteration + 1}`, { inProgress: inProgress.size, queued: this.workQueue.length });
    }

    // Queue is empty - aggregate and return results
    const initialResult = this.completedWork.get(this.initialWorkId);
    if (initialResult) {
      this.emit(createEvent('goal_achieved', {
        goal,
        completed: this.completedWork.size,
        skipped: 0,
      }));
      return this.createResult({
        success: initialResult.success,
        response: initialResult.response,
        error: initialResult.error,
        terminationReason: 'goal_state_reached',
        metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: Date.now() - startTime },
      });
    }

    // Edge case: queue emptied without completing initial item (shouldn't happen in normal flow)
    return this.createResult({
      success: false,
      response: '',
      error: 'Work queue exhausted without completing initial goal',
      terminationReason: 'agent_error',
      metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: Date.now() - startTime },
    });
  }

  // --- Private helpers ---

  /**
   * Dequeue the next ready work item (all dependencies satisfied).
   * Returns null if all items are blocked on dependencies.
   */
  private dequeueNext(): WorkItem | null {
    for (let i = 0; i < this.workQueue.length; i++) {
      const item = this.workQueue[i];
      const ready = item.dependencies.every(d => this.completedWork.has(d));
      if (ready) {
        this.workQueue.splice(i, 1);
        return item;
      }
    }
    return null;
  }

  /**
   * Dequeue ALL ready work items (all dependencies satisfied).
   * Returns empty array if all items are blocked on dependencies.
   * Used for parallel execution of independent work items.
   */
  private dequeueAllReady(): WorkItem[] {
    const ready: WorkItem[] = [];
    const indicesToRemove: number[] = [];

    for (let i = 0; i < this.workQueue.length; i++) {
      const item = this.workQueue[i];
      if (item.dependencies.every(d => this.completedWork.has(d))) {
        ready.push(item);
        indicesToRemove.push(i);
      }
    }

    // Remove in reverse order to preserve indices
    for (let i = indicesToRemove.length - 1; i >= 0; i--) {
      this.workQueue.splice(indicesToRemove[i], 1);
    }

    return ready;
  }

  private createAgent(agentType: string): Agent | null {
    // Try requested type first, then fallback to 'standard' if different
    let runtime = this.agentRegistry?.getRuntimeConfig(agentType);
    if (!runtime && agentType !== 'standard') {
      runtime = this.agentRegistry?.getRuntimeConfig('standard');
    }
    if (!runtime) return null;

    // Apply plan mode modifications if enabled
    let config = runtime.config;
    if (this.planModeOptions?.enabled) {
      config = {
        ...config,
        systemPrompt: config.systemPrompt + this.planModeOptions.promptAddendum,
        tools: this.planModeOptions.toolFilter(config.tools),
      };
    }

    return new Agent(config, {
      llm: this.llm,
      toolRegistry: this.toolRegistry,
      emit: this.emit,
      requestId: this.requestId,
      agentRegistry: this.agentRegistry,
      llmConfig: runtime.llm,
      hooks: this.hooks,
    });
  }

  private createWorkItem(goal: string, agentType: string): WorkItem {
    // Get agent's budget from registry, fallback to orchestrator config
    let agentBudget: { maxIterations: number; maxToolCalls: number; maxDurationMs: number } | undefined;
    try {
      agentBudget = this.agentRegistry?.getRuntimeConfig(agentType)?.config.budget;
    } catch {
      // Agent not in registry, use orchestrator defaults
    }

    return createWorkItem({
      goal,
      objective: goal,
      agent: agentType,
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

  /**
   * Harvest responses from completed work items and build a combined response.
   * Used when bounds are exceeded to return partial progress instead of empty.
   */
  private harvestCompletedWork(
    inProgress: Map<string, { item: WorkItem; agent: Agent }>,
    reason: string
  ): string {
    const parts: string[] = [];

    // Collect responses from completed work items
    if (this.completedWork.size > 0) {
      parts.push(`## Completed Work (${this.completedWork.size} items)`);
      for (const [workId, result] of this.completedWork) {
        if (result.response && result.response.trim().length > 0) {
          const preview = result.response.length > 2000
            ? result.response.slice(0, 2000) + '... [truncated]'
            : result.response;
          parts.push(`\n### ${workId}\n${preview}`);
        }
      }
    }

    // Note any work still in progress
    if (inProgress.size > 0) {
      parts.push(`\n## Work In Progress (${inProgress.size} items)`);
      for (const [workId, { item }] of inProgress) {
        parts.push(`- ${workId}: ${item.objective.slice(0, 100)}${item.objective.length > 100 ? '...' : ''}`);
      }
    }

    // Note any queued work that didn't start
    if (this.workQueue.length > 0) {
      parts.push(`\n## Queued Work (${this.workQueue.length} items not started)`);
      for (const item of this.workQueue.slice(0, 5)) {
        parts.push(`- ${item.workId}: ${item.objective.slice(0, 100)}${item.objective.length > 100 ? '...' : ''}`);
      }
      if (this.workQueue.length > 5) {
        parts.push(`... and ${this.workQueue.length - 5} more`);
      }
    }

    if (parts.length === 0) {
      return `Execution terminated (${reason}) with no completed work to report.`;
    }

    return `**Execution terminated: ${reason}**\n\n${parts.join('\n')}`;
  }
}
