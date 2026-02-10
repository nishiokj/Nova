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
  MemoryInjector,
} from 'agent';
import { Agent, getAsyncAgentPrompt, getAsyncModeAddendum } from 'agent';
import type { AgentRegistry } from 'agent';
import { createWorkItem, cloneWorkItemWithDependencies, type WorkItem } from 'work';
import { createEvent } from 'types';
import type { LLMRequestConfig, MessageItem } from 'types';
import { buildLLMRequestConfig, coerceStructuredOutput, profiler } from 'shared';
import {
  assertNever,
  createAgentErrorEvent,
  createBoundsExceededEvent,
  createCadenceAuditEvent,
  createGoalReachedEvent,
  createHandoffRequestedEvent,
  createWorkItemCompletedEvent,
  createUserInputRequiredEvent,
  type ControlEventType,
  type DecisionFor,
  type AgentErrorDecision,
  type BoundsDecision,
  type CadenceDecision,
  type ControlEvent,
  type EventFor,
  type ExecutionMetrics,
  type HandoffSpec,
  type HandoffDecision,
  type HookContext,
  type PromptAnswerDecision,
  type QualityGateDecision,
  type StatePatch,
  type StopHookResult,
  type WorkItemCompletedDecision,
  type TerminationReason,
} from 'protocol';
import { applyPatches } from './hookRunner/applyPatches.js';
import { runHooksForEvent, type HookExecutionResult } from './hookRunner/runHooksForEvent.js';
import type { HookRegistry } from './hookRegistry/index.js';
import {
  mapQualityDecisionToStopResult,
  mapBoundsDecisionToStopResult,
  mapPromptDecisionToStopResult,
  mapCadenceDecisionToStopResult,
  mapAgentErrorDecisionToStopResult,
  mapHandoffDecisionToStopResult,
  mapWorkItemDecisionToStopResult,
} from './decision_mappers.js';
import { createExecutionState, getElapsedMs, nextIteration, updateMetrics, type ExecutionState } from './execution_state.js';
import { buildPlanContextFromHandoff, writePlanContext } from './plan-context.js';

// --- Types ---

/**
 * Structural async-mode DB contract.
 * Kept local so orchestrator can compile independently from decision-watcher.
 */
export interface AsyncDecisionDatabase {
  search(query: string, options?: {
    category?: string;
    scope?: string;
    limit?: number;
  }): Promise<unknown[]>;
  get(id: string): Promise<unknown | null>;
  getAll(): Promise<unknown[]>;
  upsert(entry: unknown): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Structural async-mode watcher config contract.
 * Kept local so orchestrator can compile independently from decision-watcher.
 */
export interface AsyncDecisionWatcherConfig {
  enabled: boolean;
  minConfidenceThreshold: number;
  maxDecisionsToConsult: number;
  useLLMSynthesis: boolean;
  enableConsistencyChecking: boolean;
  llm?: LLMAdapter;
  llmModel?: {
    provider: string;
    model: string;
  };
  customDatabase?: AsyncDecisionDatabase;
}

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
  /** Percent context usage that triggers compaction (default 0.50) */
  compactTriggerPercent: number;
  /** Percent context usage to reset compaction hysteresis (default 0.45) */
  compactResetPercent: number;
  /** Max file content items to keep during compaction */
  compactMaxFileCount: number;
  /** Max chars per tool output during compaction */
  compactTruncateTo: number;
  /** Minimum iteration gap between watcher evaluations (default 5) */
  minWatcherIterationGap: number;
  /** Maximum realign attempts before forcing termination (default 3) */
  maxRealigns: number;
  /**
   * Async mode configuration for decision watcher.
   * When enabled, the watcher will automatically answer PromptUser questions
   * using a curated decision and preference database.
   */
  asyncMode?: {
    /** Whether async mode is enabled */
    enabled: boolean;
    /** Decision database for async mode */
    database?: AsyncDecisionDatabase;
    /** Optional custom watcher configuration */
    watcherConfig?: Partial<AsyncDecisionWatcherConfig>;
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
  /** Control-plane hook registry (orchestrator-owned) */
  hookRegistry?: HookRegistry;
  /**
   * Legacy internal hook executor (harness-owned runtime path).
   * Orchestrator enqueues internal hook events and delegates execution to this callback.
   */
  executeLegacyHook?: (event: InternalHookEvent, context: InternalHookContext) => Promise<void>;
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
  compactTriggerPercent: 0.50,
  compactResetPercent: 0.45,
  compactMaxFileCount: 20,
  compactTruncateTo: 5000,
  minWatcherIterationGap: 5,
  maxRealigns: 3,
};

/**
 * Why orchestration terminated.
 * Re-exported from shared for backwards compatibility.
 */

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
  handoffSpec?: HandoffSpec;
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
  /** Whether execution should continue (hook blocked) */
  shouldContinue: boolean;
  /** New work item to enqueue (for hook blocking) */
  newItem?: WorkItem;
  /** Work item to re-enqueue (for plan revision) */
  itemToRequeue?: WorkItem;
};

interface WorkQueueAdapter {
  enqueue(item: WorkItem): string;
  dequeueAllReady(): WorkItem[];
  size(): number;
  hasPending(): boolean;
  clear(): void;
}

interface TerminationPolicy {
  checkIterationBounds(params: {
    state: ExecutionState;
    context: ContextWindow;
    agentType: string;
    runtime?: OrchestratorRuntime;
    goal: string;
    now: number;
  }): Promise<{ terminal: OrchestratorResult | null; shouldContinue: boolean }>;
  checkResult(params: {
    result: AgentResult;
    workId: string;
    item: WorkItem;
    state: ExecutionState;
    context: ContextWindow;
    agentType: string;
    runtime?: OrchestratorRuntime;
    goal: string;
    cwd: string;
    now: number;
  }): Promise<TerminationCheckResult>;
}

interface CadenceAuditor {
  trackResult(workId: string, result: AgentResult): void;
  maybeAudit(resultsByWorkId: Map<string, AgentResult>): Promise<void>;
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
  private getModelSelection?: (agentType: string) => ModelSelection | null;
  private hookQueue: InternalHookQueue;
  private activeSessionKey?: string;

  // Work queue state for DAG-based execution
  private workQueue: WorkItem[] = [];
  private completedWork: Map<string, AgentResult> = new Map();
  private initialWorkId: string = '';
  private workItemContexts: Map<string, ContextWindow> = new Map();
  private useFreshWorkItemContexts: boolean = false;
  private handoffBaseContext: ContextWindow | null = null;

  // Realign counter to prevent infinite loops when bounds are exceeded
  // After config.maxRealigns, we force termination instead of continuing
  private realignCount: number = 0;
  private hookMetadata: Map<string, unknown> = new Map();
  private hookAuditLog: Array<{ timestamp: number; source: string; event: string; details: Record<string, unknown> }> = [];
  private hookTerminationReason: TerminationReason | null = null;
  private legacyHookExecutor?: (event: InternalHookEvent, context: InternalHookContext) => Promise<void>;

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
  }

  /**
   * Enqueue a work item for processing.
   * Items with dependencies will wait until all dependencies are completed.
   *
   * @param item - The work item to enqueue
   * @param semantic - Optional semantic state to attach (flows through to workitem_created event)
   * @returns The work item's ID
   */
  enqueue(item: WorkItem, semantic?: unknown): string {
    this.workQueue.push(item);
    const hookParams = item.params as { isInternalHook?: boolean } | undefined;
    if (!hookParams?.isInternalHook && this.useFreshWorkItemContexts && !this.workItemContexts.has(item.workId)) {
      const seededContext = this.createFreshWorkItemContext();
      if (seededContext) {
        this.workItemContexts.set(item.workId, seededContext);
      }
    }
    if (!hookParams?.isInternalHook && this.activeSessionKey) {
      this.hookQueue.enqueue({
        type: 'workitem_created',
        objective: item.objective,
        agent: item.agent,
        domain: item.domain,
        dependencies: [...item.dependencies],
        targetPaths: [...item.targetPaths],
        semantic,
      }, {
        workId: item.workId,
        agentType: item.agent,
        sessionKey: this.activeSessionKey,
        requestId: this.requestId,
        objective: item.objective,
      });
    }
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
            handler: () => this.executeLegacyHook(event, context),
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

  private async executeLegacyHook(event: InternalHookEvent, context: InternalHookContext): Promise<void> {
    if (!this.legacyHookExecutor) {
      return;
    }
    await this.legacyHookExecutor(event, context);
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
    const cleanup = runtime?.onStart?.(context as ContextWindow);
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
    this.legacyHookExecutor = runtime?.executeLegacyHook;
    this.resetExecutionState(context);

    const workQueue = this.createWorkQueueAdapter();
    const seedResult = await this.seedWorkQueueFromGoal({ context, goal, agentType, cwd, workQueue });
    const state = createExecutionState(seedResult.initialWorkId);

    this.log('info', 'Starting orchestration', { goal: seedResult.goal, agentType });
    this.emit(createEvent('orchestration_started', { goal: seedResult.goal, agentType, requestId: this.requestId }));
    profiler.instant('orchestration:start', 'orchestrator', 'p', { goal: seedResult.goal.slice(0, 100), agentType });

    const terminationPolicy = this.createTerminationPolicy();
    const cadenceAuditor = this.createCadenceAuditor({
      state,
      context,
      agentType,
      runtime,
      goal: seedResult.goal,
    });

    return this.runExecutionLoop({
      context,
      goal: seedResult.goal,
      agentType,
      cwd,
      runtime,
      state,
      workQueue,
      terminationPolicy,
      cadenceAuditor,
    });
  }

  private resetExecutionState(context: ContextWindow): void {
    this.workQueue = [];
    this.completedWork.clear();
    this.workItemContexts.clear();
    this.useFreshWorkItemContexts = false;
    this.handoffBaseContext = null;
    this.activeSessionKey = context.sessionKey;
  }

  private createWorkQueueAdapter(): WorkQueueAdapter {
    return {
      enqueue: (item) => this.enqueue(item),
      dequeueAllReady: () => this.dequeueAllReady(),
      size: () => this.workQueue.length,
      hasPending: () => this.workQueue.length > 0,
      clear: () => {
        this.workQueue = [];
      },
    };
  }

  private async seedWorkQueueFromGoal(params: {
    context: ContextWindow;
    goal: string;
    agentType: string;
    cwd: string;
    workQueue: WorkQueueAdapter;
  }): Promise<{ goal: string; initialWorkId: string; seededFromHandoff: boolean }> {
    const { context, agentType, cwd, workQueue } = params;
    let resolvedGoal = params.goal;
    let seededFromHandoff = false;

    const goalSpec = this.coerceHandoffSpec(resolvedGoal);
    if (goalSpec) {
      const planGoal = goalSpec.goal.trim().length > 0 ? goalSpec.goal : 'Execute handoff';
      resolvedGoal = planGoal;
      const workItems = this.parseHandoffSpec(goalSpec, planGoal);
      if (workItems.length > 0) {
        await this.initHandoffContext({ context, goal: planGoal, handoffSpec: goalSpec, cwd });
        this.log('info', 'Executing handoff spec payload', {
          itemCount: workItems.length,
          items: workItems.map(item => ({ id: item.workId, objective: item.objective.slice(0, 50) })),
        });
        if (this.planModeOptions?.enabled) {
          this.log('info', 'Disabling plan mode after handoff payload', { workId: workItems[0].workId });
          this.planModeOptions = undefined;
        }
        for (const item of workItems) {
          workQueue.enqueue(item);
        }
        this.initialWorkId = workItems[0].workId;
        seededFromHandoff = true;
      }
    }

    if (!seededFromHandoff) {
      const initialItem = this.createWorkItem(resolvedGoal, agentType);
      this.initialWorkId = initialItem.workId;
      workQueue.enqueue(initialItem);
    }

    return { goal: resolvedGoal, initialWorkId: this.initialWorkId, seededFromHandoff };
  }

  private createTerminationPolicy(): TerminationPolicy {
    return {
      checkIterationBounds: async ({ state, context, agentType, runtime, goal, now }) => {
        if (state.iteration > this.config.maxIterations) {
          this.log('warning', 'Max iterations exceeded', { iteration: state.iteration, completedWork: this.completedWork.size });
          const stopResult = await this.callStopHook(
            context,
            'max_iterations_exceeded',
            '',
            state.iteration,
            agentType,
            runtime,
            undefined,
            undefined,
            undefined,
            goal,
            state.totalLlmCalls,
            state.totalToolCalls
          );
          if (this.handleStopHookBlock(stopResult, context, agentType, state.iteration, 'max_iterations_exceeded')) {
            return { terminal: null, shouldContinue: true };
          }
          this.emitGoalNotAchieved(goal, 'max_iterations_exceeded');
          const harvestedResponse = this.harvestCompletedWork(state.inProgress, 'max_iterations_exceeded');
          const hasContent = this.completedWork.size > 0;
          return {
            terminal: this.createResult({
              success: hasContent,
              response: harvestedResponse,
              terminationReason: 'max_iterations_exceeded',
              metrics: {
                iterations: state.iteration - 1,
                totalLlmCalls: state.totalLlmCalls,
                totalToolCalls: state.totalToolCalls,
                durationMs: now - state.startTime,
              },
            }),
            shouldContinue: false,
          };
        }
        return { terminal: null, shouldContinue: false };
      },
      checkResult: async ({ result, workId, item, state, context, agentType, runtime, goal, cwd, now }) => {
        return this.checkTerminationConditions({
          result,
          workId,
          item,
          iteration: state.iteration,
          totalLlmCalls: state.totalLlmCalls,
          totalToolCalls: state.totalToolCalls,
          now,
          startTime: state.startTime,
          context,
          agentType,
          inProgress: state.inProgress,
          goal,
          cwd,
          runtime,
        });
      },
    };
  }

  private createCadenceAuditor(params: {
    state: ExecutionState;
    context: ContextWindow;
    agentType: string;
    runtime?: OrchestratorRuntime;
    goal: string;
  }): CadenceAuditor {
    const { state, context, agentType, runtime, goal } = params;
    const CADENCE_AUDIT_INTERVAL_MS = 3 * 60 * 1000;

    return {
      trackResult: (workId, result) => {
        state.lastAgentResult = result;
        state.lastAgentWorkId = workId;
      },
      maybeAudit: async (resultsByWorkId) => {
        if (!runtime?.hookRegistry) return;

        const cadenceNow = Date.now();
        if (cadenceNow - state.lastCadenceAuditMs < CADENCE_AUDIT_INTERVAL_MS) {
          return;
        }

        const toolCallsSinceLastAudit = state.totalToolCalls - state.lastCadenceAuditToolCalls;
        state.lastCadenceAuditMs = cadenceNow;
        state.lastCadenceAuditToolCalls = state.totalToolCalls;

        const activeWorkIds = Array.from(state.inProgress.keys());
        const auditWorkId = state.lastAgentWorkId ?? activeWorkIds[0] ?? this.initialWorkId;
        const auditItem = state.inProgress.get(auditWorkId)?.item;
        const auditResult = resultsByWorkId.get(auditWorkId)
          ?? (auditWorkId === state.lastAgentWorkId ? state.lastAgentResult : undefined);

        const recentActivityEntries = activeWorkIds.length > 0
          ? activeWorkIds
          : (state.lastAgentWorkId ? [state.lastAgentWorkId] : []);
        const workIdsForAudit = activeWorkIds.length > 0
          ? activeWorkIds
          : (state.lastAgentWorkId ? [state.lastAgentWorkId] : []);
        const recentActivity = recentActivityEntries.length > 0
          ? recentActivityEntries.map((workId) => {
              const result = resultsByWorkId.get(workId)
                ?? (workId === state.lastAgentWorkId ? state.lastAgentResult : undefined);
              const preview = result?.response?.slice(0, 200) ?? '';
              return `- ${workId}: ${preview || '[no response]'}`;
            }).join('\n')
          : (state.lastAgentResult?.response?.slice(0, 200) ?? '');

        const cadenceResult = await this.callStopHook(
          context,
          'cadence_audit' as TerminationReason,
          auditResult?.response ?? '',
          state.iteration,
          agentType,
          runtime,
          undefined,
          auditResult,
          auditWorkId,
          auditItem?.objective ?? goal,
          state.totalLlmCalls,
          state.totalToolCalls,
          {
            elapsedMs: cadenceNow - state.startTime,
            toolCallsSinceLastAudit,
            recentActivity,
            workIds: workIdsForAudit,
          }
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
      },
    };
  }

  private async runExecutionLoop(params: {
    context: ContextWindow;
    goal: string;
    agentType: string;
    cwd: string;
    runtime?: OrchestratorRuntime;
    state: ExecutionState;
    workQueue: WorkQueueAdapter;
    terminationPolicy: TerminationPolicy;
    cadenceAuditor: CadenceAuditor;
  }): Promise<OrchestratorResult> {
    const { context, goal, agentType, cwd, runtime, state, workQueue, terminationPolicy, cadenceAuditor } = params;

    while (workQueue.hasPending() || state.inProgress.size > 0) {
      const readyItems = workQueue.dequeueAllReady();

      for (const item of readyItems) {
        const hookParams = item.params as { isInternalHook?: boolean } | undefined;
        if (hookParams?.isInternalHook) {
          state.inProgress.set(item.workId, { item, agent: null });
          continue;
        }
        let agent: Agent | null = null;
        try {
          agent = this.createAgent(item.agent, context, item.workId, item.objective, runtime);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const errorResult = this.createErrorResult(errorMessage, context);
          this.completedWork.set(item.workId, errorResult);
          if (item.workId === state.initialWorkId) {
            return this.createResult({
              success: false,
              response: '',
              error: errorMessage,
              terminationReason: 'agent_error',
              metrics: { iterations: 0, totalLlmCalls: 0, totalToolCalls: 0, durationMs: 0 },
            });
          }
          continue;
        }
        if (!agent) {
          const errorResult = this.createErrorResult(`Unknown agent type: ${item.agent}`, context);
          this.completedWork.set(item.workId, errorResult);

          if (item.workId === state.initialWorkId) {
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
        state.inProgress.set(item.workId, { item, agent });
      }

      if (state.inProgress.size === 0) {
        if (workQueue.hasPending()) {
          this.log('warning', 'Work queue deadlock - all items blocked on dependencies');
        }
        break;
      }

      const iteration = nextIteration(state);
      profiler.instant(`orch.iteration:${iteration}`, 'orchestrator', 'p', {
        workItems: Array.from(state.inProgress.keys()),
        totalToolCalls: state.totalToolCalls,
        totalLlmCalls: state.totalLlmCalls,
      });
      const now = Date.now();
      const elapsed = getElapsedMs(state);

      runtime?.onIteration?.({
        iteration,
        context,
        totalToolCalls: state.totalToolCalls,
        totalLlmCalls: state.totalLlmCalls,
        elapsedMs: elapsed,
      });

      this.maybeAutoCompact(context, agentType, state);

      const iterationCheck = await terminationPolicy.checkIterationBounds({
        state,
        context,
        agentType,
        runtime,
        goal,
        now,
      });
      if (iterationCheck.shouldContinue) {
        continue;
      }
      if (iterationCheck.terminal) {
        return iterationCheck.terminal;
      }

      const itemIds = Array.from(state.inProgress.keys());
      const isParallel = state.inProgress.size > 1;
      this.log('info', `Iteration ${iteration}${isParallel ? ` (parallel: ${state.inProgress.size} items)` : ''}`, {
        totalToolCalls: state.totalToolCalls,
        totalLlmCalls: state.totalLlmCalls,
        workItems: itemIds,
      });

      for (const [workId, { item }] of state.inProgress) {
        this.emit(createEvent('iteration_started', {
          iteration,
          goal: item.goal,
          objective: item.objective,
          requestId: this.requestId,
          workId,
        }));
      }

      const executions = Array.from(state.inProgress.entries()).map(async ([workId, { item, agent }]) => {
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
                needsHandoff: false,
                isRefusal: false,
                localContext: context,
              } as AgentResult,
            };
          }

          if (!agent) {
            throw new Error(`Missing agent for work item: ${workId}`);
          }
          const agentAsyncId = profiler.asyncBegin(`agent:${item.agent}`, 'agent');
          const workContext = this.resolveWorkItemContext(workId, context);
          const result = await agent.run({ globalContext: workContext, workItem: item, cwd });
          profiler.asyncEnd(`agent:${item.agent}`, agentAsyncId, 'agent', {
            llmCalls: result.metrics.llmCallsMade,
            toolCalls: result.metrics.toolCallsMade,
          });
          return { workId, item, result };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { workId, item, result: this.createErrorResult(error, context) };
        }
      });

      const results = await Promise.all(executions);
      const resultsByWorkId = new Map<string, AgentResult>();
      let terminalResult: OrchestratorResult | null = null;

      for (const { workId, item, result } of results) {
        resultsByWorkId.set(workId, result);
        const hookParams = item.params as { isInternalHook?: boolean } | undefined;
        if (hookParams?.isInternalHook) {
          this.completedWork.set(workId, result);
          state.inProgress.delete(workId);
          continue;
        }

        updateMetrics(state, result);

        const localMetrics = result.localContext.metrics;
        context.updateMetrics(localMetrics.inputTokens, localMetrics.totalOutputTokens, localMetrics.cachedTokens);
        const workContext = this.workItemContexts.get(workId);
        if (workContext) {
          workContext.updateMetrics(localMetrics.inputTokens, localMetrics.totalOutputTokens, localMetrics.cachedTokens);
        }

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

        if (!terminalResult) {
          const checkResult = await terminationPolicy.checkResult({
            result,
            workId,
            item,
            state,
            context,
            agentType,
            runtime,
            goal,
            cwd,
            now,
          });

          if (checkResult.terminal) {
            terminalResult = checkResult.terminal;
            continue;
          }

          if (checkResult.shouldContinue) {
            if (checkResult.newItem) {
              workQueue.enqueue(checkResult.newItem);
              state.initialWorkCompleted = false;
              state.initialWorkResponse = '';
              state.initialWorkId = this.resetWorkTracking(checkResult.newItem);
              state.startTime = Date.now();
            }
            if (checkResult.itemToRequeue) {
              workQueue.enqueue(checkResult.itemToRequeue);
            }
            state.inProgress.delete(workId);
            continue;
          }
        }

        const structured = result.structuredOutput;
        const goalStateReached = structured?.goalStateReached === true || result.terminationReason === 'goal_state_reached';

        if (goalStateReached) {
          this.log('info', 'Goal state reached', { workId, response: result.response?.slice(0, 100) });
          this.completedWork.set(workId, result);
          this.mergeAgentResultContext(context, workId, result);
          state.inProgress.delete(workId);
          let workItemHookBlocked = false;

          const shouldRunWorkItemHook = !!runtime?.hookRegistry &&
            (workId !== state.initialWorkId || workQueue.hasPending() || state.inProgress.size > 0);
          if (shouldRunWorkItemHook) {
            const stopResult = await this.callStopHook(
              context,
              'goal_state_reached',
              result.response ?? '',
              iteration,
              item.agent,
              runtime,
              undefined,
              result,
              workId,
              item.objective,
              state.totalLlmCalls,
              state.totalToolCalls,
              undefined,
              'work_item_completed'
            );

            if (stopResult) {
              this.enqueueDeferredWork(stopResult);

              if (stopResult.systemMessage) {
                context.addMessage('system', stopResult.systemMessage);
              }

              if (stopResult.decision === 'block' && stopResult.reason) {
                const retryItem = this.createWorkItem(stopResult.reason, item.agent);
                workQueue.enqueue(retryItem);
                workItemHookBlocked = true;

                if (workId === state.initialWorkId) {
                  state.initialWorkCompleted = false;
                  state.initialWorkResponse = '';
                  state.initialWorkResult = undefined;
                  state.initialWorkId = this.resetWorkTracking(retryItem);
                  state.startTime = Date.now();
                }
              }
            }
          }

          if (!workItemHookBlocked && workId === state.initialWorkId) {
            state.initialWorkCompleted = true;
            state.initialWorkResponse = result.response;
            state.initialWorkResult = result;
          }
        } else {
          this.mergeAgentResultContext(context, workId, result);
        }

        cadenceAuditor.trackResult(workId, result);
      }

      await cadenceAuditor.maybeAudit(resultsByWorkId);

      if (state.initialWorkCompleted && !workQueue.hasPending() && state.inProgress.size === 0) {
        if (runtime?.checkInterruption?.()) {
          this.log('info', 'Pending interruption detected, continuing execution', { iteration });
          const newItem = this.createWorkItem('Continue with user input', agentType);
          workQueue.enqueue(newItem);
          state.initialWorkCompleted = false;
          state.initialWorkResponse = '';
          state.initialWorkId = this.resetWorkTracking(newItem);
          state.startTime = Date.now();
          continue;
        }

        if (runtime?.hookRegistry) {
          const stopResult = await this.callStopHook(
            context,
            'goal_state_reached' as TerminationReason,
            state.initialWorkResponse,
            iteration,
            agentType,
            runtime,
            undefined,
            state.initialWorkResult,
            state.initialWorkId,
            goal,
            state.totalLlmCalls,
            state.totalToolCalls
          );

          if (stopResult) {
            this.enqueueDeferredWork(stopResult);

            if (workQueue.hasPending()) {
              this.log('info', 'Deferred work enqueued, continuing loop', {
                iteration,
                queuedItems: workQueue.size(),
              });
              state.initialWorkCompleted = false;
              state.initialWorkResponse = '';
              state.initialWorkResult = undefined;
              continue;
            }

            if (stopResult.decision === 'block' && stopResult.reason) {
              this.log('info', 'Control hook blocked termination, re-injecting prompt', {
                iteration,
                promptPreview: stopResult.reason.slice(0, 100),
              });

              this.emit(createEvent('agent_progress', {
                kind: 'work',
                message: stopResult.systemMessage || `Control hook continuing (iteration ${iteration})`,
                requestId: this.requestId,
              }));

              if (stopResult.systemMessage) {
                context.addMessage('system', stopResult.systemMessage);
              }

              const newItem = this.createWorkItem(stopResult.reason, agentType);
              workQueue.enqueue(newItem);

              state.initialWorkCompleted = false;
              state.initialWorkResponse = '';
              state.initialWorkResult = undefined;
              state.initialWorkId = this.resetWorkTracking(newItem);

              continue;
            }
          }
        }

        this.emit(createEvent('goal_achieved', {
          goal,
          completed: this.completedWork.size,
          skipped: 0,
        }));
        return this.createResult({
          success: true,
          response: state.initialWorkResponse,
          terminationReason: 'goal_state_reached',
          metrics: {
            iterations: iteration,
            totalLlmCalls: state.totalLlmCalls,
            totalToolCalls: state.totalToolCalls,
            durationMs: now - state.startTime,
          },
        });
      }

      if (terminalResult) {
        return terminalResult;
      }

      this.log('info', `Continuing to iteration ${iteration + 1}`, {
        inProgress: state.inProgress.size,
        queued: workQueue.size(),
      });
    }

    const initialResult = this.completedWork.get(state.initialWorkId);
    if (initialResult) {
      if (initialResult.terminationReason === 'goal_state_reached') {
        this.emit(createEvent('goal_achieved', {
          goal,
          completed: this.completedWork.size,
          skipped: 0,
        }));
      }
      return this.createResult({
        success: initialResult.success,
        response: initialResult.response,
        error: initialResult.error,
        terminationReason: initialResult.terminationReason ?? 'agent_error',
        metrics: {
          iterations: state.iteration,
          totalLlmCalls: state.totalLlmCalls,
          totalToolCalls: state.totalToolCalls,
          durationMs: Date.now() - state.startTime,
        },
      });
    }

    return this.createResult({
      success: false,
      response: '',
      error: 'Work queue exhausted without completing initial goal',
      terminationReason: 'agent_error',
      metrics: {
        iterations: state.iteration,
        totalLlmCalls: state.totalLlmCalls,
        totalToolCalls: state.totalToolCalls,
        durationMs: Date.now() - state.startTime,
      },
    });
  }

  private maybeAutoCompact(context: ContextWindow, agentType: string, state: ExecutionState): void {
    const percentUsed = context.metrics.percentageUsed;
    if (percentUsed < this.config.compactResetPercent) {
      state.compactedRecently = false;
    }
    if (!state.compactedRecently && percentUsed >= this.config.compactTriggerPercent) {
      const compactAsyncId = profiler.asyncBegin('orch.compact', 'orchestrator');
      const compactResult = context.compact(this.getCompactionConfig());
      state.compactedRecently = true;
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

  private createAgent(
    agentType: string,
    context: ContextWindow,
    workId: string,
    objective: string,
    runtime?: OrchestratorRuntime
  ): Agent | null {
    // NO FALLBACK: If the requested agent type doesn't exist, fail explicitly
    if (!this.agentRegistry?.has(agentType)) return null;
    let config = this.agentRegistry.getConfig(agentType);

    // Apply plan mode modifications if enabled
    if (this.planModeOptions?.enabled) {
      const isPlanner = agentType === 'planner';
      config = {
        ...config,
        systemPrompt: isPlanner
          ? config.systemPrompt + this.planModeOptions.promptAddendum
          : config.systemPrompt,
        tools: isPlanner
          ? this.planModeOptions.toolFilter(config.tools)
          : config.tools,
      };
    }

    // Apply async mode modifications to worker agents (not the watcher itself)
    // CRITICAL: Must clear outputSchema - structured output is incompatible with async mode
    if (this.config.asyncMode?.enabled && agentType !== 'watcher' && agentType !== 'planner') {
      config = {
        ...config,
        systemPrompt: getAsyncAgentPrompt(),
        outputSchema: undefined,  // Async workers use free-form output, not structured schemas
      };
    }

    // Build LLM config from model selection (source of truth) + agent's llmParams
    const llmConfig = this.buildLlmConfig(config.llmParams, agentType);

    // Wire cadence check: invokes control hooks at tool-call thresholds for real oversight.
    // Fires every 60 tool calls OR every 5 minutes, whichever comes first.
    // This gives the watcher real intervention power during execution.
    let lastCadenceToolCalls = 0;
    let lastCadenceTimeMs = Date.now();
    const CADENCE_TOOL_THRESHOLD = 60;  // Every 60 tool calls
    const CADENCE_TIME_THRESHOLD_MS = 300_000;  // Every 5 minutes

    const cadenceCheck = async (metrics: AgentCadenceMetrics): Promise<AgentCadenceResult> => {
      // Check for user/system stop request
      if (runtime?.checkStopRequest?.()) {
        return { action: 'stop', systemMessage: 'Stop requested during agent execution.' };
      }

      const toolCallsSinceLast = metrics.toolCallsMade - lastCadenceToolCalls;
      const timeSinceLast = Date.now() - lastCadenceTimeMs;
      const shouldInvokeWatcher = runtime?.hookRegistry && (
        toolCallsSinceLast >= CADENCE_TOOL_THRESHOLD ||
        timeSinceLast >= CADENCE_TIME_THRESHOLD_MS
      );

      if (shouldInvokeWatcher && runtime?.hookRegistry) {
        lastCadenceToolCalls = metrics.toolCallsMade;
        lastCadenceTimeMs = Date.now();

        try {
          const executionMetrics: ExecutionMetrics = {
            toolCallsMade: metrics.toolCallsMade,
            llmCalls: metrics.llmCallsMade,
            contextPercentUsed: context.metrics.percentageUsed,
            durationMs: metrics.durationMs,
            filesRead: [],
            filesModified: [],
            iterationCount: metrics.llmCallsMade,
          };
          const hookContext = this.buildHookContext({
            context,
            workId,
            agentType,
            iteration: metrics.llmCallsMade,
            metrics: executionMetrics,
            objective,
            filesModified: [],
          });
          const event = createCadenceAuditEvent(
            context.sessionKey,
            workId,
            metrics.durationMs,
            toolCallsSinceLast,
            executionMetrics,
            'cadence_check'
          );
          const hookResult = await this.runControlHooks<'cadence_audit'>(event, hookContext, context, runtime);
          switch (hookResult.status) {
            case 'decision': {
              const decision = hookResult.decision;
              switch (decision.action) {
                case 'continue':
                  break;
                case 'inject_guidance':
                  return { action: 'inject', systemMessage: decision.message };
                case 'realign':
                  return { action: 'stop', systemMessage: decision.guidance };
                case 'split':
                  return { action: 'stop', systemMessage: 'Cadence audit requested split.' };
                case 'stop_work_item':
                  return {
                    action: 'stop',
                    systemMessage: decision.reason,
                    terminationReason: 'watcher_work_item_stopped',
                    escalationId: decision.escalationId,
                    reason: decision.reason,
                  };
                case 'stop':
                  return {
                    action: 'stop',
                    systemMessage: decision.reason,
                    terminationReason: 'watcher_stopped',
                    reason: decision.reason,
                  };
                default:
                  assertNever(decision);
              }
              break;
            }
            case 'no_decision':
              this.log('warning', 'Cadence audit hooks produced no decision', {
                eventType: event.type,
                failures: hookResult.failures.length,
                hasCriticalFailure: hookResult.hasCriticalFailure,
              });
              break;
            case 'no_hooks':
            case 'all_skipped':
            case 'no_registry':
              break;
            default:
              assertNever(hookResult);
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
      sessionKey: context.sessionKey,
      agentRegistry: this.agentRegistry,
      llmConfig,
      hooks: mergedHooks,
      internalHookQueue: this.hookQueue,
      getModelSelection: this.getModelSelection,
      memoryInjector: this.config.memoryInjector,
    });
  }

  private resolveAgentBounds(agentType: string): { maxToolCalls: number; maxDurationMs: number; maxLlmCalls: number } {
    // Get agent's budget from registry, fallback to orchestrator config
    let agentBudget: { maxIterations: number; maxToolCalls: number; maxDurationMs: number } | undefined;
    try {
      agentBudget = this.agentRegistry?.getConfig(agentType)?.budget;
    } catch {
      // Agent not in registry, use orchestrator defaults
    }

    return {
      maxToolCalls: agentBudget?.maxToolCalls ?? this.config.maxToolCalls,
      maxDurationMs: agentBudget?.maxDurationMs ?? this.config.maxDurationMs,
      maxLlmCalls: agentBudget?.maxIterations ?? this.config.maxIterations,
    };
  }

  private createWorkItem(goal: string, agentType: string): WorkItem {
    return createWorkItem({
      goal,
      objective: goal,
      agent: agentType,
      bounds: this.resolveAgentBounds(agentType),
    });
  }

  private resolveWorkItemContext(workId: string, fallback: ContextWindow): ContextWindow {
    return this.workItemContexts.get(workId) ?? fallback;
  }

  private mergeAgentResultContext(context: ContextWindow, workId: string, result: AgentResult): void {
    const workContext = this.workItemContexts.get(workId);
    if (workContext) {
      workContext.addAgentResultContext(result);
    }
    context.addAgentResultContext(result);
  }

  private createFreshWorkItemContext(): ContextWindow | null {
    if (!this.handoffBaseContext) return null;
    return ContextWindow.deserialize(this.handoffBaseContext.serialize());
  }

  private extractHandoffSpecCandidate(value: unknown): Record<string, unknown> | null {
    if (!value) return null;
    if (typeof value === 'string') {
      const parsed = coerceStructuredOutput(value);
      if (!parsed) return null;
      return this.extractHandoffSpecCandidate(parsed);
    }
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const nested = record.handoffSpec ?? record.handoff_spec;
    if (nested) {
      return this.extractHandoffSpecCandidate(nested);
    }
    return record;
  }

  private extractHandoffWorkItems(record: Record<string, unknown>): unknown[] | null {
    const direct = record.workItems;
    if (Array.isArray(direct)) return direct;
    const underscored = record.work_items;
    if (Array.isArray(underscored)) return underscored;
    const compact = record.workitems;
    if (Array.isArray(compact)) return compact;
    return null;
  }

  private coerceHandoffSpec(spec: HandoffSpec | string, fallbackGoal = ''): HandoffSpec | null {
    const candidate = this.extractHandoffSpecCandidate(spec);
    if (!candidate) return null;
    const workItems = this.extractHandoffWorkItems(candidate);
    if (!workItems || workItems.length === 0) return null;

    const rawGoal = typeof candidate.goal === 'string' ? candidate.goal.trim() : '';
    const goal = rawGoal.length > 0 ? rawGoal : fallbackGoal;
    const context = typeof candidate.context === 'string' ? candidate.context : '';

    return {
      goal,
      context,
      workItems: workItems as HandoffSpec['workItems'],
    };
  }

  private buildHandoffBaseContext(
    context: ContextWindow,
    planContextPath?: string,
    handoffSpec?: HandoffSpec | null
  ): ContextWindow {
    const base = new ContextWindow(context.sessionKey, context.maxTokens);
    const notes: string[] = [];
    if (planContextPath) {
      notes.push(`Plan context: ${planContextPath}. Read this before starting your work item.`);
    }
    if (handoffSpec?.context) {
      notes.push(`Planning notes: ${handoffSpec.context}`);
    }
    if (notes.length > 0) {
      base.addMessage('system', notes.join('\n'));
    }
    return base;
  }

  private async initHandoffContext(params: {
    context: ContextWindow;
    goal: string;
    handoffSpec: HandoffSpec | string;
    cwd: string;
  }): Promise<void> {
    const { context, goal, handoffSpec, cwd } = params;
    const parsedSpec = this.coerceHandoffSpec(handoffSpec, goal);
    let planContextPath: string | undefined;

    if (parsedSpec) {
      try {
        const planContext = buildPlanContextFromHandoff(context.sessionKey, goal, parsedSpec);
        planContextPath = await writePlanContext(cwd, planContext);
        this.log('info', 'Plan context written', { path: planContextPath });
      } catch (err) {
        this.log('warning', 'Plan context write failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.handoffBaseContext = this.buildHandoffBaseContext(context, planContextPath, parsedSpec);
    this.useFreshWorkItemContexts = true;
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

  private isKnownWorkId(workId: string): boolean {
    return this.workQueue.some(item => item.workId === workId) || this.completedWork.has(workId);
  }

  private resolveWorkItemDependencies(
    dependencies: string[] | undefined,
    idMap: Map<string, string>,
    context: string
  ): string[] {
    if (!dependencies || dependencies.length === 0) return [];

    const resolved: string[] = [];
    const unknown: string[] = [];

    for (const dep of dependencies) {
      const mapped = idMap.get(dep);
      if (mapped) {
        resolved.push(mapped);
        continue;
      }
      if (this.isKnownWorkId(dep)) {
        resolved.push(dep);
        continue;
      }
      unknown.push(dep);
    }

    if (unknown.length > 0) {
      this.log('warning', 'Dropping unknown work item dependencies', { context, unknown });
    }

    return resolved;
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
      terminationReason: 'agent_error',
      needsUserInput: false,
      needsHandoff: false,
      isRefusal: false,
      localContext: context,
    };
  }

  /**
   * Reset work tracking for continuation after interruption or stop hook block.
   */
  private resetWorkTracking(newItem: WorkItem): string {
    this.completedWork.delete(this.initialWorkId);
    this.initialWorkId = newItem.workId;
    return this.initialWorkId;
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

  private buildExecutionMetrics(params: {
    result?: AgentResult;
    context: ContextWindow;
    iteration: number;
    totalLlmCalls: number;
    totalToolCalls: number;
  }): ExecutionMetrics {
    const { result, context, iteration, totalLlmCalls, totalToolCalls } = params;
    const contextMetrics = context.metrics;
    const resultMetrics = result?.metrics;
    return {
      toolCallsMade: resultMetrics?.toolCallsMade ?? totalToolCalls,
      llmCalls: resultMetrics?.llmCallsMade ?? totalLlmCalls,
      contextPercentUsed: contextMetrics.percentageUsed,
      durationMs: resultMetrics?.durationMs ?? 0,
      filesRead: result?.filesRead ?? [],
      filesModified: result?.invalidatedPaths ?? [],
      iterationCount: iteration,
    };
  }

  private buildHookContext(params: {
    context: ContextWindow;
    workId: string;
    agentType: string;
    iteration: number;
    metrics: ExecutionMetrics;
    objective: string;
    filesModified: string[];
  }): HookContext {
    const recentMessages = params.context
      .getRecentItems(20)
      .filter((item): item is MessageItem & { role: 'system' | 'user' | 'assistant' } =>
        item.type === 'message' &&
        (item.role === 'system' || item.role === 'user' || item.role === 'assistant')
      )
      .map(item => ({
        role: item.role,
        content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
        timestamp: item.timestamp,
      }));

    return {
      sessionKey: params.context.sessionKey,
      workId: params.workId,
      agentType: params.agentType,
      iteration: params.iteration,
      metrics: params.metrics,
      recentMessages,
      filesModified: params.filesModified,
      objective: params.objective,
      realignCount: this.realignCount,
    };
  }

  private applyHookPatches(context: ContextWindow, patches: StatePatch[], source: string): void {
    if (patches.length === 0) return;
    const { state } = applyPatches({
      workQueue: this.workQueue,
      context,
      realignCount: this.realignCount,
      terminationReason: this.hookTerminationReason,
      metadata: this.hookMetadata,
      auditLog: this.hookAuditLog,
    }, patches, source);
    this.workQueue = state.workQueue;
    this.realignCount = state.realignCount;
    this.hookTerminationReason = state.terminationReason;
    this.hookMetadata = state.metadata;
    this.hookAuditLog = state.auditLog;
  }

  private async runControlHooks<E extends ControlEventType>(
    event: EventFor<E>,
    ctx: HookContext,
    context: ContextWindow,
    runtime?: OrchestratorRuntime
  ): Promise<HookExecutionResult<DecisionFor<E>>> {
    const registry = runtime?.hookRegistry;
    if (!registry) {
      return {
        status: 'no_registry',
        decision: null,
        patches: [],
        failures: [],
        hasCriticalFailure: false,
        audit: [],
      };
    }
    const result = await runHooksForEvent(event, ctx, registry);
    if (result.patches.length > 0) {
      this.applyHookPatches(context, result.patches, `hooks:${event.type}`);
    }
    return result;
  }

  private createControlEvent(params: {
    terminationReason: TerminationReason;
    context: ContextWindow;
    workId: string;
    response: string;
    metrics: ExecutionMetrics;
    userPrompt?: UserPromptInfo;
    agentResult?: AgentResult;
    cadence?: { elapsedMs: number; toolCallsSinceLastAudit: number; recentActivity: string; workIds?: string[] };
    controlEventType?: 'goal_state_reached' | 'work_item_completed';
  }): ControlEvent | null {
    const { terminationReason, context, workId, response, metrics, userPrompt, agentResult, cadence, controlEventType } = params;

    switch (terminationReason) {
      case 'goal_state_reached': {
        if (controlEventType === 'work_item_completed') {
          return createWorkItemCompletedEvent(
            context.sessionKey,
            workId,
            agentResult?.success ?? true,
            response,
            metrics.filesModified,
            metrics,
            terminationReason
          );
        }
        const artifacts = agentResult?.artifacts?.map(a => ({
          type: 'data' as const,
          path: a.sourcePath,
          description: a.insight ?? a.name,
        }));
        return createGoalReachedEvent(
          context.sessionKey,
          workId,
          response,
          metrics.filesModified,
          metrics,
          artifacts
        );
      }
      case 'max_iterations_exceeded':
      case 'max_tool_calls_exceeded':
      case 'max_duration_exceeded': {
        const boundType = terminationReason === 'max_iterations_exceeded'
          ? 'iterations'
          : terminationReason === 'max_tool_calls_exceeded'
            ? 'tool_calls'
            : 'duration';
        const limit = terminationReason === 'max_iterations_exceeded'
          ? this.config.maxIterations
          : terminationReason === 'max_tool_calls_exceeded'
            ? this.config.maxToolCalls
            : this.config.maxDurationMs;
        const current = terminationReason === 'max_iterations_exceeded'
          ? metrics.iterationCount
          : terminationReason === 'max_tool_calls_exceeded'
            ? metrics.toolCallsMade
            : metrics.durationMs;
        return createBoundsExceededEvent(
          context.sessionKey,
          workId,
          boundType,
          limit,
          current,
          response,
          metrics
        );
      }
      case 'user_input_required': {
        if (!userPrompt) return null;
        const options = userPrompt.options?.map(option => {
          if (typeof option === 'string') {
            return { label: option };
          }
          return { label: option.label, description: option.description };
        });
        return createUserInputRequiredEvent(
          context.sessionKey,
          workId,
          userPrompt.question,
          options,
          userPrompt.context,
          userPrompt.multiSelect ?? false
        );
      }
      case 'cadence_audit': {
        if (!cadence) return null;
        return createCadenceAuditEvent(
          context.sessionKey,
          workId,
          cadence.elapsedMs,
          cadence.toolCallsSinceLastAudit,
          metrics,
          cadence.recentActivity,
          cadence.workIds
        );
      }
      case 'agent_error':
      case 'invalid_action':
      case 'no_action':
      case 'stagnation': {
        const errorType = terminationReason === 'agent_error'
          ? 'exception'
          : terminationReason;
        return createAgentErrorEvent(
          context.sessionKey,
          workId,
          errorType,
          agentResult?.error ?? response ?? terminationReason,
          metrics,
          undefined
        );
      }
      case 'handoff_requested': {
        if (!agentResult?.handoffSpec) return null;
        return createHandoffRequestedEvent(
          context.sessionKey,
          workId,
          agentResult.handoffSpec,
          response
        );
      }
      case 'user_stopped':
      case 'watcher_stopped':
      case 'watcher_work_item_stopped':
      case 'rate_limit':
      case 'circuit_open':
      case 'timeout':
      case 'refusal':
        return null;
      default:
        return assertNever(terminationReason);
    }
  }

  private resolveHookDecision<D>(
    eventType: string,
    result: HookExecutionResult<D>,
    map: (decision: D) => StopHookResult
  ): StopHookResult | null {
    switch (result.status) {
      case 'decision':
        return map(result.decision);
      case 'no_decision':
        this.log('warning', 'Control hook produced no decision', {
          eventType,
          failures: result.failures.length,
          hasCriticalFailure: result.hasCriticalFailure,
        });
        return null;
      case 'no_registry':
      case 'no_hooks':
      case 'all_skipped':
        return null;
      default:
        return assertNever(result);
    }
  }

  /**
   * Call control-plane hooks and return a stop-style decision.
   * Returns null if no hook registry configured or if hooks fail.
   */
  private async callStopHook(
    context: ContextWindow,
    terminationReason: TerminationReason,
    response: string,
    iteration: number,
    agentType: string,
    runtime?: OrchestratorRuntime,
    userPrompt?: UserPromptInfo,
    agentResult?: AgentResult,
    workId?: string,
    objective?: string,
    totalLlmCalls?: number,
    totalToolCalls?: number,
    cadence?: { elapsedMs: number; toolCallsSinceLastAudit: number; recentActivity: string; workIds?: string[] },
    controlEventType?: 'goal_state_reached' | 'work_item_completed'
  ): Promise<StopHookResult | null> {
    if (!runtime?.hookRegistry) return null;

    const effectiveWorkId = workId ?? this.initialWorkId;
    const effectiveObjective = objective ?? response.slice(0, 160) ?? '';
    const metrics = this.buildExecutionMetrics({
      result: agentResult,
      context,
      iteration,
      totalLlmCalls: totalLlmCalls ?? agentResult?.metrics.llmCallsMade ?? iteration,
      totalToolCalls: totalToolCalls ?? agentResult?.metrics.toolCallsMade ?? 0,
    });
    const hookContext = this.buildHookContext({
      context,
      workId: effectiveWorkId,
      agentType,
      iteration,
      metrics,
      objective: effectiveObjective,
      filesModified: metrics.filesModified,
    });

    const event = this.createControlEvent({
      terminationReason,
      context,
      workId: effectiveWorkId,
      response,
      metrics,
      userPrompt,
      agentResult,
      cadence,
      controlEventType,
    });

    if (!event) return null;

    try {
      switch (event.type) {
        case 'goal_state_reached': {
          const hookResult = await this.runControlHooks<'goal_state_reached'>(event, hookContext, context, runtime);
          return this.resolveHookDecision(event.type, hookResult, mapQualityDecisionToStopResult);
        }
        case 'bounds_exceeded': {
          const hookResult = await this.runControlHooks<'bounds_exceeded'>(event, hookContext, context, runtime);
          return this.resolveHookDecision(event.type, hookResult, mapBoundsDecisionToStopResult);
        }
        case 'user_input_required': {
          const hookResult = await this.runControlHooks<'user_input_required'>(event, hookContext, context, runtime);
          return this.resolveHookDecision(event.type, hookResult, mapPromptDecisionToStopResult);
        }
        case 'cadence_audit': {
          const hookResult = await this.runControlHooks<'cadence_audit'>(event, hookContext, context, runtime);
          return this.resolveHookDecision(event.type, hookResult, mapCadenceDecisionToStopResult);
        }
        case 'agent_error': {
          const hookResult = await this.runControlHooks<'agent_error'>(event, hookContext, context, runtime);
          return this.resolveHookDecision(event.type, hookResult, mapAgentErrorDecisionToStopResult);
        }
        case 'handoff_requested': {
          const hookResult = await this.runControlHooks<'handoff_requested'>(event, hookContext, context, runtime);
          return this.resolveHookDecision(event.type, hookResult, mapHandoffDecisionToStopResult);
        }
        case 'work_item_completed': {
          const hookResult = await this.runControlHooks<'work_item_completed'>(event, hookContext, context, runtime);
          return this.resolveHookDecision(event.type, hookResult, mapWorkItemDecisionToStopResult);
        }
        case 'escalation_resolved':
        case 'user_stopped':
        case 'transient_error':
          return null;
        default:
          return assertNever(event);
      }
    } catch (err) {
      this.log('warning', 'Control hook error', { error: String(err), eventType: event.type });
      return null;
    }
  }

  /**
   * Handle hook "block" decision by re-injecting prompt and continuing.
   * Also enqueues any deferred work items from the hook result.
   * Returns true if loop should continue, false if termination should proceed.
   *
   * @param stopResult - The hook result (stop-style)
   * @param context - The context window
   * @param agentType - The agent type
   * @param iteration - Current iteration number
   * @param terminationReason - The reason for termination (used to differentiate handling)
   */
  private handleStopHookBlock(
    stopResult: StopHookResult | null,
    context: ContextWindow,
    agentType: string,
    iteration: number,
    terminationReason?: TerminationReason
  ): boolean {
    if (!stopResult) return false;

    // Enqueue deferred work regardless of decision (block or allow)
    const queueSizeBefore = this.workQueue.length;
    this.enqueueDeferredWork(stopResult);
    const deferredWorkAdded = this.workQueue.length > queueSizeBefore;

    // CRITICAL: If deferred work was enqueued, we must continue even if decision is 'allow'
    // This ensures work items from watcher are actually executed
    // Also reset realign counter since splitting work is progress
    if (deferredWorkAdded) {
      this.realignCount = 0; // Reset - splitting work is progress
      this.log('info', 'Deferred work added, resetting realign counter', {
        iteration,
        terminationReason,
        newItems: this.workQueue.length - queueSizeBefore,
        decision: stopResult.decision,
      });
      if (stopResult.decision !== 'block') {
        return true; // Signal to continue, even though it's not a 'block'
      }
    }

    if (stopResult.decision !== 'block' || !stopResult.reason) {
      return false;
    }

    this.log('info', 'Control hook blocked termination, re-injecting prompt', {
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

    // For bounds_exceeded: track realign count and enforce limit to prevent infinite loops
    // Check both orchestrator-level and agent-level termination reasons
    const boundsReasons = ['max_iterations_exceeded', 'max_tool_calls_exceeded', 'max_duration_exceeded'];
    const isBoundsExceeded = boundsReasons.includes(terminationReason ?? '');

    if (isBoundsExceeded) {
      this.realignCount++;
      this.log('info', 'Realign count incremented for bounds exceeded', {
        realignCount: this.realignCount,
        maxRealigns: this.config.maxRealigns,
        terminationReason,
      });

      if (this.realignCount > this.config.maxRealigns) {
        this.log('warning', 'Max realigns exceeded, forcing termination', {
          realignCount: this.realignCount,
          terminationReason,
        });
        // Don't continue - force termination
        return false;
      }
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
   * Enqueue deferred work items from a hook result.
   * These are fire-and-forget work items that don't block the current decision.
   * When bounds are specified by the watcher, they override agent registry defaults.
   */
  private enqueueDeferredWork(stopResult: StopHookResult): void {
    const deferredWork = stopResult.deferredWork;
    if (!deferredWork?.length) return;

    const idMap = new Map<string, string>();
    const created: WorkItem[] = [];
    const specs = deferredWork.map(work => {
      const defaults = this.resolveAgentBounds(work.agent);
      const bounds = work.bounds ? {
        maxToolCalls: work.bounds.maxToolCalls ?? defaults.maxToolCalls,
        maxLlmCalls: work.bounds.maxLlmCalls ?? defaults.maxLlmCalls,
        maxDurationMs: work.bounds.maxDurationMs ?? defaults.maxDurationMs,
      } : defaults;

      return {
        ...work,
        goal: work.goal ?? work.objective,
        bounds,
        dependencies: work.dependencies ?? [],
      };
    });

    for (const work of specs) {
      this.log('info', 'Enqueueing deferred work from hook', {
        objective: work.objective.slice(0, 100),
        agent: work.agent,
        hasBounds: !!work.bounds,
      });

      const item = createWorkItem({
        goal: work.goal,
        objective: work.objective,
        agent: work.agent,
        dependencies: [],
        targetPaths: work.targetPaths,
        bounds: work.bounds,
      });

      if (work.id) {
        idMap.set(work.id, item.workId);
      }

      created.push(item);
    }

    for (let i = 0; i < created.length; i++) {
      const resolvedDeps = this.resolveWorkItemDependencies(specs[i].dependencies, idMap, 'deferred_work');
      if (resolvedDeps.length > 0) {
        created[i] = cloneWorkItemWithDependencies(created[i], resolvedDeps);
      }
    }

    for (let i = 0; i < created.length; i++) {
      this.enqueue(created[i], specs[i].semantic);
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
    cwd: string;
    runtime?: OrchestratorRuntime;
  }): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, totalLlmCalls, totalToolCalls, now, startTime, context, agentType, goal, cwd, runtime } = params;

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
        this.mergeAgentResultContext(context, workId, result);
        return this.createInterruptionResult(agentType);
      }
      this.log('info', 'Pausing for user input', { workId, question: result.userPrompt.question, questionType: result.userPrompt.questionType });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'user_input_required',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        result.userPrompt,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
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
        this.mergeAgentResultContext(context, workId, result);
        return this.createInterruptionResult(agentType);
      }
      const specLength = JSON.stringify(result.handoffSpec).length;
      this.log('info', 'Handoff requested - checking approval', { workId, specLength });
      this.mergeAgentResultContext(context, workId, result);

      // Call stop hook for approval (watcher in async mode, or no-op in sync mode)
      const stopResult = await this.callStopHook(
        context,
        'handoff_requested',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );

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
          await this.initHandoffContext({ context, goal, handoffSpec: result.handoffSpec, cwd });
          this.log('info', 'Handoff approved - enqueueing work items', {
            workId,
            itemCount: workItems.length,
            items: workItems.map(w => ({ id: w.workId, objective: w.objective.slice(0, 50) })),
          });
          if (this.planModeOptions?.enabled) {
            this.log('info', 'Disabling plan mode after handoff approval', { workId });
            this.planModeOptions = undefined;
          }
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
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'refusal',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
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
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'user_stopped',
        result.response || '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
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
      this.mergeAgentResultContext(context, workId, result);
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
    // WORK-ITEM STOP: watcher stopped this agent/work item only
    // ============================================================
    if (result.terminationReason === 'watcher_work_item_stopped') {
      const reason = result.watcherStop?.reason ?? result.response ?? 'Watcher stopped this work item.';
      this.log('info', 'Watcher stopped work item', { workId, reason: reason.slice(0, 160) });
      this.mergeAgentResultContext(context, workId, result);

      this.hookQueue.enqueue({
        type: 'watcher_agent_stopped',
        sessionKey: context.sessionKey,
        workId,
        reason,
        escalationId: result.watcherStop?.escalationId,
        agentType: item.agent,
      }, {
        workId,
        agentType: item.agent,
        sessionKey: context.sessionKey,
        requestId: this.requestId,
        objective: item.objective,
      });

      this.completedWork.set(workId, result);

      return {
        terminal: null,
        shouldContinue: true,
      };
    }

    // ============================================================
    // CONTINUABLE ERRORS: no_action, invalid_action, stagnation
    // These are recoverable issues where Ralph Loop can retry with hints
    // ============================================================
    const isContinuableError = result.terminationReason === 'no_action' ||
                               result.terminationReason === 'invalid_action' ||
                               result.terminationReason === 'stagnation';
    if (isContinuableError) {
      const reason = result.terminationReason!;
      this.log('warning', `Agent ${reason}`, { workId, error: result.error });
      this.mergeAgentResultContext(context, workId, result);

      // Check control hooks - Ralph Loop can continue on these
      if (runtime?.hookRegistry) {
        const stopResult = await this.callStopHook(
          context,
          reason,
          result.response ?? '',
          iteration,
          agentType,
          runtime,
          undefined,
          result,
          workId,
          item.objective,
          totalLlmCalls,
          totalToolCalls
        );

        if (stopResult) {
          // Enqueue any deferred work regardless of decision
          const queueSizeBefore = this.workQueue.length;
          this.enqueueDeferredWork(stopResult);
          const deferredWorkAdded = this.workQueue.length > queueSizeBefore;

          // CRITICAL: If deferred work was enqueued, continue even on 'allow'
          if (deferredWorkAdded) {
            this.log('info', `Deferred work added, continuing loop`, {
              iteration,
              newItems: this.workQueue.length - queueSizeBefore,
            });
            return {
              terminal: null,
              shouldContinue: true,
            };
          }

          if (stopResult.decision === 'block' && stopResult.reason) {
            this.log('info', `Control hook blocked termination on ${reason}, re-injecting prompt`, {
              iteration,
              promptPreview: stopResult.reason.slice(0, 100),
            });

            this.emit(createEvent('agent_progress', {
              kind: 'work',
              message: stopResult.systemMessage || `Control hook continuing on ${reason} (iteration ${iteration})`,
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
        }
      }

      // No stop hook or hook allowed termination - map to appropriate orchestrator reason
      this.emitGoalNotAchieved(goal, result.error || reason, 1);
      return {
        terminal: this.createResult({
          success: false,
          response: result.response,
          error: result.error || reason,
          terminationReason: reason,
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // AGENT BOUNDS EXCEEDED: Map agent-level bounds to orchestrator-level
    // ============================================================
    if (result.terminationReason === 'max_iterations_exceeded' ||
        result.terminationReason === 'max_tool_calls_exceeded' ||
        result.terminationReason === 'max_duration_exceeded') {
      const orchReason = result.terminationReason;
      this.log('warning', `Agent bounds exceeded: ${orchReason}`, { workId });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        orchReason,
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
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
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        result.terminationReason,
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
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
    // TERMINAL: timeout - transient errors that must stop
    // ============================================================
    if (result.terminationReason === 'timeout') {
      this.log('warning', 'Agent timeout', { workId, error: result.error });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'timeout',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'timeout')) {
        return { terminal: null, shouldContinue: true };
      }
      return {
        terminal: this.createResult({
          success: false,
          response: result.response || 'Execution stopped: timeout',
          error: result.error || 'timeout',
          terminationReason: 'timeout',
          metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
        }),
        shouldContinue: false,
      };
    }

    // ============================================================
    // TERMINAL: agent_error - agent caught an unexpected error
    // ============================================================
    if (result.terminationReason === 'agent_error') {
      this.log('error', 'Agent error', { workId, error: result.error });
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'agent_error',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
      if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'agent_error')) {
        return { terminal: null, shouldContinue: true };
      }
      this.emitGoalNotAchieved(goal, result.error || 'agent_error', 1);
      return {
        terminal: this.createResult({
          success: false,
          response: result.response,
          error: result.error || 'Agent encountered an unexpected error',
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
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'agent_error',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
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
      this.mergeAgentResultContext(context, workId, result);
      const stopResult = await this.callStopHook(
        context,
        'max_tool_calls_exceeded',
        result.response ?? '',
        iteration,
        agentType,
        runtime,
        undefined,
        result,
        workId,
        item.objective,
        totalLlmCalls,
        totalToolCalls
      );
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
   * Parse a handoffSpec into WorkItems.
   * Returns empty array on parse failure.
   *
   * Uses two-pass approach to remap planner's semantic IDs to generated workIds:
   * 1. Create all work items and build ID mapping (planner ID → workId)
   * 2. Rewrite dependencies using the ID map
   */
  private parseHandoffSpec(spec: HandoffSpec | string, sessionGoal: string): WorkItem[] {
    try {
      const candidate = this.extractHandoffSpecCandidate(spec);
      if (!candidate) {
        this.log('warning', 'Handoff spec is not an object', { specPreview: typeof spec === 'string' ? spec.slice(0, 200) : undefined });
        return [];
      }

      const workItemsRaw = this.extractHandoffWorkItems(candidate);
      if (!workItemsRaw || workItemsRaw.length === 0) {
        this.log('warning', 'Handoff spec missing workItems array', { specPreview: typeof spec === 'string' ? spec.slice(0, 200) : undefined });
        return [];
      }

      const rawGoal = typeof candidate.goal === 'string' ? candidate.goal.trim() : '';
      const planGoal = rawGoal.length > 0 ? rawGoal : sessionGoal;

      // Phase 1: Create work items and build ID mapping
      const idMap = new Map<string, string>();  // planner ID → generated workId
      const normalizedItems: Array<{ spec: Record<string, unknown>; item: WorkItem }> = [];

      for (let index = 0; index < workItemsRaw.length; index++) {
        const raw = workItemsRaw[index];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const specItem = raw as Record<string, unknown>;

        const objective = typeof specItem.objective === 'string' && specItem.objective.trim().length > 0
          ? specItem.objective.trim()
          : typeof specItem.delta === 'string' && specItem.delta.trim().length > 0
            ? specItem.delta.trim()
            : typeof specItem.id === 'string' && specItem.id.trim().length > 0
              ? `Work item ${specItem.id.trim()}`
              : `Work item ${index + 1}`;

        const delta = typeof specItem.delta === 'string' && specItem.delta.trim().length > 0
          ? specItem.delta.trim()
          : undefined;

        const agent = typeof specItem.agent === 'string' && specItem.agent.trim().length > 0
          ? specItem.agent.trim()
          : 'standard';

        const domain = typeof specItem.domain === 'string' && specItem.domain.trim().length > 0
          ? specItem.domain.trim()
          : undefined;

        const dependencies = Array.isArray(specItem.dependencies)
          ? specItem.dependencies.filter((dep): dep is string => typeof dep === 'string' && dep.trim().length > 0)
          : [];

        const targetPaths = Array.isArray(specItem.targetPaths)
          ? specItem.targetPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          : [];

        const workItem = createWorkItem({
          goal: planGoal,
          objective,
          delta,
          agent,
          domain,
          dependencies: [],  // Resolved in phase 2
          targetPaths,
          stepNum: index + 1,
        });

        // Map planner's semantic ID to generated workId
        if (typeof specItem.id === 'string' && specItem.id.trim().length > 0) {
          idMap.set(specItem.id.trim(), workItem.workId);
        }

        normalizedItems.push({ spec: { ...specItem, dependencies }, item: workItem });
      }

      const items = normalizedItems.map(entry => entry.item);

      // Phase 2: Resolve dependencies using ID map (WorkItem is immutable, so clone with new deps)
      for (let i = 0; i < normalizedItems.length; i++) {
        const originalDeps = normalizedItems[i].spec.dependencies as string[] | undefined;
        if (originalDeps && originalDeps.length > 0) {
          const resolvedDeps = this.resolveWorkItemDependencies(originalDeps, idMap, 'handoff_spec');
          if (resolvedDeps.length > 0) {
            items[i] = cloneWorkItemWithDependencies(items[i], resolvedDeps);
          }
        }
      }

      this.log('info', 'Parsed handoff spec with ID remapping', {
        itemCount: items.length,
        idMappings: Array.from(idMap.entries()).map(([k, v]) => `${k} → ${v}`),
      });

      return items;
    } catch (err) {
      this.log('error', 'Failed to parse handoff spec', {
        error: err instanceof Error ? err.message : String(err),
        specPreview: typeof spec === 'string' ? spec.slice(0, 200) : JSON.stringify(spec).slice(0, 200),
      });
      return [];
    }
  }
}
