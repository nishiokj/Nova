/**
 * Wizard is the outer-loop orchestrator that owns single-writer global state.
 * Dispatches bounded work to Workers and coordinates plan evolution.
 *
 * The Wizard does NOT create plans - it receives a WizardPlan and executes it.
 * Planning is the caller's responsibility.
 *
 * Ported from: src/harness/agent/wizard/wizard.py
 */

import { v4 as uuidv4 } from 'uuid';
import type { LLMAdapter } from '../llm/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { WizardPlan } from '../types/plans.js';
import { StepStatus } from '../types/plans.js';
import type { WizardEvent } from '../types/events.js';
import { createEvent } from '../types/events.js';
import { ContextWindow } from '../types/context.js';
import type { EventBusProtocol } from '../communication/event_bus.js';
import { FactSource } from './knowledge.js';
import { PlanState, type StepState } from './plan-state.js';
import { WorkLedger } from './work-ledger.js';
import { KnowledgeStore } from './knowledge.js';
import { Worker, type WorkerConfig, type WorkerOutcome, outcomeMadeProgress } from './worker.js';
import { createWorkItem, workItemFromStepState, type WorkBounds } from './work-item.js';
import { StagnationDetector } from './stagnation.js';

/**
 * Wizard configuration.
 */
export interface WizardConfig {
  maxIterations: number;
  contextBudgetTokens: number;
  compactionThreshold: number;
  maxRetriesPerStep: number;
  maxWorkers: number;
  // Worker configuration
  workerConfig?: Partial<WorkerConfig>;
}

export const DEFAULT_WIZARD_CONFIG: WizardConfig = {
  maxIterations: 50,
  contextBudgetTokens: 100_000,
  compactionThreshold: 0.6,
  maxRetriesPerStep: 3,
  maxWorkers: 3,
};

/**
 * Result of Wizard orchestration.
 */
export interface WizardResult {
  success: boolean;
  finalResponse: string;
  planState: PlanState;
  ledger: WorkLedger;
  // Metrics
  totalIterations: number;
  totalToolCalls: number;
  totalLlmCalls: number;
  durationMs: number;
  // Step counts
  stepsCompleted: number;
  stepsSkipped: number;
  stepsFailed: number;
  // Observability
  events: WizardEvent[];
  // Pause state
  paused: boolean;
  userPrompt?: Record<string, unknown>;
}

/**
 * Logger protocol for Wizard.
 */
export interface WizardLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Wizard orchestrator.
 *
 * Owns all mutable state:
 * - PlanState (versioned, single-writer)
 * - WorkLedger (append-only audit trail)
 * - KnowledgeStore (accumulated facts)
 *
 * NOTE: ContextWindow is now passed in from the caller (Agent) and mutated
 * directly during execution. Wizard no longer creates context windows.
 */
export class Wizard {
  private toolRegistry: ToolRegistry;
  private llm: LLMAdapter;
  private config: WizardConfig;
  private logger?: WizardLogger;
  private eventBus?: EventBusProtocol;

  // State (owned by Wizard)
  private planState!: PlanState;
  private ledger!: WorkLedger;
  private knowledge!: KnowledgeStore;
  private stagnation!: StagnationDetector;
  private worker!: Worker;

  // Execution tracking
  private events: WizardEvent[] = [];
  private totalToolCalls = 0;
  private totalLlmCalls = 0;

  constructor(
    toolRegistry: ToolRegistry,
    llm: LLMAdapter,
    config?: Partial<WizardConfig>,
    logger?: WizardLogger,
    eventBus?: EventBusProtocol
  ) {
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.config = { ...DEFAULT_WIZARD_CONFIG, ...config };
    this.logger = logger;
    this.eventBus = eventBus;
  }

  private log(level: keyof WizardLogger, msg: string, meta?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger[level](msg, { component: 'wizard', ...meta });
    }
  }

  private publish(event: WizardEvent): void {
    this.events.push(event);
    if (this.eventBus) {
      this.eventBus.publish(event);
    }
  }

  /**
   * Emit context_window_telemetry event for observability.
   */
  private emitContextTelemetry(context: ContextWindow, stepNum?: number): void {
    const telemetry = context.toTelemetry();
    this.publish(createEvent('context_window_telemetry', telemetry, stepNum));
  }

  /**
   * Execute a plan and return the result.
   *
   * Uses parallel dispatch with dependency graph:
   * - Builds topo-sorted queue from step dependencies
   * - Dispatches up to maxWorkers concurrently
   * - Merges WorkerContext on completion in completion order
   *
   * @param plan - The plan to execute
   * @param context - The ContextWindow to use (mutated during execution)
   * @param behavioralRules - Optional behavioral rules for the Worker
   */
  async execute(
    plan: WizardPlan,
    context: ContextWindow,
    behavioralRules = ''
  ): Promise<WizardResult> {
    const startTime = Date.now();

    // Initialize state
    this.planState = PlanState.fromWizardPlan(plan);
    this.ledger = new WorkLedger();
    this.knowledge = new KnowledgeStore();
    this.stagnation = new StagnationDetector(this.config.maxRetriesPerStep);
    this.worker = new Worker(
      this.toolRegistry,
      this.llm,
      this.config.workerConfig,
      this.logger,
      this.publish.bind(this)
    );

    // Telemetry containers (lightweight)
    const iterationSamples: Array<{ iteration: number; timestamp: number; readyQueueLen: number; inFlightLen: number }> = [];
    const stepStartTimes = new Map<number, number>();

    this.events = [];
    this.totalToolCalls = 0;
    this.totalLlmCalls = 0;

    // Emit GOAL_STARTED event
    this.publish(createEvent('goal_started', {
      goal: plan.goal,
      userInput: '',
      steps: Array.from(this.planState.steps.values()).map(s => ({
        stepNum: s.stepNum,
        objective: s.objective,
        phase: s.phase,
        toolHint: s.toolHint,
        dependsOn: s.dependsOn,
      })),
    }));

    // Emit initial context telemetry and record token count
    this.emitContextTelemetry(context);
    let lastContextTokens: number | undefined;
    try {
      const ctxTelemetry = context.toTelemetry();
      lastContextTokens = typeof ctxTelemetry.tokenCount === 'number' ? ctxTelemetry.tokenCount : undefined;
    } catch (err) {
      // ignore
    }

    let iteration = 0;
    let paused = false;
    let userPrompt: Record<string, unknown> | undefined;
    let lastResponse = '';

    // Build dependency graph
    const remainingDeps = new Map<number, Set<number>>();
    const readyQueue: StepState[] = [];

    for (const step of this.planState.steps.values()) {
      // Filter to only include deps that are not yet completed/skipped
      const deps = new Set(
        step.dependsOn.filter(d => {
          const depStep = this.planState.steps.get(d);
          return depStep && depStep.status !== StepStatus.COMPLETED && depStep.status !== StepStatus.SKIPPED;
        })
      );
      if (deps.size === 0 && step.status === StepStatus.PENDING) {
        readyQueue.push(step);
      } else if (step.status === StepStatus.PENDING) {
        remainingDeps.set(step.stepNum, deps);
      }
    }

    // Sort ready queue by position for deterministic order
    readyQueue.sort((a, b) => a.position - b.position);

    // In-flight workers: stepNum -> Promise<{step, outcome, workerId, entryId}>
    type InFlightResult = {
      step: StepState;
      outcome: WorkerOutcome;
      workerId: string;
      entryId: string;
    };
    const inFlight = new Map<number, Promise<InFlightResult>>();

    try {
      while (readyQueue.length > 0 || inFlight.size > 0) {
        iteration++;
        if (iteration > this.config.maxIterations) {
          this.log('warning', 'Max iterations reached');
          break;
        }

        // Sample memory and queue state at start of iteration
        try {
          const mem = process.memoryUsage();
          this.publish(createEvent('memory_telemetry', { heapUsed: mem.heapUsed, rss: mem.rss }, undefined));
        } catch (err) {
          // ignore environment without process.memoryUsage
        }
        iterationSamples.push({ iteration, timestamp: Date.now(), readyQueueLen: readyQueue.length, inFlightLen: inFlight.size });

        // Dispatch up to maxWorkers
        while (readyQueue.length > 0 && inFlight.size < this.config.maxWorkers) {
          const step = readyQueue.shift()!;
          const workerId = uuidv4().slice(0, 8);

          this.log('debug', `Dispatching step ${step.stepNum}: ${step.objective.slice(0, 50)}`);

          const workItem = workItemFromStepState(step, plan.goal);
          const entryId = this.ledger.recordDispatch(step.stepNum, workItem, workerId);
          this.planState.markStepInProgress(step.stepNum, workerId);

          this.publish(createEvent('step_started', {
            objective: step.objective,
            workerId,
            dependsOn: step.dependsOn,
          }, step.stepNum));

          // record step start time for per-step duration telemetry
          stepStartTimes.set(step.stepNum, Date.now());

          // Launch worker asynchronously
          const workerPromise = this.executeWorker(
            step,
            workItem,
            context,
            behavioralRules,
            workerId,
            entryId
          );

          inFlight.set(step.stepNum, workerPromise);
        }

        if (inFlight.size === 0) {
          // No work in flight and no ready steps - check for blocked steps
          if (remainingDeps.size > 0) {
            this.log('warning', 'No ready steps but dependencies remain - possible deadlock');
            // Try to recover by skipping failed steps
            for (const step of this.planState.steps.values()) {
              if (step.status === StepStatus.FAILED && step.attemptCount >= this.config.maxRetriesPerStep) {
                this.planState.markStepSkipped(step.stepNum, 'Max retries exceeded');
                this.publish(createEvent('step_skipped', {
                  objective: step.objective,
                  reason: 'Max retries exceeded',
                }, step.stepNum));
                // Update remaining deps
                for (const [stepNum, deps] of remainingDeps) {
                  deps.delete(step.stepNum);
                  if (deps.size === 0) {
                    remainingDeps.delete(stepNum);
                    const unblocked = this.planState.steps.get(stepNum);
                    if (unblocked && unblocked.status === StepStatus.PENDING) {
                      readyQueue.push(unblocked);
                    }
                  }
                }
              }
            }
            if (readyQueue.length === 0) {
              lastResponse = 'Deadlock: no steps can proceed';
              break;
            }
          }
          continue;
        }

        // Wait for any worker to complete
        const completed = await Promise.race(inFlight.values());

        // Capture telemetry before removing from inFlight
        try {
          const start = stepStartTimes.get(completed.step.stepNum);
          const end = Date.now();
          const durationMs = start ? end - start : completed.outcome.metrics.durationMs ?? 0;

          // Publish per-step telemetry event
          this.publish(createEvent('step_telemetry', {
            stepNum: completed.step.stepNum,
            durationMs,
            toolCalls: completed.outcome.metrics.toolCallsMade,
            llmCalls: completed.outcome.metrics.llmCallsMade,
            inFlightBefore: inFlight.size,
          }, completed.step.stepNum));

          // Context growth: compare token counts and emit delta
          try {
            const ctxTelemetry = context.toTelemetry();
            const currentTokens = typeof ctxTelemetry.tokenCount === 'number' ? ctxTelemetry.tokenCount : undefined;
            if (typeof lastContextTokens === 'number' && typeof currentTokens === 'number') {
              const delta = currentTokens - lastContextTokens;
              if (delta !== 0) {
                this.publish(createEvent('context_growth', { prevTokens: lastContextTokens, currentTokens, delta }, completed.step.stepNum));
              }
            }
            lastContextTokens = currentTokens;
          } catch (err) {
            // ignore
          }
        } catch (err) {
          // ignore telemetry failures
        }

        inFlight.delete(completed.step.stepNum);

        const { step, outcome, entryId } = completed;

        // Merge WorkerContext into ContextWindow (completion order)
        for (const item of outcome.contextItems) {
          context.appendItem(item);
        }
        for (const file of outcome.filesRead) {
          context.markFileRead(file);
        }

        // Invalidate stale file_content for paths modified by Write/Edit
        for (const path of outcome.invalidatedPaths) {
          const ejectResult = context.invalidateFileContent(path);
          if (ejectResult.ejectedCount > 0) {
            this.log('debug', `Invalidated stale file_content for ${path}`, {
              stepNum: step.stepNum,
              ejectedCount: ejectResult.ejectedCount,
            });
          }
        }

        this.emitContextTelemetry(context, step.stepNum);

        // Update metrics
        this.totalToolCalls += outcome.metrics.toolCallsMade;
        this.totalLlmCalls += outcome.metrics.llmCallsMade;

        // Check stagnation
        const signal = this.stagnation.check(step.stepNum, this.ledger, outcome);
        if (signal.detected) {
          this.log('warning', `Stagnation detected: ${signal.reason}`);
          const action = this.stagnation.getEscalationAction(signal, this.planState);
          if (action.action === 'skip' && action.stepNum !== undefined) {
            this.planState.markStepSkipped(action.stepNum, signal.reason);
            this.stagnation.resetStep(action.stepNum);
            this.publish(createEvent('step_skipped', {
              objective: step.objective,
              reason: `Stagnation: ${signal.reason}`,
            }, action.stepNum));
            this.promoteReadySteps(action.stepNum, remainingDeps, readyQueue);
            continue;
          }
        }

        // Process outcome
        if (outcome.needsUserInput && outcome.userPrompt) {
          this.ledger.recordAwaitingUser(entryId, outcome.userPrompt);
          this.planState.markStepAwaitingUser(step.stepNum, uuidv4().slice(0, 8));
          paused = true;
          userPrompt = outcome.userPrompt;
          break;
        }

        if (outcome.success) {
          this.ledger.recordCompletion(entryId, outcome);
          this.planState.markStepComplete(step.stepNum, outcome.finalResponse ?? 'Completed');
          this.stagnation.resetStep(step.stepNum);
          lastResponse = outcome.finalResponse ?? '';

          this.publish(createEvent('step_completed', {
            objective: step.objective,
            finalResponse: outcome.finalResponse ?? '',
            toolCalls: outcome.metrics.toolCallsMade,
            llmCalls: outcome.metrics.llmCallsMade,
            durationMs: outcome.metrics.durationMs,
          }, step.stepNum));

          for (const fact of outcome.facts) {
            if (fact.source === FactSource.TOOL && fact.toolName) {
              this.publish(createEvent('tool_call', {
                toolName: fact.toolName,
                arguments: {},
                result: String(fact.value),
                success: true,
                durationMs: 0,
              }, step.stepNum));
            }
            this.knowledge.upsert(fact);
          }

          // Promote steps whose deps are now satisfied
          this.promoteReadySteps(step.stepNum, remainingDeps, readyQueue);
        } else {
          this.ledger.recordCompletion(entryId, outcome);
          this.planState.markStepFailed(step.stepNum, outcome.error ?? 'Unknown error');

          this.publish(createEvent('step_failed', {
            objective: step.objective,
            error: outcome.error ?? 'Unknown error',
            toolErrors: outcome.toolErrors,
            terminationReason: outcome.terminationReason,
          }, step.stepNum));

          for (const toolError of outcome.toolErrors) {
            this.publish(createEvent('tool_call', {
              toolName: 'unknown',
              arguments: {},
              result: toolError,
              success: false,
              durationMs: 0,
              error: toolError,
            }, step.stepNum));
          }

          // Check retry or skip
          if (step.attemptCount >= this.config.maxRetriesPerStep) {
            this.planState.markStepSkipped(step.stepNum, 'Max retries exceeded');
            this.stagnation.resetStep(step.stepNum);
            this.publish(createEvent('step_skipped', {
              objective: step.objective,
              reason: 'Max retries exceeded',
            }, step.stepNum));
            // Skipped step also satisfies soft deps
            this.promoteReadySteps(step.stepNum, remainingDeps, readyQueue);
          } else {
            // Reset for retry - add back to ready queue
            this.planState.resetStepForRetry(step.stepNum);
            const retryStep = this.planState.steps.get(step.stepNum);
            if (retryStep) {
              readyQueue.push(retryStep);
              readyQueue.sort((a, b) => a.position - b.position);
            }
          }
        }
      }
    } finally {
      this.stagnation.cleanupAll();
    }

    this.emitContextTelemetry(context);

    // Build result
    const stepsCompleted = Array.from(this.planState.steps.values()).filter(
      (s) => s.status === StepStatus.COMPLETED
    ).length;
    const stepsSkipped = Array.from(this.planState.steps.values()).filter(
      (s) => s.status === StepStatus.SKIPPED
    ).length;
    const stepsFailed = Array.from(this.planState.steps.values()).filter(
      (s) => s.status === StepStatus.FAILED
    ).length;

    const success = this.planState.goalAchieved();
    const finalResponse = success
      ? lastResponse || 'Plan completed successfully'
      : lastResponse || `Plan did not achieve goal. Completed: ${stepsCompleted}, Skipped: ${stepsSkipped}, Failed: ${stepsFailed}`;

    if (success) {
      this.publish(createEvent('goal_achieved', {
        goal: this.planState.goal,
        completed: stepsCompleted,
        skipped: stepsSkipped,
      }));
    } else if (!paused) {
      this.publish(createEvent('goal_aborted', {
        goal: this.planState.goal,
        reason: finalResponse,
        completed: stepsCompleted,
        skipped: stepsSkipped,
        failed: stepsFailed,
      }));
    }

    // Emit summary telemetry
    try {
      this.publish(createEvent('execution_telemetry', {
        totalIterations: iteration,
        iterationSamplesCount: iterationSamples.length,
        totalToolCalls: this.totalToolCalls,
        totalLlmCalls: this.totalLlmCalls,
        durationMs: Date.now() - startTime,
      }));
    } catch (err) {
      // ignore
    }

    return {
      success,
      finalResponse,
      planState: this.planState,
      ledger: this.ledger,
      totalIterations: iteration,
      totalToolCalls: this.totalToolCalls,
      totalLlmCalls: this.totalLlmCalls,
      durationMs: Date.now() - startTime,
      stepsCompleted,
      stepsSkipped,
      stepsFailed,
      events: this.events,
      paused,
      userPrompt,
    };
  }

  /**
   * Execute a single worker and handle exceptions.
   */
  private async executeWorker(
    step: StepState,
    workItem: ReturnType<typeof workItemFromStepState>,
    context: ContextWindow,
    behavioralRules: string,
    workerId: string,
    entryId: string
  ): Promise<{ step: StepState; outcome: WorkerOutcome; workerId: string; entryId: string }> {
    try {
      const workspaceRoot = this.toolRegistry.getWorkingDir();
      const outcome = await this.worker.execute(
        context,
        workItem,
        this.planState.version,
        behavioralRules,
        workspaceRoot
      );
      return { step, outcome, workerId, entryId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      this.log('error', `Step ${step.stepNum} threw exception: ${message}`, {
        stepNum: step.stepNum,
        objective: step.objective,
        stack,
      });

      this.publish(createEvent('step_failed', {
        objective: step.objective,
        error: `Exception: ${message}`,
        stack,
        terminationReason: `exception:${message}`,
      }, step.stepNum));

      // Return a failed outcome
      const outcome: WorkerOutcome = {
        workId: workItem.workId,
        stepNum: step.stepNum,
        baseVersion: this.planState.version,
        success: false,
        error: `Exception: ${message}`,
        toolErrors: [],
        isRefusal: false,
        facts: [],
        patchSuggestions: [],
        metrics: { toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, llmCallsMade: 0, durationMs: 0 },
        entityRefs: [],
        needsUserInput: false,
        terminationReason: `exception:${message}`,
        contextItems: [],
        filesRead: [],
        invalidatedPaths: [],
      };

      return { step, outcome, workerId, entryId };
    }
  }

  /**
   * Promote steps whose dependencies are now satisfied.
   */
  private promoteReadySteps(
    completedStepNum: number,
    remainingDeps: Map<number, Set<number>>,
    readyQueue: StepState[]
  ): void {
    for (const [stepNum, deps] of remainingDeps) {
      deps.delete(completedStepNum);
      if (deps.size === 0) {
        remainingDeps.delete(stepNum);
        const step = this.planState.steps.get(stepNum);
        if (step && step.status === StepStatus.PENDING) {
          readyQueue.push(step);
        }
      }
    }
    // Keep sorted by position
    readyQueue.sort((a, b) => a.position - b.position);
  }

  /**
   * Resume execution after user provides input.
   */
  async resume(
    context: ContextWindow,
    userResponse: string,
    behavioralRules = ''
  ): Promise<WizardResult> {
    // Add user response to context
    context.addMessage('user', userResponse);

    // Find the awaiting step and reset it
    for (const step of this.planState.steps.values()) {
      if (step.status === StepStatus.AWAITING_USER) {
        this.planState.resetStepForRetry(step.stepNum);
        break;
      }
    }

    // Continue execution
    const plan: WizardPlan = {
      goal: this.planState.goal,
      goalType: this.planState.goalType,
      steps: Array.from(this.planState.steps.values()).map((s) => ({
        stepNum: s.stepNum,
        objective: s.objective,
        status: s.status,
        phase: s.phase,
        dependsOn: s.dependsOn,
        toolHint: s.toolHint,
        targetPaths: s.targetPaths,
        required: s.required,
      })),
    };

    return this.execute(plan, context, behavioralRules);
  }
}
