/**
 * Agent TypeScript - Main Entry Point
 *
 * This is the TypeScript implementation of the agent system,
 * replacing the Python harness/agent/ code.
 *
 * Structure:
 * - types/: Core type definitions (events, plans, tools, sessions)
 * - graphd/: SQLite-backed persistence layer
 * - llm/: LLM adapter layer (Anthropic, OpenAI)
 * - tools/: Tool registry and execution
 * - wizard/: Worker/Wizard orchestration
 * - planner/: Planning logic
 * - synthesis/: Response synthesis
 * - agent/: Main agent harness
 */

// ============================================
// TYPES (core type definitions)
// ============================================
export * from './types/index.js';

// ============================================
// GRAPHD (persistence layer)
// ============================================
export * from './graphd/index.js';

// ============================================
// LLM (adapters - re-exports some types)
// Note: LLMAdapter, LLMConfig, etc. also exported from types
// ============================================
export {
  // Retry/resilience
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
  // Adapters
  BaseLLMAdapter,
  AnthropicAdapter,
  OpenAIAdapter,
  createAdapter,
} from './llm/index.js';

// ============================================
// TOOLS (registry and builtins)
// ============================================
export {
  // Types (avoid conflict with types/tools.js ToolExecutor)
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
  // Registry
  ToolRegistry,
  // Builtins
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
// WIZARD (orchestration)
// NOTE: ContextWindow is now exported from types/index.js
// ============================================
export {
  // Context utilities (only buildSystemMessage remains here)
  buildSystemMessage,
  // Work items (renamed to avoid conflict)
  type WorkBounds,
  type WorkItemCriteria,
  type WorkItem as WizardWorkItem,
  DEFAULT_WORK_BOUNDS,
  createWorkItemCriteria,
  createWorkItem as createWizardWorkItem,
  workItemFromStepState,
  // Knowledge (renamed to avoid conflict)
  FactSource,
  type KnowledgeFact,
  createKnowledgeFact,
  KnowledgeStore as WizardKnowledgeStore,
  // Plan state
  type StepDependency,
  type StepState,
  stepStateFromWizardStep,
  PlanState,
  // Ledger
  EntryStatus,
  PatchDecision,
  type PatchRecord,
  type LedgerEntry,
  WorkLedger,
  // Worker (renamed to avoid conflict)
  WorkerAction,
  type ToolExchange,
  type WorkerMetrics as WizardWorkerMetrics,
  createWorkerMetrics as createWizardWorkerMetrics,
  type PatchSuggestion,
  type WorkerOutcome as WizardWorkerOutcome,
  createWorkerOutcome as createWizardWorkerOutcome,
  outcomeMadeProgress,
  type WorkerConfig,
  DEFAULT_WORKER_CONFIG,
  type WorkerLogger,
  Worker,
  // Stagnation
  type StagnationSignal,
  noStagnation,
  StagnationDetector,
  // Wizard
  type WizardConfig,
  DEFAULT_WIZARD_CONFIG,
  type WizardResult,
  type WizardLogger,
  Wizard,
} from './wizard/index.js';

// ============================================
// PLANNER
// ============================================
export * from './planner/index.js';

// ============================================
// SYNTHESIS
// ============================================
export * from './synthesis/index.js';

// ============================================
// AGENT
// NOTE: SessionContext has been removed, use ContextWindow from types/
// ============================================
export {
  type AgentConfig,
  type AgentResponse,
  type AgentLogger,
  DEFAULT_AGENT_CONFIG,
  Agent,
} from './agent/index.js';

// ============================================
// HARNESS (TUI integration layer)
// ============================================
export {
  AgentHarness,
  createHarnessFromEnv,
  translateWizardEvent,
  createStreamEvent,
  createStatusEvent,
  createResponseEvent,
  createErrorEvent,
  createReadyEvent,
  type FullHarnessConfig,
  type AgentRunParams,
  type AgentRunResult,
  type AgentRunHandle,
  type BridgeEvent,
  type BridgeEventType,
  type UserPromptInfo,
  type StatusEventData,
  type ProgressEventData,
  type StreamEventData,
  type ResponseEventData,
  type ReadyEventData,
  type UserPromptEventData,
  type ErrorEventData,
} from './harness/index.js';
