/**
 * Agent and Orchestrator event types.
 *
 * Events are emitted via callbacks; the EventBus tags requestId/runId and fans out.
 */

// AgentType is just a string identifier for agent types (e.g., 'routing', 'explorer', 'standard')
type CoreAgentType = string;

// ============================================
// EVENT TYPES
// ============================================

/**
 * Core agent event types.
 */
export type AgentCoreEventType =
  | 'tool_call'
  | 'hook_call'
  | 'llm_call'
  | 'llm_error'
  | 'rate_limit'
  | 'agent_bounds_hit'
  | 'agent_message'
  | 'artifact_discovered'
  | 'agent_progress';

/**
 * Orchestrator event types.
 */
export type OrchestratorEventType =
  | 'orchestration_started'
  | 'iteration_started'
  | 'iteration_completed'
  | 'runtime_script_created'
  | 'workitem_status'
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
 * Work item status values.
 */
export type WorkItemStatusValue = 'started' | 'completed' | 'failed' | 'skipped';

/**
 * Unified data for workitem_status event.
 */
export interface WorkItemStatusData {
  workId: string;
  objective: string;
  delta?: string;
  agent: AgentType;
  dependencies: string[];
  status: WorkItemStatusValue;
  // Fields for 'completed' status
  response?: string;
  metrics?: {
    llmCallsMade: number;
    toolCallsMade: number;
    durationMs: number;
  };
  // Fields for 'failed' status
  error?: string;
  toolErrors?: string[];
  terminationReason?: string;
  // Fields for 'skipped' status
  reason?: string;
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
 * Phase of a hook call event.
 */
export type HookCallPhase = 'starting' | 'completed';

/**
 * Data for hook_call event.
 */
export interface HookCallData {
  hookType: string;
  phase: HookCallPhase;
  success?: boolean;
  error?: string;
  durationMs?: number;
}

/**
 * Data for llm_call event.
 */
export interface LLMCallData {
  agentType: AgentType;
  provider: string;
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

/**
 * Rate limit type classification.
 */
export type RateLimitType = 'window' | 'quota' | 'billing' | 'unknown';

/**
 * Data for rate_limit event.
 * Emitted when a rate limit is hit and the adapter can't recover automatically.
 */
export interface RateLimitData {
  provider: string;
  model: string;
  /** Type of rate limit hit */
  type: RateLimitType;
  /** Retry-after time in milliseconds, if known */
  retryAfterMs?: number;
  /** What was limited (tokens, requests, etc.) */
  limitType?: string;
  /** Error message from the API */
  message: string;
  /** Whether the context was preserved */
  contextPreserved: boolean;
}

/**
 * Data for artifact_discovered event.
 * Emitted in real-time when an agent discovers artifacts.
 */
export interface ArtifactDiscoveredData {
  artifact: {
    id: string;
    sourcePath: string;
    line?: number;
    kind: string;
    name: string;
    signature?: string;
    insight?: string;
    relevance: number;
  };
  agentType: string;
  artifactCount: number;
}

/**
 * Data for agent_progress event.
 * Emitted at key milestones for TUI progress display.
 */
export interface AgentProgressData {
  message: string;
  agentType: string;
  category?: 'search' | 'analysis' | 'discovery' | 'synthesis';
  count?: { current: number; total?: number; label: string };
}

// ============================================
// EVENT CALLBACK TYPE
// ============================================

/**
 * Callback function type for receiving events.
 */
export type EventCallback = (event: AgentEvent) => void;
