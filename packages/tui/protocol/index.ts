/**
 * Bridge Protocol Types
 *
 * Wire format for TCP JSONL communication.
 * Nothing UI-specific. Nothing application-state-specific.
 */

// ===========================================================================
// COMMAND TYPES
// ===========================================================================

export type BridgeCommandType =
  | "init"
  | "send_text"
  | "voice_start"
  | "voice_stop"
  | "get_config"
  | "get_models"
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
  | "auth_start"
  | "auth_poll"
  | "auth_verify"
  | "auth_logout"
  | "providers_list"
  | "providers_save"
  | "providers_delete"
  | "providers_test"
  | "session_fork"
  | "compact_context";

export type BridgeEventType =
  | "ready"
  | "status"
  | "progress"
  | "stream"
  | "response"
  | "transcription"
  | "user_prompt"
  | "error"
  | "llm_call";

export interface BridgeCommand {
  type: BridgeCommandType;
  data?: Record<string, unknown>;
}

export interface BridgeEvent {
  type: BridgeEventType;
  data?: Record<string, unknown>;
}

// ===========================================================================
// EVENT PAYLOADS
// ===========================================================================

export interface ReadyData {
  session_key?: string;
  log_dir?: string;
  capabilities?: {
    voice_available?: boolean;
    streaming_supported?: boolean;
  };
  config_summary?: string;
  /** Message history for session rehydration */
  history?: Array<{
    role: "user" | "agent" | "system";
    content: string;
    timestamp: number;
    request_id?: string;
  }>;
}

export interface StatusData {
  state?: TUIState;
  message?: string;
  level?: EventLevel;
  kind?: EventKind;
}

export interface ProgressData {
  request_id?: string;
  message?: string;
  tool_name?: string;
  step_number?: number;
  level?: EventLevel;
  kind?: EventKind;
  duration_ms?: number;
}

export interface StreamData {
  request_id: string;
  chunk: string;
  chunk_index?: number;
  is_final?: boolean;
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

export interface TranscriptionData {
  text?: string;
  request_id?: string;
  duration_ms?: number;
}

export interface ErrorData {
  message?: string;
  detail?: unknown;
  fatal?: boolean;
  code?: string;
}

export interface UserPromptData {
  request_id: string;
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multi_select?: boolean;
  question_type?: string;
}

// ===========================================================================
// SHARED ENUMS (used by both protocol and UI)
// ===========================================================================

export type TUIState =
  | "idle"
  | "recording"
  | "transcribing"
  | "sending"
  | "streaming"
  | "error";

export type EventLevel = "info" | "success" | "warning" | "error";
export type EventKind = "work" | "tool" | "planning" | "system";