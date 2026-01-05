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

/**
 * LLM provider type.
 */
export type LLMProvider = 'anthropic' | 'openai';

/**
 * LLM configuration.
 */
export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  baseUrl?: string; // For custom API endpoints
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
  maxTokens?: number;
  temperature?: number;
  system?: string;
  // Responses API specific parameters (OpenAI)
  promptCacheKey?: string;
  promptCacheRetention?: string;
  previousResponseId?: string;
  maxToolCalls?: number;
  parallelToolCalls?: boolean;
}

/**
 * Parameters for LLM stream call.
 */
export interface StreamParams extends RespondParams {
  onChunk?: (chunk: string) => void;
}

/**
 * LLM adapter interface.
 * Abstracts provider differences.
 */
export interface LLMAdapter {
  readonly provider: LLMProvider;
  readonly model: string;

  /**
   * Send a prompt and get a complete response.
   */
  respond(params: RespondParams): Promise<LLMResponse>;

  /**
   * Send a prompt and stream the response.
   * Returns an async generator that yields chunks.
   */
  stream(params: StreamParams): AsyncGenerator<string, LLMResponse>;
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
