/**
 * Work items are bounded units of work dispatched to Workers.
 * Each has clear success criteria and resource limits.
 *
 * Ported from: src/harness/agent/wizard/work_item.py
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Resource bounds for a work unit.
 *
 * These defaults are per-step limits. The Wizard can allocate different
 * budgets per step, but these are sensible defaults for most work.
 */
export interface WorkBounds {
  /** Max tool calls per step (default: 150) */
  maxToolCalls: number;
  /** Max duration in ms (default: 120000 = 2 minutes) */
  maxDurationMs: number;
  /** Max LLM calls per step (default: 20) */
  maxLlmCalls: number;
}

export const DEFAULT_WORK_BOUNDS: WorkBounds = {
  maxToolCalls: 150,
  maxDurationMs: 120_000,
  maxLlmCalls: 20,
};

/**
 * Success criteria for a work item.
 */
export interface WorkItemCriteria {
  /** Description of success criteria */
  description: string;
  /** Required outputs */
  requiredOutputs: string[];
  /** Postconditions to verify */
  postconditions: string[];
  /** Hints for verification */
  verificationHints: string[];
}

export function createWorkItemCriteria(
  description = '',
  requiredOutputs: string[] = [],
  postconditions: string[] = [],
  verificationHints: string[] = []
): WorkItemCriteria {
  return { description, requiredOutputs, postconditions, verificationHints };
}

/**
 * Bounded work unit dispatched to Worker.
 *
 * Workers receive WorkItems and return WorkerOutcomes.
 * WorkItems are immutable once created.
 */
export interface WorkItem {
  /** Unique work item ID */
  readonly workId: string;
  /** Step number in the plan */
  readonly stepNum?: number;
  /** High-level goal of the plan */
  readonly goal: string;
  /** Objective to accomplish */
  readonly objective: string;
  /** How this advances the goal */
  readonly delta?: string;
  /** Agent type to execute this work */
  readonly agent: string;
  /** Dependencies (work IDs) that must complete first */
  readonly dependencies: readonly string[];
  /** Target file paths to operate on */
  readonly targetPaths: readonly string[];
  /** Suggested tool to use */
  readonly toolHint?: string;
  /** Suggested tool arguments */
  readonly toolArgsHint?: Record<string, unknown>;
  /** Optional structured params */
  readonly params?: Record<string, unknown>;
  /** Resource bounds */
  readonly bounds: WorkBounds;
  /** Success criteria */
  readonly successCriteria: WorkItemCriteria;
  /** Preconditions that have been met */
  readonly preconditionsMet: readonly string[];
}

/**
 * Known param shapes for typed access.
 * The actual params field remains Record<string, unknown> for flexibility.
 */
export interface InternalHookParams {
  isInternalHook: true;
  hookType: string;
  handler: () => Promise<void>;
}

/**
 * Create a work item.
 */
export function createWorkItem(params: {
  stepNum?: number;
  goal: string;
  objective: string;
  delta?: string;
  agent?: string;
  dependencies?: string[];
  targetPaths?: string[];
  toolHint?: string;
  toolArgsHint?: Record<string, unknown>;
  bounds?: Partial<WorkBounds>;
  successCriteria?: Partial<WorkItemCriteria>;
  preconditionsMet?: string[];
  params?: Record<string, unknown>;
}): WorkItem {
  return {
    workId: uuidv4().slice(0, 8),
    stepNum: params.stepNum,
    goal: params.goal,
    objective: params.objective,
    delta: params.delta,
    agent: params.agent ?? 'standard',
    dependencies: Object.freeze(params.dependencies ?? []),
    targetPaths: Object.freeze(params.targetPaths ?? []),
    toolHint: params.toolHint,
    toolArgsHint: params.toolArgsHint,
    params: params.params,
    bounds: { ...DEFAULT_WORK_BOUNDS, ...params.bounds },
    successCriteria: {
      description: params.successCriteria?.description ?? `Complete: ${params.objective}`,
      requiredOutputs: params.successCriteria?.requiredOutputs ?? [],
      postconditions: params.successCriteria?.postconditions ?? [],
      verificationHints: params.successCriteria?.verificationHints ?? [],
    },
    preconditionsMet: Object.freeze(params.preconditionsMet ?? []),
  };
}

/**
 * Create a work item from step state.
 */
export function workItemFromStepState(
  step: {
    stepNum: number;
    objective: string;
    overrideObjective?: string;
    toolHint?: string;
    targetPaths?: string[];
  },
  goal: string,
  bounds?: Partial<WorkBounds>
): WorkItem {
  return createWorkItem({
    stepNum: step.stepNum,
    goal,
    objective: step.overrideObjective ?? step.objective,
    targetPaths: step.targetPaths ?? [],
    toolHint: step.toolHint,
    bounds,
  });
}
