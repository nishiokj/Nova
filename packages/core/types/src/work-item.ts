import { v4 as uuidv4 } from 'uuid';

export interface WorkBounds {
  maxToolCalls: number;
  maxDurationMs: number;
  maxLlmCalls: number;
}

export const DEFAULT_WORK_BOUNDS: WorkBounds = {
  maxToolCalls: 150,
  maxDurationMs: 120_000,
  maxLlmCalls: 20,
};

export interface WorkItemCriteria {
  description: string;
  requiredOutputs: string[];
  postconditions: string[];
  verificationHints: string[];
}

export interface WorkItem {
  readonly workId: string;
  readonly stepNum?: number;
  readonly goal: string;
  readonly objective: string;
  readonly delta?: string;
  readonly agent: string;
  readonly domain?: string;
  readonly dependencies: readonly string[];
  readonly targetPaths: readonly string[];
  readonly toolHint?: string;
  readonly toolArgsHint?: Record<string, unknown>;
  readonly params?: Record<string, unknown>;
  readonly bounds: WorkBounds;
  readonly successCriteria: WorkItemCriteria;
  readonly preconditionsMet: readonly string[];
}

export function createWorkItem(params: {
  stepNum?: number;
  goal: string;
  objective: string;
  delta?: string;
  agent?: string;
  domain?: string;
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
    domain: params.domain,
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

export function cloneWorkItemWithDependencies(item: WorkItem, dependencies: string[]): WorkItem {
  return {
    ...item,
    dependencies: Object.freeze(dependencies),
  };
}
