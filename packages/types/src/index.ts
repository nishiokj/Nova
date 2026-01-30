/**
 * Agent TypeScript Types - Barrel Export
 */

// ============================================
// CONTEXT (Responses API compatible)
// ============================================
export type {
  ContextItemType,
  MessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ReasoningItem,
  FileContentItem,
  ArtifactKind,
  UncertaintyCategory,
  ArtifactPayload,
  ArtifactItem,
  ContextItem,
  ContextWindowSnapshot,
  ContextWindowTelemetry,
  EjectResult,
  CompactOptions,
  CompactResult,
} from './context.js';

// ============================================
// EVENTS
// ============================================
export type {
  AgentCoreEventType,
  OrchestratorEventType,
  AgentEventType,
  AgentEvent,
  AgentType,
  RuntimeScriptCreatedData,
  WorkItemStatusValue,
  WorkItemStatusData,
  GoalAchievedData,
  GoalNotAchievedData,
  ToolCallData,
  ToolCallPhase,
  HookCallData,
  HookCallPhase,
  LLMCallData,
  LLMErrorData,
  RateLimitType,
  RateLimitData,
  ArtifactDiscoveredData,
  AgentProgressData,
  AgentReasoningData,
  EventCallback,
  PermissionRequestEventData,
} from './events.js';

export {
  createEvent,
  eventToDict,
} from './events.js';

// Event Zod schemas
export {
  AgentEventSchema,
  ToolCallEventSchema,
  HookCallEventSchema,
  LLMCallEventSchema,
  LLMErrorEventSchema,
  WorkItemStatusEventSchema,
  WorkItemStatusDataSchema,
  ToolCallDataSchema,
  HookCallDataSchema,
  LLMCallDataSchema,
  LLMErrorDataSchema,
  parseEvent,
  isValidEvent,
} from './event_schemas.js';

// ============================================
// TOOLS
// ============================================
export type {
  ToolStatus,
  ToolResult,
  ToolCallRecord,
  ToolDefinition,
  ToolParameterSchema,
  BashArgs,
  ReadArgs,
  WriteArgs,
  GrepArgs,
  GlobArgs,
  ToolArgs,
  ToolExecutor,
} from './tools.js';

export {
  successResult,
  errorResult,
  timeoutResult,
  createToolCallRecord,
} from './tools.js';

// ============================================
// LLM
// ============================================
export type {
  MessageRole,
  ContentBlockType,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ImageContentBlock,
  ContentBlock,
  Message,
  LLMRequestConfig,
  LLMClientConfig,
  StopReason,
  TokenUsage,
  ToolCall,
  LLMResponse,
  RespondParams,
  StreamParams,
  LLMAdapter,
  ConversationContext,
  StructuredOutputSchema,
  FallbackConfig,
} from './llm.js';

export {
  textMessage,
  blocksMessage,
  getMessageText,
  getToolUseBlocks,
  createConversationContext,
  addMessage,
  estimateTokens,
} from './llm.js';

// ============================================
// SESSION
// ============================================
export type {
  SessionStatus,
  ClientType,
  Session,
  ContextWindowMetrics,
  SessionContext,
  ConversationMessage,
  ContextSnapshot,
  KnowledgeEntry,
  KnowledgeStore,
} from './session.js';

export {
  createContextWindowMetrics,
  updateContextMetrics,
  createSessionContext,
  createKnowledgeStore,
  addKnowledge,
  getKnowledge,
  clearExpiredKnowledge,
} from './session.js';

// ============================================
// DESIGN SPEC
// ============================================
export type {
  ColorPalette,
  TypographySpec,
  TypographyFull,
  SpacingScale,
  AestheticPreset,
  LayoutType,
  LayoutRegion,
  ComponentSpec,
  PageSpec,
  StateFlow,
  DesignSpec,
  ImageGenParams,
  ImageGenResult,
  DesignPromptParams,
  GalleryImage,
  SelectionResult,
  ScaffoldConfig,
  GeneratedFile,
  ScaffoldResult,
} from './design-spec.js';

// ============================================
// PROVIDERS
// ============================================
export type {
  LLMProvider,
  SupportedProvider,
  ModelRole,
  ProviderDefinition,
  ProviderResponseFormat,
  ProviderModelDefinition,
  ProviderModelEntry,
  ReasoningOptions,
} from './providers.js';

export {
  PROVIDER_REGISTRY,
  OPENAI_COMPAT_PROVIDERS,
  PROVIDER_MODEL_DEFAULTS,
  SUPPORTED_PROVIDER_IDS,
  DEFAULT_CONTEXT_WINDOW,
  isSupportedProvider,
  isOpenAICompatProvider,
  getCanonicalProvider,
  getProviderBaseUrl,
  getProviderEnvVar,
  getProviderDisplayName,
  getProviderTestEndpoint,
  getProviderDashboardUrl,
  getProviderResponseFormat,
  providerRequiresAuth,
  getProviderDefinition,
  getAllProviders,
  getProvidersByCanonical,
  getAllModels,
  getProviderModels,
  getProviderForModel,
  getModelDefinition,
  getModelReasoningOptions,
  modelSupportsReasoning,
  getModelContextWindow,
} from './providers.js';

// ============================================
// PERMISSIONS
// ============================================
export type {
  PermissionedTool,
  PermissionRule,
  PermissionConfig,
  PermissionSettings,
  SessionPermissionState,
  PermissionDecision,
  PermissionRequest,
  PermissionResponse,
  PermissionRequestEvent,
  PermissionResponseCommand,
} from './permissions.js';

export {
  PERMISSIONED_TOOLS,
  isPermissionedTool,
  normalizeToolName,
  DEFAULT_PERMISSION_SETTINGS,
} from './permissions.js';

// ============================================
// AGENT TRACE (cursor/agent-trace spec)
// ============================================
export type {
  ContributorType,
  Contributor,
  VCSType,
  VCSInfo,
  LineRange,
  RelatedResource,
  Conversation,
  FileAttribution,
  ToolInfo,
  TraceRecord,
  PendingFileModification,
  ConversationUrlProvider,
} from './agent_trace.js';

export {
  AGENT_TRACE_VERSION,
  dummyUrlProvider,
  formatModelId,
  rfc3339Timestamp,
  generateTraceId,
} from './agent_trace.js';
