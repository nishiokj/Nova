/**
 * Orchestrator - Loop Governor for goal-driven agent execution.
 *
 * Replaces the DAG-based task coordinator with a simple loop-until-goal model:
 * - Agent decides what to do
 * - Orchestrator decides when to stop (bounds exceeded, goal reached, user input needed)
 * - Context is truth - no separate state machine
 */

import { Effect } from 'effect';
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
import { Agent } from 'agent';
import type { AgentRegistry } from 'agent';
import { createWorkItem, cloneWorkItemWithDependencies, type WorkItem } from 'work';
import { createEvent } from 'types';
import type {
  LLMRequestConfig,
  MessageItem,
  RunCancellationMetadata,
  RunControlMetadata,
  RunExecutionMetadata,
} from 'types';
import { buildLLMRequestConfig, profiler } from 'shared';
import {
  takeAllRuntimeControl,
  type RuntimeControlMessage,
  type RuntimeControlQueue,
} from 'runtime';
import {
  assertNever,
  createAgentErrorEvent,
  createBoundsExceededEvent,
  createCadenceAuditEvent,
  createGoalReachedEvent,
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
  type HookContext,
  type PromptAnswerDecision,
  type QualityGateDecision,
  type StatePatch,
  type StopHookResult,
  type WorkItemCompletedDecision,
  type TerminationReason,
} from 'protocol';
import { applyPatches } from './hookRunner/applyPatches.js';
import {
  runUnifiedDecisionHooks,
  type UnifiedDecisionAuditEntry,
  type UnifiedDecisionExecutionResult,
  type UnifiedHookFailure,
} from './unifiedHooks/runner.js';
import type { UnifiedHookRegistry } from './unifiedHooks/registry.js';
import {
  mapQualityDecisionToStopResult,
  mapBoundsDecisionToStopResult,
  mapPromptDecisionToStopResult,
  mapCadenceDecisionToStopResult,
  mapAgentErrorDecisionToStopResult,
  mapWorkItemDecisionToStopResult,
} from './decision_mappers.js';
import {
  createExecutionState,
  getElapsedMs,
  nextIteration,
  updateMetrics,
  updateRunControl,
  type ExecutionState,
  type InProgressWork,
} from './execution_state.js';

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
  /** Percent context usage that triggers compaction (default 0.50) */
  compactTriggerPercent: number;
  /** Percent context usage to reset compaction hysteresis (default 0.45) */
  compactResetPercent: number;
  /** Max file content items to keep during compaction */
  compactMaxFileCount: number;
  /** Max chars per tool output during compaction */
  compactTruncateTo: number;
  /** Minimum iteration gap between observer evaluations (default 5) */
  minObserverIterationGap: number;
  /** Maximum realign attempts before forcing termination (default 3) */
  maxRealigns: number;
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
 * State passed to the onIteration callback for observer evaluation.
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
  hookRegistry?: UnifiedHookRegistry;
  /**
   * Session-scoped effect hook executor (harness-owned runtime path).
   * Orchestrator enqueues internal hook events and delegates execution to this callback.
   */
  executeEffectHook?: (
    event: InternalHookEvent,
    context: InternalHookContext,
    signal?: AbortSignal
  ) => Promise<void>;
  /**
   * Check for pending user interruption that arrived during execution.
   * Called before terminating on goal_state_reached.
   * If returns true, orchestrator creates new work item and continues.
   */
  checkInterruption?: () => boolean;
  /**
   * Optional runtime control queue for cancel orchestration control.
   */
  controlQueue?: RuntimeControlQueue;
  /**
   * Optional lifecycle hook for wiring external subscriptions.
   * Return a cleanup function to run when execution ends.
   */
  onStart?: (context: ContextWindow) => void | (() => void);
  /**
   * Called each iteration with execution state.
   * May be sync or async.
   */
  onIteration?: (state: IterationState) => void | Promise<void>;
  /**
   * Optional run-control snapshot provider used to annotate terminal results/events.
   */
  getRunControl?: () => RunControlMetadata | undefined;
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
  minObserverIterationGap: 5,
  maxRealigns: 3,
};

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
  cancellationMetadata?: RunCancellationMetadata;
  runControl: RunControlMetadata;
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

type WorkExecutionResult = {
  workId: string;
  item: WorkItem;
  result: AgentResult;
};

type StopHookDecisionEventType =
  | 'goal_state_reached'
  | 'bounds_exceeded'
  | 'user_input_required'
  | 'cadence_audit'
  | 'agent_error'
  | 'work_item_completed';

interface CallStopHookParams {
  context: ContextWindow;
  terminationReason: TerminationReason;
  response: string;
  iteration: number;
  agentType: string;
  runtime?: OrchestratorRuntime;
  userPrompt?: UserPromptInfo;
  agentResult?: AgentResult;
  workId?: string;
  objective?: string;
  totalLlmCalls?: number;
  totalToolCalls?: number;
  cadence?: { elapsedMs: number; toolCallsSinceLastAudit: number; recentActivity: string; workIds?: string[] };
  controlEventType?: 'goal_state_reached' | 'work_item_completed';
}

type ControlHookExecutionResult<D> =
  | (UnifiedDecisionExecutionResult<D> & { status: 'decision' | 'no_decision' | 'no_hooks' })
  | {
      status: 'no_registry';
      decision: null;
      patches: StatePatch[];
      failures: UnifiedHookFailure[];
      hasCriticalFailure: boolean;
      audit: UnifiedDecisionAuditEntry[];
    };

interface WorkQueueAdapter {
  enqueue(item: WorkItem): string;
  dequeueAllReady(): WorkItem[];
  size(): number;
  hasPending(): boolean;
  clear(): void;
}

interface CheckTerminationParams {
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
  inProgress: Map<string, InProgressWork>;
  goal: string;
  cwd: string;
  runtime?: OrchestratorRuntime;
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

type SyntheticResultTerminationReason = Extract<TerminationReason, 'goal_state_reached' | 'agent_error' | 'user_stopped'>;

const BOUNDS_TERMINATION_REASONS = new Set<TerminationReason>([
  'max_iterations_exceeded',
  'max_tool_calls_exceeded',
  'max_duration_exceeded',
]);

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
  private getModelSelection?: (agentType: string) => ModelSelection | null;
  private hookQueue: InternalHookQueue;
  private activeSessionKey?: string;

  // Work queue state for DAG-based execution
  private workQueue: WorkItem[] = [];
  private completedWork: Map<string, AgentResult> = new Map();
  private initialWorkId: string = '';
  private workItemContexts: Map<string, ContextWindow> = new Map();

  // Realign counter to prevent infinite loops when bounds are exceeded
  // After config.maxRealigns, we force termination instead of continuing
  private realignCount: number = 0;
  private hookMetadata: Map<string, unknown> = new Map();
  private hookAuditLog: Array<{ timestamp: number; source: string; event: string; details: Record<string, unknown> }> = [];
  private hookTerminationReason: TerminationReason | null = null;
  private effectHookExecutor?: (
    event: InternalHookEvent,
    context: InternalHookContext,
    signal?: AbortSignal
  ) => Promise<void>;
  private activeInProgress: Map<string, InProgressWork> | null = null;
  private runtimeRunControl: RunControlMetadata = { state: 'running' };

  constructor(
    config: Partial<OrchestratorConfig>,
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    emit: EventEmitCallback,
    requestId: string,
    logger?: OrchestratorLogger,
    agentRegistry?: AgentRegistry,
    hooks?: AgentHooks,
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
            handler: (signal?: AbortSignal) => this.executeEffectHook(event, context, signal),
          },
        });

        this.enqueue(hookWorkItem);
      },
    };
  }

  private awaitHookAbort(signal?: AbortSignal): Effect.Effect<never, Error> {
    if (!signal) {
      return Effect.never;
    }
    return Effect.async<never, Error>((resume) => {
      if (signal.aborted) {
        resume(Effect.fail(new Error('hook_cancelled')));
        return;
      }
      const onAbort = () => {
        resume(Effect.fail(new Error('hook_cancelled')));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      return Effect.sync(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private async runHookHandler(params: {
    handler: (signal?: AbortSignal) => Promise<void>;
    hookType: string;
    workItemId: string;
    event?: InternalHookEvent;
    hookContext?: InternalHookContext;
    contextWindow: ContextWindow;
    signal?: AbortSignal;
  }): Promise<void> {
    const timeoutMs = this.config.hookTimeoutMs;
    const start = Date.now();
    const callId = `hook-${params.hookType}-${params.workItemId}`;
    const hookArgs = {
      hookType: params.hookType,
      event: params.event,
      context: params.hookContext,
    };
    params.contextWindow.addFunctionCall(callId, `hook:${params.hookType}`, hookArgs);

    this.emit(createEvent('hook_call', {
      hookType: params.hookType,
      phase: 'starting',
    }, params.workItemId, this.requestId));
    let success = false;
    let error: string | undefined;
    try {
      const handlerResult = params.handler(params.signal);
      await Effect.runPromise(
        Effect.tryPromise({
          try: () => handlerResult,
          catch: (e) => e as Error,
        }).pipe(
          Effect.timeoutFail({
            duration: timeoutMs,
            onTimeout: () => new Error('hook_timeout'),
          }),
          Effect.raceFirst(this.awaitHookAbort(params.signal))
        )
      );
      success = true;
      this.emit(createEvent('hook_call', {
        hookType: params.hookType,
        phase: 'completed',
        success,
        durationMs: Date.now() - start,
      }, params.workItemId, this.requestId));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.emit(createEvent('hook_call', {
        hookType: params.hookType,
        phase: 'completed',
        success: false,
        error,
        durationMs: Date.now() - start,
      }, params.workItemId, this.requestId));
      this.log('error', 'Internal hook handler failed', {
        hookType: params.hookType,
        workItemId: params.workItemId,
        error,
      });
    } finally {
      params.contextWindow.addFunctionCallOutput(
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
    }
  }

  private async executeEffectHook(
    event: InternalHookEvent,
    context: InternalHookContext,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.effectHookExecutor) {
      return;
    }
    await this.effectHookExecutor(event, context, signal);
  }

  /**
   * Main entry point: Execute until goal is reached or bounds exceeded.
   *
   * @param context - The context window for the session
   * @param goal - The goal to achieve
   * @param agentType - The type of agent to use
   * @param cwd - Working directory for tool execution (required for concurrent-safe operation)
   */
  execute(
    context: ContextWindow,
    goal: string,
    agentType: string = 'standard',
    cwd: string,
    runtime?: OrchestratorRuntime
  ): Effect.Effect<OrchestratorResult, never> {
    const startedAt = Date.now();
    return Effect.acquireUseRelease(
      Effect.sync(() => runtime?.onStart?.(context)),
      () => this.executeInner(context, goal, agentType, cwd, runtime),
      (cleanup) => Effect.sync(() => {
        if (typeof cleanup === 'function') cleanup();
      })
    ).pipe(
      Effect.catchAllDefect((defect) => Effect.sync(() => {
        const message = defect instanceof Error ? defect.message : String(defect);
        this.log('error', 'Orchestrator execution failed', { goal, agentType, error: message });
        return this.createResult({
          success: false,
          response: '',
          error: message,
          terminationReason: 'agent_error',
          metrics: {
            iterations: 0,
            totalLlmCalls: 0,
            totalToolCalls: 0,
            durationMs: Date.now() - startedAt,
          },
        });
      }))
    );
  }

  /**
   * Inner execution logic, wrapped by execute() for cleanup.
   */
  private executeInner(
    context: ContextWindow,
    goal: string,
    agentType: string,
    cwd: string,
    runtime?: OrchestratorRuntime
  ): Effect.Effect<OrchestratorResult> {
    return Effect.gen(this, function* () {
      this.effectHookExecutor = runtime?.executeEffectHook;
      this.resetExecutionState(context);
      this.runtimeRunControl = this.cloneRunControlMetadata(runtime?.getRunControl?.());

      const workQueue = this.createWorkQueueAdapter();
      const seedResult = this.seedWorkQueueFromGoal({ goal, agentType, workQueue });
      const state = createExecutionState(seedResult.initialWorkId, this.cloneRunControlMetadata(this.runtimeRunControl));

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

      this.activeInProgress = state.inProgress;
      try {
        return yield* this.runExecutionLoop({
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
      } finally {
        this.activeInProgress = null;
      }
    });
  }

  private resetExecutionState(context: ContextWindow): void {
    this.workQueue = [];
    this.completedWork.clear();
    this.workItemContexts.clear();
    this.initialWorkId = '';
    this.realignCount = 0;
    this.hookMetadata = new Map();
    this.hookAuditLog = [];
    this.hookTerminationReason = null;
    this.activeSessionKey = context.sessionKey;
    this.activeInProgress = null;
    this.runtimeRunControl = { state: 'running' };
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

  private seedWorkQueueFromGoal(params: {
    goal: string;
    agentType: string;
    workQueue: WorkQueueAdapter;
  }): { goal: string; initialWorkId: string } {
    const { goal, agentType, workQueue } = params;
    const initialItem = this.createWorkItem(goal, agentType);
    this.initialWorkId = initialItem.workId;
    workQueue.enqueue(initialItem);
    return { goal, initialWorkId: this.initialWorkId };
  }

  private createTerminationPolicy(): TerminationPolicy {
    return {
      checkIterationBounds: async ({ state, context, agentType, runtime, goal, now }) => {
        if (state.iteration > this.config.maxIterations) {
          this.log('warning', 'Max iterations exceeded', { iteration: state.iteration, completedWork: this.completedWork.size });
          const stopResult = await this.callStopHook({
            context,
            terminationReason: 'max_iterations_exceeded',
            response: '',
            iteration: state.iteration,
            agentType,
            runtime,
            objective: goal,
            totalLlmCalls: state.totalLlmCalls,
            totalToolCalls: state.totalToolCalls,
          });
          if (this.handleStopHookBlock(stopResult, context, agentType, state.iteration, 'max_iterations_exceeded')) {
            return { terminal: null, shouldContinue: true };
          }
          this.emitGoalNotAchieved(goal, 'max_iterations_exceeded');
          const harvestedResponse = this.harvestCompletedWork(state.inProgress, 'max_iterations_exceeded');
          return {
            terminal: this.createResult({
              success: false,
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

        const workIdsForAudit = activeWorkIds.length > 0
          ? activeWorkIds
          : (state.lastAgentWorkId ? [state.lastAgentWorkId] : []);
        const recentActivity = workIdsForAudit.length > 0
          ? workIdsForAudit.map((workId) => {
              const result = resultsByWorkId.get(workId)
                ?? (workId === state.lastAgentWorkId ? state.lastAgentResult : undefined);
              const preview = result?.response?.slice(0, 200) ?? '';
              return `- ${workId}: ${preview || '[no response]'}`;
            }).join('\n')
          : (state.lastAgentResult?.response?.slice(0, 200) ?? '');

        const cadenceResult = await this.callStopHook({
          context,
          terminationReason: 'cadence_audit' as TerminationReason,
          response: auditResult?.response ?? '',
          iteration: state.iteration,
          agentType,
          runtime,
          agentResult: auditResult,
          workId: auditWorkId,
          objective: auditItem?.objective ?? goal,
          totalLlmCalls: state.totalLlmCalls,
          totalToolCalls: state.totalToolCalls,
          cadence: {
            elapsedMs: cadenceNow - state.startTime,
            toolCallsSinceLastAudit,
            recentActivity,
            workIds: workIdsForAudit,
          },
        });

        if (cadenceResult) {
          this.enqueueDeferredWork(cadenceResult);

          // Inject observer guidance even on 'allow' - makes cadence audits actually do something
          if (cadenceResult.systemMessage && cadenceResult.decision === 'allow') {
            context.addMessage('system', cadenceResult.systemMessage);
          }

          if (cadenceResult.decision === 'block' && cadenceResult.reason) {
            // Observer wants to realign — inject new work item
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

  private cloneRunControlMetadata(control?: RunControlMetadata): RunControlMetadata {
    if (!control) {
      return { state: 'running' };
    }
    return {
      state: control.state,
      cancellation: control.cancellation
        ? {
            ...control.cancellation,
            targetWorkIds: control.cancellation.targetWorkIds
              ? [...control.cancellation.targetWorkIds]
              : undefined,
          }
        : undefined,
    };
  }

  private buildRunControlTarget(message: RuntimeControlMessage): {
    scope: 'run' | 'work_item' | 'tool';
    runId?: string;
    workItemIds?: string[];
  } {
    const workItemIds = message.cancellation?.targetWorkIds
      ?? (message.workItemId ? [message.workItemId] : undefined);
    const scope = message.cancellation?.scope ?? (workItemIds?.length ? 'work_item' : 'run');
    return {
      scope,
      runId: message.runId,
      workItemIds,
    };
  }

  private isRunScopedCancellation(control: RunControlMetadata = this.runtimeRunControl): boolean {
    const state = control.state;
    if (state !== 'cancelling' && state !== 'cancelled') {
      return false;
    }
    const scope = control.cancellation?.scope ?? 'run';
    return scope === 'run';
  }

  private applyRuntimeControlMessage(message: RuntimeControlMessage): void {
    if (message.action === 'continue') {
      this.runtimeRunControl = {
        state: 'running',
        cancellation: this.runtimeRunControl.cancellation,
      };
      return;
    }

    const stateBefore = this.runtimeRunControl.state;
    const target = this.buildRunControlTarget(message);
    const source = message.cancellation?.requestedBy ?? 'system';

    this.emit(createEvent('run_control_requested', {
      action: message.action,
      source,
      target,
      stateBefore,
      cancellation: message.cancellation,
    }, message.workItemId, this.requestId));

    if (message.action !== 'cancel') {
      return;
    }

    const cancellation = message.cancellation ?? {
      requestedAt: Date.now(),
      requestedBy: source,
      reason: 'Execution cancelled by runtime control',
      scope: target.scope,
      targetWorkIds: target.workItemIds,
    };
    const cancellationScope = cancellation.scope ?? target.scope;
    const targetIds = cancellation.targetWorkIds;
    if (cancellationScope !== 'run' && (!targetIds || targetIds.length === 0)) {
      this.emit(createEvent('run_control_rejected', {
        action: message.action,
        source,
        target,
        stateBefore,
        reason: 'missing_target_work_items',
        cancellation,
      }, message.workItemId, this.requestId));
      return;
    }

    if (cancellationScope === 'run') {
      this.runtimeRunControl = {
        state: 'cancelling',
        cancellation,
      };
    } else {
      this.runtimeRunControl = {
        state: this.runtimeRunControl.state === 'cancelled' ? 'cancelled' : this.runtimeRunControl.state,
        cancellation: undefined,
      };
    }

    const cancelReason = cancellation.reason ?? 'Execution cancelled by runtime control';
    if (targetIds && targetIds.length > 0) {
      for (const workId of targetIds) {
        this.cancelInProgressWork(workId, cancelReason);
      }
    } else if (cancellationScope === 'run' && this.activeInProgress) {
      for (const workId of this.activeInProgress.keys()) {
        this.cancelInProgressWork(workId, cancelReason);
      }
    }

    this.emit(createEvent('run_control_applied', {
      action: message.action,
      source,
      target,
      stateBefore,
      stateAfter: this.runtimeRunControl.state,
      cancellation,
    }, message.workItemId, this.requestId));
  }

  private syncRuntimeControlState(runtime?: OrchestratorRuntime): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (runtime?.controlQueue) {
        const messages = yield* takeAllRuntimeControl(runtime.controlQueue);
        for (const message of messages) {
          this.applyRuntimeControlMessage(message);
        }
        if (messages.length > 0) {
          return;
        }
      }

      const controlSnapshot = runtime?.getRunControl?.();
      if (controlSnapshot) {
        this.runtimeRunControl = this.cloneRunControlMetadata(controlSnapshot);
      }
    });
  }

  private quiesceInProgressWork(state: ExecutionState, reason: string): void {
    for (const workId of state.inProgress.keys()) {
      this.cancelInProgressWork(workId, reason);
    }
    state.inProgress.clear();
  }

  private buildAgentRunControl(
    workItemId: string,
    attempt: number
  ): {
    execution: RunExecutionMetadata;
    control: RunControlMetadata;
  } {
    return {
      execution: {
        requestId: this.requestId,
        runId: this.requestId,
        workItemId,
        attempt,
      },
      control: this.runtimeRunControl,
    };
  }

  private createSyntheticAgentResult(params: {
    context: ContextWindow;
    terminationReason: SyntheticResultTerminationReason;
    success: boolean;
    response?: string;
    error?: string;
  }): AgentResult {
    const { context, terminationReason, success, response = '', error } = params;
    return {
      success,
      response,
      error,
      metrics: { llmCallsMade: 0, toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, durationMs: 0 },
      filesRead: [],
      invalidatedPaths: [],
      toolErrors: [],
      terminationReason,
      needsUserInput: false,
      isRefusal: false,
      localContext: context,
    };
  }

  private createInternalHookResult(context: ContextWindow): AgentResult {
    return this.createSyntheticAgentResult({
      context,
      terminationReason: 'goal_state_reached',
      success: true,
    });
  }

  private async executeSingleWorkItem(params: {
    workId: string;
    inProgress: InProgressWork;
    context: ContextWindow;
    cwd: string;
    iteration: number;
  }): Promise<WorkExecutionResult> {
    const { workId, inProgress, context, cwd, iteration } = params;
    const { item, agent, abortController } = inProgress;
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
        await this.runHookHandler({
          handler: handler as (signal?: AbortSignal) => Promise<void>,
          hookType: String(hookParams?.hookType ?? 'unknown'),
          workItemId: workId,
          event: hookParams?.event,
          hookContext: hookParams?.hookContext,
          contextWindow: context,
          signal: abortController?.signal,
        });
        return { workId, item, result: this.createInternalHookResult(context) };
      }

      if (!agent) {
        throw new Error(`Missing agent for work item: ${workId}`);
      }
      const agentAsyncId = profiler.asyncBegin(`agent:${item.agent}`, 'agent');
      const workContext = this.resolveWorkItemContext(workId, context);
      const result = await Effect.runPromise(agent.run({
        globalContext: workContext,
        workItem: item,
        cwd,
        signal: abortController?.signal,
        runControl: this.buildAgentRunControl(workId, iteration),
      }));
      profiler.asyncEnd(`agent:${item.agent}`, agentAsyncId, 'agent', {
        llmCalls: result.metrics.llmCallsMade,
        toolCalls: result.metrics.toolCallsMade,
      });
      return { workId, item, result };
    } catch (err) {
      const cancelReason = this.activeInProgress?.get(workId)?.cancelReason;
      if (cancelReason) {
        return { workId, item, result: this.createCancelledWorkItemResult(cancelReason, context) };
      }
      const error = err instanceof Error ? err.message : String(err);
      return { workId, item, result: this.createErrorResult(error, context) };
    }
  }

  private async executeInProgressWorkItems(params: {
    entries: Array<[string, InProgressWork]>;
    context: ContextWindow;
    cwd: string;
    iteration: number;
  }): Promise<WorkExecutionResult[]> {
    const { entries, context, cwd, iteration } = params;
    if (entries.length === 0) {
      return [];
    }

    return Promise.all(
      entries.map(([workId, inProgress]) =>
        this.executeSingleWorkItem({ workId, inProgress, context, cwd, iteration })
      )
    );
  }

  private executeInProgressWorkItemsWithRuntimeControl(params: {
    entries: Array<[string, InProgressWork]>;
    context: ContextWindow;
    cwd: string;
    iteration: number;
    runtime?: OrchestratorRuntime;
    state: ExecutionState;
  }): Effect.Effect<WorkExecutionResult[]> {
    const { entries, context, cwd, iteration, runtime, state } = params;

    return Effect.promise(async () => {
      const executionPromise = this.executeInProgressWorkItems({
        entries, context, cwd, iteration,
      });

      if (!runtime?.controlQueue) {
        return executionPromise;
      }

      let settled = false;
      const monitorPromise = (async () => {
        while (!settled) {
          await Effect.runPromise(this.syncRuntimeControlState(runtime));

          if (this.isRunScopedCancellation(this.runtimeRunControl)) {
            const reason = this.runtimeRunControl.cancellation?.reason ?? 'Execution cancelled by runtime control';
            this.quiesceInProgressWork(state, reason);
          }

          if (settled) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })();

      try {
        return await executionPromise;
      } finally {
        settled = true;
        await monitorPromise;
      }
    });
  }

  private maybeCreateRuntimeControlResult(params: {
    state: ExecutionState;
    goal: string;
  }): OrchestratorResult | null {
    const { state, goal } = params;
    if (!this.isRunScopedCancellation(this.runtimeRunControl)) {
      return null;
    }

    const now = Date.now();
    const cancellationReason = this.runtimeRunControl.cancellation?.reason ?? 'Execution cancelled by runtime control';
    const harvestedResponse = this.harvestCompletedWork(state.inProgress, 'user_stopped');
    this.quiesceInProgressWork(state, cancellationReason);
    this.runtimeRunControl = {
      state: 'cancelled',
      cancellation: this.runtimeRunControl.cancellation,
    };
    const response = state.initialWorkResponse || harvestedResponse;
    this.emitGoalNotAchieved(goal, 'user_stopped');
    return this.createResult({
      success: !!response,
      response,
      error: cancellationReason,
      cancellationMetadata: this.runtimeRunControl.cancellation,
      runControl: this.cloneRunControlMetadata(this.runtimeRunControl),
      terminationReason: 'user_stopped',
      metrics: {
        iterations: state.iteration,
        totalLlmCalls: state.totalLlmCalls,
        totalToolCalls: state.totalToolCalls,
        durationMs: now - state.startTime,
      },
    });
  }

  private runExecutionLoop(params: {
    context: ContextWindow;
    goal: string;
    agentType: string;
    cwd: string;
    runtime?: OrchestratorRuntime;
    state: ExecutionState;
    workQueue: WorkQueueAdapter;
    terminationPolicy: TerminationPolicy;
    cadenceAuditor: CadenceAuditor;
  }): Effect.Effect<OrchestratorResult> {
    return Effect.gen(this, function* () {
    const { context, goal, agentType, cwd, runtime, state, workQueue, terminationPolicy, cadenceAuditor } = params;

    while (workQueue.hasPending() || state.inProgress.size > 0) {
      yield* this.syncRuntimeControlState(runtime);
      updateRunControl(state, this.cloneRunControlMetadata(this.runtimeRunControl));
      const controlResult = this.maybeCreateRuntimeControlResult({ state, goal });
      if (controlResult) {
        return controlResult;
      }

      const readyItems = workQueue.dequeueAllReady();

      for (const item of readyItems) {
        const hookParams = item.params as { isInternalHook?: boolean } | undefined;
        if (hookParams?.isInternalHook) {
          state.inProgress.set(item.workId, {
            item,
            agent: null,
            abortController: new AbortController(),
          });
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
        state.inProgress.set(item.workId, { item, agent, abortController: new AbortController() });
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

      if (runtime?.onIteration) {
        yield* Effect.promise(async () => {
          await runtime.onIteration!({
            iteration,
            context,
            totalToolCalls: state.totalToolCalls,
            totalLlmCalls: state.totalLlmCalls,
            elapsedMs: elapsed,
          });
        });
      }

      this.maybeAutoCompact(context, agentType, state);

      const iterationCheck = yield* Effect.promise(() => terminationPolicy.checkIterationBounds({
        state,
        context,
        agentType,
        runtime,
        goal,
        now,
      }));
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

      const results = yield* this.executeInProgressWorkItemsWithRuntimeControl({
        entries: Array.from(state.inProgress.entries()),
        context,
        cwd,
        iteration,
        runtime,
        state,
      });
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

        if (this.isRunScopedCancellation(this.runtimeRunControl)) {
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
          const checkResult = yield* Effect.promise(() => terminationPolicy.checkResult({
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
          }));

          if (checkResult.terminal) {
            terminalResult = checkResult.terminal;
            continue;
          }

          if (checkResult.shouldContinue) {
            if (checkResult.newItem) {
              workQueue.enqueue(checkResult.newItem);
              this.resetInitialWorkState(state, this.resetWorkTracking(checkResult.newItem));
            } else if (this.initialWorkId !== state.initialWorkId) {
              // Some continuation paths (e.g. user_input hook answers) enqueue via
              // handleStopHookBlock and update orchestrator-level tracking directly.
              // Keep execution-state tracking aligned with that canonical initial work id.
              this.resetInitialWorkState(state, this.initialWorkId);
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
            const stopResult = yield* Effect.promise(() => this.callStopHook({
              context,
              terminationReason: 'goal_state_reached',
              response: result.response ?? '',
              iteration,
              agentType: item.agent,
              runtime,
              agentResult: result,
              workId,
              objective: item.objective,
              totalLlmCalls: state.totalLlmCalls,
              totalToolCalls: state.totalToolCalls,
              controlEventType: 'work_item_completed',
            }));

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
                  this.resetInitialWorkState(state, this.resetWorkTracking(retryItem));
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

      yield* Effect.promise(() => cadenceAuditor.maybeAudit(resultsByWorkId));

      if (state.initialWorkCompleted && !workQueue.hasPending() && state.inProgress.size === 0) {
        if (runtime?.checkInterruption?.()) {
          this.log('info', 'Pending interruption detected, continuing execution', { iteration });
          const newItem = this.createWorkItem('Continue with user input', agentType);
          workQueue.enqueue(newItem);
          this.resetInitialWorkState(state, this.resetWorkTracking(newItem));
          continue;
        }

        if (runtime?.hookRegistry) {
          const stopResult = yield* Effect.promise(() => this.callStopHook({
            context,
            terminationReason: 'goal_state_reached' as TerminationReason,
            response: state.initialWorkResponse,
            iteration,
            agentType,
            runtime,
            agentResult: state.initialWorkResult,
            workId: state.initialWorkId,
            objective: goal,
            totalLlmCalls: state.totalLlmCalls,
            totalToolCalls: state.totalToolCalls,
          }));

          if (stopResult) {
            this.enqueueDeferredWork(stopResult);

            if (workQueue.hasPending()) {
              this.log('info', 'Deferred work enqueued, continuing loop', {
                iteration,
                queuedItems: workQueue.size(),
              });
              this.resetInitialWorkState(state);
              continue;
            }

            if (stopResult.decision === 'block') {
              const reason = stopResult.reason || 'Quality gate failed';
              this.log('info', 'Control hook blocked termination, re-injecting prompt', {
                iteration,
                promptPreview: reason.slice(0, 100),
              });

              this.emit(createEvent('agent_progress', {
                kind: 'work',
                message: stopResult.systemMessage || `Control hook continuing (iteration ${iteration})`,
                requestId: this.requestId,
              }));

              if (stopResult.systemMessage) {
                context.addMessage('system', stopResult.systemMessage);
              }

              const newItem = this.createWorkItem(reason, agentType);
              workQueue.enqueue(newItem);

              this.resetInitialWorkState(state, this.resetWorkTracking(newItem));

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
    const config = this.agentRegistry.getConfig(agentType);

    // Build LLM config from model selection (source of truth) + agent's llmParams
    const llmConfig = this.buildLlmConfig(config.llmParams, agentType);

    // Wire cadence check: invokes control hooks at tool-call thresholds for real oversight.
    // Fires every 60 tool calls OR every 5 minutes, whichever comes first.
    // This gives the observer real intervention power during execution.
    let lastCadenceToolCalls = 0;
    let lastCadenceTimeMs = Date.now();
    const CADENCE_TOOL_THRESHOLD = 60;  // Every 60 tool calls
    const CADENCE_TIME_THRESHOLD_MS = 300_000;  // Every 5 minutes

    const cadenceCheck = async (metrics: AgentCadenceMetrics): Promise<AgentCadenceResult> => {
      const toolCallsSinceLast = metrics.toolCallsMade - lastCadenceToolCalls;
      const timeSinceLast = Date.now() - lastCadenceTimeMs;
      const shouldInvokeObserver = runtime?.hookRegistry && (
        toolCallsSinceLast >= CADENCE_TOOL_THRESHOLD ||
        timeSinceLast >= CADENCE_TIME_THRESHOLD_MS
      );

      if (shouldInvokeObserver && runtime?.hookRegistry) {
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
                    terminationReason: 'observer_work_item_stopped',
                    reason: decision.reason,
                  };
                case 'stop':
                  return {
                    action: 'stop',
                    systemMessage: decision.reason,
                    terminationReason: 'observer_stopped',
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
            case 'no_registry':
              break;
            default:
              assertNever(hookResult);
          }
        } catch (err) {
          // Don't crash on observer failure - log and continue
          this.log('warning', 'Cadence check observer invocation failed', {
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

    // Merge hooks: cadence check for observer oversight.
    const mergedHooks: AgentHooks = {
      ...this.hooks,
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

  private createResult(
    partial: Partial<OrchestratorResult> & { terminationReason: TerminationReason; metrics: OrchestratorMetrics }
  ): OrchestratorResult {
    const runControl = partial.runControl ?? this.deriveRunControlMetadata(partial);
    return {
      success: partial.success ?? false,
      response: partial.response ?? '',
      error: partial.error,
      cancellationMetadata: partial.cancellationMetadata ?? runControl.cancellation,
      runControl,
      userPrompt: partial.userPrompt,
      terminationReason: partial.terminationReason,
      metrics: partial.metrics,
    };
  }

  private deriveRunControlMetadata(
    partial: Partial<OrchestratorResult>
  ): RunControlMetadata {
    if (partial.runControl) {
      return partial.runControl;
    }
    const base = this.cloneRunControlMetadata(this.runtimeRunControl);

    const cancellationReasons = new Set<TerminationReason>([
      'user_stopped',
      'observer_stopped',
      'observer_work_item_stopped',
    ]);

    if (partial.terminationReason && cancellationReasons.has(partial.terminationReason)) {
      return {
        state: 'cancelled',
        cancellation: partial.cancellationMetadata ?? base.cancellation,
      };
    }

    return {
      state: base.state,
      cancellation: partial.cancellationMetadata ?? base.cancellation,
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
    return this.createSyntheticAgentResult({
      context,
      terminationReason: 'agent_error',
      success: false,
      error,
    });
  }

  private createCancelledWorkItemResult(reason: string, context: ContextWindow): AgentResult {
    return this.createSyntheticAgentResult({
      context,
      terminationReason: 'user_stopped',
      success: false,
      error: reason,
    });
  }

  private cancelInProgressWork(workId: string, reason: string): boolean {
    const active = this.activeInProgress?.get(workId);
    if (!active) {
      return false;
    }

    active.cancelReason = reason;

    if (active.abortController && !active.abortController.signal.aborted) {
      active.abortController.abort(reason);
    }

    return true;
  }

  /**
   * Reset work tracking for continuation after interruption or stop hook block.
   */
  private resetWorkTracking(newItem: WorkItem): string {
    this.completedWork.delete(this.initialWorkId);
    this.initialWorkId = newItem.workId;
    return this.initialWorkId;
  }

  private resetInitialWorkState(state: ExecutionState, newInitialWorkId?: string): void {
    state.initialWorkCompleted = false;
    state.initialWorkResponse = '';
    state.initialWorkResult = undefined;

    if (newInitialWorkId) {
      state.initialWorkId = newInitialWorkId;
      state.startTime = Date.now();
    }
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
      cancelInProgressWork: (workId, reason) => this.cancelInProgressWork(workId, reason),
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
  ): Promise<ControlHookExecutionResult<DecisionFor<E>>> {
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
    const result = await Effect.runPromise(runUnifiedDecisionHooks(event, ctx, registry));
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
        const firstQuestion = userPrompt.questions?.[0];
        if (!firstQuestion?.question) return null;
        const options = firstQuestion.options?.map(option => {
          if (typeof option === 'string') {
            return { label: option };
          }
          return { label: option.label, description: option.description };
        });
        return createUserInputRequiredEvent(
          context.sessionKey,
          workId,
          firstQuestion.question,
          options,
          firstQuestion.context,
          firstQuestion.multiSelect ?? false
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
      case 'no_action': {
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
      case 'user_stopped':
      case 'observer_stopped':
      case 'observer_work_item_stopped':
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
    result: ControlHookExecutionResult<D>,
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
        return null;
      default:
        return assertNever(result);
    }
  }

  /**
   * Call control-plane hooks and return a stop-style decision.
   * Returns null if no hook registry configured or if hooks fail.
   */
  private async runMappedStopHookDecision<E extends StopHookDecisionEventType>(params: {
    event: EventFor<E>;
    hookContext: HookContext;
    context: ContextWindow;
    runtime: OrchestratorRuntime;
    mapper: (decision: DecisionFor<E>) => StopHookResult;
  }): Promise<StopHookResult | null> {
    const { event, hookContext, context, runtime, mapper } = params;
    const hookResult = await this.runControlHooks<E>(event, hookContext, context, runtime);
    return this.resolveHookDecision(event.type, hookResult, mapper);
  }

  private async callStopHook(params: CallStopHookParams): Promise<StopHookResult | null> {
    const { context, terminationReason, response, iteration, agentType, runtime, userPrompt, agentResult, workId, objective, totalLlmCalls, totalToolCalls, cadence, controlEventType } = params;
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
        case 'goal_state_reached':
          return this.runMappedStopHookDecision<'goal_state_reached'>({
            event,
            hookContext,
            context,
            runtime,
            mapper: mapQualityDecisionToStopResult,
          });
        case 'bounds_exceeded':
          return this.runMappedStopHookDecision<'bounds_exceeded'>({
            event,
            hookContext,
            context,
            runtime,
            mapper: mapBoundsDecisionToStopResult,
          });
        case 'user_input_required':
          return this.runMappedStopHookDecision<'user_input_required'>({
            event,
            hookContext,
            context,
            runtime,
            mapper: mapPromptDecisionToStopResult,
          });
        case 'cadence_audit':
          return this.runMappedStopHookDecision<'cadence_audit'>({
            event,
            hookContext,
            context,
            runtime,
            mapper: mapCadenceDecisionToStopResult,
          });
        case 'agent_error':
          return this.runMappedStopHookDecision<'agent_error'>({
            event,
            hookContext,
            context,
            runtime,
            mapper: mapAgentErrorDecisionToStopResult,
          });
        case 'work_item_completed':
          return this.runMappedStopHookDecision<'work_item_completed'>({
            event,
            hookContext,
            context,
            runtime,
            mapper: mapWorkItemDecisionToStopResult,
          });
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

    // === HARD SAFETY CAP (checked first, before any processing) ===
    // Every bounds_exceeded hook call counts toward the cap, regardless of decision type.
    // This prevents alternating realign/split from bypassing maxRealigns.
    const isBoundsExceeded = terminationReason ? BOUNDS_TERMINATION_REASONS.has(terminationReason) : false;

    if (isBoundsExceeded) {
      this.realignCount++;
      this.log('info', 'Bounds hook call count incremented', {
        realignCount: this.realignCount,
        maxRealigns: this.config.maxRealigns,
        terminationReason,
      });

      if (this.realignCount > this.config.maxRealigns) {
        this.log('warning', 'Max realigns exceeded, forcing termination', {
          realignCount: this.realignCount,
          terminationReason,
        });
        return false;
      }
    }

    // === DEFERRED WORK ===
    const queueSizeBefore = this.workQueue.length;
    this.enqueueDeferredWork(stopResult);
    const deferredWorkAdded = this.workQueue.length > queueSizeBefore;

    if (deferredWorkAdded) {
      this.log('info', 'Deferred work added', {
        iteration,
        terminationReason,
        newItems: this.workQueue.length - queueSizeBefore,
        decision: stopResult.decision,
      });
      if (stopResult.decision !== 'block') {
        return true;
      }
    }

    if (stopResult.decision !== 'block') {
      return false;
    }

    const reason = stopResult.reason || 'Hook blocked termination';

    this.log('info', 'Control hook blocked termination, re-injecting prompt', {
      iteration,
      terminationReason,
      promptPreview: reason.slice(0, 100),
    });

    // For user_input_required: the observer answered the question.
    // Inject the answer as a USER message (simulating user response),
    // not as a new goal. This preserves the conversational flow.
    if (terminationReason === 'user_input_required') {
      if (stopResult.systemMessage) {
        context.addMessage('system', stopResult.systemMessage);
      }
      // The observer's answer goes as a user message (like a human would respond)
      context.addMessage('user', reason);
      // Continue with a generic goal - the answer is now in context
      const newItem = this.createWorkItem('Continue with the provided answer', agentType);
      this.enqueue(newItem);
      this.resetWorkTracking(newItem);
      return true;
    }

    // Default handling for other termination reasons (hook-directed continuation, bounds exceeded, etc.)
    // The reason becomes the new work item's goal
    if (stopResult.systemMessage) {
      context.addMessage('system', stopResult.systemMessage);
    }

    const newItem = this.createWorkItem(reason, agentType);
    this.enqueue(newItem);
    this.resetWorkTracking(newItem);

    return true;
  }

  /**
   * Enqueue deferred work items from a hook result.
   * These are fire-and-forget work items that don't block the current decision.
   * When bounds are specified by the observer, they override agent registry defaults.
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
    inProgress: Map<string, InProgressWork>,
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
   */
  private async checkTerminationConditions(params: CheckTerminationParams): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, context, agentType, goal, runtime } = params;

    // Extract structured output early for use in multiple checks
    const structured = result.structuredOutput as { action?: string; goalStateReached?: boolean } | undefined;
    const actionIsContinue = structured?.action === 'continue';

    // --- User input needed (via PromptUser tool) ---
    if (result.needsUserInput && result.userPrompt) {
      return this.handleUserInputRequired(params);
    }

    // --- Refusal ---
    if (result.isRefusal) {
      return this.handleStandardTermination(params, 'refusal', {
        logLevel: 'warning',
        logMessage: 'Agent refused',
        logMeta: { workId, response: result.response },
        emitGoalNotAchieved: 'refusal',
        error: result.response,
      });
    }

    // --- User stopped ---
    if (result.terminationReason === 'user_stopped') {
      return this.handleStandardTermination(params, 'user_stopped', {
        logMessage: 'User stopped execution',
        logMeta: { workId },
        fallbackResponse: 'Execution stopped by user.',
      });
    }

    // --- Observer stopped (mid-agent cadence check) ---
    if (result.terminationReason === 'observer_stopped') {
      return this.handleObserverStopped(params);
    }

    // --- Observer stopped work item only ---
    if (result.terminationReason === 'observer_work_item_stopped') {
      return this.handleObserverWorkItemStopped(params);
    }

    // --- Continuable errors: no_action, invalid_action ---
    if (result.terminationReason === 'no_action' ||
        result.terminationReason === 'invalid_action') {
      return this.handleContinuableError(params, result.terminationReason);
    }

    // --- Agent bounds exceeded ---
    if (result.terminationReason === 'max_iterations_exceeded' ||
        result.terminationReason === 'max_tool_calls_exceeded' ||
        result.terminationReason === 'max_duration_exceeded') {
      return this.handleStandardTermination(params, result.terminationReason, {
        logLevel: 'warning',
        logMessage: `Agent bounds exceeded: ${result.terminationReason}`,
        logMeta: { workId },
        success: !!result.response,
        fallbackResponse: `Agent terminated: ${result.terminationReason}`,
      });
    }

    // --- Transient errors: rate_limit, circuit_open ---
    if (result.terminationReason === 'rate_limit' || result.terminationReason === 'circuit_open') {
      return this.handleStandardTermination(params, result.terminationReason as TerminationReason, {
        logLevel: 'warning',
        logMessage: `Agent ${result.terminationReason}`,
        logMeta: { workId },
        fallbackResponse: `Execution stopped: ${result.terminationReason}`,
        error: result.terminationReason,
      });
    }

    // --- Timeout ---
    if (result.terminationReason === 'timeout') {
      return this.handleStandardTermination(params, 'timeout', {
        logLevel: 'warning',
        logMessage: 'Agent timeout',
        logMeta: { workId, error: result.error },
        fallbackResponse: 'Execution stopped: timeout',
        error: result.error || 'timeout',
      });
    }

    // --- Agent error ---
    if (result.terminationReason === 'agent_error') {
      return this.handleStandardTermination(params, 'agent_error', {
        logLevel: 'error',
        logMessage: 'Agent error',
        logMeta: { workId, error: result.error },
        emitGoalNotAchieved: result.error || 'agent_error',
        error: result.error || 'Agent encountered an unexpected error',
      });
    }

    // --- Hard error catch-all ---
    if (result.error && !result.success && !actionIsContinue) {
      return this.handleStandardTermination(params, 'agent_error', {
        logLevel: 'error',
        logMessage: 'Agent error',
        logMeta: { workId, error: result.error, terminationReason: result.terminationReason },
        emitGoalNotAchieved: result.error,
        error: result.error,
      });
    }

    // --- Orchestrator-level tool call bounds ---
    if (params.totalToolCalls >= this.config.maxToolCalls) {
      return this.handleOrchestratorToolCallBounds(params);
    }

    // No terminal condition - execution should continue
    return { terminal: null, shouldContinue: false };
  }

  /**
   * Common handler for standard termination reasons that follow the pattern:
   * log → merge context → callStopHook → handleStopHookBlock → maybe emitGoalNotAchieved → return terminal result
   */
  private async handleStandardTermination(
    params: CheckTerminationParams,
    reason: TerminationReason,
    opts: {
      logLevel?: 'info' | 'warning' | 'error';
      logMessage: string;
      logMeta?: Record<string, unknown>;
      emitGoalNotAchieved?: string;
      success?: boolean;
      fallbackResponse?: string;
      error?: string;
    },
  ): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, totalLlmCalls, totalToolCalls, now, startTime, context, agentType, goal, runtime } = params;

    this.log(opts.logLevel ?? 'info', opts.logMessage, opts.logMeta);
    this.mergeAgentResultContext(context, workId, result);

    const stopResult = await this.callStopHook({
      context,
      terminationReason: reason,
      response: result.response ?? '',
      iteration,
      agentType,
      runtime,
      agentResult: result,
      workId,
      objective: item.objective,
      totalLlmCalls,
      totalToolCalls,
    });
    if (this.handleStopHookBlock(stopResult, context, agentType, iteration, reason)) {
      return { terminal: null, shouldContinue: true };
    }

    if (opts.emitGoalNotAchieved) {
      this.emitGoalNotAchieved(goal, opts.emitGoalNotAchieved, 1);
    }

    return {
      terminal: this.createResult({
        success: opts.success ?? false,
        response: result.response || opts.fallbackResponse,
        error: opts.error,
        terminationReason: reason,
        metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
      }),
      shouldContinue: false,
    };
  }

  /**
   * Handle user_input_required termination - unique: interruption check.
   */
  private async handleUserInputRequired(params: CheckTerminationParams): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, totalLlmCalls, totalToolCalls, now, startTime, context, agentType, runtime } = params;

    if (runtime?.checkInterruption?.()) {
      this.log('info', 'Interruption preempts user prompt request', { iteration, workId });
      this.mergeAgentResultContext(context, workId, result);
      return this.createInterruptionResult(agentType);
    }

    const firstPromptQuestion = result.userPrompt?.questions?.[0];
    this.log('info', 'Awaiting user input', {
      workId,
      question: firstPromptQuestion?.question,
      questionType: firstPromptQuestion?.questionType,
    });
    this.mergeAgentResultContext(context, workId, result);

    const stopResult = await this.callStopHook({
      context,
      terminationReason: 'user_input_required',
      response: result.response ?? '',
      iteration,
      agentType,
      runtime,
      userPrompt: result.userPrompt,
      agentResult: result,
      workId,
      objective: item.objective,
      totalLlmCalls,
      totalToolCalls,
    });
    if (this.handleStopHookBlock(stopResult, context, agentType, iteration, 'user_input_required')) {
      return { terminal: null, shouldContinue: true };
    }

    return {
      terminal: this.createResult({
        success: false,
        response: result.response ?? '',
        userPrompt: result.userPrompt,
        terminationReason: 'user_input_required',
        metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
      }),
      shouldContinue: false,
    };
  }

  /**
   * Handle observer_stopped - unique: no stopHook, success=!!response.
   */
  private handleObserverStopped(params: CheckTerminationParams): TerminationCheckResult {
    const { result, workId, iteration, totalLlmCalls, totalToolCalls, now, startTime, context } = params;

    this.log('info', 'Observer stopped execution via cadence check', { workId });
    this.mergeAgentResultContext(context, workId, result);

    return {
      terminal: this.createResult({
        success: !!result.response,
        response: result.response || 'Execution stopped by observer.',
        terminationReason: 'observer_stopped',
        metrics: { iterations: iteration, totalLlmCalls, totalToolCalls, durationMs: now - startTime },
      }),
      shouldContinue: false,
    };
  }

  /**
   * Handle observer_work_item_stopped - unique: hookQueue enqueue, no stopHook, returns continue.
   */
  private handleObserverWorkItemStopped(params: CheckTerminationParams): TerminationCheckResult {
    const { result, workId, item, context } = params;

    const reason = result.observerStop?.reason ?? result.response ?? 'Observer stopped this work item.';
    this.log('info', 'Observer stopped work item', { workId, reason: reason.slice(0, 160) });
    this.mergeAgentResultContext(context, workId, result);

    this.hookQueue.enqueue({
      type: 'observer_agent_stopped',
      sessionKey: context.sessionKey,
      workId,
      reason,
      agentType: item.agent,
    }, {
      workId,
      agentType: item.agent,
      sessionKey: context.sessionKey,
      requestId: this.requestId,
      objective: item.objective,
    });

    this.completedWork.set(workId, result);

    return { terminal: null, shouldContinue: true };
  }

  /**
   * Handle continuable errors (no_action, invalid_action) - unique: inline deferred work check.
   */
  private async handleContinuableError(
    params: CheckTerminationParams,
    reason: TerminationReason,
  ): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, totalLlmCalls, totalToolCalls, now, startTime, context, agentType, goal, runtime } = params;

    this.log('warning', `Agent ${reason}`, { workId, error: result.error });
    this.mergeAgentResultContext(context, workId, result);

    if (runtime?.hookRegistry) {
      const stopResult = await this.callStopHook({
        context,
        terminationReason: reason,
        response: result.response ?? '',
        iteration,
        agentType,
        runtime,
        agentResult: result,
        workId,
        objective: item.objective,
        totalLlmCalls,
        totalToolCalls,
      });

      if (stopResult) {
        const queueSizeBefore = this.workQueue.length;
        this.enqueueDeferredWork(stopResult);
        const deferredWorkAdded = this.workQueue.length > queueSizeBefore;

        if (deferredWorkAdded) {
          this.log('info', 'Deferred work added, continuing loop', {
            iteration,
            newItems: this.workQueue.length - queueSizeBefore,
          });
          return { terminal: null, shouldContinue: true };
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

  /**
   * Handle orchestrator-level tool call bounds exceeded - unique: harvestCompletedWork fallback.
   */
  private async handleOrchestratorToolCallBounds(params: CheckTerminationParams): Promise<TerminationCheckResult> {
    const { result, workId, item, iteration, totalLlmCalls, totalToolCalls, now, startTime, context, agentType, goal, runtime } = params;

    this.log('warning', 'Max tool calls exceeded', { totalToolCalls, completedWork: this.completedWork.size });
    this.mergeAgentResultContext(context, workId, result);

    const stopResult = await this.callStopHook({
      context,
      terminationReason: 'max_tool_calls_exceeded',
      response: result.response ?? '',
      iteration,
      agentType,
      runtime,
      agentResult: result,
      workId,
      objective: item.objective,
      totalLlmCalls,
      totalToolCalls,
    });
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

}
