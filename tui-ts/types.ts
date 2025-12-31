export type BridgeCommandType =
  | "init"
  | "send_text"
  | "voice_start"
  | "voice_stop"
  | "get_config"
  | "get_models"
  | "get_status"
  | "shutdown";

export type BridgeEventType =
  | "ready"
  | "status"
  | "progress"
  | "stream"
  | "response"
  | "transcription"
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

export type Role = "user" | "agent" | "system" | "status";

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
  detail?: string;
  fatal?: boolean;
}
