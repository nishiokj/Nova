/**
 * Execution State - Consolidated state for orchestrator loop execution.
 *
 * Groups scattered local variables from executeInner into a single object
 * for cleaner parameter passing and state management.
 */

import type { WorkItem } from 'work';
import type { Agent, AgentResult } from 'agent';

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
  /** Last cadence audit timestamp (ms) */
  lastCadenceAuditMs: number;
  /** Tool calls at last cadence audit */
  lastCadenceAuditToolCalls: number;
  /** Last agent result (for hook context) */
  lastAgentResult?: AgentResult;
  /** Last agent work ID (for hook context) */
  lastAgentWorkId?: string;
  /** In-progress work items with their agents */
  inProgress: Map<string, { item: WorkItem; agent: Agent | null }>;
}

/**
 * Create initial execution state for a new orchestration run.
 */
export function createExecutionState(initialWorkId: string): ExecutionState {
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
    lastCadenceAuditMs: Date.now(),
    lastCadenceAuditToolCalls: 0,
    lastAgentResult: undefined,
    lastAgentWorkId: undefined,
    inProgress: new Map(),
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
  state.lastAgentResult = result;
}
