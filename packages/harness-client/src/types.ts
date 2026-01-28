/**
 * Shared types for harness communication.
 */

export interface Attachment {
  type: 'image' | 'document' | 'audio' | 'video'
  url?: string
  file_id?: string
  mimeType?: string
  size?: number
  metadata?: Record<string, unknown>
}

export type BridgeCommandType =
  | 'init'
  | 'send_text'
  | 'send_media'
  | 'voice_start'
  | 'voice_stop'
  | 'get_config'
  | 'get_models'
  | 'models_delete'
  | 'get_status'
  | 'skills_list'
  | 'skills_get'
  | 'skills_create'
  | 'skills_update'
  | 'skills_delete'
  | 'skills_enable'
  | 'skills_disable'
  | 'skills_run'
  | 'hooks_list'
  | 'hooks_get'
  | 'hooks_create'
  | 'hooks_update'
  | 'hooks_delete'
  | 'hooks_enable'
  | 'hooks_disable'
  | 'user_prompt_response'
  | 'permission_response'
  | 'auth_start'
  | 'auth_poll'
  | 'auth_verify'
  | 'auth_logout'
  | 'providers_list'
  | 'providers_save'
  | 'providers_delete'
  | 'providers_test'
  | 'session_fork'
  | 'session_close'
  | 'list_sessions'
  | 'compact_context'
  | 'set_model'
  | 'get_model'
  | 'set_dangerous_mode'
  | 'ralph_loop_start'
  | 'ralph_loop_cancel'
  | 'watcher_status'
  | 'watcher_context'
  | 'watcher_search'
  | 'watcher_decisions'
  | 'watcher_inspect'
  | 'watcher_memory'
  | 'watcher_focus'
  | 'watcher_defocus'
  | 'watcher_reanchor'
  | 'watcher_summarize'
  | 'async_start'
  | 'async_cancel'
  | 'async_status';

export type BridgeEventType =
  | 'ready'
  | 'status'
  | 'progress'
  | 'stream'
  | 'response'
  | 'transcription'
  | 'user_prompt'
  | 'error'
  | 'provider_key_required'
  | 'model_changed'
  | 'permission_request'
  | 'llm_call';

export interface BridgeCommand {
  type: BridgeCommandType;
  data?: Record<string, unknown>;
}

export interface BridgeEvent {
  type: BridgeEventType;
  data?: Record<string, unknown>;
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

export interface StreamData {
  request_id: string;
  chunk: string;
  chunk_index?: number;
  is_final?: boolean;
  is_reasoning?: boolean;
}

export interface ProgressData {
  request_id?: string;
  message?: string;
  tool_name?: string;
  step_number?: number;
  level?: 'info' | 'success' | 'warning' | 'error';
  kind?: 'work' | 'tool' | 'planning' | 'system';
  duration_ms?: number;
  tool_args?: Record<string, unknown>;
  tool_success?: boolean;
}

export interface UserPromptData {
  request_id: string;
  question?: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multi_select?: boolean;
  question_type?: string;
  questions?: Array<{
    question: string;
    options?: Array<string | { label: string; description?: string }>;
    context?: string;
    multi_select?: boolean;
    question_type?: string;
  }>;
}

export interface PermissionRequestData {
  request_id: string;
  tool: 'Bash' | 'Write' | 'Edit';
  target: string;
  suggested_pattern: string;
  working_directory: string;
  description: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
