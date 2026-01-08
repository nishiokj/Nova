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
  | "skills_run"
  | "hooks_list"
  | "hooks_get"
  | "hooks_create"
  | "hooks_update"
  | "hooks_delete"
  | "user_prompt_response";

export type BridgeEventType =
  | "ready"
  | "status"
  | "progress"
  | "stream"
  | "response"
  | "transcription"
  | "user_prompt"
  | "error";

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

export type Role = "user" | "agent" | "system" | "status";

export type UIMode = "chat" | "skills" | "hooks" | "wizard" | "question";
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

// Box styling for message containers
export type BoxStyle = "rounded" | "sharp" | "double" | "minimal";

export const BOX_CHARS = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  sharp: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  minimal: { tl: " ", tr: " ", bl: " ", br: " ", h: " ", v: "│" },
} as const;

export interface MessageBoxConfig {
  style: BoxStyle;
  alignment: "left" | "right";
  maxWidth: number;
  padding: number;
  showTimestamp?: boolean;
}

// Question flow types
export type QuestionType =
  | "multiple_choice"
  | "multi_select"
  | "fill_in_blank"
  | "yes_no"
  | "free_text";

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

export interface UserPromptData {
  request_id: string;
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multi_select?: boolean;
}
