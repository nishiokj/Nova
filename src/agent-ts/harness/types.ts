/**
 * Harness types for wiring the TypeScript agent to the TUI.
 *
 * These types bridge the agent's internal types with the TUI's BridgeEvent format.
 *
 * NOTE: SessionContext has been replaced by ContextWindow from types/context.ts.
 * The harness now manages ContextWindow internally via getOrCreateContext().
 */

import type { Tier } from './config_types.js';

// Re-export Tier for convenience
export type { Tier } from './config_types.js';

/**
 * Parameters for running the agent.
 */
export interface AgentRunParams {
  requestId: string;
  inputText: string;
  tier?: Tier;
  sessionKey: string;
  context?: string;
}

/**
 * Result from an agent run.
 */
export interface AgentRunResult {
  requestId: string;
  sessionKey: string;
  success: boolean;
  finalText: string;
  errorMessage?: string;
  paused: boolean;
  userPrompt?: UserPromptInfo;
  toolsUsed: string[];
  durationMs: number;
  metadata?: Record<string, unknown>;
}

/**
 * User prompt info when agent pauses for input.
 */
export interface UserPromptInfo {
  requestId: string;
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multiSelect?: boolean;
}

/**
 * Bridge event types matching TUI expectations.
 */
export type BridgeEventType =
  | 'ready'
  | 'status'
  | 'progress'
  | 'stream'
  | 'response'
  | 'user_prompt'
  | 'error';

/**
 * Bridge event structure matching TUI expectations.
 */
export interface BridgeEvent {
  type: BridgeEventType;
  data?: Record<string, unknown>;
}

/**
 * Handle returned from agent.run() for streaming events.
 */
export interface AgentRunHandle {
  /** Promise that resolves when the agent completes */
  result: Promise<AgentRunResult>;
  /** Async iterator of BridgeEvents for streaming updates */
  events: AsyncIterable<BridgeEvent>;
  /** Abort the current run */
  abort?: () => void;
}

/**
 * Status data for status events.
 */
export interface StatusEventData {
  state: 'idle' | 'sending' | 'streaming' | 'error';
  message?: string;
}

/**
 * Progress data for progress events.
 */
export interface ProgressEventData {
  request_id?: string;
  message?: string;
  tool_name?: string;
  step_number?: number;
}

/**
 * Stream data for streaming events.
 */
export interface StreamEventData {
  request_id: string;
  chunk: string;
  chunk_index?: number;
  is_final?: boolean;
}

/**
 * Response data for response events.
 */
export interface ResponseEventData {
  request_id?: string;
  success?: boolean;
  content?: string;
  tools_used?: string[];
  duration_ms?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Ready data for ready events.
 */
export interface ReadyEventData {
  session_key?: string;
  capabilities?: {
    voice_available?: boolean;
    streaming_supported?: boolean;
  };
  config_summary?: string;
}

/**
 * User prompt data for user_prompt events.
 */
export interface UserPromptEventData {
  request_id: string;
  question: string;
  options?: Array<string | { label: string; description?: string }>;
  context?: string;
  multi_select?: boolean;
}

/**
 * Error data for error events.
 */
export interface ErrorEventData {
  message?: string;
  detail?: unknown;
  fatal?: boolean;
}
