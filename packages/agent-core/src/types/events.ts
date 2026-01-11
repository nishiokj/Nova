/**
 * Agent and Orchestrator event types.
 *
 * Events are emitted via callbacks; the EventBus tags requestId/runId and fans out.
 */

import type { AgentType as CoreAgentType } from '../agent/types.js';

// ============================================
// EVENT TYPES
// ============================================

/**
 * Core agent event types.
 */
export type AgentCoreEventType =
  | 'tool_call'
  | 'llm_call'
  | 'llm_error'
  | 'agent_bounds_hit';

/**
 * Orchestrator event types.
 */
export type OrchestratorEventType =
  | 'orchestration_started'
  | 'iteration_started'
  | 'iteration_completed'
  | 'runtime_script_created'
  | 'workitem_started'
  | 'workitem_completed'
  | 'workitem_failed'
  | 'workitem_skipped'
  | 'goal_achieved'
  | 'goal_not_achieved';

/**
 * All event types.
 */
export type AgentEventType = AgentCoreEventType | OrchestratorEventType;

/**
 * Event agent type identifiers.
 */
export type AgentType = CoreAgentType | 'orchestrator';

// ============================================
// BASE EVENT
// ============================================

/**
 * Base event structure.
 * All events conform to this shape.
 */
export interface AgentEvent<T = Record<string, unknown>> {
  type: AgentEventType;
  /** REQUIRED: Correlates all events for a single request */
  requestId: string;
  /** Optional run ID for per-run channels */
  runId?: string;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** WorkItem ID if event is workitem-related */
  workItemId?: string;
  /** Event-specific payload */
  data: T;
}

/**
 * Create an event with current timestamp.
 */
export function createEvent<T>(
  type: AgentEventType,
  data: T,
  workItemId?: string,
  requestId = ''
): AgentEvent<T> {
  return {
    type,
    requestId,
    timestamp: Date.now() / 1000,
    workItemId,
    data,
  };
}

/**
 * Serialize event to JSON-compatible dict.
 */
export function eventToDict(event: AgentEvent): Record<string, unknown> {
  return {
    type: event.type,
    timestamp: event.timestamp,
    request_id: event.requestId,
    run_id: event.runId ?? null,
    work_item_id: event.workItemId ?? null,
    data: event.data ?? {},
  };
}

// ============================================
// EVENT PAYLOADS
// ============================================

/**
 * Data for runtime_script_created event.
 */
export interface RuntimeScriptCreatedData {
  goal: string;
  workItemCount: number;
  workItems: Array<{
    workId: string;
    objective: string;
    delta?: string;
    agent: AgentType;
    dependencies: string[];
  }>;
  systemContext: {
    packageManagers: string[];
    frameworks: string[];
    languages: string[];
  };
}

/**
 * Data for workitem_started event.
 */
export interface WorkItemStartedData {
  workId: string;
  objective: string;
  delta?: string;
  agent: AgentType;
  dependencies: string[];
}

/**
 * Data for workitem_completed event.
 */
export interface WorkItemCompletedData {
  workId: string;
  objective: string;
  response: string;
  metrics: {
    llmCallsMade: number;
    toolCallsMade: number;
    durationMs: number;
  };
}

/**
 * Data for workitem_failed event.
 */
export interface WorkItemFailedData {
  workId: string;
  objective: string;
  error: string;
  toolErrors?: string[];
  terminationReason: string;
}

/**
 * Data for workitem_skipped event.
 */
export interface WorkItemSkippedData {
  workId: string;
  objective: string;
  reason: string;
}

/**
 * Data for goal_achieved event.
 */
export interface GoalAchievedData {
  goal: string;
  completed: number;
  skipped: number;
}

/**
 * Data for goal_not_achieved event.
 */
export interface GoalNotAchievedData {
  goal: string;
  reason: string;
  completed: number;
  failed: number;
  skipped: number;
}

/**
 * Phase of a tool call event.
 */
export type ToolCallPhase = 'starting' | 'completed';

/**
 * Data for tool_call event.
 */
export interface ToolCallData {
  toolName: string;
  arguments: Record<string, unknown>;
  phase: ToolCallPhase;
  result?: string;
  success?: boolean;
  durationMs?: number;
}

/**
 * Data for llm_call event.
 */
export interface LLMCallData {
  agentType: AgentType;
  promptPreview: string;
  responsePreview: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  model: string;
  toolCallsCount: number;
  toolNames: string[];
  messageCount: number;
}

/**
 * Data for llm_error event.
 */
export interface LLMErrorData {
  agentType: AgentType;
  provider: string;
  model: string;
  error: string;
  errorType: 'api_error' | 'rate_limit' | 'timeout' | 'validation' | 'circuit_open' | 'unknown';
}

// ============================================
// EVENT CALLBACK TYPE
// ============================================

/**
 * Callback function type for receiving events.
 */
export type EventCallback = (event: AgentEvent) => void;
