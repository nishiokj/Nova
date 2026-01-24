export type BridgeCommandType =
  | "init"
  | "send_text"
  | "voice_start"
  | "voice_stop"
  | "get_config"
  | "get_models"
  | "models_delete"
  | "get_status"
  | "skills_list"
  | "skills_get"
  | "skills_create"
  | "skills_update"
  | "skills_delete"
  | "skills_enable"
  | "skills_disable"
  | "skills_run"
  | "hooks_list"
  | "hooks_get"
  | "hooks_create"
  | "hooks_update"
  | "hooks_delete"
  | "hooks_enable"
  | "hooks_disable"
  | "user_prompt_response"
  | "permission_response"
  | "auth_start"
  | "auth_poll"
  | "auth_verify"
  | "auth_logout"
  | "providers_list"
  | "providers_save"
  | "providers_delete"
  | "providers_test"
  | "session_fork"
  | "session_close"
  | "list_sessions"
  | "compact_context"
  | "set_model"
  | "get_model"
  | "ralph_loop_start"
  | "ralph_loop_cancel";

export type BridgeEventType =
  | "ready"
  | "status"
  | "progress"
  | "stream"
  | "response"
  | "transcription"
  | "user_prompt"
  | "error"
  | "provider_key_required"
  | "model_changed"
  | "permission_request"
  | "llm_call";

export interface BridgeCommand {
  type: BridgeCommandType;
  data?: Record<string, unknown>;
}

export interface BridgeEvent {
  type: BridgeEventType;
  data?: Record<string, unknown>;
}

export type TUIState =
  | "idle"
  | "recording"
  | "transcribing"
  | "sending"
  | "streaming"
  | "error";

/** Semantic level for coloring/priority */
export type EventLevel = "info" | "success" | "warning" | "error";

/** Event kind for categorization */
export type EventKind = "work" | "tool" | "planning" | "system";

export type Role = "user" | "agent" | "system" | "status" | "reasoning";

export type UIMode = "chat" | "skills" | "hooks" | "wizard" | "question" | "providers" | "theme" | "response" | "models" | "sessions" | "usage" | "permission";
export type WizardType = "skill" | "hook";

export interface MessageEntry {
  id: string;
  role: Role;
  text: string;
  timestamp: number;
  pending?: boolean;
  meta?: string;
  requestId?: string;
}

export interface ProgressData {
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

export interface StreamData {
  request_id: string;
  chunk: string;
  chunk_index?: number;
  is_final?: boolean;
  /** True if this is reasoning/thinking content from the model */
  is_reasoning?: boolean;
}

export interface LlmCallData {
  agentType?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  maxWindowSize?: number;
}

export interface ResponseData {
  request_id?: string;
  success?: boolean;
  content?: string;
  spoken_response?: string;
  tools_used?: string[];
  duration_ms?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderKeyRequiredData {
  provider?: string;
  model?: string;
  reasoning?: string;
}

export interface ModelChangedData {
  selectedModel?: string | null;
  selectedProvider?: string | null;
  provider?: string;
  model?: string;
  reasoning?: string;
}

export interface StatusData {
  state?: TUIState;
  message?: string;
  /** Semantic level for TUI coloring */
  level?: EventLevel;
  /** Event kind for categorization */
  kind?: EventKind;
}

export interface ReadyData {
  session_key?: string;
  log_dir?: string;
  capabilities?: {
    voice_available?: boolean;
    streaming_supported?: boolean;
  };
  config_summary?: string;
}

export interface TranscriptionData {
  text?: string;
  request_id?: string;
  duration_ms?: number;
}

export interface ErrorData {
  message?: string;
  detail?: unknown;
  fatal?: boolean;
  /** Error code for programmatic handling */
  code?: string;
}

// Question flow types
export type QuestionType =
  | "multiple_choice"
  | "multi_select"
  | "fill_in_blank"
  | "yes_no"
  | "free_text"
  | "plan_mode_exit"
  | "spec_review";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentQuestion {
  requestId: string;
  type: QuestionType;
  question: string;
  context?: string;
  options?: QuestionOption[];
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
}

/** Single question item in a user prompt */
export interface UserPromptQuestion {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multi_select?: boolean;
  question_type?: string;
}

/** User prompt data from harness - supports single question or multiple */
export interface UserPromptData {
  request_id: string;
  /** Single question (backwards compatible) */
  question?: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multi_select?: boolean;
  question_type?: string;
  /** Multiple questions to ask in sequence */
  questions?: UserPromptQuestion[];
}

/** Response content for full-pane response mode */
export interface ResponseContent {
  /** Type of response content */
  type: "diff" | "text";
  /** Lines to render (pre-processed for full-width) */
  lines: ResponseLine[];
  /** Original file path (for diff responses) */
  filePath?: string;
}

/** A single line in a response pane */
export interface ResponseLine {
  text: string;
  type: "header" | "added" | "removed" | "context" | "text" | "separator";
}

/** A styled text segment for rendering within a HistoryLine */
export interface TextSegment {
  /** The text content of this segment */
  text: string;
  /** Optional bold modifier */
  bold?: boolean;
  /** Optional italic modifier */
  italic?: boolean;
  /** Optional underline modifier */
  underline?: boolean;
  /** Optional dim modifier */
  dim?: boolean;
  /** Optional color name (for theme mapping) */
  color?: "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray" | "text" | "muted";
  /** Optional background color */
  bgColor?: "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray" | "userBg" | "diffContextBg";
}

/** Model entry from the harness */
export interface ModelEntry {
  id: string;
  name: string;
  provider?: string;
  /** Available reasoning levels (undefined if model doesn't support reasoning) */
  reasoning?: string[];
}

/** Session entry for session recovery */
export interface SessionEntry {
  sessionKey: string;
  clientType: string;
  createdAt: number;
  lastAccessedAt: number;
  workingDir: string | null;
  status: string;
  lastUserMessagePreview?: string | null;
}

/** Usage session summary for /usage view */
export interface UsageSessionSummary {
  sessionKey: string;
  status: "active" | "idle" | "ended";
  projectName: string;
  workingDir: string | null;
  createdAt: number;
  lastAccessedAt: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  llmCallCount: number;
  toolCallCount: number;
  durationMs: number;
  providerTokens: Map<string, number>;
}

/** Daily usage analytics */
export interface UsageDayStats {
  date: string;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  llmCallCount: number;
}

/** Provider usage analytics */
export interface UsageProviderStats {
  provider: string;
  today: number;
  week: number;
  month: number;
}

/** Ralph Loop progress data for iteration updates */
export interface RalphProgressData {
  type: "ralph_iteration";
  iteration: number;
  maxIterations: number;
  completionPromise: string | null;
}

/** Ralph Loop completion reason */
export type RalphCompletionReason =
  | "promise_detected"
  | "max_iterations"
  | "manual_cancel"
  | "error";

// ============================================
// PERMISSION TYPES
// ============================================

/** Tools that require permission checks */
export type PermissionedTool = "Bash" | "Write" | "Edit";

/** Permission request data from harness */
export interface PermissionRequestData {
  request_id: string;
  tool: PermissionedTool;
  target: string;
  suggested_pattern: string;
  working_directory: string;
  description: string;
}

/** Permission response to send back to harness */
export interface PermissionResponseData {
  request_id: string;
  decision: "allow" | "always_allow" | "deny";
  pattern?: string;
}
