/**
 * Stop Hook Types - Shared between agent and orchestrator.
 *
 * Moved to protocol layer to avoid circular dependency:
 * orchestrator needs StopHookResult but can't import from agent.
 */

import type { TerminationReason } from './termination.js';
import type { HandoffSpec } from './state.js';

/**
 * Deferred work item specification for stop hooks.
 * Allows hooks to enqueue additional work when allowing/blocking termination.
 */
export interface DeferredWorkItem {
  id?: string;
  goal: string;
  objective: string;
  agent: string;
  background: boolean;
  dependencies?: string[];
  targetPaths?: string[];
  bounds?: { maxToolCalls?: number; maxLlmCalls?: number; maxDurationMs?: number };
  /** Semantic state for this work item (flows through from watcher split/create) */
  semantic?: unknown;
}

/**
 * Snapshot of agent execution state, provided to stop hooks for informed decisions.
 */
export interface ExecutionSnapshot {
  toolHistory: Array<{
    name: string;
    args: Record<string, unknown>;
    success: boolean;
    durationMs: number;
    outputPreview?: string; // first ~500 chars
  }>;
  filesModified: string[];
  filesRead: string[];
  metrics: {
    llmCallsMade: number;
    toolCallsMade: number;
    toolCallsSucceeded: number;
    toolCallsFailed: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    contextPercentUsed: number;
  };
  artifacts?: Array<{ sourcePath: string; name: string; kind: string; insight?: string }>;
  fullResponse: string;
}

/**
 * Result from a stop hook - can block termination and re-inject a prompt.
 */
export type StopHookResult =
  | {
      /** Allow termination to proceed */
      decision: 'allow';
      /** System message to prepend */
      systemMessage?: string;
      /** Deferred work items for async dispatch */
      deferredWork?: DeferredWorkItem[];
    }
  | {
      /** Block termination and continue execution */
      decision: 'block';
      /** Reason/prompt to inject when blocking */
      reason: string;
      /** System message to prepend */
      systemMessage?: string;
      /** Deferred work items for async dispatch */
      deferredWork?: DeferredWorkItem[];
    };

/**
 * User prompt info passed to stop hooks.
 */
export interface StopHookUserPrompt {
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
  questionType?: string;
}

/**
 * Context passed to a stop hook when the orchestrator reaches a terminal condition.
 */
export interface StopHookContext {
  workId: string;
  response: string;
  terminationReason: TerminationReason;
  iteration: number;
  agentType: string;
  sessionKey: string;
  /** The actual PromptUser question/options when terminationReason is 'user_input_required' */
  userPrompt?: StopHookUserPrompt;
  /** Execution snapshot for enriched stop hook evaluation */
  executionSnapshot?: ExecutionSnapshot;
  /** Handoff spec when terminationReason is 'handoff_requested' */
  handoffSpec?: HandoffSpec;
}

/**
 * A stop hook handler that can block orchestrator termination.
 */
export type StopHookHandler = (context: StopHookContext) => StopHookResult | Promise<StopHookResult>;
