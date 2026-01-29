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
  AgentCadenceMetrics,
  AgentCadenceResult,
  InternalHookEvent,
  InternalHookContext,
  InternalHookQueue,
  ModelSelection,
  ExecutionSnapshot,
  MemoryInjector,
} from 'agent';
import { Agent, getAsyncAgentPrompt, getAsyncModeAddendum } from 'agent';
import type { AgentRegistry } from 'agent';
import { createWorkItem, type WorkItem } from 'work';
import { createEvent } from 'types';
import type { LLMRequestConfig } from 'types';
import { buildLLMRequestConfig, type OrchestratorTerminationReason, profiler } from 'shared';
import { executeHooks, type StopHookHandler } from './hooks.js';
import { BoundsChecker } from './bounds-checker.js';
import type {
  DecisionDatabase,
  DecisionWatcherConfig,
} from 'decision-watcher';

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
  /**
   * Async mode configuration for decision watcher.
   * When enabled, the watcher will automatically answer PromptUser questions
   * using a curated decision and preference database.
   */
  asyncMode?: {
    /** Whether async mode is enabled */
    enabled: boolean;
    /** Decision database for async mode */
    database?: DecisionDatabase;
    /** Optional custom watcher configuration */
    watcherConfig?: Partial<DecisionWatcherConfig>;
  };
  /**
   * Optional memory injector for injecting relevant memory into agent context.
   * When provided, the orchestrator passes it to agents for automatic memory retrieval.
   */
  memoryInjector?: MemoryInjector;
}

/**
 * Per-execution runtime hooks and callbacks.
 */
/**
 * State passed to the onIteration callback for watcher evaluation.
 */
export interface IterationState {
  iteration: number;
  context: ContextWindow;
  totalToolCalls: number;
  totalLlmCalls: number;
  elapsedMs: number;
}

export interface OrchestratorRuntime {
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
  /**
   * Optional lifecycle hook for wiring external subscriptions.
   * Return a cleanup function to run when execution ends.
   */
  onStart?: (context: ContextWindow) => void | (() => void);
  /**
   * Called each iteration with execution state.
   * Used by the watcher to evaluate rules and steer the decision engine.
   * May be sync or async — if async, the orchestrator does not await it
   * (fire-and-forget to avoid blocking the loop).
   */
  onIteration?: (state: IterationState) => void;
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
  /** Work item to re-enqueue (for plan revision) */
  itemToRequeue?: WorkItem;
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
    cwd: string,
    runtime?: OrchestratorRuntime
  ): Promise<OrchestratorResult> {
    const cleanup = runtime?.onStart?.(context);
    try {
      return await this.executeInner(context, goal, agentType, cwd, runtime);
    } finally {
      if (typeof cleanup === 'function') {
        cleanup();
      }
    }
  }

  /**
   * Inner execution logic, wrapped by execute() for cleanup.
   */
  private async executeInner(
    context: ContextWindow,
    goal: string,
    agentType: string,
    cwd: string,
    runtime?: OrchestratorRuntime
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

    // Cadence audit: periodic watcher check every 60 seconds (secondary safety net)
    const CADENCE_AUDIT_INTERVAL_MS = 60 * 1000;
    let lastCadenceAuditMs = Date.now();
    let lastAgentResult: AgentResult | undefined;

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
        const agent = this.createAgent(item.agent, context.sessionKey, runtime);
        if (!agent) {
          // Mark as failed with synthetic error
          const errorResult = this.createErrorResult(`Unknown agent type: ${item.agent}`, context);
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

      // Watcher evaluation — fire-and-forget, does not block the loop
      runtime?.onIteration?.({ iteration, context, totalToolCalls, totalLlmCalls, elapsedMs: elapsed });

      // AUTO-COMPACT with hysteresis
      const percentUsed = context.metrics.percentageUsed;
      if (percentUsed < this.config.compactResetPercent) {
        compactedRecently = false;
      }
      if (!compactedRecently && percentUsed >= this.config.compactTriggerPercent) {
        const compactAsyncId = profiler.asyncBegin('orch.compact', 'orchestrator');
        const llmConfig = this.resolveCompactionLlmConfig(agentType);
        let compactResult;
        const compactionConfig = this.getCompactionConfig();
        if (llmConfig) {
          try {
            compactResult = await context.compactWithLedger({
              llm: this.llm,
              llmConfig,
              targetReductionRatio: 0.66,
              preserveRecentItems: 12,
              ...compactionConfig,
            });
          } catch {
            compactResult = context.compact(compactionConfig);
          }
        } else {
          compactResult = context.compact(compactionConfig);
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
        const stopResult = await this.callStopHook(context, 'max_iterations_exceeded', '', iteration, agentType, runtime);
        if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'max_iterations_exceeded')) {
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
          const error = err instanceof Error ? err.message : String(err);
          return { workId, item, result: this.createErrorResult(error, context) };
        }
      });

      const results = await Promise.all(executions);

      // Process results and check for terminal conditions
      let terminalResult: OrchestratorResult | null = null;

      // Track initial work completion to defer return until after processing all results (race condition fix)
      let initialWorkCompleted = false;
      let initialWorkResponse = '';
      let initialWorkResult: AgentResult | undefined;

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
            runtime,
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
              this.resetWorkTracking(checkResult.newItem);
              startTime = Date.now();
            }
            if (checkResult.itemToRequeue) {
              // Re-enqueue the work item for plan revision
              this.enqueue(checkResult.itemToRequeue);
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
            initialWorkResult = result;
          }
        } else {
          // Item needs more iterations - keep in progress, merge context
          context.addAgentResultContext(result);
        }

        // Track latest agent result for cadence audit
        lastAgentResult = result;
      }

      // Cadence audit: every 60 seconds, invoke stop hook for oversight check
      const cadenceNow = Date.now();
      if (cadenceNow - lastCadenceAuditMs >= CADENCE_AUDIT_INTERVAL_MS && runtime?.stopHook) {
        lastCadenceAuditMs = cadenceNow;
        const cadenceResult = await this.callStopHook(
          context, 'cadence_audit' as TerminationReason, '', iteration, agentType, runtime, undefined, lastAgentResult
        );
        if (cadenceResult) {
          this.enqueueDeferredWork(cadenceResult);

          // Inject watcher guidance even on 'allow' - makes cadence audits actually do something
          if (cadenceResult.systemMessage && cadenceResult.decision === 'allow') {
            context.addMessage('system', cadenceResult.systemMessage);
          }

          if (cadenceResult.decision === 'block' && cadenceResult.reason) {
            // Watcher wants to realign — inject new work item
            if (cadenceResult.systemMessage) {
              context.addMessage('system', cadenceResult.systemMessage);
            }
            const realignItem = this.createWorkItem(cadenceResult.reason, agentType);
            this.enqueue(realignItem);
          }
        }
      }

      // Check if initial work completed after processing ALL results (fixes race condition in parallel execution)
      if (initialWorkCompleted && this.workQueue.length === 0 && inProgress.size === 0) {
        // Check for pending user interruption before terminating
        // This catches messages that arrived during execution but weren't seen by the agent
        if (runtime?.checkInterruption?.()) {
          this.log('info', 'Pending interruption detected, continuing execution', { iteration });

          // Create new work item to continue - the interruption message is already in context
          const newItem = this.createWorkItem('Continue with user input', agentType);
          this.enqueue(newItem);

          // Reset completion tracking and duration timer for the new work
          initialWorkCompleted = false;
          initialWorkResponse = '';
          this.resetWorkTracking(newItem);
          startTime = Date.now(); // Reset duration timer on interruption

          continue;
        }

        // Execute per-request stop hook before terminating - allows Ralph Loop and similar patterns
        if (runtime?.stopHook) {
          const stopContext = {
            workId: this.initialWorkId,
            response: initialWorkResponse,
            terminationReason: 'goal_state_reached' as TerminationReason,
            iteration,
            agentType,
            sessionKey: context.sessionKey,
            executionSnapshot: initialWorkResult ? this.buildExecutionSnapshot(initialWorkResult, context) : undefined,
          };

          try {
            const stopResult = await runtime.stopHook(stopContext);

            // Enqueue any deferred work regardless of decision
            this.enqueueDeferredWork(stopResult);

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
              initialWorkResult = undefined;
              this.resetWorkTracking(newItem);

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

  private createAgent(agentType: string, sessionKey: string, runtime?: OrchestratorRuntime): Agent | null {
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

    // Apply async mode addendum to worker agents (not the watcher itself)
    if (this.config.asyncMode?.enabled && agentType !== 'watcher') {
      config = {
        ...config,
        systemPrompt:  getAsyncAgentPrompt(),
      };
    }

    // Build LLM config from model selection (source of truth) + agent's llmParams
    const llmConfig = this.buildLlmConfig(config.llmParams, agentType);

    // Wire cadence check: invokes watcher stopHook at tool-call thresholds for real oversight.
    // Fires every 30 tool calls OR every 2 minutes, whichever comes first.
    // This gives the watcher real intervention power during execution.
    let lastCadenceToolCalls = 0;
    let lastCadenceTimeMs = Date.now();
    const CADENCE_TOOL_THRESHOLD = 30;  // Every 30 tool calls
    const CADENCE_TIME_THRESHOLD_MS = 120_000;  // Every 2 minutes

    const cadenceCheck = async (metrics: AgentCadenceMetrics): Promise<AgentCadenceResult> => {
      // Check for user/system stop request
      if (runtime?.checkStopRequest?.()) {
        return { action: 'stop', systemMessage: 'Stop requested during agent execution.' };
      }

      const toolCallsSinceLast = metrics.toolCallsMade - lastCadenceToolCalls;
      const timeSinceLast = Date.now() - lastCadenceTimeMs;
      const shouldInvokeWatcher = runtime?.stopHook && (
        toolCallsSinceLast >= CADENCE_TOOL_THRESHOLD ||
        timeSinceLast >= CADENCE_TIME_THRESHOLD_MS
      );

      if (shouldInvokeWatcher && runtime?.stopHook) {
        lastCadenceToolCalls = metrics.toolCallsMade;
        lastCadenceTimeMs = Date.now();

        try {
          const stopResult = await runtime.stopHook({
            workId: this.initialWorkId,
            response: '',
            terminationReason: 'cadence_audit',
            iteration: metrics.llmCallsMade,
            agentType,
            sessionKey,
          });

          // If watcher says block with reason, stop the agent
          if (stopResult.decision === 'block' && stopResult.reason) {
            return {
              action: 'stop',
              systemMessage: stopResult.systemMessage ?? `[Watcher intervention]: ${stopResult.reason}`,
            };
          }

          // If watcher has guidance, inject it
          if (stopResult.systemMessage) {
            return {
              action: 'inject',
              systemMessage: stopResult.systemMessage,
            };
          }
        } catch (err) {
          // Don't crash on watcher failure - log and continue
          this.log('warning', 'Cadence check watcher invocation failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Metric-based guardrail: if duration exceeds 5 minutes, inject a refocus nudge
      if (metrics.durationMs > 300_000) {
        return {
          action: 'inject',
          systemMessage: `[System] You have been running for ${Math.round(metrics.durationMs / 60_000)} minutes with ${metrics.toolCallsMade} tool calls. Stay focused on the current objective. If you are stuck, wrap up with what you have.`,
        };
      }

      return { action: 'continue' };
    };

    // Merge hooks: shouldStop for user interruption, cadenceCheck for watcher oversight
    const mergedHooks: AgentHooks = {
      ...this.hooks,
      ...(runtime?.checkStopRequest ? { shouldStop: runtime.checkStopRequest } : {}),
      cadenceCheck,
    };

    return new Agent(config, {
      llm: this.llm,
      toolRegistry: this.toolRegistry,
      emit: this.emit,
      requestId: this.requestId,
      sessionKey,
      agentRegistry: this.agentRegistry,
      llmConfig,
      hooks: mergedHooks,
      internalHookQueue: this.hookQueue,
      getModelSelection: this.getModelSelection,
      memoryInjector: this.config.memoryInjector,
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

  // --- Helper methods for code deduplication ---

  /**
   * Create a synthetic error result when agent fails to execute.
   */
  private createErrorResult(error: string, context: ContextWindow): AgentResult {
    return {
      success: false,
      response: '',
      error,
      metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
      filesRead: [],
      invalidatedPaths: [],
      toolErrors: [],
      terminationReason: 'exception',
      needsUserInput: false,
      isRefusal: false,
      localContext: context,
    };
  }

  /**
   * Reset work tracking for continuation after interruption or stop hook block.
   */
  private resetWorkTracking(newItem: WorkItem): void {
    this.completedWork.delete(this.initialWorkId);
    this.initialWorkId = newItem.workId;
  }

  /**
   * Check for and handle user interruption. Returns true if interruption was handled.
   */
  private handleInterruption(
    context: ContextWindow,
    agentType: string,
    iteration: number,
    runtime?: OrchestratorRuntime
  ): WorkItem | null {
    if (!runtime?.checkInterruption?.()) {
      return null;
    }
    const newItem = this.createWorkItem('Continue with user input', agentType);
    this.enqueue(newItem);
    this.resetWorkTracking(newItem);
    return newItem;
  }

  /**
   * Create TerminationCheckResult for interruption continuation.
   */
  private createInterruptionResult(agentType: string): TerminationCheckResult {
    return {
      terminal: null,
      shouldContinue: true,
      newItem: this.createWorkItem('Continue with user input', agentType),
    };
  }

  /**
   * Get base compaction configuration shared between ledger and simple compaction.
   */
  private getCompactionConfig() {
    return {
      deduplicateByPath: true,
      maxFileContentCount: this.config.compactMaxFileCount,
      truncateOutputsTo: this.config.compactTruncateTo,
    };
  }

  /**
   * Build an ExecutionSnapshot from an AgentResult and context metrics.
   * Provides enriched data for stop hook evaluation.
   */
  private buildExecutionSnapshot(result: AgentResult, context: ContextWindow): ExecutionSnapshot {
    // Extract tool history from localContext items (function_call + function_call_output pairs)
    const toolHistory: ExecutionSnapshot['toolHistory'] = [];
    const items = result.localContext.items;
    for (let i = 0; i < items.length && toolHistory.length < 20; i++) {
      const item = items[i];
      if (item.type === 'function_call') {
        const name = item.name;
        const args = item.arguments;
        // Look for matching output
        let success = true;
        let durationMs = 0;
        let outputPreview: string | undefined;
        for (let j = i + 1; j < items.length; j++) {
          const out = items[j];
          if (out.type === 'function_call_output' && out.callId === item.callId) {
            success = !out.isError;
            durationMs = out.durationMs ?? 0;
            if (out.output) {
              outputPreview = out.output.length > 500 ? out.output.slice(0, 500) : out.output;
            }
            break;
          }
        }
        toolHistory.push({ name, args, success, durationMs, outputPreview });
      }
    }

    const contextMetrics = context.metrics;

    return {
      toolHistory,
      filesModified: result.invalidatedPaths,
      filesRead: result.filesRead,
      metrics: {
        llmCallsMade: result.metrics.llmCallsMade,
        toolCallsMade: result.metrics.toolCallsMade,
        toolCallsSucceeded: result.metrics.toolCallsSucceeded,
        toolCallsFailed: result.metrics.toolCallsFailed,
        durationMs: result.metrics.durationMs,
        inputTokens: contextMetrics.inputTokens,
        outputTokens: contextMetrics.totalOutputTokens,
        contextPercentUsed: contextMetrics.percentageUsed,
      },
      artifacts: result.artifacts?.map(a => ({
        sourcePath: a.sourcePath,
        name: a.name,
        kind: a.kind,
        insight: a.insight,
      })),
      fullResponse: result.response,
    };
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
    agentType: string,
    runtime?: OrchestratorRuntime,
    userPrompt?: UserPromptInfo,
    agentResult?: AgentResult
  ): Promise<import('agent').StopHookResult | null> {
    if (!runtime?.stopHook) return null;

    try {
      return await runtime.stopHook({
        workId: this.initialWorkId,
        response,
        terminationReason,
        iteration,
        agentType,
        sessionKey: context.sessionKey,
        userPrompt: userPrompt ? {
          question: userPrompt.question,
          options: userPrompt.options,
          context: userPrompt.context,
          multiSelect: userPrompt.multiSelect,
          questionType: userPrompt.questionType,
        } : undefined,
        executionSnapshot: agentResult ? this.buildExecutionSnapshot(agentResult, context) : undefined,
        handoffSpec: agentResult?.handoffSpec,
      });
    } catch (err) {
      this.log('warning', 'Stop hook error', { error: String(err) });
      return null;
    }
  }

  /**
   * Handle stop hook "block" decision by re-injecting prompt and continuing.
   * Also enqueues any deferred work items from the stop hook result.
   * Returns true if loop should continue, false if termination should proceed.
   *
   * @param stopResult - The stop hook result
   * @param context - The context window
   * @param agentType - The agent type
   * @param iteration - Current iteration number
   * @param terminationReason - The reason for termination (used to differentiate handling)
   */
  private handleStopHookBlock(
    stopResult: import('agent').StopHookResult | null,
    context: ContextWindow,
    agentType: string,
    iteration: number,
    terminationReason?: TerminationReason
  ): boolean {
    if (!stopResult) return false;

    // Enqueue deferred work regardless of decision (block or allow)
    this.enqueueDeferredWork(stopResult);

    if (stopResult.decision !== 'block' || !stopResult.reason) {
      return false;
    }

    this.log('info', 'Stop hook blocked termination, re-injecting prompt', {
      iteration,
      terminationReason,
      promptPreview: stopResult.reason.slice(0, 100),
    });

    // For user_input_required: the watcher answered the question.
    // Inject the answer as a USER message (simulating user response),
    // not as a new goal. This preserves the conversational flow.
    if (terminationReason === 'user_input_required') {
      if (stopResult.systemMessage) {
        context.addMessage('system', stopResult.systemMessage);
      }
      // The watcher's answer goes as a user message (like a human would respond)
      context.addMessage('user', stopResult.reason);
      // Continue with a generic goal - the answer is now in context
      const newItem = this.createWorkItem('Continue with the provided answer', agentType);
      this.enqueue(newItem);
      this.completedWork.delete(this.initialWorkId);
      this.initialWorkId = newItem.workId;
      return true;
    }

    // For handoff_requested: the watcher rejected the plan.
    // Inject the rejection message into context so the planner can revise.
    // Re-enqueue the work item so it can execute again with fresh agent state.
    if (terminationReason === 'handoff_requested') {
      if (stopResult.systemMessage) {
        context.addMessage('system', stopResult.systemMessage);
      }
      // The rejection goes as a user message
      context.addMessage('user', stopResult.reason);
      // Re-enqueue the work item (do NOT create a new one or reset initialWorkId)
      // The planner will revise the plan on the same work item
      return true;
    }

    // Default handling for other termination reasons (Ralph Loop, bounds exceeded, etc.)
    // The reason becomes the new work item's goal
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
   * Enqueue deferred work items from a stop hook result.
   * These are fire-and-forget work items that don't block the current decision.
   * When bounds are specified by the watcher, they override agent registry defaults.
   */
  private enqueueDeferredWork(stopResult: import('agent').StopHookResult): void {
    if (!stopResult.deferredWork?.length) return;

    for (const work of stopResult.deferredWork) {
      this.log('info', 'Enqueueing deferred work from stop hook', {
        objective: work.objective.slice(0, 100),
        agent: work.agent,
        hasBounds: !!work.bounds,
      });

      let item: WorkItem;
      if (work.bounds) {
        // Watcher-specified bounds override agent registry defaults
        item = createWorkItem({
          goal: work.goal ?? work.objective,
          objective: work.objective,
          agent: work.agent,
          dependencies: work.dependencies,
          targetPaths: work.targetPaths,
          bounds: {
            maxToolCalls: work.bounds.maxToolCalls ?? this.config.maxToolCalls,
            maxLlmCalls: work.bounds.maxLlmCalls ?? this.config.maxIterations,
            maxDurationMs: work.bounds.maxDurationMs ?? this.config.maxDurationMs,
          },
        });
      } else {
        item = this.createWorkItem(work.objective, work.agent);
      }
      this.enqueue(item);
    }
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
    runtime?: OrchestratorRuntime;
  }): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, totalLlmCalls, totalToolCalls, now, startTime, context, agentType, goal, runtime } = params;

    // Extract structured output early for use in multiple checks
    const structured = result.structuredOutput as { action?: string; goalStateReached?: boolean } | undefined;
    const actionIsContinue = structured?.action === 'continue';

    // ============================================================
    // TERMINAL: User input needed (via PromptUser tool)
    // ============================================================
    if (result.needsUserInput && result.userPrompt) {
      // Check for interruption - user message takes precedence over agent's question
      if (runtime?.checkInterruption?.()) {
        this.log('info', 'Interruption preempts user prompt request', { iteration, workId });
        context.addAgentResultContext(result);
        return this.createInterruptionResult(agentType);
      }
      this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question, questionType: result.userPrompt.questionType });
      context.addAgentResultContext(result);
      const stopResult = await this.callStopHook(context, 'user_input_required', result.response ?? '', iteration, agentType, runtime, result.userPrompt, result);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'user_input_required')) {
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
      if (runtime?.checkInterruption?.()) {
        this.log('info', 'Interruption preempts handoff request', { iteration, workId });
        context.addAgentResultContext(result);
        return this.createInterruptionResult(agentType);
      }
      this.log('info', 'Handoff requested - checking approval', { workId, specLength: result.handoffSpec.length });
      context.addAgentResultContext(result);

      // Call stop hook for approval (watcher in async mode, or no-op in sync mode)
      const stopResult = await this.callStopHook(context, 'handoff_requested', result.response ?? '', iteration, agentType, runtime, undefined, result);

      // If stop hook blocks, the watcher rejected the plan - planner should revise
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'handoff_requested')) {
        // Re-enqueue the same work item so the planner can revise
        return { terminal: null, shouldContinue: true, itemToRequeue: item };
      }

      // Stop hook allowed - check if watcher approved (has stop hook registered)
      // If a stop hook is registered and returned 'allow', the watcher approved the plan
      // Parse the spec and enqueue work items
      if (stopResult && stopResult.decision === 'allow') {
        const workItems = this.parseHandoffSpec(result.handoffSpec, goal);
        if (workItems.length > 0) {
          this.log('info', 'Handoff approved - enqueueing work items', {
            workId,
            itemCount: workItems.length,
            items: workItems.map(w => ({ id: w.workId, objective: w.objective.slice(0, 50) })),
          });
          for (const item of workItems) {
            this.enqueue(item);
          }
          // Continue the loop to execute the queued work
          return { terminal: null, shouldContinue: true };
        }
        // Empty spec or parse failed - log warning and pause for user
        this.log('warning', 'Handoff spec parse returned no work items', { workId });
      }

      // No stop hook or parse failed - pause for user approval (sync mode)
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
      const stopResult = await this.callStopHook(context, 'refusal', result.response, iteration, agentType, runtime, undefined, result);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'refusal')) {
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
      const stopResult = await this.callStopHook(context, 'user_stopped', result.response || '', iteration, agentType, runtime, undefined, result);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'user_stopped')) {
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
    // TERMINAL: Watcher stopped (mid-agent cadence check intervention)
    // ============================================================
    if (result.terminationReason === 'watcher_stopped') {
      this.log('info', 'Watcher stopped execution via cadence check', { workId });
      context.addAgentResultContext(result);
      return {
        terminal: this.createResult({
          success: !!result.response,
          response: result.response || 'Execution stopped by watcher.',
          terminationReason: 'watcher_stopped',
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
      if (runtime?.stopHook) {
        try {
          const stopResult = await runtime.stopHook({
            workId,
            response: result.response,
            terminationReason: reason,
            iteration,
            agentType,
            sessionKey: context.sessionKey,
            executionSnapshot: this.buildExecutionSnapshot(result, context),
          });

          // Enqueue any deferred work regardless of decision
          this.enqueueDeferredWork(stopResult);

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
      const stopResult = await this.callStopHook(context, orchReason, result.response, iteration, agentType, runtime, undefined, result);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, orchReason)) {
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
      const stopResult = await this.callStopHook(context, result.terminationReason, result.response, iteration, agentType, runtime, undefined, result);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, result.terminationReason as TerminationReason)) {
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
      const stopResult = await this.callStopHook(context, 'agent_error', result.response, iteration, agentType, runtime, undefined, result);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'agent_error')) {
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
      const stopResult = await this.callStopHook(context, 'agent_error', result.response, iteration, agentType, runtime, undefined, result);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'agent_error')) {
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
      const stopResult = await this.callStopHook(context, 'max_tool_calls_exceeded', result.response, iteration, agentType, runtime, undefined, result);
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'max_tool_calls_exceeded')) {
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

  /**
   * Parse a handoffSpec JSON string into WorkItems.
   * Returns empty array on parse failure.
   */
  private parseHandoffSpec(spec: string, sessionGoal: string): WorkItem[] {
    try {
      const parsed = JSON.parse(spec) as {
        goal?: string;
        context?: string;
        workItems?: Array<{
          id?: string;
          objective: string;
          delta?: string;
          agent?: string;
          domain?: string;
          dependencies?: string[];
          targetPaths?: string[];
        }>;
      };

      if (!parsed.workItems || !Array.isArray(parsed.workItems)) {
        this.log('warning', 'Handoff spec missing workItems array', { spec: spec.slice(0, 200) });
        return [];
      }

      const planGoal = parsed.goal ?? sessionGoal;

      return parsed.workItems.map((item, index) => createWorkItem({
        goal: planGoal,
        objective: item.objective,
        delta: item.delta,
        agent: item.agent ?? 'standard',
        domain: item.domain,
        dependencies: item.dependencies ?? [],
        targetPaths: item.targetPaths ?? [],
        stepNum: index + 1,
      }));
    } catch (err) {
      this.log('error', 'Failed to parse handoff spec', {
        error: err instanceof Error ? err.message : String(err),
        specPreview: spec.slice(0, 200),
      });
      return [];
    }
  }
}
