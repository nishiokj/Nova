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
import { PlanState, type StepState } from './plan-state.js';
import { WorkLedger } from './work-ledger.js';
import { KnowledgeStore } from './knowledge.js';
import { Worker, type WorkerConfig, type WorkerOutcome, outcomeMadeProgress } from './worker.js';
import { createWorkItem, workItemFromStepState, type WorkBounds } from './work-item.js';
import { createContextWindow, type ContextWindow } from './context.js';
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
 */
export class Wizard {
  private toolRegistry: ToolRegistry;
  private llm: LLMAdapter;
  private config: WizardConfig;
  private logger?: WizardLogger;
  private eventEmitter?: (event: WizardEvent) => void;

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
    eventEmitter?: (event: WizardEvent) => void
  ) {
    this.toolRegistry = toolRegistry;
    this.llm = llm;
    this.config = { ...DEFAULT_WIZARD_CONFIG, ...config };
    this.logger = logger;
    this.eventEmitter = eventEmitter;
  }

  private log(level: keyof WizardLogger, msg: string, meta?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger[level](msg, { component: 'wizard', ...meta });
    }
  }

  private emit(event: WizardEvent): void {
    this.events.push(event);
    if (this.eventEmitter) {
      this.eventEmitter(event);
    }
  }

  /**
   * Execute a plan and return the result.
   */
  async execute(
    plan: WizardPlan,
    baseContext?: Partial<ContextWindow>,
    behavioralRules = ''
  ): Promise<WizardResult> {
    const startTime = Date.now();

    // Initialize state
    this.planState = PlanState.fromWizardPlan(plan);
    this.ledger = new WorkLedger();
    this.knowledge = new KnowledgeStore();
    this.stagnation = new StagnationDetector(this.config.maxRetriesPerStep);
    this.worker = new Worker(this.toolRegistry, this.llm, this.config.workerConfig);

    this.events = [];
    this.totalToolCalls = 0;
    this.totalLlmCalls = 0;

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
            this.log('warning', 'Deadlock detected - no ready steps');
            break;
          }

          // Check for stuck steps
          const stuckSteps = this.planState.getStuckSteps();
          if (stuckSteps.length > 0) {
            // Try to recover stuck steps
            for (const step of stuckSteps) {
              if (step.status === StepStatus.FAILED) {
                if (step.attemptCount >= this.config.maxRetriesPerStep) {
                  this.planState.markStepSkipped(step.stepNum, 'Max retries exceeded');
                  this.stagnation.resetStep(step.stepNum);
                } else {
                  this.planState.resetStepForRetry(step.stepNum);
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

        // Build context window
        const context = createContextWindow(
          baseContext?.systemPrompt ?? '',
          this.planState.goal,
          step.overrideObjective ?? step.objective,
          step.stepNum,
          baseContext?.messages ?? [],
          baseContext?.readFiles ?? new Set()
        );

        try {
          // Execute work
          const outcome = await this.worker.execute(
            context,
            workItem,
            this.planState.version,
            behavioralRules
          );

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

            // Ingest facts
            for (const fact of outcome.facts) {
              this.knowledge.upsert(fact);
            }
          } else {
            this.ledger.recordCompletion(entryId, outcome);
            this.planState.markStepFailed(step.stepNum, outcome.error ?? 'Unknown error');

            // Check if we should retry
            if (step.attemptCount >= this.config.maxRetriesPerStep) {
              this.planState.markStepSkipped(step.stepNum, 'Max retries exceeded');
              this.stagnation.resetStep(step.stepNum);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log('error', `Step ${step.stepNum} error: ${message}`);
          this.planState.clearInProgress(step.stepNum);
        }
      }
    } finally {
      this.stagnation.cleanupAll();
    }

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
      : `Plan did not achieve goal. Completed: ${stepsCompleted}, Skipped: ${stepsSkipped}, Failed: ${stepsFailed}`;

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
    userResponse: string,
    behavioralRules = ''
  ): Promise<WizardResult> {
    // Find the awaiting step and reset it with user response context
    for (const step of this.planState.steps.values()) {
      if (step.status === StepStatus.AWAITING_USER) {
        this.planState.resetStepForRetry(step.stepNum);
        // Add user response to context (would need to track this)
        break;
      }
    }

    // Continue execution (simplified - would need full context restoration)
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

    return this.execute(plan, undefined, behavioralRules);
  }
}
