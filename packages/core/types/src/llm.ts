/**
 * LLM adapter types.
 *
 * Defines interfaces for LLM communication that abstracts
 * provider differences (Anthropic, OpenAI).
 *
 * Ported from: src/util/llm_adapter.py (Message and related types)
 */

// ============================================
// MESSAGE TYPES
// ============================================

/**
 * Message role in a conversation.
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Content block types.
 */
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'image';

/**
 * Text content block.
 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/**
 * Tool use content block (when assistant calls a tool).
 */
export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result content block (response to a tool call).
 */
export interface ToolResultContentBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * Image content block.
 */
export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

/**
 * Union of all content block types.
 */
export type ContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock;

/**
 * Message in a conversation.
 * Supports both simple string content and complex content blocks.
 */
export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}

/**
 * Create a simple text message.
 */
export function textMessage(role: MessageRole, text: string): Message {
  return { role, content: text };
}

/**
 * Create a message with content blocks.
 */
export function blocksMessage(role: MessageRole, blocks: ContentBlock[]): Message {
  return { role, content: blocks };
}

/**
 * Extract text content from a message.
 */
export function getMessageText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Extract tool use blocks from a message.
 */
export function getToolUseBlocks(message: Message): ToolUseContentBlock[] {
  if (typeof message.content === 'string') {
    return [];
  }
  return message.content.filter(
    (b): b is ToolUseContentBlock => b.type === 'tool_use'
  );
}

// ============================================
// LLM CONFIG
// ============================================

// Import and re-export LLMProvider from the central providers module
import type { LLMProvider } from './providers.js';
import type { Effect, Stream } from 'effect';
export type { LLMProvider };

/**
 * Reasoning configuration.
 */
export type ReasoningEffort =
  | 'none'
  | 'standard'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface ReasoningConfig {
  effort: ReasoningEffort;
}

/**
 * Fallback model configuration for resilience.
 * Used when primary model fails (circuit breaker trip or exhausted retries).
 */
export interface FallbackConfig {
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Structured output schema for JSON responses.
 */
export interface StructuredOutputSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  /** Optional schema identifier for runtime validation (e.g., "goal_driven"). */
  schemaId?: string;
}

/**
 * Per-request LLM configuration.
 */
export interface LLMRequestConfig {
  model: string;
  provider?: LLMProvider;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string; // Optional override for custom API endpoints
  /** User-facing provider name for error messages (e.g., 'cerebras' when provider is 'openai-compat') */
  displayProvider?: string;
  reasoning?: ReasoningConfig;
  fallback?: FallbackConfig; // Fallback model if primary fails
}

/**
 * Client-level configuration for the adapter.
 */
export interface LLMClientConfig {
  apiKeys?: Partial<Record<LLMProvider, string>>;
  baseUrls?: Partial<Record<LLMProvider, string>>;
  modelRegistry?: Record<string, { provider: LLMProvider; baseUrl?: string }>;
  fallback?: FallbackConfig; // Global fallback model if primary fails
}

// ============================================
// LLM RESPONSE
// ============================================

/**
 * Stop reason for LLM response.
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

/**
 * Token usage statistics.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

/**
 * Tool call extracted from LLM response.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * LLM response.
 */
export interface LLMResponse {
  content: string;
  contentBlocks?: ContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  toolCalls?: ToolCall[];
  model: string;
  durationMs: number;
  responseId?: string; // OpenAI Responses API response ID
  usedFallback?: boolean; // True if fallback model was used due to primary failure
  /** Reasoning/thinking trace from models that support it (e.g., GLM-4.7, Claude extended thinking) */
  reasoningContent?: string;
}

// ============================================
// EFFECT RUNTIME CONTROL
// ============================================

export type RunControlState = 'running' | 'paused' | 'cancelling' | 'cancelled';

export interface RunPauseMetadata {
  requestedAt: number;
  requestedBy?: 'user' | 'system' | 'policy';
  reason?: string;
}

export interface RunCancellationMetadata {
  requestedAt: number;
  requestedBy?: 'user' | 'system' | 'policy';
  reason?: string;
  scope?: 'run' | 'work_item' | 'tool';
  targetWorkIds?: string[];
}

export interface RunControlMetadata {
  state: RunControlState;
  pause?: RunPauseMetadata;
  cancellation?: RunCancellationMetadata;
}

export interface RunExecutionMetadata {
  requestId: string;
  runId?: string;
  workItemId?: string;
  attempt?: number;
}

export interface LLMExecutionContext {
  execution: RunExecutionMetadata;
  control: RunControlMetadata;
}

export interface LLMExecutionError {
  type:
    | 'cancelled'
    | 'paused'
    | 'timeout'
    | 'provider_error'
    | 'schema_error'
    | 'unknown';
  message: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

// ============================================
// LLM ADAPTER INTERFACE
// ============================================

/**
 * Parameters for LLM respond call.
 */
export interface RespondParams {
  messages: Message[];
  tools?: import('./tools.js').ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxTokens?: number;
  temperature?: number;
  system?: string;
  llm: LLMRequestConfig;
  responseSchema?: StructuredOutputSchema;
  // Responses API specific parameters (OpenAI)
  promptCacheKey?: string;
  promptCacheRetention?: string;
  previousResponseId?: string;
  maxToolCalls?: number;
  parallelToolCalls?: boolean;
  run?: RunExecutionMetadata;
  control?: RunControlMetadata;
}

/**
 * Parameters for LLM stream call.
 */
export interface StreamParams extends RespondParams {
  onChunk?: (chunk: string) => void;
  /** Callback for reasoning/thinking content chunks (e.g., GLM-4.7 thinking traces) */
  onReasoningChunk?: (chunk: string) => void;
  /** Callback when streaming finalizes with the complete response object. */
  onComplete?: (response: LLMResponse) => void;
}

/**
 * LLM adapter interface.
 * Abstracts provider differences.
 */
export interface LLMAdapter {
  readonly provider?: LLMProvider;
  readonly model?: string;

  /**
   * Send a prompt and get a complete response.
   */
  respond(params: RespondParams): Effect.Effect<LLMResponse, LLMExecutionError>;

  /**
   * Send a prompt and stream response chunks.
   */
  stream(params: StreamParams): Stream.Stream<string, LLMExecutionError>;

  /**
   * Register a model mapping for provider/baseUrl resolution.
   */
  registerModel?(model: string, provider: LLMProvider, baseUrl?: string): void;

  /**
   * Update or add an API key for a provider at runtime.
   * Also resets the circuit breaker to allow immediate retries.
   */
  updateApiKey?(provider: LLMProvider, apiKey: string): void;

  /**
   * Check if an API key exists for a provider.
   */
  hasApiKey?(provider: LLMProvider): boolean;

  /**
   * Reset the circuit breaker state.
   */
  resetCircuitBreaker?(): void;

  /**
   * Update the global fallback configuration at runtime.
   */
  updateFallback?(fallback: FallbackConfig | undefined): void;
}

// ============================================
// CONVERSATION CONTEXT
// ============================================

/**
 * Conversation context for managing message history.
 */
export interface ConversationContext {
  messages: Message[];
  system?: string;
  totalTokens: number;
  maxTokens: number;
}

/**
 * Create an empty conversation context.
 */
export function createConversationContext(
  system?: string,
  maxTokens = 200000
): ConversationContext {
  return {
    messages: [],
    system,
    totalTokens: 0,
    maxTokens,
  };
}

/**
 * Add a message to conversation context.
 */
export function addMessage(
  context: ConversationContext,
  message: Message
): ConversationContext {
  return {
    ...context,
    messages: [...context.messages, message],
  };
}

/**
 * Estimate token count for a message (rough approximation).
 * Uses ~4 chars per token heuristic.
 */
export function estimateTokens(message: Message): number {
  const text = getMessageText(message);
  return Math.ceil(text.length / 4);
}
