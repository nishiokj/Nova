/**
 * Wizard Plan Types
 *
 * Types for the Wizard execution system.
 * Ported from: src/harness/agent/wizard/types.py
 */

/**
 * Step execution status.
 */
export enum StepStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  AWAITING_USER = 'awaiting_user',
}

/**
 * Step execution phase.
 */
export enum StepPhase {
  DISCOVERY = 'discovery',
  EXECUTION = 'execution',
}

/**
 * Dependency type (hard vs soft).
 */
export enum DependencyType {
  /** HARD: Must be COMPLETED (SKIPPED blocks the step) */
  HARD = 'hard',
  /** SOFT: Can be COMPLETED or SKIPPED */
  SOFT = 'soft',
}

/**
 * Goal type classification for Wizard plans.
 * Note: Named WizardGoalType to avoid conflict with plan.ts GoalType
 */
export type WizardGoalType = 'task' | 'question' | 'search' | 'error';

/**
 * A single step in a wizard plan.
 */
export interface WizardStep {
  /** Step number (unique identifier) */
  stepNum: number;
  /** What this step accomplishes */
  objective: string;
  /** Current status */
  status: StepStatus;
  /** Phase of execution */
  phase: StepPhase;
  /** Steps this depends on (soft dependencies) */
  dependsOn: number[];
  /** Suggested tool to use */
  toolHint?: string;
  /** Suggested tool arguments */
  toolArgsHint?: Record<string, unknown>;
  /** Target file paths */
  targetPaths?: string[];
  /** If true, this step must complete for goal success */
  required?: boolean;
}

/**
 * A wizard execution plan.
 */
export interface WizardPlan {
  /** High-level goal */
  goal: string;
  /** Type of goal */
  goalType: WizardGoalType | string;
  /** Ordered steps to execute */
  steps: WizardStep[];
  /** Reasoning for this plan structure */
  reasoning?: string;
  /** Assumptions made during planning */
  assumptions?: string[];
}

/**
 * Create a wizard step.
 */
export function createWizardStep(params: {
  stepNum: number;
  objective: string;
  phase?: StepPhase;
  dependsOn?: number[];
  toolHint?: string;
  toolArgsHint?: Record<string, unknown>;
  targetPaths?: string[];
  required?: boolean;
}): WizardStep {
  return {
    stepNum: params.stepNum,
    objective: params.objective,
    status: StepStatus.PENDING,
    phase: params.phase ?? StepPhase.EXECUTION,
    dependsOn: params.dependsOn ?? [],
    toolHint: params.toolHint,
    toolArgsHint: params.toolArgsHint,
    targetPaths: params.targetPaths,
    required: params.required,
  };
}

/**
 * Create a wizard plan.
 */
export function createWizardPlan(params: {
  goal: string;
  goalType?: WizardGoalType | string;
  steps?: WizardStep[];
  reasoning?: string;
  assumptions?: string[];
}): WizardPlan {
  return {
    goal: params.goal,
    goalType: params.goalType ?? 'task',
    steps: params.steps ?? [],
    reasoning: params.reasoning,
    assumptions: params.assumptions,
  };
}

/**
 * Reflection on plan execution.
 */
export interface WizardReflection {
  planGoal: string;
  goalAchieved: boolean;
  confidence: number;
  evidence: string[];
  gaps: string[];
  suggestions: string[];
  summary: string;
}

/**
 * Verdict from reflection.
 */
export enum ReflectionVerdict {
  ACCEPT = 'accept',
  REFINE = 'refine',
  REJECT = 'reject',
}
