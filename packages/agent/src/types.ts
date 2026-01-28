import type { ContextWindow } from 'context';
import type { WorkItem } from 'work';
import type { AgentEvent, StructuredOutputSchema, ToolResult, ArtifactItem, LLMRequestConfig } from 'types';
import type { LLMAdapter } from 'llm';
import type { ToolRegistry } from 'tools';
import type { AgentTerminationReason } from 'shared';

/**
 * Agent type identifier - any string, defined via config.
 * Common types: 'routing', 'explorer', 'standard', 'complex'
 */
export type AgentType = string;

/**
 * Budget constraints for agent execution.
 */
export interface AgentBudget {
  /** Maximum LLM calls per run */
  maxIterations: number;
  /** Maximum tool calls per run */
  maxToolCalls: number;
  /** Maximum duration in milliseconds */
  maxDurationMs: number;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxIterations: 20,
  maxToolCalls: 150,
  maxDurationMs: 120_000,
};

/**
 * LLM operational parameters - NOT provider/model selection.
 * These control HOW the model runs, not WHICH model runs.
 */
export interface LLMParams {
  /** Maximum tokens in response */
  maxTokens: number;
  /** Temperature for sampling (0-1) */
  temperature: number;
}

export const DEFAULT_LLM_PARAMS: LLMParams = {
  maxTokens: 16000,
  temperature: 0.7,
};

/**
 * Agent configuration - wired at instantiation.
 * Determines the agent's capabilities and constraints.
 *
 * NOTE: The LLM provider/model is NOT specified here. Model selection
 * comes EXCLUSIVELY from SessionStore via getModelSelection.
 * Only operational params (maxTokens, temperature) are stored here.
 */
export interface AgentConfig {
  /** Agent type identifier */
  type: AgentType;
  /** System prompt defining agent behavior */
  systemPrompt: string;
  /** Tools this agent can access (discretionary) */
  tools: string[];
  /** Resource budget */
  budget: AgentBudget;
  /** LLM operational parameters (NOT provider/model) */
  llmParams: LLMParams;
  /** Structured output schema for responses */
  outputSchema?: StructuredOutputSchema;
}

/**
 * Parameters for Agent.run().
 * Minimal interface - all config is at construction.
 */
export interface AgentRunParams {
  /** Global context window - read-only reference, agent writes to its own local context */
  globalContext: ContextWindow;
  /** Work item defining the objective */
  workItem: WorkItem;
  /** Working directory for tool execution. Required for concurrent-safe operation. */
  cwd: string;
}

/**
 * Metrics from agent execution.
 */
export interface AgentMetrics {
  /** Number of LLM calls made */
  llmCallsMade: number;
  /** Number of tool calls made */
  toolCallsMade: number;
  /** Number of successful tool calls */
  toolCallsSucceeded: number;
  /** Number of failed tool calls */
  toolCallsFailed: number;
  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Result from Agent.run().
 * Contains all outputs; agent does not mutate input context.
 */
export interface AgentResult {
  /** Whether the objective was achieved */
  success: boolean;
  /** Response content (if successful) */
  response: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution metrics */
  metrics: AgentMetrics;
  /** Files read during execution */
  filesRead: string[];
  /** Paths invalidated by Write/Edit operations */
  invalidatedPaths: string[];
  /** Tool errors encountered */
  toolErrors: string[];
  /** Why execution terminated (undefined while still running) */
  terminationReason?: AgentTerminationReason;
  /** Whether user input is needed */
  needsUserInput: boolean;
  /** User prompt info (if needsUserInput) */
  userPrompt?: UserPromptInfo;
  /** Whether handoff is requested (planning → execution transition) */
  needsHandoff?: boolean;
  /** Handoff spec (if needsHandoff) */
  handoffSpec?: string;
  /** Whether LLM refused to complete */
  isRefusal: boolean;
  /** Whether result is incomplete (e.g., iterations exhausted but has partial output) */
  isIncomplete?: boolean;
  /** Parsed structured output (if available). Shape defined by config, not TypeScript. */
  structuredOutput?: Record<string, unknown>;
  /** Explicitly bundled artifacts discovered during execution */
  artifacts?: ArtifactItem[];
  /** Agent's execution context - contains tool calls, outputs, reasoning from this run */
  localContext: ContextWindow;
  /** Rate limit info (if terminationReason is 'rate_limit') */
  rateLimitInfo?: {
    provider: string;
    model: string;
    type: string;
    retryAfterMs?: number;
    message: string;
  };
}

/**
 * Single question in a multi-question prompt.
 */
export interface UserPromptQuestion {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
}

/**
 * User prompt information for interactive requests.
 * Supports single question (backwards compatible) or multiple questions.
 */
export interface UserPromptInfo {
  /** Single question (backwards compatible) */
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
  /** Multiple questions to ask in sequence */
  questions?: UserPromptQuestion[];
}

/**
 * Event emit callback type.
 * Agents receive this, never the EventBus directly.
 */
export type EventEmitCallback = (event: AgentEvent) => void;

/**
 * Noop emit callback for testing or when events aren't needed.
 */
export const noopEmit: EventEmitCallback = () => {};

// ============================================
// TOOL HOOKS
// ============================================

/**
 * Result from a tool hook execution.
 */
export interface ToolHookResult {
  /** Action to take: allow, block, or modify */
  action: 'allow' | 'block' | 'modify';
  /** Message explaining the action */
  message?: string;
  /** Modified arguments (for PreToolUse with action: 'modify') */
  modifiedArgs?: Record<string, unknown>;
  /** Modified result (for PostToolUse with action: 'modify') */
  modifiedResult?: ToolResult;
}

/**
 * Hooks for tool execution lifecycle.
 * These are optional callbacks that can block or modify tool execution.
 */
export interface AgentHooks {
  /**
   * Called before a tool is executed.
   * Can block execution or modify arguments.
   */
  preToolUse?: (
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<ToolHookResult>;

  /**
   * Called after a tool is executed.
   * Can modify the result before it's added to context.
   */
  postToolUse?: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult
  ) => Promise<ToolHookResult>;

  /**
   * Called at the start of each agent iteration to check for stop signal.
   * Returns true if agent should stop immediately (e.g., user typed "stop").
   */
  shouldStop?: () => boolean;
}

// ============================================
// INTERNAL ASYNC HOOKS (best-effort housekeeping)
// ============================================

/**
 * Internal hook event types.
 * Fired by agent, enqueued as work items, executed as plain functions (no LLM).
 */
export type InternalHookEvent =
  | {
      type: 'turn_completed';
      iteration: number;
      toolCallsMade: number;
      llmCallsMade: number;
      hasResponse: boolean;
      terminationReason?: AgentTerminationReason;
    }
  | {
      type: 'tool_batch_completed';
      toolNames: string[];
      successCount: number;
      failCount: number;
    }
  | {
      type: 'context_threshold';
      usagePercent: number;
      tokenCount: number;
      itemCount: number;
    }
  | {
      type: 'artifacts_discovered';
      artifacts: Array<{ sourcePath: string; name: string; kind: string }>;
      discoveredBy: string;
    }
  | {
      type: 'files_modified';
      paths: string[];
    }
  | {
      type: 'agent_completed';
      workId: string;
      success: boolean;
      terminationReason: AgentTerminationReason;
      filesRead: string[];
      invalidatedPaths: string[];
    };

/**
 * Result from a stop hook - can block termination and re-inject a prompt.
 */
export interface StopHookResult {
  /** Whether to block the stop and continue */
  decision: 'allow' | 'block';
  /** New prompt to inject (required if decision is 'block') */
  reason?: string;
  /** System message to prepend */
  systemMessage?: string;
}

/**
 * Context passed to a stop hook when the orchestrator reaches a terminal condition.
 */
export interface StopHookContext {
  workId: string;
  response: string;
  terminationReason: string;
  iteration: number;
  agentType: string;
  sessionKey: string;
  /** The actual PromptUser question/options when terminationReason is 'user_input_required' */
  userPrompt?: {
    question: string;
    options?: Array<string | { label: string; description?: string }>;
    context?: string;
    multiSelect?: boolean;
    questionType?: string;
  };
}

/**
 * A stop hook handler that can block orchestrator termination.
 */
export type StopHookHandler = (context: StopHookContext) => StopHookResult | Promise<StopHookResult>;

/**
 * Context passed to internal hook handlers.
 */
export interface InternalHookContext {
  workId: string;
  agentType: string;
  sessionKey: string;
  requestId: string;
}

/**
 * Internal hook handler function signature.
 * Plain async function - no LLM, no agent.
 */
export type InternalHookHandler<T extends InternalHookEvent = InternalHookEvent> = (
  event: T,
  context: InternalHookContext
) => Promise<void>;

/**
 * Interface for enqueueing internal hook work items.
 * Implemented by orchestrator, passed to agent.
 */
export interface InternalHookQueue {
  /**
   * Enqueue a hook event as a work item.
   * Returns immediately - does not block.
   */
  enqueue(event: InternalHookEvent, context: InternalHookContext): void;
}

/**
 * Noop hook queue for when hooks are disabled.
 */
export const noopHookQueue: InternalHookQueue = {
  enqueue: () => {},
};

// ============================================
// AGENT RUNTIME CONFIG
// ============================================

// Forward declaration for AgentRegistry to avoid circular import
export interface AgentRegistry {
  has(agentType: string): boolean;
  getConfig(agentType: string): AgentConfig;
  listToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

/**
 * Model selection from SessionStore - identifies WHICH model to use.
 * This is the runtime type for getModelSelection callback.
 */
export interface ModelSelectionInfo {
  provider: string;
  model: string;
  reasoning?: string;
}

/**
 * Runtime configuration for Agent.
 * Groups all runtime dependencies into a single object.
 *
 * NOTE: llmConfig is REQUIRED - agents must receive pre-resolved config at creation.
 * getModelSelection is only needed for sub-agent spawning.
 */
export interface AgentRuntimeConfig {
  /** LLM adapter for inference */
  llm: LLMAdapter;
  /** Tool registry for tool execution */
  toolRegistry: ToolRegistry;
  /** Event emit callback */
  emit: EventEmitCallback;
  /** Request ID for correlation */
  requestId: string;
  /** Optional agent registry for agent-as-tool */
  agentRegistry?: AgentRegistry;
  /** LLM configuration for this agent - REQUIRED, pre-resolved at creation */
  llmConfig: LLMRequestConfig;
  /** Optional lifecycle hooks */
  hooks?: AgentHooks;
  /** Optional internal hook queue */
  internalHookQueue?: InternalHookQueue;
  /** Model selection callback for sub-agent spawning */
  getModelSelection?: (agentType: string) => ModelSelectionInfo | null;
}
