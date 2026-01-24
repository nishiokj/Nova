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
import { ContextWindow } from 'context';
import type {
  EventEmitCallback,
  UserPromptInfo,
  AgentHooks,
  AgentResult,
  InternalHookEvent,
  InternalHookContext,
  InternalHookQueue,
  ModelSelection,
} from 'agent';
import { Agent } from 'agent';
import type { AgentRegistry } from 'agent';
import { createWorkItem, type WorkItem } from 'work';
import { createEvent } from 'types';
import type { ArtifactKind, ArtifactDiscoveredData, AgentEvent, LLMRequestConfig } from 'types';
import type { EventBusProtocol } from 'comms-bus';
import { buildLLMRequestConfig, type OrchestratorTerminationReason, profiler } from 'shared';
import { executeHooks, type StopHookHandler } from './hooks.js';
import { BoundsChecker } from './bounds-checker.js';

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
  /** Max time for internal hook handler execution */
  hookTimeoutMs: number;
  /** Percent context usage that triggers compaction (default 0.8) */
  compactTriggerPercent: number;
  /** Percent context usage to reset compaction hysteresis (default 0.7) */
  compactResetPercent: number;
  /** Max file content items to keep during compaction */
  compactMaxFileCount: number;
  /** Max chars per tool output during compaction */
  compactTruncateTo: number;
  /** Per-request stop hook - intercepts goal completion */
  stopHook?: StopHookHandler;
  /**
   * Check for pending user interruption that arrived during execution.
   * Called before terminating on goal_state_reached.
   * If returns true, orchestrator creates new work item and continues.
   */
  checkInterruption?: () => boolean;
  /**
   * Check for user stop request (e.g., user typed "stop").
   * Passed to agent's shouldStop hook. Called each agent iteration.
   */
  checkStopRequest?: () => boolean;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxIterations: 70,
  maxToolCalls: 250,
  maxDurationMs: 300_000, // 5 minutes
  hookTimeoutMs: 5000,
  compactTriggerPercent: 0.70,
  compactResetPercent: 0.7,
  compactMaxFileCount: 20,
  compactTruncateTo: 5000,
};

/**
 * Why orchestration terminated.
 * Re-exported from shared for backwards compatibility.
 */
export type TerminationReason = OrchestratorTerminationReason;

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
  /** Handoff spec for planning → execution transition */
  handoffSpec?: string;
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

/**
 * Result of a termination condition check.
 */
type TerminationCheckResult = {
  /** Terminal result to return, or null if execution should continue */
  terminal: OrchestratorResult | null;
  /** Whether execution should continue (stop hook blocked) */
  shouldContinue: boolean;
  /** New work item to enqueue (for stop hook blocking) */
  newItem?: WorkItem;
};

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
  private getModelSelection?: (agentType: string) => ModelSelection | null;
  private eventBus?: EventBusProtocol;
  private hookQueue: InternalHookQueue;
  private boundsChecker: BoundsChecker;

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
    eventBus?: EventBusProtocol,
    getModelSelection?: (agentType: string) => ModelSelection | null
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
    this.getModelSelection = getModelSelection;
    this.eventBus = eventBus;
    this.hookQueue = this.createHookQueue();
    this.boundsChecker = new BoundsChecker({
      maxIterations: this.config.maxIterations,
      maxDurationMs: this.config.maxDurationMs,
      maxToolCalls: this.config.maxToolCalls,
    });
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
   * Creates a hook queue that enqueues events as work items.
   */
  private createHookQueue(): InternalHookQueue {
    return {
      enqueue: (event: InternalHookEvent, context: InternalHookContext) => {
        const hookWorkItem = createWorkItem({
          goal: 'internal_hook',
          objective: `hook:${event.type}`,
          agent: 'internal',
          dependencies: [],
          bounds: {
            maxToolCalls: 0,
            maxDurationMs: this.config.hookTimeoutMs,
            maxLlmCalls: 0,
          },
          params: {
            isInternalHook: true,
            hookType: event.type,
            event,
            hookContext: context,
            handler: () => executeHooks(event.type, event, context),
          },
        });

        this.enqueue(hookWorkItem);
      },
    };
  }

  /**
   * Run a hook handler without blocking the orchestrator loop.
   */
  private runHookHandler(params: {
    handler: () => Promise<void>;
    hookType: string;
    workItemId: string;
    event?: InternalHookEvent;
    hookContext?: InternalHookContext;
    contextWindow: ContextWindow;
  }): void {
    const timeoutMs = this.config.hookTimeoutMs;
    void (async () => {
      const start = Date.now();
      const callId = `hook-${params.hookType}-${params.workItemId}`;
      const hookArgs = {
        hookType: params.hookType,
        event: params.event,
        context: params.hookContext,
      };
      const hookCallContext = new ContextWindow(params.contextWindow.sessionKey, params.contextWindow.maxTokens);
      hookCallContext.addFunctionCall(callId, `hook:${params.hookType}`, hookArgs);
      params.contextWindow.addAgentResultContext({
        response: '',
        filesRead: [],
        invalidatedPaths: [],
        localContext: hookCallContext,
      });

      this.emit(createEvent('hook_call', {
        hookType: params.hookType,
        phase: 'starting',
      }, params.workItemId, this.requestId));
      let timer: ReturnType<typeof setTimeout> | null = null;
      let success = false;
      let error: string | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('hook_timeout'));
          }, timeoutMs);
        });
        await Promise.race([params.handler(), timeout]);
        success = true;
        this.emit(createEvent('hook_call', {
          hookType: params.hookType,
          phase: 'completed',
          success,
          durationMs: Date.now() - start,
        }, params.workItemId, this.requestId));
      } catch (err) {
        error = String(err);
        this.emit(createEvent('hook_call', {
          hookType: params.hookType,
          phase: 'completed',
          success: false,
          error,
          durationMs: Date.now() - start,
        }, params.workItemId, this.requestId));
        console.error(`[HOOK:${params.hookType}] Handler error:`, err);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        const hookOutput = new ContextWindow(params.contextWindow.sessionKey, params.contextWindow.maxTokens);
        hookOutput.addFunctionCallOutput(
          callId,
          JSON.stringify(
            {
              hookType: params.hookType,
              success,
              durationMs: Date.now() - start,
              error: error ?? null,
            },
            null,
            2
          ),
          !success
        );
        params.contextWindow.addAgentResultContext({
          response: '',
          filesRead: [],
          invalidatedPaths: [],
          localContext: hookOutput,
        });
      }
    })();
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
    const unsubscribe = this.eventBus?.subscribe('artifact_discovered', (event: AgentEvent<ArtifactDiscoveredData>) => {
      const data = event.data;
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

    let startTime = Date.now();
    let iteration = 0;
    let totalLlmCalls = 0;
    let totalToolCalls = 0;

    // Hysteresis gate for compaction: compact at 80%, don't compact again until below 70%
    let compactedRecently = false;

    this.log('info', 'Starting orchestration', { goal, agentType });
    this.emit(createEvent('orchestration_started', { goal, agentType, requestId: this.requestId }));
    profiler.instant('orchestration:start', 'orchestrator', 'p', { goal: goal.slice(0, 100), agentType });

    // Track in-progress work items (for multi-iteration execution)
    const inProgress: Map<string, { item: WorkItem; agent: Agent | null }> = new Map();

    // Process work queue with parallel execution for independent items
    while (this.workQueue.length > 0 || inProgress.size > 0) {
      // Dequeue all ready items (dependencies satisfied)
      const readyItems = this.dequeueAllReady();

      // Create agents for new ready items
      for (const item of readyItems) {
        const hookParams = item.params as { isInternalHook?: boolean } | undefined;
        if (hookParams?.isInternalHook) {
          inProgress.set(item.workId, { item, agent: null });
          continue;
        }
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
            terminationReason: 'exception', // Agent-level reason for orchestrator error
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
      profiler.instant(`orch.iteration:${iteration}`, 'orchestrator', 'p', {
        workItems: Array.from(inProgress.keys()),
        totalToolCalls,
        totalLlmCalls,
      });
      const now = Date.now();
      const elapsed = now - startTime;

      // AUTO-COMPACT with hysteresis
      const percentUsed = context.metrics.percentageUsed;
      if (percentUsed < this.config.compactResetPercent) {
        compactedRecently = false;
      }
      if (!compactedRecently && percentUsed >= this.config.compactTriggerPercent) {
        const compactAsyncId = profiler.asyncBegin('orch.compact', 'orchestrator');
        const llmConfig = this.resolveCompactionLlmConfig(agentType);
        let compactResult;
        if (llmConfig) {
          try {
            compactResult = await context.compactWithLedger({
              llm: this.llm,
              llmConfig,
              targetReductionRatio: 0.66,
              preserveRecentItems: 12,
              deduplicateByPath: true,
              maxFileContentCount: this.config.compactMaxFileCount,
              truncateOutputsTo: this.config.compactTruncateTo,
            });
          } catch {
            compactResult = context.compact({
              deduplicateByPath: true,
              maxFileContentCount: this.config.compactMaxFileCount,
              truncateOutputsTo: this.config.compactTruncateTo,
            });
          }
        } else {
          compactResult = context.compact({
            deduplicateByPath: true,
            maxFileContentCount: this.config.compactMaxFileCount,
            truncateOutputsTo: this.config.compactTruncateTo,
          });
        }
        compactedRecently = true;
        profiler.asyncEnd('orch.compact', compactAsyncId, 'orchestrator', {
          itemsRemoved: compactResult.itemsRemoved,
          bytesRecovered: compactResult.bytesRecovered,
        });
        this.log('info', 'Auto-compacted context', {
          percentUsed,
          itemsRemoved: compactResult.itemsRemoved,
          bytesRecovered: compactResult.bytesRecovered,
        });
      }

      // BOUND CHECK: Iterations
      if (iteration > this.config.maxIterations) {
        this.log('warning', 'Max iterations exceeded', { iteration, completedWork: this.completedWork.size });
        const stopResult = await this.callStopHook(context, 'max_iterations_exceeded', '', iteration, agentType);
        if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
          continue; // Stop hook blocked - keep going
        }
        this.emitGoalNotAchieved(goal, 'max_iterations_exceeded');
        const harvestedResponse = this.harvestCompletedWork(inProgress, 'max_iterations_exceeded');
        const hasContent = this.completedWork.size > 0;
        return this.createResult({
          success: hasContent,
          response: harvestedResponse,
          terminationReason: 'max_iterations_exceeded',
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
      // Each execution is wrapped in try-catch to preserve all results even if some fail
      const executions = Array.from(inProgress.entries()).map(async ([workId, { item, agent }]) => {
        try {
          const hookParams = item.params as {
            isInternalHook?: boolean;
            handler?: unknown;
            hookType?: unknown;
            event?: InternalHookEvent;
            hookContext?: InternalHookContext;
          } | undefined;
          const handler = hookParams?.handler;
          if (hookParams?.isInternalHook && typeof handler === 'function') {
            this.runHookHandler({
              handler: handler as () => Promise<void>,
              hookType: String(hookParams?.hookType ?? 'unknown'),
              workItemId: workId,
              event: hookParams?.event,
              hookContext: hookParams?.hookContext,
              contextWindow: context,
            });
            return {
              workId,
              item,
              result: {
                success: true,
                response: '',
                metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
                filesRead: [],
                invalidatedPaths: [],
                toolErrors: [],
                terminationReason: 'goal_state_reached',
                needsUserInput: false,
                isRefusal: false,
                localContext: context,
              } as AgentResult,
            };
          }

          if (!agent) {
            throw new Error(`Missing agent for work item: ${workId}`);
          }
          const agentAsyncId = profiler.asyncBegin(`agent:${item.agent}`, 'agent');
          const result = await agent.run({ globalContext: context, workItem: item, cwd });
          profiler.asyncEnd(`agent:${item.agent}`, agentAsyncId, 'agent', { llmCalls: result.metrics.llmCallsMade, toolCalls: result.metrics.toolCallsMade });
          return { workId, item, result };
        } catch (err) {
          // Construct synthetic failure result to preserve all results on Promise.all
          const errorResult: AgentResult = {
            success: false,
            response: '',
            error: err instanceof Error ? err.message : String(err),
            metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
            filesRead: [],
            invalidatedPaths: [],
            toolErrors: [],
            terminationReason: 'exception', // Agent-level reason for orchestrator-caught exception
            needsUserInput: false,
            isRefusal: false,
            localContext: context,
          };
          return { workId, item, result: errorResult };
        }
      });

      const results = await Promise.all(executions);

      // Process results and check for terminal conditions
      let terminalResult: OrchestratorResult | null = null;

      // Track initial work completion to defer return until after processing all results (race condition fix)
      let initialWorkCompleted = false;
      let initialWorkResponse = '';

      for (const { workId, item, result } of results) {
        const hookParams = item.params as { isInternalHook?: boolean } | undefined;
        if (hookParams?.isInternalHook) {
          this.completedWork.set(workId, result);
          inProgress.delete(workId);
          continue;
        }

        totalLlmCalls += result.metrics.llmCallsMade;
        totalToolCalls += result.metrics.toolCallsMade;

        // Merge token metrics (use totalOutputTokens for cumulative count across all LLM calls in this run)
        const localMetrics = result.localContext.metrics;
        context.updateMetrics(localMetrics.inputTokens, localMetrics.totalOutputTokens, localMetrics.cachedTokens);

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
          const checkResult = await this.checkTerminationConditions({
            result,
            workId,
            item,
            iteration,
            totalLlmCalls,
            totalToolCalls,
            now,
            startTime,
            context,
            agentType,
            inProgress,
            goal,
          });

          if (checkResult.terminal) {
            // Terminal condition hit
            terminalResult = checkResult.terminal;
            continue;
          }

          if (checkResult.shouldContinue) {
            // Stop hook blocked or interruption detected
            if (checkResult.newItem) {
              // Handle interruption or stop hook blocking
              this.enqueue(checkResult.newItem);
              // Reset completion tracking and duration timer for the new work
              initialWorkCompleted = false;
              initialWorkResponse = '';
              this.completedWork.delete(this.initialWorkId);
              this.initialWorkId = checkResult.newItem.workId;
              startTime = Date.now();
            }
            inProgress.delete(workId);
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

          // Track initial work completion (deferred until after processing all results)
          if (workId === this.initialWorkId) {
            initialWorkCompleted = true;
            initialWorkResponse = result.response;
          }
        } else {
          // Item needs more iterations - keep in progress, merge context
          context.addAgentResultContext(result);
        }
      }

      // Check if initial work completed after processing ALL results (fixes race condition in parallel execution)
      if (initialWorkCompleted && this.workQueue.length === 0 && inProgress.size === 0) {
        // Check for pending user interruption before terminating
        // This catches messages that arrived during execution but weren't seen by the agent
        if (this.config.checkInterruption?.()) {
          this.log('info', 'Pending interruption detected, continuing execution', { iteration });

          // Create new work item to continue - the interruption message is already in context
          const newItem = this.createWorkItem('Continue with user input', agentType);
          this.enqueue(newItem);

          // Reset completion tracking and duration timer for the new work
          initialWorkCompleted = false;
          initialWorkResponse = '';
          this.completedWork.delete(this.initialWorkId);
          this.initialWorkId = newItem.workId;
          startTime = Date.now(); // Reset duration timer on interruption

          continue;
        }

        // Execute per-request stop hook before terminating - allows Ralph Loop and similar patterns
        if (this.config.stopHook) {
          const stopContext = {
            workId: this.initialWorkId,
            response: initialWorkResponse,
            terminationReason: 'goal_state_reached' as TerminationReason,
            iteration,
            agentType,
            sessionKey: context.sessionKey,
          };

          try {
            const stopResult = await this.config.stopHook(stopContext);

            if (stopResult.decision === 'block' && stopResult.reason) {
              // Re-inject prompt and continue the loop
              this.log('info', 'Stop hook blocked termination, re-injecting prompt', {
                iteration,
                promptPreview: stopResult.reason.slice(0, 100),
              });

              // Emit progress event so TUI knows loop is continuing
              this.emit(createEvent('agent_progress', {
                kind: 'work',
                message: stopResult.systemMessage || `Stop hook continuing (iteration ${iteration})`,
                requestId: this.requestId,
              }));

              // Add system message if provided
              if (stopResult.systemMessage) {
                context.addMessage('system', stopResult.systemMessage);
              }

              // Create new work item with the injected prompt
              const newItem = this.createWorkItem(stopResult.reason, agentType);
              this.enqueue(newItem);

              // Reset completion tracking
              initialWorkCompleted = false;
              initialWorkResponse = '';
              this.completedWork.delete(this.initialWorkId);
              this.initialWorkId = newItem.workId;

              // Continue the loop
              continue;
            }
          } catch (err) {
            // Stop hook error should NOT crash the orchestrator - log and continue to termination
            this.log('error', 'Stop hook threw error on goal_state_reached', {
              error: err instanceof Error ? err.message : String(err),
              iteration,
            });
          }
        }

        this.emit(createEvent('goal_achieved', {
          goal,
          completed: this.completedWork.size,
          skipped: 0,
        }));
        return this.createResult({
          success: true,
          response: initialWorkResponse,
          terminationReason: 'goal_state_reached',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        });
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
   * Build LLM config from model selection + agent's operational params.
   * NO FALLBACK: If no model selection exists for this agent type, throws an error.
   * Users must explicitly select models for each agent type they want to use.
   *
   * Model selection (provider/model) comes from SessionStore - this is the SINGLE SOURCE OF TRUTH.
   * Operational params (maxTokens, temperature) come from AgentConfig.
   *
   * @param llmParams - Operational params from AgentConfig (maxTokens, temperature)
   * @param agentType - Agent type for model selection lookup
   * @returns Complete LLM config ready for use
   * @throws Error if no model selection exists for this agent type
   */
  private buildLlmConfig(
    llmParams: { maxTokens: number; temperature: number },
    agentType: string
  ): LLMRequestConfig {
    const modelSelection = this.getModelSelection?.(agentType);
    if (!modelSelection) {
      this.log('error', `No model selection for agent type '${agentType}'. User must select a model via /models.`, { agentType });
      throw new Error(`No model configured for agent type '${agentType}'. Please select a model using /models before using this agent.`);
    }

    return buildLLMRequestConfig(modelSelection, llmParams);
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
    // NO FALLBACK: If the requested agent type doesn't exist, fail explicitly
    if (!this.agentRegistry?.has(agentType)) return null;
    let config = this.agentRegistry.getConfig(agentType);

    // Apply plan mode modifications if enabled
    if (this.planModeOptions?.enabled) {
      config = {
        ...config,
        systemPrompt: config.systemPrompt + this.planModeOptions.promptAddendum,
        tools: this.planModeOptions.toolFilter(config.tools),
      };
    }

    // Build LLM config from model selection (source of truth) + agent's llmParams
    const llmConfig = this.buildLlmConfig(config.llmParams, agentType);

    // Merge hooks with shouldStop wired to checkStopRequest
    const mergedHooks = this.config.checkStopRequest
      ? { ...this.hooks, shouldStop: this.config.checkStopRequest }
      : this.hooks;

    return new Agent(config, {
      llm: this.llm,
      toolRegistry: this.toolRegistry,
      emit: this.emit,
      requestId: this.requestId,
      agentRegistry: this.agentRegistry,
      llmConfig,
      hooks: mergedHooks,
      internalHookQueue: this.hookQueue,
      getModelSelection: this.getModelSelection,
    });
  }

  private resolveCompactionLlmConfig(agentType: string): LLMRequestConfig | null {
    // For compaction, gracefully return null if no model selection - will use simple compaction
    if (!this.agentRegistry?.has(agentType)) return null;

    const modelSelection = this.getModelSelection?.(agentType);
    if (!modelSelection) {
      // No model selection - caller will use simple compaction instead
      return null;
    }

    const config = this.agentRegistry.getConfig(agentType);
    return buildLLMRequestConfig(modelSelection, config.llmParams);
  }

  private createWorkItem(goal: string, agentType: string): WorkItem {
    // Get agent's budget from registry, fallback to orchestrator config
    let agentBudget: { maxIterations: number; maxToolCalls: number; maxDurationMs: number } | undefined;
    try {
      agentBudget = this.agentRegistry?.getConfig(agentType)?.budget;
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
      handoffSpec: partial.handoffSpec,
      terminationReason: partial.terminationReason,
      metrics: partial.metrics,
    };
  }

  private log(level: keyof OrchestratorLogger, msg: string, meta?: Record<string, unknown>): void {
    this.logger?.[level](msg, { component: 'orchestrator', requestId: this.requestId, ...meta });
  }

  /**
   * Emit a goal_not_achieved event.
   */
  private emitGoalNotAchieved(goal: string, reason: string, failed = 0): void {
    this.emit(createEvent('goal_not_achieved', { goal, reason, completed: 0, failed, skipped: 0 }));
  }

  /**
   * Call stop hook and return its decision.
   * Returns null if no stop hook configured or if hook throws.
   */
  private async callStopHook(
    context: ContextWindow,
    terminationReason: TerminationReason,
    response: string,
    iteration: number,
    agentType: string
  ): Promise<import('agent').StopHookResult | null> {
    if (!this.config.stopHook) return null;

    try {
      return await this.config.stopHook({
        workId: this.initialWorkId,
        response,
        terminationReason,
        iteration,
        agentType,
        sessionKey: context.sessionKey,
      });
    } catch (err) {
      this.log('warning', 'Stop hook error', { error: String(err) });
      return null;
    }
  }

  /**
   * Handle stop hook "block" decision by re-injecting prompt and continuing.
   * Returns true if loop should continue, false if termination should proceed.
   */
  private handleStopHookBlock(
    stopResult: import('agent').StopHookResult | null,
    context: ContextWindow,
    agentType: string,
    iteration: number
  ): boolean {
    if (!stopResult || stopResult.decision !== 'block' || !stopResult.reason) {
      return false;
    }

    this.log('info', 'Stop hook blocked termination, re-injecting prompt', {
      iteration,
      promptPreview: stopResult.reason.slice(0, 100),
    });

    if (stopResult.systemMessage) {
      context.addMessage('system', stopResult.systemMessage);
    }

    const newItem = this.createWorkItem(stopResult.reason, agentType);
    this.enqueue(newItem);
    this.completedWork.delete(this.initialWorkId);
    this.initialWorkId = newItem.workId;

    return true;
  }

  /**
   * Harvest responses from completed work items and build a combined response.
   * Used when bounds are exceeded to return partial progress instead of empty.
   */
  private harvestCompletedWork(
    inProgress: Map<string, { item: WorkItem; agent: Agent | null }>,
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

  /**
   * Check all termination conditions for a single agent result.
   *
   * This method encapsulates the state machine logic for determining whether
   * execution should stop or continue based on the agent's result.
   *
   * @param params - Check parameters including the agent result and execution context
   * @returns TerminationCheckResult indicating what should happen next
   */
  private async checkTerminationConditions(params: {
    result: AgentResult;
    workId: string;
    item: WorkItem;
    iteration: number;
    totalLlmCalls: number;
    totalToolCalls: number;
    now: number;
    startTime: number;
    context: ContextWindow;
    agentType: string;
    inProgress: Map<string, { item: WorkItem; agent: Agent | null }>;
    goal: string;
  }): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, totalLlmCalls, totalToolCalls, now, startTime, context, agentType, goal } = params;

    // Extract structured output early for use in multiple checks
    const structured = result.structuredOutput as { action?: string; goalStateReached?: boolean } | undefined;
    const actionIsContinue = structured?.action === 'continue';

    // ============================================================
    // TERMINAL: User input needed (via PromptUser tool)
    // ============================================================
    if (result.needsUserInput && result.userPrompt) {
      // Check for interruption - user message takes precedence over agent's question
      if (this.config.checkInterruption?.()) {
        this.log('info', 'Interruption preempts user prompt request', { iteration, workId });
        context.addAgentResultContext(result);
        return {
          terminal: null,
          shouldContinue: true,
          newItem: this.createWorkItem('Continue with user input', agentType),
        };
      }
      this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question, questionType: result.userPrompt.questionType });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, 'user_input_required', result.response ?? '', iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response ?? '',
          paused: true,
          userPrompt: result.userPrompt,
          handoffSpec: result.handoffSpec,
          terminationReason: 'user_input_required',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: Handoff requested
    // ============================================================
    if (result.needsHandoff && result.handoffSpec) {
      // Check for interruption - user message takes precedence over handoff
      if (this.config.checkInterruption?.()) {
        this.log('info', 'Interruption preempts handoff request', { iteration, workId });
        context.addAgentResultContext(result);
        return {
          terminal: null,
          shouldContinue: true,
          newItem: this.createWorkItem('Continue with user input', agentType),
        };
      }
      this.log('info', 'Handoff requested - executing with spec', { workId, specLength: result.handoffSpec.length });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, 'handoff_requested', result.response ?? '', iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: true,
          response: result.response ?? 'Planning complete. Ready to execute.',
          paused: true,
          handoffSpec: result.handoffSpec,
          terminationReason: 'handoff_requested',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: Refusal
    // ============================================================
    if (result.isRefusal) {
      this.log('warning', 'Agent refused', { workId, response: result.response });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, 'refusal', result.response, iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      this.emitGoalNotAchieved(goal, 'refusal', 1);
      return {
        terminal: this.createResult({
          success: false,
          response: result.response,
          error: result.response,
          terminationReason: 'refusal',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: User stopped (explicit "stop" from user)
    // ============================================================
    if (result.terminationReason === 'user_stopped') {
      this.log('info', 'User stopped execution', { workId });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, 'user_stopped', result.response || '', iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response || 'Execution stopped by user.',
          terminationReason: 'user_stopped',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // CONTINUABLE ERRORS: no_action, invalid_action, stagnation
    // These are recoverable issues where Ralph Loop can retry with hints
    // ============================================================
    const isContinuableError = result.terminationReason === 'no_action' ||
                               result.terminationReason === 'invalid_action' ||
                               result.terminationReason === 'stagnation:tool_repeat';
    if (isContinuableError) {
      const reason = result.terminationReason!;
      this.log('warning', `Agent ${reason}`, { workId, error: result.error });
      context.addAgentResultContext(result);

      // Check stop hook - Ralph Loop can continue on these
      if (this.config.stopHook) {
        try {
          const stopResult = await this.config.stopHook({
            workId,
            response: result.response,
            terminationReason: reason,
            iteration,
            agentType,
            sessionKey: context.sessionKey,
          });
          if (stopResult.decision === 'block' && stopResult.reason) {
            this.log('info', `Stop hook blocked termination on ${reason}, re-injecting prompt`, {
              iteration,
              promptPreview: stopResult.reason.slice(0, 100),
            });

            this.emit(createEvent('agent_progress', {
              kind: 'work',
              message: stopResult.systemMessage || `Stop hook continuing on ${reason} (iteration ${iteration})`,
              requestId: this.requestId,
            }));

            if (stopResult.systemMessage) {
              context.addMessage('system', stopResult.systemMessage);
            }

            return {
              terminal: null,
              shouldContinue: true,
              newItem: this.createWorkItem(stopResult.reason, agentType),
            };
          }
        } catch (err) {
          this.log('error', `Stop hook threw error on ${reason}`, {
            error: err instanceof Error ? err.message : String(err),
            iteration,
          });
        }
      }

      // No stop hook or hook allowed termination - map to appropriate orchestrator reason
      const orchReason = reason === 'stagnation:tool_repeat' ? 'agent_error' : reason;
      this.emitGoalNotAchieved(goal, result.error || reason, 1);
      return {
        terminal: this.createResult({
          success: false,
          response: result.response,
          error: result.error || reason,
          terminationReason: orchReason as TerminationReason,
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // AGENT BOUNDS EXCEEDED: Map agent-level bounds to orchestrator-level
    // ============================================================
    if (result.terminationReason === 'iterations_exhausted' ||
        result.terminationReason === 'bounds:tool_calls' ||
        result.terminationReason === 'bounds:duration') {
      const orchReason = result.terminationReason === 'iterations_exhausted' ? 'max_iterations_exceeded'
        : result.terminationReason === 'bounds:tool_calls' ? 'max_tool_calls_exceeded'
        : 'max_duration_exceeded';
      this.log('warning', `Agent bounds exceeded: ${result.terminationReason}`, { workId });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, orchReason, result.response, iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: !!result.response,
          response: result.response || `Agent terminated: ${result.terminationReason}`,
          terminationReason: orchReason,
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: rate_limit, circuit_open - transient errors that must stop
    // ============================================================
    if (result.terminationReason === 'rate_limit' || result.terminationReason === 'circuit_open') {
      this.log('warning', `Agent ${result.terminationReason}`, { workId });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, result.terminationReason, result.response, iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response || `Execution stopped: ${result.terminationReason}`,
          error: result.terminationReason,
          terminationReason: result.terminationReason,
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: exception - agent caught an unexpected error
    // ============================================================
    if (result.terminationReason === 'exception') {
      this.log('error', 'Agent exception', { workId, error: result.error });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, 'agent_error', result.response, iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      this.emitGoalNotAchieved(goal, result.error || 'exception', 1);
      return {
        terminal: this.createResult({
          success: false,
          response: result.response,
          error: result.error || 'Agent encountered an unexpected exception',
          terminationReason: 'agent_error',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: Hard error (catch-all for error + !success cases)
    // ============================================================
    if (result.error && !result.success && !actionIsContinue) {
      this.log('error', 'Agent error', { workId, error: result.error, terminationReason: result.terminationReason });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, 'agent_error', result.response, iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      this.emitGoalNotAchieved(goal, result.error, 1);
      return {
        terminal: this.createResult({
          success: false,
          response: result.response,
          error: result.error,
          terminationReason: 'agent_error',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // BOUND CHECK: Total tool calls
    // ============================================================
    if (totalToolCalls >= this.config.maxToolCalls) {
      this.log('warning', 'Max tool calls exceeded', { totalToolCalls, completedWork: this.completedWork.size });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, 'max_tool_calls_exceeded', result.response, iteration, agentType);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration)) {
        return { terminal: null, shouldContinue: true };
      }
      this.emitGoalNotAchieved(goal, 'max_tool_calls_exceeded');
      const response = result.response || this.harvestCompletedWork(params.inProgress, 'max_tool_calls_exceeded');
      const hasContent = !!result.response || this.completedWork.size > 0;
      return {
        terminal: this.createResult({
          success: hasContent,
          response,
          terminationReason: 'max_tool_calls_exceeded',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // No terminal condition - execution should continue
    return { terminal: null, shouldContinue: false };
  }
}
