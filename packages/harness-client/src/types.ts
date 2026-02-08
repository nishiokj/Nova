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
  | 'session_delete'
  | 'list_sessions'
  | 'usage_summary'
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
  | 'async_status'
  | 'control_plane_dispatch'
  | 'control_plane_stop'
  | 'control_plane_fork'
  | 'control_plane_permissions_get'
  | 'control_plane_permissions_update'
  | 'control_plane_resolve_escalation'
  | 'control_plane_memory_info'
  | 'control_plane_model_get'
  | 'control_plane_model_set'
  | 'shutdown';

export interface InitCommandData extends CommandDataBase {
  session_key?: string;
  working_dir?: string;
}

export interface SendTextCommandData extends CommandDataBase {
  text: string;
  client_request_id?: string;
  tier?: string;
  plan_mode?: boolean;
  working_dir?: string;
  attachments?: Attachment[];
}

export interface SendMediaCommandData extends CommandDataBase {
  text?: string;
  client_request_id?: string;
  tier?: string;
  plan_mode?: boolean;
  working_dir?: string;
  attachments: Attachment[];
}

export interface ModelsDeleteCommandData extends CommandDataBase {
  model?: string;
  model_id?: string;
}

export interface SkillIdCommandData extends CommandDataBase {
  id: string;
}

export interface SkillsCreateCommandData extends CommandDataBase {
  skill: Record<string, unknown>;
}

export interface SkillsUpdateCommandData extends CommandDataBase {
  id: string;
  updates: Record<string, unknown>;
}

export interface HooksCreateCommandData extends CommandDataBase {
  hook: Record<string, unknown>;
}

export interface HooksUpdateCommandData extends CommandDataBase {
  id: string;
  updates: Record<string, unknown>;
}

export interface UserPromptResponseCommandData extends CommandDataBase {
  request_id: string;
  answer: string;
}

export interface PermissionResponseCommandData extends CommandDataBase {
  request_id: string;
  allowed: boolean;
}

export interface AuthStartCommandData extends CommandDataBase {
  device?: string;
}

export interface AuthPollCommandData extends CommandDataBase {
  stateToken: string;
}

export interface AuthVerifyCommandData extends CommandDataBase {
  sessionToken: string;
}

export interface AuthLogoutCommandData extends CommandDataBase {
  sessionToken: string;
}

export interface ProvidersCommandData extends CommandDataBase {
  sessionToken?: string;
  provider?: string;
  apiKey?: string;
}

export interface ListSessionsCommandData extends CommandDataBase {
  workingDir?: string;
  status?: string | string[];
  limit?: number;
}

export interface SessionDeleteCommandData extends CommandDataBase {
  sessionKey?: string;
  session_key?: string;
}

export interface UsageSummaryCommandData extends CommandDataBase {
  status?: string | string[];
  limit?: number;
}

export interface SetModelCommandData extends CommandDataBase {
  agent_type?: string;
  provider?: string;
  model?: string;
  reasoning?: string;
  reset?: boolean;
}

export interface GetModelCommandData extends CommandDataBase {
  agent_type?: string;
}

export interface RalphLoopStartCommandData extends CommandDataBase {
  prompt?: string;
  goal?: string;
  working_dir?: string;
  plan_mode?: boolean;
}

export interface PermissionSetDangerousModeData extends CommandDataBase {
  enabled: boolean;
}

export interface AsyncStartCommandData extends CommandDataBase {
  goal: string;
  working_dir?: string;
}

export interface WatcherSearchCommandData extends CommandDataBase {
  query: string;
}

export interface WatcherInspectCommandData extends CommandDataBase {
  id: string;
}

export interface WatcherFocusCommandData extends CommandDataBase {
  topic: string;
}

export interface WatcherReanchorCommandData extends CommandDataBase {
  goal: string;
}

export interface ControlPlaneDispatchCommandData extends CommandDataBase {
  session_key: string;
  message: string;
  context?: string;
  metadata?: Record<string, unknown>;
  request_id?: string;
  working_dir?: string;
}

export interface ControlPlaneStopCommandData extends CommandDataBase {
  session_key: string;
  note?: string;
  working_dir?: string;
}

export interface ControlPlaneForkCommandData extends CommandDataBase {
  source_session_key: string;
  target_session_key?: string;
}

export interface ControlPlanePermissionsGetCommandData extends CommandDataBase {
  session_key: string;
  working_dir?: string;
}

export interface ControlPlanePermissionsUpdateCommandData extends CommandDataBase {
  session_key: string;
  working_dir?: string;
  update: {
    dangerousMode?: boolean;
    allowOutsideRoot?: boolean;
    webSearchEnabled?: boolean;
    writesNoDeletes?: boolean;
    restrictWriteToPaths?: string[] | null;
    reloadPersistentConfig?: boolean;
  };
}

export interface ControlPlaneResolveEscalationCommandData extends CommandDataBase {
  session_key: string;
  escalation_id: string;
  resolution: {
    optionId?: string;
    freeformResponse?: string;
    resolvedBy?: 'user' | 'system' | 'timeout';
  };
}

export interface ControlPlaneModelGetCommandData extends CommandDataBase {
  session_key: string;
}

export interface ControlPlaneModelSetCommandData extends CommandDataBase {
  session_key: string;
  agent_type?: string;
  provider: string;
  model: string;
  reasoning?: string;
}

export interface BridgeCommandDataMap {
  init: InitCommandData;
  send_text: SendTextCommandData;
  send_media: SendMediaCommandData;
  voice_start: NoData;
  voice_stop: NoData;
  get_config: NoData;
  get_models: NoData;
  models_delete: ModelsDeleteCommandData;
  get_status: NoData;
  skills_list: NoData;
  skills_get: SkillIdCommandData;
  skills_create: SkillsCreateCommandData;
  skills_update: SkillsUpdateCommandData;
  skills_delete: SkillIdCommandData;
  skills_enable: SkillIdCommandData;
  skills_disable: SkillIdCommandData;
  skills_run: NoData;
  hooks_list: NoData;
  hooks_get: SkillIdCommandData;
  hooks_create: HooksCreateCommandData;
  hooks_update: HooksUpdateCommandData;
  hooks_delete: SkillIdCommandData;
  hooks_enable: SkillIdCommandData;
  hooks_disable: SkillIdCommandData;
  user_prompt_response: UserPromptResponseCommandData;
  permission_response: PermissionResponseCommandData;
  auth_start: AuthStartCommandData;
  auth_poll: AuthPollCommandData;
  auth_verify: AuthVerifyCommandData;
  auth_logout: AuthLogoutCommandData;
  providers_list: ProvidersCommandData;
  providers_save: ProvidersCommandData;
  providers_delete: ProvidersCommandData;
  providers_test: ProvidersCommandData;
  session_fork: NoData;
  session_close: NoData;
  session_delete: SessionDeleteCommandData;
  list_sessions: ListSessionsCommandData;
  usage_summary: UsageSummaryCommandData;
  compact_context: NoData;
  set_model: SetModelCommandData;
  get_model: GetModelCommandData;
  set_dangerous_mode: PermissionSetDangerousModeData;
  ralph_loop_start: RalphLoopStartCommandData;
  ralph_loop_cancel: NoData;
  watcher_status: NoData;
  watcher_context: NoData;
  watcher_search: WatcherSearchCommandData;
  watcher_decisions: NoData;
  watcher_inspect: WatcherInspectCommandData;
  watcher_memory: NoData;
  watcher_focus: WatcherFocusCommandData;
  watcher_defocus: NoData;
  watcher_reanchor: WatcherReanchorCommandData;
  watcher_summarize: NoData;
  async_start: AsyncStartCommandData;
  async_cancel: NoData;
  async_status: NoData;
  control_plane_dispatch: ControlPlaneDispatchCommandData;
  control_plane_stop: ControlPlaneStopCommandData;
  control_plane_fork: ControlPlaneForkCommandData;
  control_plane_permissions_get: ControlPlanePermissionsGetCommandData;
  control_plane_permissions_update: ControlPlanePermissionsUpdateCommandData;
  control_plane_resolve_escalation: ControlPlaneResolveEscalationCommandData;
  control_plane_memory_info: NoData;
  control_plane_model_get: ControlPlaneModelGetCommandData;
  control_plane_model_set: ControlPlaneModelSetCommandData;
  shutdown: NoData;
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
