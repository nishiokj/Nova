/**
 * Worker types.
 *
 * Types for the stateless Worker component that executes individual work items.
 */

import type { ToolCallRecord, ToolResult } from './tools.js';
import type { Message, LLMResponse } from './llm.js';
import type { PlanPhase } from './plan.js';

// ============================================
// WORKER OUTCOME
// ============================================

/**
 * Outcome status from worker execution.
 */
export type OutcomeStatus =
  | 'success' // Work completed successfully
  | 'needs_user_input' // Paused waiting for user input
  | 'max_iterations' // Hit iteration limit
  | 'stagnation' // Detected lack of progress
  | 'error' // Encountered an error
  | 'aborted'; // Externally aborted

/**
 * Result of worker executing a work item.
 */
export interface WorkerOutcome {
  status: OutcomeStatus;
  /** Whether the work item was completed successfully */
  success: boolean;
  /** Final response text if worker generated one */
  finalResponse?: string;
  /** Tool calls made during execution */
  toolCalls: ToolCallRecord[];
  /** LLM messages generated */
  llmMessages: Message[];
  /** Accumulated context delta */
  contextDelta: ContextDelta;
  /** Error message if status is 'error' */
  error?: string;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Number of LLM iterations */
  iterations: number;
  /** Metrics about the execution */
  metrics: WorkerMetrics;
}

// ============================================
// WORK ITEM
// ============================================

/**
 * Work item for worker to execute.
 */
export interface WorkItem {
  /** Step number this work item belongs to */
  stepNum: number;
  /** Objective to accomplish */
  objective: string;
  /** Phase (discovery or execution) */
  phase: PlanPhase;
  /** Suggested tool to use */
  toolHint?: string;
  /** Suggested tool arguments */
  toolArgsHint?: Record<string, unknown>;
  /** Maximum tool calls allowed */
  maxToolCalls: number;
  /** Maximum LLM iterations allowed */
  maxIterations: number;
  /** Success criteria description */
  successCriteria?: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Create a work item with defaults.
 */
export function createWorkItem(
  stepNum: number,
  objective: string,
  opts?: Partial<Omit<WorkItem, 'stepNum' | 'objective'>>
): WorkItem {
  return {
    stepNum,
    objective,
    phase: opts?.phase ?? 'execution',
    toolHint: opts?.toolHint,
    toolArgsHint: opts?.toolArgsHint,
    maxToolCalls: opts?.maxToolCalls ?? 10,
    maxIterations: opts?.maxIterations ?? 5,
    successCriteria: opts?.successCriteria,
    context: opts?.context,
  };
}

// ============================================
// CONTEXT DELTA
// ============================================

/**
 * Changes to context during worker execution.
 * This is the "delta" that gets accumulated back to the session.
 */
export interface ContextDelta {
  /** Tool results keyed by tool name */
  toolResults: Record<string, ToolResult>;
  /** Files that were read */
  filesRead: string[];
  /** Files that were modified */
  filesModified: string[];
  /** Commands that were executed */
  commandsExecuted: string[];
  /** Discoveries made (for discovery phase) */
  discoveries: DiscoveryDelta[];
  /** Knowledge accumulated */
  knowledge: Record<string, unknown>;
}

/**
 * Create an empty context delta.
 */
export function createContextDelta(): ContextDelta {
  return {
    toolResults: {},
    filesRead: [],
    filesModified: [],
    commandsExecuted: [],
    discoveries: [],
    knowledge: {},
  };
}

/**
 * Discovery made during worker execution.
 */
export interface DiscoveryDelta {
  type: 'file' | 'search' | 'command' | 'error';
  path?: string;
  content?: string;
  matches?: string[];
  error?: string;
  timestamp: number;
}

// ============================================
// WORKER METRICS
// ============================================

/**
 * Metrics collected during worker execution.
 */
export interface WorkerMetrics {
  /** Total LLM calls made */
  llmCalls: number;
  /** Total tool calls made */
  toolCalls: number;
  /** Tool calls that failed */
  toolFailures: number;
  /** Total prompt tokens used */
  promptTokens: number;
  /** Total completion tokens used */
  completionTokens: number;
  /** Time spent waiting for LLM (ms) */
  llmLatencyMs: number;
  /** Time spent executing tools (ms) */
  toolLatencyMs: number;
  /** Stagnation score (0-1, higher = more stagnation detected) */
  stagnationScore: number;
}

/**
 * Create empty worker metrics.
 */
export function createWorkerMetrics(): WorkerMetrics {
  return {
    llmCalls: 0,
    toolCalls: 0,
    toolFailures: 0,
    promptTokens: 0,
    completionTokens: 0,
    llmLatencyMs: 0,
    toolLatencyMs: 0,
    stagnationScore: 0,
  };
}

/**
 * Update worker metrics after an LLM call.
 */
export function updateMetricsFromLLM(
  metrics: WorkerMetrics,
  response: LLMResponse
): WorkerMetrics {
  return {
    ...metrics,
    llmCalls: metrics.llmCalls + 1,
    promptTokens: metrics.promptTokens + response.usage.promptTokens,
    completionTokens: metrics.completionTokens + response.usage.completionTokens,
    llmLatencyMs: metrics.llmLatencyMs + response.durationMs,
    toolCalls: metrics.toolCalls + (response.toolCalls?.length ?? 0),
  };
}

/**
 * Update worker metrics after a tool call.
 */
export function updateMetricsFromTool(
  metrics: WorkerMetrics,
  result: ToolResult
): WorkerMetrics {
  return {
    ...metrics,
    toolLatencyMs: metrics.toolLatencyMs + result.durationMs,
    toolFailures: result.isSuccess ? metrics.toolFailures : metrics.toolFailures + 1,
  };
}

// ============================================
// STAGNATION DETECTION
// ============================================

/**
 * Stagnation detection state.
 */
export interface StagnationState {
  /** Recent tool call patterns for detecting loops */
  recentToolCalls: string[];
  /** Recent response hashes for detecting repetition */
  recentResponseHashes: string[];
  /** Number of consecutive similar responses */
  similarResponseCount: number;
  /** Maximum similar responses before flagging stagnation */
  maxSimilar: number;
  /** Window size for pattern detection */
  windowSize: number;
}

/**
 * Create initial stagnation state.
 */
export function createStagnationState(
  maxSimilar = 3,
  windowSize = 5
): StagnationState {
  return {
    recentToolCalls: [],
    recentResponseHashes: [],
    similarResponseCount: 0,
    maxSimilar,
    windowSize,
  };
}

/**
 * Simple hash function for stagnation detection.
 */
export function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Update stagnation state after an LLM response.
 */
export function updateStagnation(
  state: StagnationState,
  responseText: string,
  toolCalls: string[]
): StagnationState {
  const hash = simpleHash(responseText);
  const newHashes = [...state.recentResponseHashes, hash].slice(-state.windowSize);
  const newToolCalls = [...state.recentToolCalls, ...toolCalls].slice(-state.windowSize * 2);

  // Check for hash repetition
  const lastHash = state.recentResponseHashes[state.recentResponseHashes.length - 1];
  const similarCount = hash === lastHash
    ? state.similarResponseCount + 1
    : 0;

  return {
    ...state,
    recentResponseHashes: newHashes,
    recentToolCalls: newToolCalls,
    similarResponseCount: similarCount,
  };
}

/**
 * Check if stagnation is detected.
 */
export function isStagnating(state: StagnationState): boolean {
  return state.similarResponseCount >= state.maxSimilar;
}

/**
 * Calculate stagnation score (0-1).
 */
export function getStagnationScore(state: StagnationState): number {
  // Check for tool call loops
  const toolCallLoopScore = detectToolCallLoop(state.recentToolCalls);

  // Check for response repetition
  const repetitionScore = state.similarResponseCount / state.maxSimilar;

  return Math.min(1, Math.max(toolCallLoopScore, repetitionScore));
}

/**
 * Detect repeating patterns in tool calls.
 */
function detectToolCallLoop(calls: string[]): number {
  if (calls.length < 4) return 0;

  // Check for simple 2-element loops (A, B, A, B)
  const last4 = calls.slice(-4);
  if (last4[0] === last4[2] && last4[1] === last4[3]) {
    return 0.8;
  }

  // Check for 3-element loops
  if (calls.length >= 6) {
    const last6 = calls.slice(-6);
    if (
      last6[0] === last6[3] &&
      last6[1] === last6[4] &&
      last6[2] === last6[5]
    ) {
      return 0.9;
    }
  }

  // Check for same tool called repeatedly
  const last3 = calls.slice(-3);
  if (last3.every((c) => c === last3[0])) {
    return 0.7;
  }

  return 0;
}
