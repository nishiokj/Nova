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
  | 'agent_reasoning'
  | 'artifact_discovered'
  | 'agent_progress'
  | 'memory_injected'
  | 'permission_request'
  | 'git_commit'
  | 'harness_response'
  | 'harness_status'
  | 'harness_error'
  | 'harness_user_prompt';

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
  | 'goal_not_achieved'
  | 'watcher_decision';

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
  /** Optional session key for routing events to persistence */
  sessionKey?: string;
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
  requestId = '',
  sessionKey?: string
): AgentEvent<T> {
  return {
    type,
    requestId,
    sessionKey,
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
    session_key: event.sessionKey ?? null,
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
  cachedTokens?: number;
  maxWindowSize?: number;
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

/**
 * Data for agent_reasoning event.
 * Emitted when the LLM produces reasoning/thinking content.
 */
export interface AgentReasoningData {
  /** The reasoning/thinking content from the model */
  content: string;
  /** Agent type that produced this reasoning */
  agentType: string;
  /** Whether this is a final chunk or streaming */
  isFinal?: boolean;
}

/**
 * Data for memory_injected event.
 * Emitted when memory is injected into the agent context.
 */
export interface MemoryInjectedData {
  /** Search query used to retrieve memory */
  query: string;
  /** Memory content preview - first 500 chars */
  resultPreview?: string;
  /** Full injected memory content (if available) */
  memoryContent?: string;
  /** Final task context string with memory appended (if available) */
  contextWithMemory?: string;
  /** Number of memory items returned */
  itemCount: number;
  /** Whether injection succeeded */
  success: boolean;
  /** Which iteration this was */
  iteration: number;
  /** Injection version */
  version?: 'v1' | 'v2';
  /** Retrieval latency (ms) */
  latencyMs?: number;
  /** Category coverage counts (v2 only) */
  coverage?: Record<string, number>;
  /** Discriminators included (v2 only) */
  discriminatorsIncluded?: number;
  /** Total tokens injected (v2 only) */
  totalTokens?: number;
  /** Whether v2 fell back to v1 */
  fallbackToV1?: boolean;
}

/**
 * Data for watcher_decision event.
 * Emitted when the decision watcher makes an autonomous decision.
 */
export interface WatcherDecisionData {
  trigger: string;
  watcherAction: string;
  question?: string;
  answer?: string;
  rationale: string;
  qualityGate?: { passed: boolean; issues?: string[] };
}

/**
 * Data for permission_request event.
 * Emitted when a tool requires user permission.
 */
export interface PermissionRequestEventData {
  /** Unique ID for this permission request */
  requestId: string;
  /** The tool requiring permission */
  tool: 'Bash' | 'Write' | 'Edit';
  /** Target: command for Bash, file path for Write/Edit */
  target: string;
  /** Suggested pattern for "Always Allow" option */
  suggestedPattern: string;
  /** Working directory for context */
  workingDirectory: string;
  /** Human-readable description of the action */
  description: string;
}

/**
 * Data for git_commit event.
 * Emitted when a git commit is detected from Bash tool output.
 */
export interface GitCommitData {
  /** Git commit SHA (7-40 hex chars) */
  sha: string;
  /** Explicit head SHA for deterministic revision ranges (usually same as sha) */
  headSha?: string;
  /** Explicit base SHA captured at commit time, when available */
  baseSha?: string;
  /** The bash command that triggered the commit */
  command: string;
  /** Commit message if extractable */
  message?: string;
  /** Branch name if detectable */
  branch?: string;
}

// ============================================
// EVENT CALLBACK TYPE
// ============================================

/**
 * Callback function type for receiving events.
 */
export type EventCallback = (event: AgentEvent) => void;
