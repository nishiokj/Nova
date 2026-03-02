/**
 * Execution State - Consolidated state for orchestrator loop execution.
 *
 * Groups scattered local variables from executeInner into a single object
 * for cleaner parameter passing and state management.
 */

import type { WorkItem } from 'types';
import type { Agent, AgentResult } from 'agent';
import type { RunControlMetadata } from 'types';

export interface InProgressWork {
  item: WorkItem;
  agent: Agent | null;
  abortController?: AbortController;
  cancelReason?: string;
}

/**
 * Consolidated execution state for the orchestrator loop.
 */
export interface ExecutionState {
  /** Current iteration number */
  iteration: number;
  /** Total LLM calls across all work items */
  totalLlmCalls: number;
  /** Total tool calls across all work items */
  totalToolCalls: number;
  /** Execution start time (ms since epoch) */
  startTime: number;
  /** Initial work item ID */
  initialWorkId: string;
  /** Whether initial work has completed */
  initialWorkCompleted: boolean;
  /** Response from initial work */
  initialWorkResponse: string;
  /** Full result from initial work */
  initialWorkResult?: AgentResult;
  /** Whether context was compacted recently (hysteresis gate) */
  compactedRecently: boolean;
  /** In-progress work items with their agents */
  inProgress: Map<string, InProgressWork>;
  /** Latest run-control snapshot applied by the orchestrator runtime */
  runControl: RunControlMetadata;
}

/**
 * Create initial execution state for a new orchestration run.
 */
export function createExecutionState(
  initialWorkId: string,
  runControl: RunControlMetadata = { state: 'running' }
): ExecutionState {
  return {
    iteration: 0,
    totalLlmCalls: 0,
    totalToolCalls: 0,
    startTime: Date.now(),
    initialWorkId,
    initialWorkCompleted: false,
    initialWorkResponse: '',
    initialWorkResult: undefined,
    compactedRecently: false,
    inProgress: new Map(),
    runControl,
  };
}

/**
 * Get elapsed time since execution started.
 */
export function getElapsedMs(state: ExecutionState): number {
  return Date.now() - state.startTime;
}

/**
 * Increment iteration and return new value.
 */
export function nextIteration(state: ExecutionState): number {
  state.iteration++;
  return state.iteration;
}

/**
 * Update metrics from agent result.
 */
export function updateMetrics(
  state: ExecutionState,
  result: AgentResult
): void {
  state.totalLlmCalls += result.metrics.llmCallsMade;
  state.totalToolCalls += result.metrics.toolCallsMade;
}

export function updateRunControl(
  state: ExecutionState,
  runControl: RunControlMetadata
): void {
  state.runControl = runControl;
}
