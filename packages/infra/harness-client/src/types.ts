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

type CommandDataBase = Record<string, unknown>;
type NoData = Record<string, never> | undefined

export type BridgeCommandType =
  | 'init'
  | 'send_text'
  | 'send_media'
  | 'user_prompt_response'
  | 'permission_response';

export interface InitCommandData extends CommandDataBase {
  session_key?: string;
  working_dir?: string;
}

export interface SendTextCommandData extends CommandDataBase {
  text: string;
  client_request_id?: string;
  tier?: string;
  working_dir?: string;
  attachments?: Attachment[];
}

export interface SendMediaCommandData extends CommandDataBase {
  text?: string;
  client_request_id?: string;
  tier?: string;
  working_dir?: string;
  attachments: Attachment[];
}

export interface UserPromptResponseCommandData extends CommandDataBase {
  request_id: string;
  answer: string;
}

export interface PermissionResponseCommandData extends CommandDataBase {
  request_id: string;
  decision?: 'allow' | 'always_allow' | 'deny';
  pattern?: string;
  /**
   * Backwards compatibility for older scripts.
   * `allowed: true` maps to `decision: "allow"`, false maps to `decision: "deny"`.
   */
  allowed?: boolean;
}

export interface BridgeCommandDataMap {
  init: InitCommandData;
  send_text: SendTextCommandData;
  send_media: SendMediaCommandData;
  user_prompt_response: UserPromptResponseCommandData;
  permission_response: PermissionResponseCommandData;
}

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

export type BridgeCommand =
  | {
    [K in BridgeCommandType]: BridgeCommandDataMap[K] extends NoData
      ? { type: K; data?: BridgeCommandDataMap[K] }
      : { type: K; data: BridgeCommandDataMap[K] }
  }[BridgeCommandType]
  | { type: BridgeCommandType; data?: Record<string, unknown> };

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

export type EventLevel = 'info' | 'success' | 'warning' | 'error';
export type EventKind = 'work' | 'tool' | 'planning' | 'system' | 'thinking';

export interface StatusData {
  state: 'idle' | 'sending' | 'streaming' | 'error';
  message?: string;
  level?: EventLevel;
  kind?: EventKind;
}

export interface ErrorData {
  message: string;
  fatal?: boolean;
  detail?: Record<string, unknown>;
}

export interface ProviderKeyRequiredData {
  provider?: string;
  model?: string;
  reasoning?: string;
}

export interface ModelChangedData {
  agentType?: string;
  selectedModel?: string | null;
  selectedProvider?: string | null;
  provider?: string | null;
  model?: string | null;
  reasoning?: string | null;
}

export interface ProgressData {
  request_id?: string;
  message?: string;
  tool_name?: string;
  step_number?: number;
  level?: EventLevel;
  kind?: EventKind;
  duration_ms?: number;
  tool_args?: Record<string, unknown>;
  tool_success?: boolean;
  tool_result?: string;
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

export interface LlmCallData {
  agentType?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  maxWindowSize?: number;
}

export interface TranscriptionData {
  text?: string;
  segments?: unknown[];
  language?: string;
  duration_ms?: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface BridgeEventDataMap {
  ready: ReadyData;
  status: StatusData;
  progress: ProgressData;
  stream: StreamData;
  response: ResponseData;
  transcription: TranscriptionData;
  user_prompt: UserPromptData;
  error: ErrorData;
  provider_key_required: ProviderKeyRequiredData;
  model_changed: ModelChangedData;
  permission_request: PermissionRequestData;
  llm_call: LlmCallData;
}

export type BridgeEvent = {
  [K in BridgeEventType]: { type: K; data?: BridgeEventDataMap[K] }
}[BridgeEventType];
