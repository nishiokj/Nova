/**
 * LLM Adapter implementations.
 *
 * Provides concrete implementations for Anthropic and OpenAI.
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
// BASE ADAPTER
// ============================================

/**
 * Base class for LLM adapters with common functionality.
 */
export abstract class BaseLLMAdapter implements LLMAdapter {
  protected config: LLMConfig;
  protected circuitState: CircuitBreakerState;
  protected resilienceConfig: ResilienceConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.circuitState = createCircuitState();
    this.resilienceConfig = {
      ...DEFAULT_RESILIENCE_CONFIG,
      maxRetries: 2,
      initialBackoffMs: 1000,
    };
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

  constructor(config: LLMConfig) {
    super(config);
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
        throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
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
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
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
// OPENAI ADAPTER
// ============================================

/**
 * OpenAI adapter.
 *
 * Note: This implementation uses the native fetch API.
 * For production use, consider using the openai package.
 */
export class OpenAIAdapter extends BaseLLMAdapter {
  private baseUrl: string;

  constructor(config: LLMConfig) {
    super(config);
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
  }

  get provider(): LLMProvider {
    return 'openai';
  }

  protected formatTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: t.parameters.properties,
          required: t.parameters.required,
        },
      },
    }));
  }

  private formatMessages(
    messages: Message[],
    system?: string
  ): Array<{ role: string; content: string | unknown[]; tool_calls?: unknown[] }> {
    const result: Array<{
      role: string;
      content: string | unknown[];
      tool_calls?: unknown[];
    }> = [];

    // Add system message first if provided
    if (system) {
      result.push({ role: 'system', content: system });
    }

    for (const m of messages) {
      if (m.role === 'system' && system) continue; // Already added

      const msg: {
        role: string;
        content: string | unknown[];
        tool_calls?: unknown[];
      } = {
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((block) => {
                if (block.type === 'text') {
                  return { type: 'text', text: block.text };
                }
                if (block.type === 'tool_result') {
                  // Tool results need special handling in OpenAI
                  return { type: 'text', text: block.content };
                }
                return block;
              }),
      };

      // Handle tool_use blocks for assistant messages
      if (typeof m.content !== 'string') {
        const toolUseBlocks = m.content.filter((b) => b.type === 'tool_use');
        if (toolUseBlocks.length > 0) {
          msg.tool_calls = toolUseBlocks.map((b) => ({
            id: (b as { id: string }).id,
            type: 'function',
            function: {
              name: (b as { name: string }).name,
              arguments: JSON.stringify(
                (b as { input: Record<string, unknown> }).input
              ),
            },
          }));
        }
      }

      result.push(msg);
    }

    return result;
  }

  private isReasoningModel(): boolean {
    const model = this.model.toLowerCase();
    return model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3');
  }

  async respond(params: RespondParams): Promise<LLMResponse> {
    const startTime = Date.now();

    return this.withResilience(async () => {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: this.formatMessages(params.messages, params.system),
      };

      // Handle max tokens based on model
      if (this.isReasoningModel()) {
        body.max_completion_tokens =
          params.maxTokens ?? this.config.maxTokens ?? 4096;
      } else {
        body.max_tokens = params.maxTokens ?? this.config.maxTokens ?? 4096;
        if (params.temperature ?? this.config.temperature) {
          body.temperature = params.temperature ?? this.config.temperature;
        }
      }

      if (params.tools && params.tools.length > 0) {
        body.tools = this.formatTools(params.tools);
        // For reasoning models, force tool use
        body.tool_choice = this.isReasoningModel() ? 'required' : 'auto';
      }

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason: string;
        }>;
        usage: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
        model: string;
      };

      const choice = data.choices[0];
      const message = choice.message;

      // Extract tool calls
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

      // Map stop reason
      const stopReasonMap: Record<string, StopReason> = {
        stop: 'end_turn',
        length: 'max_tokens',
        tool_calls: 'tool_use',
      };
      const stopReason: StopReason =
        stopReasonMap[choice.finish_reason] ?? 'end_turn';

      const usage: TokenUsage = {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      };

      return {
        content: message.content ?? '',
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

    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.formatMessages(params.messages, params.system),
      stream: true,
    };

    if (this.isReasoningModel()) {
      body.max_completion_tokens =
        params.maxTokens ?? this.config.maxTokens ?? 4096;
    } else {
      body.max_tokens = params.maxTokens ?? this.config.maxTokens ?? 4096;
      if (params.temperature ?? this.config.temperature) {
        body.temperature = params.temperature ?? this.config.temperature;
      }
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
      body.tool_choice = this.isReasoningModel() ? 'required' : 'auto';
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
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
              choices: Array<{
                delta: { content?: string };
                finish_reason?: string;
              }>;
              model?: string;
              usage?: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
              };
            };

            if (event.model) {
              model = event.model;
            }

            if (event.choices?.[0]?.delta?.content) {
              const text = event.choices[0].delta.content;
              fullContent += text;
              params.onChunk?.(text);
              yield text;
            }

            if (event.choices?.[0]?.finish_reason) {
              const reason = event.choices[0].finish_reason;
              const reasonMap: Record<string, StopReason> = {
                stop: 'end_turn',
                length: 'max_tokens',
                tool_calls: 'tool_use',
              };
              stopReason = reasonMap[reason] ?? 'end_turn';
            }

            if (event.usage) {
              usage = {
                promptTokens: event.usage.prompt_tokens,
                completionTokens: event.usage.completion_tokens,
                totalTokens: event.usage.total_tokens,
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
// FACTORY
// ============================================

/**
 * Create an LLM adapter based on configuration.
 */
export function createAdapter(config: LLMConfig): LLMAdapter {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicAdapter(config);
    case 'openai':
      return new OpenAIAdapter(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
