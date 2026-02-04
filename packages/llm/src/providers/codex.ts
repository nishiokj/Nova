/**
 * Codex Provider - Uses OpenAI's Responses API with OAuth tokens.
 *
 * Key differences from standard OpenAI provider:
 * - Uses OAuth access tokens (from subscription), not API keys
 * - Same Responses API endpoint but simpler request format
 * - Optimized for Codex-specific models
 */

import type {
  ToolDefinition,
  ToolCall,
  TokenUsage,
  StopReason,
  LLMResponse,
  Message,
  RespondParams,
  StreamParams,
} from 'types';
import type { ProviderContext, LLMProviderAdapter } from './types.js';
import { PartialStreamError } from './types.js';

// ============================================
// CODEX PROVIDER
// ============================================

export class CodexProvider implements LLMProviderAdapter {
  readonly name = 'codex' as const;

  async respond(context: ProviderContext, params: RespondParams): Promise<LLMResponse> {
    const { config, logger } = context;
    const { messages, tools, system } = params;

    const allMessages: Message[] = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;

    const body: Record<string, unknown> = {
      model: config.model,
      input: this.formatInput(allMessages),
      store: true, // Required for reasoning traces
    };

    if (config.maxTokens) body.max_output_tokens = config.maxTokens;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools?.length) body.tools = this.formatTools(tools);
    if (config.reasoning) {
      body.reasoning = { effort: config.reasoning };
    }

    const url = `${config.baseUrl}/v1/responses`;

    logger.debug('Codex request', { url, model: config.model });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Codex API error ${response.status}: ${errorText}`);
    }

    const data: ResponsesAPIResponse = await response.json();
    return this.parseResponse(data, context);
  }

  async *stream(context: ProviderContext, params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const { config, logger } = context;
    const { messages, tools, system } = params;

    const allMessages: Message[] = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;

    const body: Record<string, unknown> = {
      model: config.model,
      input: this.formatInput(allMessages),
      stream: true,
      store: true,
    };

    if (config.maxTokens) body.max_output_tokens = config.maxTokens;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools?.length) body.tools = this.formatTools(tools);
    if (config.reasoning) {
      body.reasoning = { effort: config.reasoning };
    }

    const url = `${config.baseUrl}/v1/responses`;

    logger.debug('Codex stream request', { url, model: config.model });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Codex API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    const toolCalls: ToolCall[] = [];
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let responseId: string | undefined;

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
            const event = JSON.parse(data) as StreamEvent;

            if (event.type === 'response.created') {
              responseId = event.id;
            }

            if (event.type === 'response.output_text.delta') {
              const text = event.delta ?? '';
              fullContent += text;
              params.onChunk?.(text);
              yield text;
            }

            if (event.type === 'response.function_call_arguments.done') {
              toolCalls.push({
                id: event.call_id!,
                name: event.name!,
                arguments: this.parseArguments(event.arguments),
              });
            }

            if (event.type === 'response.completed' && event.response?.usage) {
              usage = {
                promptTokens: event.response.usage.input_tokens ?? 0,
                completionTokens: event.response.usage.output_tokens ?? 0,
                totalTokens: event.response.usage.total_tokens ?? 0,
              };
            }
          } catch {
            // Ignore parse errors in stream
          }
        }
      }
    } catch (streamError) {
      const cause = streamError instanceof Error ? streamError : new Error(String(streamError));
      logger.warn('Codex stream interrupted', {
        model: config.model,
        partialContentLength: fullContent.length,
        error: cause.message,
      });
      throw new PartialStreamError('Stream interrupted', cause, fullContent, toolCalls);
    } finally {
      reader.releaseLock();
    }

    const stopReason: StopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

    return {
      content: fullContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      stopReason,
      model: config.model,
      durationMs: Date.now() - context.startTime,
      responseId,
    };
  }

  formatTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.parameters.properties,
        required: tool.parameters.required,
        additionalProperties: tool.parameters.additionalProperties,
      },
    }));
  }

  // ============================================
  // HELPERS
  // ============================================

  private formatInput(messages: Message[]): ResponsesInput[] {
    return messages.map((msg) => {
      if (msg.role === 'user') {
        return { type: 'message', role: 'user', content: msg.content as string };
      }
      if (msg.role === 'assistant') {
        return { type: 'message', role: 'assistant', content: msg.content as string };
      }
      if (msg.role === 'system') {
        return { type: 'message', role: 'system', content: msg.content as string };
      }
      if (msg.role === 'tool') {
        return {
          type: 'function_call_output',
          call_id: (msg as ToolMessage).toolCallId,
          output: msg.content as string,
        };
      }
      throw new Error(`Unknown message role: ${msg.role}`);
    });
  }

  private parseResponse(data: ResponsesAPIResponse, context: ProviderContext): LLMResponse {
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const item of data.output ?? []) {
      if (item.type === 'message' && item.content) {
        for (const block of item.content) {
          if (block.type === 'output_text' || block.type === 'text') {
            content += block.text ?? '';
          }
        }
      }
      if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id!,
          name: item.name!,
          arguments: this.parseArguments(item.arguments),
        });
      }
    }

    const stopReason: StopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason,
      model: data.model ?? context.config.model,
      durationMs: Date.now() - context.startTime,
      responseId: data.id,
    };
  }

  private parseArguments(args?: string): Record<string, unknown> {
    if (!args) return {};
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
}

// ============================================
// Responses API Types (internal)
// ============================================

interface ToolMessage extends Message {
  toolCallId: string;
}

interface ResponsesInput {
  type: 'message' | 'function_call_output';
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  call_id?: string;
  output?: string;
}

interface ResponsesAPIResponse {
  id: string;
  model?: string;
  status: 'completed' | 'failed' | 'in_progress';
  output?: Array<{
    type: 'message' | 'function_call';
    content?: Array<{ type: string; text?: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

interface StreamEvent {
  type: string;
  id?: string;
  delta?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  response?: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  };
}
