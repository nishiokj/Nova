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
  LLMCallData,
  LLMErrorData,
  ArtifactDiscoveredData,
  AgentProgressData,
  EventCallback,
} from './events.js';

export {
  createEvent,
  eventToDict,
} from './events.js';

// Event Zod schemas
export {
  AgentEventSchema,
  ToolCallEventSchema,
  LLMCallEventSchema,
  LLMErrorEventSchema,
  WorkItemStatusEventSchema,
  WorkItemStatusDataSchema,
  ToolCallDataSchema,
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
  LLMProvider,
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
