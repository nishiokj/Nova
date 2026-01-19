/**
 * Harness types for wiring the TypeScript agent to the TUI.
 *
 * These types bridge the agent's internal types with the TUI's BridgeEvent format.
 */

/** Tier classification for routing */
export type Tier = 'simple' | 'standard' | 'complex';

/**
 * Parameters for running the agent.
 */
export interface AgentRunParams {
  requestId: string;
  inputText: string;
  tier?: Tier;
  sessionKey: string;
  workingDir: string;
  context?: string;
  planMode?: boolean;
  stopHook?: import('orchestrator').StopHookHandler;
}

/**
 * Result from an agent run.
 */
export interface AgentRunResult {
  requestId: string;
  sessionKey: string;
  success: boolean;
  finalText: string;
  errorMessage?: string;
  paused: boolean;
  userPrompt?: UserPromptInfo;
  toolsUsed: string[];
  durationMs: number;
  metadata?: Record<string, unknown>;
}

/** Single question item */
export interface UserPromptQuestion {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
}

/**
 * User prompt info when agent pauses for input.
 */
export interface UserPromptInfo {
  requestId: string;
  /** Single question (backwards compatible) */
  question?: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
  /** Multiple questions to ask in sequence */
  questions?: UserPromptQuestion[];
}

/**
 * Bridge event types matching TUI expectations.
 */
export type BridgeEventType =
  | 'ready'
  | 'status'
  | 'progress'
  | 'stream'
  | 'response'
  | 'user_prompt'
  | 'error'
  | 'provider_key_required'
  | 'model_changed';

/**
 * Bridge event structure matching TUI expectations.
 */
export interface BridgeEvent {
  type: BridgeEventType;
  data?: Record<string, unknown>;
}

/**
 * Handle returned from agent.run() for streaming events.
 */
export interface AgentRunHandle {
  result: Promise<AgentRunResult>;
  events: AsyncIterable<BridgeEvent>;
  abort?: () => void;
}

/**
 * Semantic level for coloring/priority.
 */
export type EventLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * Event kind for categorization.
 */
export type EventKind = 'work' | 'tool' | 'planning' | 'system' | 'thinking';

/**
 * Status data for status events.
 */
export interface StatusEventData {
  state: 'idle' | 'sending' | 'streaming' | 'error';
  message?: string;
  /** Semantic level for TUI coloring */
  level?: EventLevel;
  /** Event kind for categorization */
  kind?: EventKind;
}

/**
 * Progress data for progress events.
 */
export interface ProgressEventData {
  request_id?: string;
  message?: string;
  tool_name?: string;
  step_number?: number;
  /** Semantic level for TUI coloring */
  level?: EventLevel;
  /** Event kind for categorization */
  kind?: EventKind;
  /** Duration in milliseconds (for completed operations) */
  duration_ms?: number;
  /** Tool arguments (for structured display) */
  tool_args?: Record<string, unknown>;
  /** Tool result success flag */
  tool_success?: boolean;
}

/**
 * Stream data for streaming events.
 */
export interface StreamEventData {
  request_id: string;
  chunk: string;
  chunk_index?: number;
  is_final?: boolean;
  /** True if this is reasoning/thinking content from the model */
  is_reasoning?: boolean;
}

/**
 * Response data for response events.
 */
export interface ResponseEventData {
  request_id?: string;
  success?: boolean;
  content?: string;
  tools_used?: string[];
  duration_ms?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Ready data for ready events.
 */
export interface ReadyEventData {
  session_key?: string;
  capabilities?: {
    voice_available?: boolean;
    streaming_supported?: boolean;
  };
  config_summary?: string;
}

/** Single question item in wire format */
export interface UserPromptEventQuestion {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multi_select?: boolean;
  question_type?: string;
}

/**
 * User prompt data for user_prompt events.
 */
export interface UserPromptEventData {
  request_id: string;
  /** Single question (backwards compatible) */
  question?: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multi_select?: boolean;
  question_type?: string;
  /** Multiple questions to ask in sequence */
  questions?: UserPromptEventQuestion[];
}

/**
 * Error data for error events.
 */
export interface ErrorEventData {
  message?: string;
  detail?: unknown;
  fatal?: boolean;
  /** Error code for programmatic handling */
  code?: string;
}
