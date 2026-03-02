import type { TerminationReason } from 'types';

export interface ControlEventBase {
  type: string;
  timestamp: number;
  sessionKey: string;
  workId: string;
}

export interface ExecutionMetrics {
  toolCallsMade: number;
  llmCalls: number;
  contextPercentUsed: number;
  durationMs: number;
  filesRead: string[];
  filesModified: string[];
  iterationCount: number;
}

export interface Artifact {
  type: 'file' | 'url' | 'data';
  path?: string;
  url?: string;
  data?: unknown;
  description: string;
}

export interface PromptOption {
  label: string;
  description?: string;
}

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

export interface AgentErrorEvent extends ControlEventBase {
  type: 'agent_error';
  errorType: 'exception' | 'invalid_action' | 'no_action';
  error: string;
  stack?: string;
  metrics: ExecutionMetrics;
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

export type ControlEvent =
  | GoalReachedEvent
  | BoundsExceededEvent
  | UserInputRequiredEvent
  | AgentErrorEvent
  | UserStoppedEvent
  | TransientErrorEvent
  | WorkItemCompletedEvent;

export type ControlEventType = ControlEvent['type'];

export const ALL_EVENT_TYPES: readonly ControlEventType[] = [
  'goal_state_reached',
  'bounds_exceeded',
  'user_input_required',
  'agent_error',
  'user_stopped',
  'transient_error',
  'work_item_completed',
] as const;

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

export function createAgentErrorEvent(
  sessionKey: string,
  workId: string,
  errorType: 'exception' | 'invalid_action' | 'no_action',
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

export function createWorkItemCompletedEvent(
  sessionKey: string,
  workId: string,
  success: boolean,
  response: string,
  filesModified: string[],
  metrics: ExecutionMetrics,
  terminationReason: TerminationReason
): WorkItemCompletedEvent {
  return {
    type: 'work_item_completed',
    timestamp: Date.now(),
    sessionKey,
    workId,
    success,
    response,
    filesModified,
    metrics,
    terminationReason,
  };
}
