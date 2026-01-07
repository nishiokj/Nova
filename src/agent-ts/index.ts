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
// ============================================
export * from './types/index.js';

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
  DEFAULT_WORK_BOUNDS,
  createWorkItem,
  FactSource,
  type KnowledgeFact,
  createKnowledgeFact,
  KnowledgeStore,
  EntryStatus,
  type LedgerEntry,
  WorkLedger,
  type StagnationSignal,
  noStagnation,
  StagnationDetector,
} from './wizard/index.js';

// ============================================
// ORCHESTRATOR
// ============================================
export * from './orchestrator/index.js';

// ============================================
// AGENT
// ============================================
export * from './agent/index.js';

// ============================================
// HARNESS (TUI integration layer)
// ============================================
export * from './harness/index.js';
