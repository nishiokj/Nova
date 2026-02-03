/**
 * Control Plane Events - Discriminated Union
 *
 * All events that flow through the control plane.
 * Each event type has its own payload structure.
 */

import type { HandoffSpec } from './state.js';
import type { TerminationReason } from './termination.js';

/**
 * Base event interface.
 */
export interface ControlEventBase {
  type: string;
  timestamp: number;
  sessionKey: string;
  workId: string;
}

/**
 * Execution metrics snapshot.
 */
export interface ExecutionMetrics {
  toolCallsMade: number;
  llmCalls: number;
  contextPercentUsed: number;
  durationMs: number;
  filesRead: string[];
  filesModified: string[];
  iterationCount: number;
}

/**
 * Artifact produced by the agent.
 */
export interface Artifact {
  type: 'file' | 'url' | 'data';
  path?: string;
  url?: string;
  data?: unknown;
  description: string;
}

/**
 * Prompt option for user input.
 */
export interface PromptOption {
  label: string;
  description?: string;
}

// ============================================
// EVENT DEFINITIONS
// ============================================

export interface GoalReachedEvent extends ControlEventBase {
  type: 'goal_state_reached';
  response: string;
  filesModified: string[];
  metrics: ExecutionMetrics;
  artifacts?: Artifact[];
}

export interface BoundsExceededEvent extends ControlEventBase {
  type: 'bounds_exceeded';
  boundType: 'iterations' | 'tool_calls' | 'duration';
  limit: number;
  current: number;
  response: string;
  metrics: ExecutionMetrics;
}

export interface UserInputRequiredEvent extends ControlEventBase {
  type: 'user_input_required';
  prompt: {
    question: string;
    options?: PromptOption[];
    context?: string;
    multiSelect: boolean;
  };
}

export interface CadenceAuditEvent extends ControlEventBase {
  type: 'cadence_audit';
  elapsedMs: number;
  toolCallsSinceLastAudit: number;
  metrics: ExecutionMetrics;
  recentActivity: string;
  /** Optional list of active workItem IDs included in this audit. */
  workIds?: string[];
}

export interface AgentErrorEvent extends ControlEventBase {
  type: 'agent_error';
  errorType: 'exception' | 'invalid_action' | 'no_action' | 'stagnation';
  error: string;
  stack?: string;
  metrics: ExecutionMetrics;
}

export interface HandoffRequestedEvent extends ControlEventBase {
  type: 'handoff_requested';
  handoffSpec: HandoffSpec;
  plannerResponse: string;
}

export interface UserStoppedEvent extends ControlEventBase {
  type: 'user_stopped';
}

export interface TransientErrorEvent extends ControlEventBase {
  type: 'transient_error';
  errorType: 'rate_limit' | 'circuit_open' | 'timeout';
  retryAfterMs?: number;
}

export interface WorkItemCompletedEvent extends ControlEventBase {
  type: 'work_item_completed';
  success: boolean;
  response: string;
  filesModified: string[];
  metrics: ExecutionMetrics;
  terminationReason: TerminationReason;
}

// ============================================
// CONTROL EVENT UNION
// ============================================

/**
 * All control plane events (discriminated union).
 */
export type ControlEvent =
  | GoalReachedEvent
  | BoundsExceededEvent
  | UserInputRequiredEvent
  | CadenceAuditEvent
  | AgentErrorEvent
  | HandoffRequestedEvent
  | UserStoppedEvent
  | TransientErrorEvent
  | WorkItemCompletedEvent;

/**
 * Extract the type string from a ControlEvent.
 */
export type ControlEventType = ControlEvent['type'];

/**
 * All event types as an array.
 */
export const ALL_EVENT_TYPES: readonly ControlEventType[] = [
  'goal_state_reached',
  'bounds_exceeded',
  'user_input_required',
  'cadence_audit',
  'agent_error',
  'handoff_requested',
  'user_stopped',
  'transient_error',
  'work_item_completed',
] as const;

// ============================================
// TYPE GUARDS
// ============================================

export function isGoalReached(evt: ControlEvent): evt is GoalReachedEvent {
  return evt.type === 'goal_state_reached';
}

export function isBoundsExceeded(evt: ControlEvent): evt is BoundsExceededEvent {
  return evt.type === 'bounds_exceeded';
}

export function isUserInputRequired(evt: ControlEvent): evt is UserInputRequiredEvent {
  return evt.type === 'user_input_required';
}

export function isCadenceAudit(evt: ControlEvent): evt is CadenceAuditEvent {
  return evt.type === 'cadence_audit';
}

export function isAgentError(evt: ControlEvent): evt is AgentErrorEvent {
  return evt.type === 'agent_error';
}

export function isHandoffRequested(evt: ControlEvent): evt is HandoffRequestedEvent {
  return evt.type === 'handoff_requested';
}

export function isUserStopped(evt: ControlEvent): evt is UserStoppedEvent {
  return evt.type === 'user_stopped';
}

export function isTransientError(evt: ControlEvent): evt is TransientErrorEvent {
  return evt.type === 'transient_error';
}

export function isWorkItemCompleted(evt: ControlEvent): evt is WorkItemCompletedEvent {
  return evt.type === 'work_item_completed';
}

// ============================================
// EVENT FACTORIES
// ============================================

/**
 * Create a GoalReachedEvent.
 */
export function createGoalReachedEvent(
  sessionKey: string,
  workId: string,
  response: string,
  filesModified: string[],
  metrics: ExecutionMetrics,
  artifacts?: Artifact[]
): GoalReachedEvent {
  return {
    type: 'goal_state_reached',
    timestamp: Date.now(),
    sessionKey,
    workId,
    response,
    filesModified,
    metrics,
    artifacts,
  };
}

/**
 * Create a BoundsExceededEvent.
 */
export function createBoundsExceededEvent(
  sessionKey: string,
  workId: string,
  boundType: 'iterations' | 'tool_calls' | 'duration',
  limit: number,
  current: number,
  response: string,
  metrics: ExecutionMetrics
): BoundsExceededEvent {
  return {
    type: 'bounds_exceeded',
    timestamp: Date.now(),
    sessionKey,
    workId,
    boundType,
    limit,
    current,
    response,
    metrics,
  };
}

/**
 * Create a UserInputRequiredEvent.
 */
export function createUserInputRequiredEvent(
  sessionKey: string,
  workId: string,
  question: string,
  options?: PromptOption[],
  context?: string,
  multiSelect = false
): UserInputRequiredEvent {
  return {
    type: 'user_input_required',
    timestamp: Date.now(),
    sessionKey,
    workId,
    prompt: { question, options, context, multiSelect },
  };
}

/**
 * Create a CadenceAuditEvent.
 */
export function createCadenceAuditEvent(
  sessionKey: string,
  workId: string,
  elapsedMs: number,
  toolCallsSinceLastAudit: number,
  metrics: ExecutionMetrics,
  recentActivity: string,
  workIds?: string[]
): CadenceAuditEvent {
  return {
    type: 'cadence_audit',
    timestamp: Date.now(),
    sessionKey,
    workId,
    elapsedMs,
    toolCallsSinceLastAudit,
    metrics,
    recentActivity,
    ...(workIds && workIds.length > 0 ? { workIds } : {}),
  };
}

/**
 * Create an AgentErrorEvent.
 */
export function createAgentErrorEvent(
  sessionKey: string,
  workId: string,
  errorType: 'exception' | 'invalid_action' | 'no_action' | 'stagnation',
  error: string,
  metrics: ExecutionMetrics,
  stack?: string
): AgentErrorEvent {
  return {
    type: 'agent_error',
    timestamp: Date.now(),
    sessionKey,
    workId,
    errorType,
    error,
    metrics,
    stack,
  };
}

export function createHandoffRequestedEvent(
  sessionKey: string,
  workId: string,
  handoffSpec: HandoffSpec,
  plannerResponse: string
): HandoffRequestedEvent {
  return {
    type: 'handoff_requested',
    timestamp: Date.now(),
    sessionKey,
    workId,
    handoffSpec,
    plannerResponse,
  };
}
