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
  // LLM API format types
  LLMMessageItem,
  LLMFunctionCallItem,
  LLMFunctionCallOutputItem,
  LLMReasoningItem,
  LLMItem,
} from './context.js';

export {
  isLLMMessageItem,
  isLLMFunctionCallItem,
  isLLMFunctionCallOutputItem,
  isLLMReasoningItem,
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
  MemoryInjectionTrainingSignal,
  MemoryInjectedData,
  RunControlAction,
  RunControlScope,
  RunControlSource,
  RunControlTarget,
  RunControlRequestedData,
  RunControlAppliedData,
  RunControlRejectedData,
  RunControlRequestedEventData,
  RunControlAppliedEventData,
  RunControlRejectedEventData,
  EventCallback,
  PermissionRequestEventData,
  GitCommitData,
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
  MemoryInjectedEventSchema,
  WorkItemStatusEventSchema,
  WorkItemStatusDataSchema,
  ToolCallDataSchema,
  HookCallDataSchema,
  LLMCallDataSchema,
  LLMErrorDataSchema,
  MemoryInjectedDataSchema,
  MemoryInjectionTrainingSignalSchema,
  RunControlStateSchema,
  RunControlActionSchema,
  RunControlScopeSchema,
  RunControlSourceSchema,
  RunCancellationMetadataSchema,
  RunControlTargetSchema,
  RunControlRequestedDataSchema,
  RunControlAppliedDataSchema,
  RunControlRejectedDataSchema,
  RunControlRequestedEventSchema,
  RunControlAppliedEventSchema,
  RunControlRejectedEventSchema,
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
  ToolExecutionContext,
  ToolExecutionError,
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
  RunControlState,
  RunCancellationMetadata,
  RunControlMetadata,
  RunExecutionMetadata,
  LLMExecutionContext,
  LLMExecutionError,
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
  GATEWAY_MODEL_PROVIDER_IDS,
  GATEWAY_MODEL_PROVIDERS,
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
  toGatewayModel,
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

// ============================================
// WORKITEM TEMPLATES
// ============================================
export type {
  WorkItemSpec,
  WorkItemTemplate,
  WorkItemTemplateCreateInput,
  DefaultTemplateName,
} from './workitem-template.js';

export {
  FEATURE_TEMPLATE_SPECS,
  BUGFIX_TEMPLATE_SPECS,
  PROTOTYPE_TEMPLATE_SPECS,
  REFACTOR_TEMPLATE_SPECS,
  TEST_TEMPLATE_SPECS,
  DEFAULT_TEMPLATE_NAMES,
  getDefaultTemplateSpecs,
} from './workitem-template.js';

// ============================================
// TEST REPORTS
// ============================================
export type {
  TestVerdict,
  TestCategory,
  TestCase,
  CategorySummary,
  TestCoverage,
  TestReport,
  TestReportCreateInput,
} from './test-report.js';

export {
  ALL_TEST_CATEGORIES,
  ALL_TEST_VERDICTS,
  computeAggregateVerdict,
  buildCategorySummary,
  buildAllCategorySummaries,
} from './test-report.js';

// ============================================
// AGENTIC TASKS
// ============================================
export type {
  AgenticTaskMode,
  AgenticTaskStatus,
  CapabilityScope,
  MutationBudget,
  AgenticTask,
  AgenticTaskCreateInput,
  AgenticTaskUpdateInput,
  AgenticRunStatus,
  AgenticRunVerdict,
  MutationObservation,
  AgenticRun,
  AgenticRunCreateInput,
} from './agentic-task.js';

export {
  isAgenticRunTerminal,
  isAgenticTaskSchedulable,
} from './agentic-task.js';
