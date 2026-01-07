/**
 * Agent TypeScript - Main Entry Point
 *
 * Structure:
 * - types/: Core type definitions
 * - graphd/: SQLite-backed persistence layer
 * - llm/: LLM adapter layer (Anthropic, OpenAI)
 * - tools/: Tool registry and execution
 * - agent/: Pure agent primitive
 * - orchestrator/: Orchestration runtime
 * - wizard/: Shared utilities (work-item, ledger, knowledge)
 * - harness/: TUI integration layer
 */

// ============================================
// TYPES (core type definitions)
// Note: AgentType and LLMProvider also exported from harness - use explicit exports
// ============================================
export type {
  ContextItemType,
  MessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ReasoningItem,
  FileContentItem,
  ContextItem,
  ContextWindowSnapshot,
  ContextWindowTelemetry,
  AgentCoreEventType,
  OrchestratorEventType,
  AgentEventType,
  AgentEvent,
  RuntimeScriptCreatedData,
  WorkItemStartedData,
  WorkItemCompletedData,
  WorkItemFailedData,
  WorkItemSkippedData,
  GoalAchievedData,
  GoalNotAchievedData,
  ToolCallData,
  ToolCallPhase,
  LLMCallData,
  LLMErrorData,
  EventCallback,
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
  SessionStatus,
  ClientType,
  Session,
  ContextWindowMetrics,
  SessionContext,
  ConversationMessage,
  ContextSnapshot,
  KnowledgeEntry,
  KnowledgeStore as TypesKnowledgeStore,
} from './types/index.js';

export {
  ContextWindow,
  createEvent,
  eventToDict,
  successResult,
  errorResult,
  timeoutResult,
  createToolCallRecord,
  textMessage,
  blocksMessage,
  getMessageText,
  getToolUseBlocks,
  createConversationContext,
  addMessage,
  estimateTokens,
  createContextWindowMetrics,
  updateContextMetrics,
  createSessionContext,
  createKnowledgeStore as createTypesKnowledgeStore,
  addKnowledge,
  getKnowledge,
  clearExpiredKnowledge,
} from './types/index.js';

// ============================================
// GRAPHD (persistence layer)
// ============================================
export * from './graphd/index.js';

// ============================================
// LLM (adapters - re-exports some types)
// ============================================
export {
  type CircuitState,
  type CircuitBreakerState,
  type ResilienceConfig,
  createCircuitState,
  DEFAULT_RESILIENCE_CONFIG,
  calculateBackoff,
  sleep,
  isRetryableError,
  shouldAllowRequest,
  recordSuccess,
  recordFailure,
  CircuitOpenError,
  RetriesExhaustedError,
  type ResilientCallOptions,
  resilientCall,
  createAdapter,
} from './llm/index.js';

// ============================================
// TOOLS (registry and builtins)
// ============================================
export {
  type Tool,
  type ToolExecutionContext,
  type ToolRegistrationOptions,
  type CachedToolResult,
  type CacheConfig,
  type ToolRegistryConfig,
  createTool,
  createExecutionContext,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_TOOL_CONFIG,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_EXTENSIONS,
  DANGEROUS_PATTERNS,
  shouldSkipDir,
  shouldSkipFile,
  isDangerousCommand,
  ToolRegistry,
  executeBash,
  executeRead,
  executeWrite,
  executeEdit,
  executeGrep,
  executeGlob,
  bashToolOptions,
  readToolOptions,
  writeToolOptions,
  editToolOptions,
  grepToolOptions,
  globToolOptions,
  builtinToolOptions,
  createToolRegistry,
} from './tools/index.js';

// ============================================
// WIZARD (shared utilities)
// ============================================
export {
  buildSystemMessage,
  type WorkBounds,
  type WorkItem,
  type WorkItemCriteria,
  DEFAULT_WORK_BOUNDS,
  createWorkItem,
  createWorkItemCriteria,
  FactSource,
  type KnowledgeFact,
  createKnowledgeFact,
  KnowledgeStore,
  EntryStatus,
  PatchDecision,
  type PatchRecord,
  type LedgerEntry,
  WorkLedger,
} from './wizard/index.js';

// ============================================
// ORCHESTRATOR
// ============================================
export * from './orchestrator/index.js';

// ============================================
// AGENT (explicit exports to avoid duplicates)
// Note: AgentType, UserPromptInfo, AgentRunParams also in harness/types
// ============================================
export { Agent } from './agent/agent.js';
export { AgentRegistry } from './agent/agent-registry.js';
export type {
  AgentBudget,
  AgentConfig,
  AgentMetrics,
  AgentResult,
  EventEmitCallback,
} from './agent/types.js';
// Re-export AgentType from agent module as the canonical source
export type { AgentType, UserPromptInfo, AgentRunParams } from './agent/types.js';
export { DEFAULT_AGENT_BUDGET, noopEmit } from './agent/types.js';
export {
  ROUTING_PROMPT,
  SIMPLE_PROMPT,
  EXPLORER_PROMPT,
  RUNTIME_SCRIPT_PROMPT,
  STANDARD_PROMPT,
  getAgentPrompt,
  buildAgentConfig,
} from './agent/prompts.js';

// ============================================
// HARNESS (TUI integration layer - explicit exports)
// Note: Avoid re-exporting AgentType, UserPromptInfo, AgentRunParams, LLMProvider
// ============================================
export { AgentHarness, createHarnessFromEnv } from './harness/harness.js';
export {
  translateAgentEvent,
  createStreamEvent,
  createStatusEvent,
  createResponseEvent,
  createErrorEvent,
  createReadyEvent,
  createUserPromptEvent,
} from './harness/event_translator.js';
export type {
  AgentRunResult,
  AgentRunHandle,
  BridgeEvent,
  BridgeEventType,
  Tier,
  StatusEventData,
  ProgressEventData,
  StreamEventData,
  ResponseEventData,
  ReadyEventData,
  UserPromptEventData,
  ErrorEventData,
} from './harness/types.js';

// Re-export EventBus for external subscribers
export { EventBus, type EventBusProtocol } from './communication/event_bus.js';

// Config loading
export {
  loadConfig,
  loadConfigFile,
  getAgentConfig,
  createConfigFromFile,
  createConfigFromEnv,
  resolveApiKey,
} from './harness/config_loader.js';
export type {
  LLMProvider,
  ReasoningEffort,
  AgentLLMConfig,
  AgentBudgetConfig,
  AgentConfigEntry,
  HarnessConfigFile,
  FullHarnessConfig,
  ResolvedLLMConfig,
  ResolvedAgentConfig,
  ToolsConfigSection,
  GraphDConfigSection,
  ContextConfigSection,
  SkillsConfigSection,
  HooksConfigSection,
  SkillConfigEntry,
  HookConfigEntry,
} from './harness/config_types.js';
export {
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_GRAPHD_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_ENABLED_TOOLS,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_HOOKS_CONFIG,
} from './harness/config_types.js';

// Skills and hooks loading
export {
  loadSkillDefinitions,
  loadHookDefinitions,
} from './harness/skills_loader.js';
export type {
  SkillDefinitionStub,
  HookDefinitionStub,
} from './harness/skills_loader.js';
