import type { ContextWindow } from '../types/context.js';
import type { WorkItem } from '../wizard/work-item.js';
import type { AgentEvent } from '../types/events.js';
import type { StructuredOutputSchema } from '../types/llm.js';

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
  maxIterations: 10,
  maxToolCalls: 15,
  maxDurationMs: 120_000,
};

/**
 * Agent configuration - wired at instantiation.
 * Determines the agent's capabilities and constraints.
 *
 * NOTE: The LLM model is NOT specified here. Agents receive an LLMAdapter
 * at construction time. Model selection is handled by the harness/orchestrator
 * via llm_configs in harness_config.json.
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
  /** Structured output schema for responses */
  outputSchema?: StructuredOutputSchema;
}

/**
 * Parameters for Agent.run().
 * Minimal interface - all config is at construction.
 */
export interface AgentRunParams {
  /** Context window - passed by value, agent mutates locally */
  context: ContextWindow;
  /** Work item defining the objective */
  workItem: WorkItem;
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
 * Contains all outputs; no side effects beyond context mutation.
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
  /** Why execution terminated */
  terminationReason: string;
  /** Whether user input is needed */
  needsUserInput: boolean;
  /** User prompt info (if needsUserInput) */
  userPrompt?: UserPromptInfo;
  /** Whether LLM refused to complete */
  isRefusal: boolean;
  /** Whether result is incomplete (e.g., iterations exhausted but has partial output) */
  isIncomplete?: boolean;
  /** Parsed structured output (if available). Shape defined by config, not TypeScript. */
  structuredOutput?: Record<string, unknown>;
}

/**
 * User prompt information for interactive requests.
 */
export interface UserPromptInfo {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
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
