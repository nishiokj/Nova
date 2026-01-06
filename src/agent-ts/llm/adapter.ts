/**
 * LLM Adapter implementations.
 *
 * Provides concrete implementations for Anthropic and OpenAI.
 * OpenAI uses the Responses API (not Chat Completions).
 *
 * Ported from: src/util/llm_adapter.py
 */

import type {
  LLMConfig,
  LLMAdapter,
  LLMResponse,
  RespondParams,
  StreamParams,
  LLMProvider,
  Message,
  ToolCall,
  TokenUsage,
  StopReason,
} from '../types/llm.js';
import type { ToolDefinition } from '../types/tools.js';
import {
  resilientCall,
  createCircuitState,
  type CircuitBreakerState,
  type ResilienceConfig,
  DEFAULT_RESILIENCE_CONFIG,
} from './retry.js';

// ============================================
// LOGGER PROTOCOL
// ============================================

/**
 * Logger interface for adapter operations.
 */
export interface AdapterLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Default console logger.
 */
export const consoleLogger: AdapterLogger = {
  debug: (msg, meta) => console.debug(`[LLM] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[LLM] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[LLM] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[LLM] ${msg}`, meta ?? ''),
};

/**
 * Parse API error response to extract detailed error information.
 */
function parseApiError(
  provider: string,
  status: number,
  responseText: string
): Error {
  // Try to parse as JSON for structured error info
  try {
    const parsed = JSON.parse(responseText);

    // OpenAI error format: { error: { message, type, code } }
    if (parsed.error?.message) {
      const errObj = parsed.error;
      const details = [
        errObj.type && `type=${errObj.type}`,
        errObj.code && `code=${errObj.code}`,
        errObj.param && `param=${errObj.param}`,
      ].filter(Boolean).join(', ');

      return new Error(
        `${provider} API error ${status}: ${errObj.message}${details ? ` (${details})` : ''}`
      );
    }

    // Anthropic error format: { type, error: { type, message } }
    if (parsed.error?.type && parsed.error?.message) {
      return new Error(
        `${provider} API error ${status} [${parsed.error.type}]: ${parsed.error.message}`
      );
    }

    // Generic message field
    if (parsed.message) {
      return new Error(`${provider} API error ${status}: ${parsed.message}`);
    }

    // Fallback to stringified JSON
    return new Error(`${provider} API error ${status}: ${JSON.stringify(parsed)}`);
  } catch {
    // Not JSON, use raw text
    const truncated = responseText.length > 500
      ? responseText.slice(0, 500) + '...'
      : responseText;
    return new Error(`${provider} API error ${status}: ${truncated}`);
  }
}

// ============================================
// BASE ADAPTER
// ============================================

/**
 * Base class for LLM adapters with common functionality.
 */
export abstract class BaseLLMAdapter implements LLMAdapter {
  protected config: LLMConfig;
  protected circuitState: CircuitBreakerState;
  protected resilienceConfig: ResilienceConfig;
  protected logger: AdapterLogger;

  constructor(config: LLMConfig, logger?: AdapterLogger) {
    this.config = config;
    this.circuitState = createCircuitState();
    this.resilienceConfig = {
      ...DEFAULT_RESILIENCE_CONFIG,
      maxRetries: 2,
      initialBackoffMs: 1000,
    };
    this.logger = logger ?? consoleLogger;
  }

  abstract get provider(): LLMProvider;

  get model(): string {
    return this.config.model;
  }

  abstract respond(params: RespondParams): Promise<LLMResponse>;

  abstract stream(params: StreamParams): AsyncGenerator<string, LLMResponse>;

  /**
   * Convert tool definitions to provider-specific format.
   */
  protected abstract formatTools(
    tools: ToolDefinition[]
  ): Record<string, unknown>[];

  /**
   * Execute LLM call with resilience (retry + circuit breaker).
   */
  protected async withResilience<T>(fn: () => Promise<T>): Promise<T> {
    return resilientCall(fn, {
      config: this.resilienceConfig,
      circuitState: this.circuitState,
      circuitKey: `${this.provider}:${this.model}`,
      onRetry: (attempt, error, delayMs) => {
        this.logger.warn(`LLM call failed, retrying`, {
          provider: this.provider,
          model: this.model,
          attempt,
          delayMs,
          error: error.message,
        });
      },
    });
  }
}

// ============================================
// ANTHROPIC ADAPTER
// ============================================

/**
 * Anthropic Claude adapter.
 *
 * Note: This implementation uses the native fetch API.
 * For production use, consider using the @anthropic-ai/sdk package.
 */
export class AnthropicAdapter extends BaseLLMAdapter {
  private baseUrl: string;

  constructor(config: LLMConfig, logger?: AdapterLogger) {
    super(config, logger);
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  get provider(): LLMProvider {
    return 'anthropic';
  }

  protected formatTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: t.parameters.properties,
        required: t.parameters.required,
      },
    }));
  }

  private formatMessages(
    messages: Message[]
  ): Array<{ role: string; content: string | unknown[] }> {
    return messages
      .filter((m) => m.role !== 'system') // System handled separately
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((block) => {
                if (block.type === 'text') {
                  return { type: 'text', text: block.text };
                }
                if (block.type === 'tool_use') {
                  return {
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: block.input,
                  };
                }
                if (block.type === 'tool_result') {
                  return {
                    type: 'tool_result',
                    tool_use_id: block.toolUseId,
                    content: block.content,
                    is_error: block.isError,
                  };
                }
                return block;
              }),
      }));
  }

  async respond(params: RespondParams): Promise<LLMResponse> {
    const startTime = Date.now();

    return this.withResilience(async () => {
      const systemMessage = params.messages.find((m) => m.role === 'system');
      const systemPrompt =
        params.system ??
        (systemMessage && typeof systemMessage.content === 'string'
          ? systemMessage.content
          : undefined);

      const body: Record<string, unknown> = {
        model: this.model,
        max_tokens: params.maxTokens ?? this.config.maxTokens ?? 4096,
        messages: this.formatMessages(params.messages),
      };

      if (systemPrompt) {
        body.system = systemPrompt;
      }

      if (params.temperature ?? this.config.temperature) {
        body.temperature = params.temperature ?? this.config.temperature;
      }

      if (params.tools && params.tools.length > 0) {
        body.tools = this.formatTools(params.tools);
      }

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('Anthropic API request failed', {
          method: 'respond',
          endpoint: '/v1/messages',
          status: response.status,
          model: this.model,
          errorPreview: errorText.slice(0, 200),
        });
        throw parseApiError('Anthropic', response.status, errorText);
      }

      const data = (await response.json()) as {
        content: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        stop_reason: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
        };
        model: string;
      };

      // Extract text content
      const textBlocks = data.content.filter((c) => c.type === 'text');
      const content = textBlocks.map((c) => c.text ?? '').join('');

      // Extract tool calls
      const toolUseBlocks = data.content.filter((c) => c.type === 'tool_use');
      const toolCalls: ToolCall[] = toolUseBlocks.map((c) => ({
        id: c.id ?? '',
        name: c.name ?? '',
        arguments: (c.input as Record<string, unknown>) ?? {},
      }));

      // Map stop reason
      const stopReasonMap: Record<string, StopReason> = {
        end_turn: 'end_turn',
        max_tokens: 'max_tokens',
        stop_sequence: 'stop_sequence',
        tool_use: 'tool_use',
      };
      const stopReason: StopReason =
        stopReasonMap[data.stop_reason] ?? 'end_turn';

      const usage: TokenUsage = {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      };

      return {
        content,
        stopReason,
        usage,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model: data.model,
        durationMs: Date.now() - startTime,
      };
    });
  }

  async *stream(params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const startTime = Date.now();

    const systemMessage = params.messages.find((m) => m.role === 'system');
    const systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens ?? this.config.maxTokens ?? 4096,
      messages: this.formatMessages(params.messages),
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (params.temperature ?? this.config.temperature) {
      body.temperature = params.temperature ?? this.config.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      this.logger.error('Anthropic API stream request failed', {
        method: 'stream',
        endpoint: '/v1/messages',
        status: response.status,
        model: this.model,
        errorPreview: errorText.slice(0, 200),
      });
      throw parseApiError('Anthropic', response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';
    let stopReason: StopReason = 'end_turn';
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const toolCalls: ToolCall[] = [];
    let model = this.model;
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as {
              type: string;
              delta?: { type: string; text?: string };
              message?: { model: string };
              usage?: { input_tokens: number; output_tokens: number };
            };

            if (
              event.type === 'content_block_delta' &&
              event.delta?.type === 'text_delta'
            ) {
              const text = event.delta.text ?? '';
              fullContent += text;
              params.onChunk?.(text);
              yield text;
            }

            if (event.type === 'message_start' && event.message?.model) {
              model = event.message.model;
            }

            if (event.type === 'message_delta' && event.usage) {
              usage = {
                promptTokens: event.usage.input_tokens,
                completionTokens: event.usage.output_tokens,
                totalTokens:
                  event.usage.input_tokens + event.usage.output_tokens,
              };
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      durationMs: Date.now() - startTime,
    };
  }
}

// ============================================
// OPENAI ADAPTER (Responses API)
// ============================================

/**
 * OpenAI adapter using the Responses API.
 *
 * This uses the Responses API (`/v1/responses`) NOT Chat Completions.
 * Matches the Python implementation in src/util/llm_adapter.py.
 */
export class OpenAIAdapter extends BaseLLMAdapter {
  private baseUrl: string;

  constructor(config: LLMConfig, logger?: AdapterLogger) {
    super(config, logger);
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
  }

  get provider(): LLMProvider {
    return 'openai';
  }

  /**
   * Check if this is a reasoning model (o1, o3, gpt-5-*).
   */
  private isReasoningModel(): boolean {
    const model = this.model.toLowerCase();
    return model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3');
  }

  /**
   * Check if model supports sampling parameters like temperature.
   */
  private supportsSamplingParams(): boolean {
    const model = this.model.toLowerCase();
    return !model.startsWith('gpt-5') && !model.startsWith('o1') && !model.startsWith('o3');
  }

  /**
   * Check if the model supports prompt_cache_retention parameter.
   * Some smaller models (e.g., gpt-5-nano) don't support this feature.
   */
  private supportsPromptCacheRetention(): boolean {
    const model = this.model.toLowerCase();
    // gpt-5-nano doesn't support prompt_cache_retention
    return !model.includes('nano');
  }

  /**
   * Poll for async response completion.
   * When background: true, the API returns immediately with a response ID.
   * We must poll until status is 'completed' or 'failed'.
   */
  private async pollForCompletion(
    responseId: string,
    maxWaitMs: number = 300000, // 5 minutes default
    pollIntervalMs: number = 500
  ): Promise<Record<string, unknown>> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const response = await fetch(`${this.baseUrl}/v1/responses/${responseId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('OpenAI poll request failed', {
          method: 'pollForCompletion',
          endpoint: `/v1/responses/${responseId}`,
          status: response.status,
          responseId,
          errorPreview: errorText.slice(0, 200),
        });
        throw parseApiError('OpenAI', response.status, errorText);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const status = data.status as string;

      if (status === 'completed') {
        return data;
      }

      if (status === 'failed' || status === 'cancelled') {
        const error = data.error as Record<string, unknown> | undefined;
        const errorMessage = error?.message ?? `Response ${status}`;
        const errorCode = error?.code ?? 'unknown';
        this.logger.error(`OpenAI response ${status}`, {
          method: 'pollForCompletion',
          endpoint: `/v1/responses/${responseId}`,
          responseId,
          errorCode,
          errorMessage,
        });
        throw new Error(`OpenAI Responses API ${status} [${errorCode}]: ${errorMessage}`);
      }

      // Status is 'queued' or 'in_progress' - wait and poll again
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    this.logger.error('OpenAI response timeout', {
      method: 'pollForCompletion',
      endpoint: `/v1/responses/${responseId}`,
      responseId,
      maxWaitMs,
    });
    throw new Error(`OpenAI Responses API timeout: response ${responseId} did not complete within ${maxWaitMs}ms`);
  }

  /**
   * Format tools for Responses API (internally-tagged format).
   */
  protected formatTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.parameters.properties,
        required: t.parameters.required,
      },
    }));
  }

  /**
   * Normalize input to Responses API content block format.
   * System messages are handled separately via `instructions` parameter.
   *
   * Handles both:
   * - Message[] format (role + content)
   * - Raw Responses API items (function_call, function_call_output) passed through from ContextWindow
   */
  private normalizeInput(
    messages: Message[]
  ): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      // Cast to access potential 'type' field for raw items
      const item = msg as unknown as Record<string, unknown>;
      const callId = (item.call_id ?? item.id ?? item.callId) as string;


      // Handle raw function_call items (already in Responses API format)
      if (item.type === 'function_call') {
        input.push({
          type: 'function_call',
          call_id: callId,
          name: item.name,
          arguments: item.arguments,
        });
        continue;
      }

      // Handle raw function_call_output items (already in Responses API format)
      if (item.type === 'function_call_output') {
        input.push({
          type: 'function_call_output',
          call_id: item.call_id,
          output: item.output,
        });
        continue;
      }

      // Standard Message handling below
      if (msg.role === 'system') continue; // System handled separately via instructions

      if (typeof msg.content === 'string') {
        const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';
        input.push({
          role: msg.role,
          content: [{ type: contentType, text: msg.content }],
        });
      } else if (msg.content) {
        // Handle content blocks
        const blocks: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';
            blocks.push({ type: contentType, text: block.text });
          } else if (block.type === 'tool_use') {
            // Assistant tool call -> function_call item
            input.push({
              type: 'function_call',
              call_id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
            });
            continue; // Don't add to blocks
          } else if (block.type === 'tool_result') {
            // Tool result -> function_call_output item
            input.push({
              type: 'function_call_output',
              call_id: block.toolUseId,
              output: block.content,
            });
            continue; // Don't add to blocks
          }
        }
        if (blocks.length > 0) {
          input.push({ role: msg.role, content: blocks });
        }
      }
    }

    return input;
  }

  /**
   * Extract text from Responses API output.
   */
  private parseOutputText(response: Record<string, unknown>): string {
    const outputText = response.output_text;
    if (typeof outputText === 'string' && outputText) {
      return outputText;
    }

    const output = response.output;
    if (!Array.isArray(output)) {
      return (outputText as string) ?? '';
    }

    const parts: string[] = [];
    for (const item of output) {
      const itemType = (item as Record<string, unknown>).type;
      if (itemType === 'output_text' || itemType === 'text') {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === 'string' && text) {
          parts.push(text);
        }
        continue;
      }

      if (itemType !== 'message') continue;

      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        const blockType = (block as Record<string, unknown>).type;
        if (blockType !== 'output_text' && blockType !== 'text') continue;
        const text = (block as Record<string, unknown>).text;
        if (typeof text === 'string' && text) {
          parts.push(text);
        }
      }
    }

    return parts.join('') || ((outputText as string) ?? '');
  }

  /**
   * Extract tool calls from Responses API output.
   */
  private parseToolCalls(response: Record<string, unknown>): ToolCall[] {
    const output = response.output;
    if (!Array.isArray(output)) {
      return [];
    }

    const toolCalls: ToolCall[] = [];
    for (const item of output) {
      const itemType = (item as Record<string, unknown>).type;
      if (itemType !== 'function_call') continue;

      const callId =
        ((item as Record<string, unknown>).call_id as string) ??
        ((item as Record<string, unknown>).id as string) ??
        '';
      const name = ((item as Record<string, unknown>).name as string) ?? '';
      const rawArgs = (item as Record<string, unknown>).arguments ?? {};

      let args: Record<string, unknown>;
      if (typeof rawArgs === 'string') {
        try {
          args = rawArgs ? JSON.parse(rawArgs) : {};
        } catch {
          args = {};
        }
      } else if (typeof rawArgs === 'object') {
        args = rawArgs as Record<string, unknown>;
      } else {
        args = {};
      }

      toolCalls.push({
        id: callId,
        name,
        arguments: args,
      });
    }

    return toolCalls;
  }

  async respond(params: RespondParams): Promise<LLMResponse> {
    const startTime = Date.now();

    return this.withResilience(async () => {
      // Extract system message as instructions
      const systemMessage = params.messages.find((m) => m.role === 'system');
      const instructions =
        params.system ??
        (systemMessage && typeof systemMessage.content === 'string'
          ? systemMessage.content
          : undefined);

      // =================================================================
      // PROMPT CACHING OPTIMIZATION: Order matters for cache hits!
      // Stable content (instructions, tools) should come BEFORE dynamic
      // content (input) so the prefix can be cached across requests.
      // Order: model → instructions → tools → config → input
      // =================================================================
      const body: Record<string, unknown> = {
        model: this.model,
        background: true, // Async execution - returns immediately, poll for completion
      };

      // 1. Instructions (system prompt) - STABLE, cacheable prefix
      if (instructions) {
        body.instructions = instructions;
      }

      // 2. Tools - STABLE, cacheable prefix
      if (params.tools && params.tools.length > 0) {
        body.tools = this.formatTools(params.tools);
        // For reasoning models, force tool use
        body.tool_choice = 'auto';
      }

      // 3. Prompt caching parameters - config for cache behavior
      if (params.promptCacheKey) {
        body.prompt_cache_key = params.promptCacheKey;
      }
      // Only add prompt_cache_retention for models that support it
      if (params.promptCacheRetention && this.supportsPromptCacheRetention()) {
        body.prompt_cache_retention = params.promptCacheRetention;
      }

      // 4. Stateful conversation continuation
      if (params.previousResponseId) {
        body.previous_response_id = params.previousResponseId;
      }

      // 5. Generation config
      if (this.supportsSamplingParams()) {
        if (params.temperature ?? this.config.temperature) {
          body.temperature = params.temperature ?? this.config.temperature;
        }
      }

      body.max_output_tokens = params.maxTokens ?? this.config.maxTokens ?? 4096;

      if (params.maxToolCalls !== undefined) {
        body.max_tool_calls = params.maxToolCalls;
      }
      if (params.parallelToolCalls !== undefined) {
        body.parallel_tool_calls = params.parallelToolCalls;
      }

      // 6. Input (conversation) - DYNAMIC, comes LAST for cache efficiency
      body.input = this.normalizeInput(params.messages);

      // Validate input - should never be empty after normalizeInput handles edge cases
      const inputArray = body.input as Array<Record<string, unknown>>;
      if (!inputArray || inputArray.length === 0) {
        // This should only happen if messages array is completely empty
        this.logger.error('OpenAI request has no input items', {
          method: 'respond',
          endpoint: '/v1/responses',
          totalMessages: params.messages.length,
          messageRoles: params.messages.map(m => m.role),
        });
        throw new Error(
          `OpenAI Responses API requires input: got ${params.messages.length} messages ` +
          `but normalized to 0 input items. Roles: [${params.messages.map(m => m.role).join(', ')}]`
        );
      }

      // Debug log the request (without sensitive data)
      this.logger.debug('OpenAI API request', {
        method: 'respond',
        endpoint: '/v1/responses',
        model: this.model,
        hasInstructions: !!body.instructions,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        inputLength: inputArray.length,
        messageCount: params.messages.length,
      });

      const response = await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('OpenAI API request failed', {
          method: 'respond',
          endpoint: '/v1/responses',
          status: response.status,
          model: this.model,
          inputLength: Array.isArray(body.input) ? body.input.length : 0,
          errorPreview: errorText.slice(0, 200),
        });
        throw parseApiError('OpenAI', response.status, errorText);
      }

      let data = (await response.json()) as Record<string, unknown>;

      // With background: true, we get an immediate response with status 'queued' or 'in_progress'
      // Only poll for non-terminal states. Terminal states: completed, failed, cancelled, incomplete
      const status = data.status as string;
      if (status === 'queued' || status === 'in_progress') {
        const responseId = data.id as string;
        if (!responseId) {
          this.logger.error('OpenAI background response missing id', {
            method: 'respond',
            endpoint: '/v1/responses',
            status,
          });
          throw new Error('OpenAI Responses API: background response missing id');
        }
        data = await this.pollForCompletion(responseId);
      } else if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
        // Handle terminal error states immediately
        const error = data.error as Record<string, unknown> | undefined;
        const errorMessage = error?.message ?? `Response ${status}`;
        const errorCode = error?.code ?? 'unknown';
        this.logger.error(`OpenAI immediate ${status}`, {
          method: 'respond',
          endpoint: '/v1/responses',
          errorCode,
          errorMessage,
          responseId: data.id,
        });
        throw new Error(`OpenAI Responses API ${status} [${errorCode}]: ${errorMessage}`);
      }

      // Parse response
      const outputText = this.parseOutputText(data);
      const toolCalls = this.parseToolCalls(data);

      // Map status to stop reason
      const finalStatus = (data.status as string) ?? 'completed';
      const stopReasonMap: Record<string, StopReason> = {
        completed: 'end_turn',
        failed: 'end_turn',
        cancelled: 'end_turn',
      };
      const stopReason: StopReason = toolCalls.length > 0 ? 'tool_use' : (stopReasonMap[finalStatus] ?? 'end_turn');

      // Extract usage
      const usageData = data.usage as Record<string, number> | undefined;
      const usage: TokenUsage = usageData
        ? {
            promptTokens: usageData.input_tokens ?? 0,
            completionTokens: usageData.output_tokens ?? 0,
            totalTokens: usageData.total_tokens ?? 0,
          }
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      return {
        content: outputText,
        stopReason,
        usage,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model: (data.model as string) ?? this.model,
        durationMs: Date.now() - startTime,
        responseId: data.id as string | undefined,
      };
    });
  }

  async *stream(params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const startTime = Date.now();

    // Extract system message as instructions
    const systemMessage = params.messages.find((m) => m.role === 'system');
    const instructions =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    // =================================================================
    // PROMPT CACHING OPTIMIZATION: Order matters for cache hits!
    // Stable content (instructions, tools) should come BEFORE dynamic
    // content (input) so the prefix can be cached across requests.
    // Order: model → instructions → tools → config → input
    // =================================================================
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
    };

    // 1. Instructions (system prompt) - STABLE, cacheable prefix
    if (instructions) {
      body.instructions = instructions;
    }

    // 2. Tools - STABLE, cacheable prefix
    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
      body.tool_choice = this.isReasoningModel() ? 'required' : 'auto';
    }

    // 3. Prompt caching parameters - config for cache behavior
    if (params.promptCacheKey) {
      body.prompt_cache_key = params.promptCacheKey;
    }
    // Only add prompt_cache_retention for models that support it
    if (params.promptCacheRetention && this.supportsPromptCacheRetention()) {
      body.prompt_cache_retention = params.promptCacheRetention;
    }

    // 4. Stateful conversation continuation
    if (params.previousResponseId) {
      body.previous_response_id = params.previousResponseId;
    }

    // 5. Generation config
    if (this.supportsSamplingParams()) {
      if (params.temperature ?? this.config.temperature) {
        body.temperature = params.temperature ?? this.config.temperature;
      }
    }

    body.max_output_tokens = params.maxTokens ?? this.config.maxTokens ?? 4096;

    if (params.maxToolCalls !== undefined) {
      body.max_tool_calls = params.maxToolCalls;
    }
    if (params.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = params.parallelToolCalls;
    }

    // 6. Input (conversation) - DYNAMIC, comes LAST for cache efficiency
    body.input = this.normalizeInput(params.messages);

    const response = await fetch(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      this.logger.error('OpenAI API stream request failed', {
        method: 'stream',
        endpoint: '/v1/responses',
        status: response.status,
        model: this.model,
        errorPreview: errorText.slice(0, 200),
      });
      throw parseApiError('OpenAI', response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';
    let stopReason: StopReason = 'end_turn';
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const toolCallsData: Map<string, { name: string; arguments: string }> = new Map();
    let model = this.model;
    let responseId: string | undefined;
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as Record<string, unknown>;
            const eventType = event.type as string;

            // Handle text content deltas
            if (eventType === 'response.output_text.delta') {
              const delta = event.delta as string;
              if (delta) {
                fullContent += delta;
                params.onChunk?.(delta);
                yield delta;
              }
            }

            // Handle function call output item added
            if (eventType === 'response.output_item.added') {
              const item = event.item as Record<string, unknown> | undefined;
              if (item && item.type === 'function_call') {
                const callId = (item.call_id as string) ?? (item.id as string) ?? '';
                const name = (item.name as string) ?? '';
                if (callId) {
                  toolCallsData.set(callId, { name, arguments: '' });
                }
              }
            }

            // Handle function call arguments delta
            if (eventType === 'response.function_call_arguments.delta') {
              const callId = (event.call_id as string) ?? (event.item_id as string) ?? '';
              const delta = (event.delta as string) ?? '';
              const existing = toolCallsData.get(callId);
              if (existing) {
                existing.arguments += delta;
              }
            }

            // Handle completion event
            if (eventType === 'response.completed') {
              const responseObj = event.response as Record<string, unknown> | undefined;
              if (responseObj) {
                responseId = responseObj.id as string | undefined;
                const usageData = responseObj.usage as Record<string, number> | undefined;
                if (usageData) {
                  usage = {
                    promptTokens: usageData.input_tokens ?? 0,
                    completionTokens: usageData.output_tokens ?? 0,
                    totalTokens: usageData.total_tokens ?? 0,
                  };
                }
                const status = (responseObj.status as string) ?? 'completed';
                if (status === 'failed' || status === 'cancelled') {
                  const error = responseObj.error as Record<string, unknown> | undefined;
                  this.logger.error(`OpenAI stream response ${status}`, {
                    method: 'stream',
                    endpoint: '/v1/responses',
                    responseId,
                    errorCode: error?.code,
                    errorMessage: error?.message,
                  });
                  stopReason = 'end_turn';
                }
                model = (responseObj.model as string) ?? model;

                // Parse any remaining text
                const parsedText = this.parseOutputText(responseObj);
                if (parsedText && !fullContent) {
                  fullContent = parsedText;
                  yield parsedText;
                }
              }
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Build final tool calls
    const toolCalls: ToolCall[] = [];
    for (const [callId, tcData] of toolCallsData) {
      if (tcData.name) {
        let args: Record<string, unknown>;
        try {
          args = tcData.arguments ? JSON.parse(tcData.arguments) : {};
        } catch {
          args = {};
        }
        toolCalls.push({
          id: callId,
          name: tcData.name,
          arguments: args,
        });
      }
    }

    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    }

    return {
      content: fullContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      durationMs: Date.now() - startTime,
      responseId,
    };
  }
}

// ============================================
// FACTORY
// ============================================

/**
 * Create an LLM adapter based on configuration.
 */
export function createAdapter(config: LLMConfig, logger?: AdapterLogger): LLMAdapter {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicAdapter(config, logger);
    case 'openai':
      return new OpenAIAdapter(config, logger);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
