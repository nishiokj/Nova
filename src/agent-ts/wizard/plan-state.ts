/**
 * Versioned, single-writer plan state.
 * Only the Wizard may modify plan state. Steps become frozen once DONE.
 *
 * Ported from: src/harness/agent/wizard/plan_state.py
 */

import { v4 as uuidv4 } from 'uuid';
import type { WizardPlan, WizardStep } from '../types/plans.js';
import { StepStatus, StepPhase, DependencyType } from '../types/plans.js';

/**
 * Typed dependency with hard/soft semantics.
 */
export interface StepDependency {
  stepNum: number;
  depType: DependencyType;
}

/**
 * Runtime state for a single step.
 */
export interface StepState {
  stepNum: number;
  status: StepStatus;
  /** IMMUTABLE - never mutated after creation */
  objective: string;
  toolHint?: string;
  /** Legacy: step nums (treated as soft deps) */
  dependsOn: number[];
  phase: StepPhase;
  /** Typed dependencies (replaces dependsOn for new steps) */
  typedDeps: StepDependency[];
  /** Target paths - explicit files to operate on */
  targetPaths: string[];
  /** True when DONE - cannot be modified */
  isFrozen: boolean;
  startedAt?: number;
  completedAt?: number;
  /** Worker tracking */
  workerId?: string;
  outcomeSummary?: string;
  /** Attempt tracking */
  attemptCount: number;
  lastError?: string;
  /** Clarification tracking */
  clarificationRequestId?: string;
  /** Redo overrides (objective remains immutable) */
  overrideObjective?: string;
  /** Scaffolding metadata */
  scaffoldedFrom?: number;
  scaffoldDepth: number;
  /** Explicit position for correct execution order */
  position: number;
  /** If True, cannot be skipped for goal_achieved */
  required: boolean;
}

/**
 * Create StepState from WizardStep definition.
 */
export function stepStateFromWizardStep(step: WizardStep): StepState {
  const typedDeps: StepDependency[] = step.dependsOn.map((dep) => ({
    stepNum: dep,
    depType: DependencyType.SOFT,
  }));

  return {
    stepNum: step.stepNum,
    status: step.status,
    objective: step.objective,
    toolHint: step.toolHint,
    dependsOn: [...step.dependsOn],
    phase: step.phase,
    typedDeps,
    targetPaths: step.targetPaths ? [...step.targetPaths] : [],
    isFrozen: false,
    attemptCount: 0,
    scaffoldDepth: 0,
    position: step.stepNum,
    required: step.required ?? false,
  };
}

// Statuses that satisfy SOFT dependencies
const SOFT_DEP_SATISFIED = new Set([StepStatus.COMPLETED, StepStatus.SKIPPED]);
// Statuses that satisfy HARD dependencies (SKIPPED does NOT satisfy)
const HARD_DEP_SATISFIED = new Set([StepStatus.COMPLETED]);

/**
 * Single-writer global plan state owned by Wizard.
 *
 * INVARIANTS:
 * - version increments on every modification
 * - frozen steps cannot be modified
 * - only FUTURE steps can be patched
 */
export class PlanState {
  planId: string;
  version: number;
  goal: string;
  goalType: string;
  steps: Map<number, StepState>;
  discoveryComplete: boolean;
  executionComplete: boolean;
  createdAt: number;
  lastModified: number;

  constructor(
    planId: string,
    goal: string,
    goalType: string,
    steps: Map<number, StepState>
  ) {
    this.planId = planId;
    this.version = 1;
    this.goal = goal;
    this.goalType = goalType;
    this.steps = steps;
    this.discoveryComplete = false;
    this.executionComplete = false;
    this.createdAt = Date.now();
    this.lastModified = Date.now();
  }

  /**
   * Create PlanState from WizardPlan.
   */
  static fromWizardPlan(plan: WizardPlan): PlanState {
    const steps = new Map<number, StepState>();
    for (const step of plan.steps) {
      steps.set(step.stepNum, stepStateFromWizardStep(step));
    }
    return new PlanState(uuidv4(), plan.goal, plan.goalType, steps);
  }

  /**
   * Get steps whose dependencies are satisfied and status is PENDING.
   */
  getReadySteps(): StepState[] {
    const ready: StepState[] = [];

    for (const step of this.steps.values()) {
      if (step.status !== StepStatus.PENDING) continue;
      if (step.isFrozen) continue;

      if (this.checkDependenciesSatisfied(step)) {
        ready.push(step);
      }
    }

    // Sort by position for deterministic execution order
    ready.sort((a, b) => a.position - b.position);
    return ready;
  }

  /**
   * Check if all dependencies for a step are satisfied.
   */
  private checkDependenciesSatisfied(step: StepState): boolean {
    // If we have typed_deps, use those
    if (step.typedDeps.length > 0) {
      for (const dep of step.typedDeps) {
        const depStep = this.steps.get(dep.stepNum);
        if (!depStep) return false;

        if (dep.depType === DependencyType.HARD) {
          if (!HARD_DEP_SATISFIED.has(depStep.status)) return false;
        } else {
          if (!SOFT_DEP_SATISFIED.has(depStep.status)) return false;
        }
      }
      return true;
    }

    // Legacy: use dependsOn as soft deps
    for (const depNum of step.dependsOn) {
      const depStep = this.steps.get(depNum);
      if (!depStep) return false;
      if (!SOFT_DEP_SATISFIED.has(depStep.status)) return false;
    }
    return true;
  }

  /**
   * Only PENDING steps that are not frozen can be modified.
   */
  canModifyStep(stepNum: number): boolean {
    const step = this.steps.get(stepNum);
    if (!step) return false;
    return !step.isFrozen && step.status === StepStatus.PENDING;
  }

  /**
   * Mark step as frozen (DONE). Cannot be undone.
   */
  freezeStep(stepNum: number): void {
    const step = this.steps.get(stepNum);
    if (step) {
      step.isFrozen = true;
      if (step.completedAt === undefined) {
        step.completedAt = Date.now();
      }
    }
  }

  /**
   * Mark step as IN_PROGRESS with worker assignment.
   */
  markStepInProgress(stepNum: number, workerId: string): void {
    const step = this.steps.get(stepNum);
    if (step && this.canModifyStep(stepNum)) {
      step.status = StepStatus.IN_PROGRESS;
      step.workerId = workerId;
      step.startedAt = Date.now();
      step.attemptCount += 1;
      this.bumpVersion();
    }
  }

  /**
   * Mark step as COMPLETED and freeze it.
   */
  markStepComplete(stepNum: number, outcomeSummary: string): void {
    const step = this.steps.get(stepNum);
    if (step) {
      step.status = StepStatus.COMPLETED;
      step.outcomeSummary = outcomeSummary;
      step.completedAt = Date.now();
      this.freezeStep(stepNum);
      this.bumpVersion();
    }
  }

  /**
   * Mark step as FAILED (can be retried).
   */
  markStepFailed(stepNum: number, error: string): void {
    const step = this.steps.get(stepNum);
    if (step) {
      step.status = StepStatus.FAILED;
      step.outcomeSummary = `FAILED: ${error}`;
      step.lastError = error;
      step.workerId = undefined;
      this.bumpVersion();
    }
  }

  /**
   * Mark step as SKIPPED (permanently giving up).
   */
  markStepSkipped(stepNum: number, reason: string): void {
    const step = this.steps.get(stepNum);
    if (step) {
      step.status = StepStatus.SKIPPED;
      step.outcomeSummary = `SKIPPED: ${reason}`;
      step.completedAt = Date.now();
      this.freezeStep(stepNum);
      this.bumpVersion();
    }
  }

  /**
   * Mark step as AWAITING_USER with clarification request ID.
   */
  markStepAwaitingUser(stepNum: number, requestId: string): void {
    const step = this.steps.get(stepNum);
    if (step && !step.isFrozen) {
      step.status = StepStatus.AWAITING_USER;
      step.clarificationRequestId = requestId;
      this.bumpVersion();
    }
  }

  /**
   * Reset a FAILED/IN_PROGRESS/AWAITING_USER step back to PENDING for retry.
   */
  resetStepForRetry(stepNum: number, lastError?: string): boolean {
    const step = this.steps.get(stepNum);
    if (!step) return false;
    if (step.isFrozen) return false;

    const retryableStatuses = [
      StepStatus.FAILED,
      StepStatus.IN_PROGRESS,
      StepStatus.AWAITING_USER,
    ];
    if (!retryableStatuses.includes(step.status)) return false;

    step.status = StepStatus.PENDING;
    step.workerId = undefined;
    step.startedAt = undefined;
    step.outcomeSummary = undefined;
    step.clarificationRequestId = undefined;
    if (lastError !== undefined) {
      step.lastError = lastError;
    }
    this.bumpVersion();
    return true;
  }

  /**
   * Set or clear a redo override objective for a step.
   */
  setOverrideObjective(stepNum: number, objective?: string): boolean {
    const step = this.steps.get(stepNum);
    if (!step || step.isFrozen) return false;
    step.overrideObjective = objective;
    this.bumpVersion();
    return true;
  }

  /**
   * Update a step's tool hint.
   */
  setStepToolHint(stepNum: number, toolHint?: string): boolean {
    const step = this.steps.get(stepNum);
    if (!step || step.isFrozen) return false;
    step.toolHint = toolHint;
    this.bumpVersion();
    return true;
  }

  /**
   * Clear IN_PROGRESS state without marking success/failure.
   */
  clearInProgress(stepNum: number): void {
    const step = this.steps.get(stepNum);
    if (step && step.status === StepStatus.IN_PROGRESS) {
      const errorMsg = 'Interrupted: cleared from IN_PROGRESS';
      step.status = StepStatus.FAILED;
      step.outcomeSummary = errorMsg;
      step.lastError = errorMsg;
      step.workerId = undefined;
      this.bumpVersion();
    }
  }

  /**
   * Check if all steps have reached a terminal state.
   */
  isTerminated(): boolean {
    for (const step of this.steps.values()) {
      if (
        step.status !== StepStatus.COMPLETED &&
        step.status !== StepStatus.SKIPPED
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if the goal was actually achieved.
   */
  goalAchieved(): boolean {
    if (!this.isTerminated()) return false;

    const requiredSteps = Array.from(this.steps.values()).filter((s) => s.required);

    if (requiredSteps.length > 0) {
      // All required steps must be COMPLETED
      return requiredSteps.every((s) => s.status === StepStatus.COMPLETED);
    } else {
      // No required steps: at least one must be COMPLETED
      return Array.from(this.steps.values()).some(
        (s) => s.status === StepStatus.COMPLETED
      );
    }
  }

  /**
   * Get steps that are stuck (IN_PROGRESS too long or FAILED).
   */
  getStuckSteps(): StepState[] {
    const stuck: StepState[] = [];
    const now = Date.now();

    for (const step of this.steps.values()) {
      if (step.status === StepStatus.IN_PROGRESS) {
        // Stuck if IN_PROGRESS for > 5 minutes
        if (step.startedAt && now - step.startedAt > 300_000) {
          stuck.push(step);
        }
      } else if (step.status === StepStatus.FAILED) {
        stuck.push(step);
      }
    }

    return stuck;
  }

  /**
   * Insert a new step into the plan.
   */
  insertStep(params: {
    objective: string;
    toolHint?: string;
    phase?: StepPhase;
    dependsOn?: number[];
    insertAfter?: number;
    required?: boolean;
    scaffoldedFrom?: number;
    scaffoldDepth?: number;
  }): number {
    const nextNum = Math.max(0, ...this.steps.keys()) + 1;

    // Calculate position
    let position: number;
    if (params.insertAfter !== undefined) {
      const afterStep = this.steps.get(params.insertAfter);
      if (afterStep) {
        const higherPositions = Array.from(this.steps.values())
          .filter((s) => s.position > afterStep.position)
          .map((s) => s.position);
        if (higherPositions.length > 0) {
          position = (afterStep.position + Math.min(...higherPositions)) / 2;
        } else {
          position = afterStep.position + 1.0;
        }
      } else {
        position = nextNum;
      }
    } else {
      const maxPosition = Math.max(0, ...Array.from(this.steps.values()).map((s) => s.position));
      position = maxPosition + 1.0;
    }

    const validDeps = (params.dependsOn ?? []).filter((d) => this.steps.has(d));
    const typedDeps: StepDependency[] = validDeps.map((d) => ({
      stepNum: d,
      depType: DependencyType.SOFT,
    }));

    const newStep: StepState = {
      stepNum: nextNum,
      status: StepStatus.PENDING,
      objective: params.objective,
      toolHint: params.toolHint,
      dependsOn: validDeps,
      phase: params.phase ?? StepPhase.EXECUTION,
      typedDeps,
      targetPaths: [],
      isFrozen: false,
      attemptCount: 0,
      scaffoldedFrom: params.scaffoldedFrom,
      scaffoldDepth: params.scaffoldDepth ?? 0,
      position,
      required: params.required ?? false,
    };

    this.steps.set(nextNum, newStep);
    this.bumpVersion();
    return nextNum;
  }

  private bumpVersion(): void {
    this.version += 1;
    this.lastModified = Date.now();
  }
}
