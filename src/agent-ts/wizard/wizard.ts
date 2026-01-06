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
  deadlockThreshold: number;
  // Worker configuration
  workerConfig?: Partial<WorkerConfig>;
}

export const DEFAULT_WIZARD_CONFIG: WizardConfig = {
  maxIterations: 50,
  contextBudgetTokens: 100_000,
  compactionThreshold: 0.6,
  maxRetriesPerStep: 3,
  deadlockThreshold: 5,
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
    // Pass event emitter callback to Worker for LLM_CALL and TOOL_CALL events
    this.worker = new Worker(
      this.toolRegistry,
      this.llm,
      this.config.workerConfig,
      this.logger, // Pass logger for Worker logging
      this.publish.bind(this) // eventEmitter callback
    );

    this.events = [];
    this.totalToolCalls = 0;
    this.totalLlmCalls = 0;

    // Emit GOAL_STARTED event
    this.publish(createEvent('goal_started', {
      goal: plan.goal,
      userInput: '', // Would come from context in full implementation
      steps: Array.from(this.planState.steps.values()).map(s => ({
        stepNum: s.stepNum,
        objective: s.objective,
        phase: s.phase,
        toolHint: s.toolHint,
      })),
    }));

    // Emit initial context telemetry
    this.emitContextTelemetry(context);

    let iteration = 0;
    let deadlockCounter = 0;
    let paused = false;
    let userPrompt: Record<string, unknown> | undefined;
    let lastResponse = '';

    try {
      while (iteration < this.config.maxIterations) {
        iteration++;

        // Check termination
        if (this.planState.isTerminated()) {
          this.log('info', 'Plan terminated - all steps complete');
          break;
        }

        // Get ready steps
        const readySteps = this.planState.getReadySteps();

        if (readySteps.length === 0) {
          // Check for deadlock
          deadlockCounter++;
          if (deadlockCounter >= this.config.deadlockThreshold) {
            // CRITICAL: Deadlock is a fatal condition - record it properly
            const stepStatuses = Array.from(this.planState.steps.values())
              .map(s => `Step ${s.stepNum}: ${s.status}${s.lastError ? ` (${s.lastError.slice(0, 50)})` : ''}`)
              .join(', ');
            const deadlockError = `Deadlock detected after ${deadlockCounter} iterations. No ready steps. Step states: ${stepStatuses}`;
            this.log('error', deadlockError);
            // Store the error for the result
            lastResponse = deadlockError;
            break;
          }

          // Check for stuck steps
          const stuckSteps = this.planState.getStuckSteps();
          if (stuckSteps.length > 0) {
            // Try to recover stuck steps
            for (const stuckStep of stuckSteps) {
              if (stuckStep.status === StepStatus.FAILED) {
                if (stuckStep.attemptCount >= this.config.maxRetriesPerStep) {
                  this.planState.markStepSkipped(stuckStep.stepNum, 'Max retries exceeded');
                  this.stagnation.resetStep(stuckStep.stepNum);
                  // Emit STEP_SKIPPED event for stuck step recovery
                  this.publish(createEvent('step_skipped', {
                    objective: stuckStep.objective,
                    reason: 'Max retries exceeded (stuck step recovery)',
                  }, stuckStep.stepNum));
                } else {
                  this.planState.resetStepForRetry(stuckStep.stepNum);
                }
              }
            }
          }
          continue;
        }

        deadlockCounter = 0;

        // Execute first ready step
        const step = readySteps[0];
        const workerId = uuidv4().slice(0, 8);

        this.log('debug', `Executing step ${step.stepNum}: ${step.objective.slice(0, 50)}`);

        // Create work item
        const workItem = workItemFromStepState(step);

        // Record dispatch
        const entryId = this.ledger.recordDispatch(step.stepNum, workItem, workerId);
        this.planState.markStepInProgress(step.stepNum, workerId);

        // Emit STEP_STARTED event
        this.publish(createEvent('step_started', {
          objective: step.objective,
          workerId,
        }, step.stepNum));

        try {
          // Execute work (pass workspace root for context in LLM prompts)
          const workspaceRoot = this.toolRegistry.getWorkingDir();
          const outcome = await this.worker.execute(
            context,
            workItem,
            this.planState.version,
            behavioralRules,
            workspaceRoot
          );

          // Emit context telemetry after step execution
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
              // Emit STEP_SKIPPED event for stagnation
              this.publish(createEvent('step_skipped', {
                objective: step.objective,
                reason: `Stagnation: ${signal.reason}`,
              }, action.stepNum));
              continue;
            }
          }

          // Process outcome
          if (outcome.needsUserInput && outcome.userPrompt) {
            // Pause for user input
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

            // Emit STEP_COMPLETED event (no truncation - observability needs full context)
            this.publish(createEvent('step_completed', {
              objective: step.objective,
              finalResponse: outcome.finalResponse ?? '',
              toolCalls: outcome.metrics.toolCallsMade,
              llmCalls: outcome.metrics.llmCallsMade,
              durationMs: outcome.metrics.durationMs,
            }, step.stepNum));

            // Emit TOOL_CALL events for successful tools (no truncation for observability)
            for (const fact of outcome.facts) {
              if (fact.source === FactSource.TOOL && fact.toolName) {
                this.publish(createEvent('tool_call', {
                  toolName: fact.toolName,
                  arguments: {}, // Tool args not captured in facts - would need worker to emit these
                  result: String(fact.value),
                  success: true,
                  durationMs: 0, // Duration not captured in facts
                }, step.stepNum));
              }
            }

            // Ingest facts
            for (const fact of outcome.facts) {
              this.knowledge.upsert(fact);
            }
          } else {
            this.ledger.recordCompletion(entryId, outcome);
            this.planState.markStepFailed(step.stepNum, outcome.error ?? 'Unknown error');

            // Emit STEP_FAILED event with full error details
            this.publish(createEvent('step_failed', {
              objective: step.objective,
              error: outcome.error ?? 'Unknown error',
              toolErrors: outcome.toolErrors,
              terminationReason: outcome.terminationReason,
            }, step.stepNum));

            // Emit TOOL_CALL events for tool errors (no truncation - observability needs full context)
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

            // Check if we should retry
            if (step.attemptCount >= this.config.maxRetriesPerStep) {
              this.planState.markStepSkipped(step.stepNum, 'Max retries exceeded');
              this.stagnation.resetStep(step.stepNum);
              // Emit STEP_SKIPPED event
              this.publish(createEvent('step_skipped', {
                objective: step.objective,
                reason: 'Max retries exceeded',
              }, step.stepNum));
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : undefined;

          // CRITICAL: Log with full context and NEVER silently swallow
          this.log('error', `Step ${step.stepNum} threw exception: ${message}`, {
            stepNum: step.stepNum,
            objective: step.objective,
            stack,
          });

          // Emit STEP_FAILED event with full stack trace for observability
          this.publish(createEvent('step_failed', {
            objective: step.objective,
            error: `Exception: ${message}`,
            stack,
            terminationReason: `exception:${message}`,
          }, step.stepNum));

          // Record the failure with the actual error message
          this.planState.markStepFailed(step.stepNum, `Exception: ${message}`);

          // Also record in ledger so it shows up in history
          this.ledger.recordCompletion(entryId, {
            workId: workItem.workId,
            stepNum: step.stepNum,
            baseVersion: this.planState.version,
            success: false,
            error: `Exception: ${message}`,
            toolErrors: [],
            isRefusal: outcome.isRefusal,
            facts: [],
            patchSuggestions: [],
            metrics: { toolCallsMade: 0, toolCallsSucceeded: 0, toolCallsFailed: 0, llmCallsMade: 0, durationMs: 0 },
            entityRefs: [],
            needsUserInput: false,
            terminationReason: `exception:${message}`,
          });

          // IMPORTANT: If this is the only step and it failed, capture the error in lastResponse
          if (Array.from(this.planState.steps.values()).every(s => s.status === StepStatus.FAILED || s.status === StepStatus.SKIPPED)) {
            lastResponse = `All steps failed. Last error: ${message}`;
          }
        }
      }
    } finally {
      this.stagnation.cleanupAll();
    }

    // Emit final context telemetry
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

    // Emit GOAL_ACHIEVED or GOAL_ABORTED event
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
