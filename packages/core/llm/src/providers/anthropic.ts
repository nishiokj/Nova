/**
 * Anthropic provider implementation.
 * Handles Anthropic Messages API - streaming and non-streaming.
 */

import type {
  ToolDefinition,
  ToolCall,
  TokenUsage,
  StopReason,
  LLMResponse,
  RespondParams,
  StreamParams,
  LLMExecutionError,
} from 'types';
import { Effect, Stream } from 'effect';
import type { ProviderContext, LLMProviderAdapter } from './types.js';
import { PartialStreamError, toLLMExecutionError } from './types.js';
import {
  createRateLimitError,
} from '../rate-limits.js';
import { parseApiErrorResponse, formatApiError } from '../response_schemas.js';

function parseApiError(provider: string, status: number, responseText: string): Error {
  const parsed = parseApiErrorResponse(provider, status, responseText);
  return formatApiError(provider, status, parsed);
}

function buildSchemaInstruction(schema: Record<string, unknown>): string {
  return `Return a single JSON object that matches this schema:\n${JSON.stringify(schema)}`;
}

// ============================================
// ANTHROPIC PROVIDER
// ============================================

export class AnthropicProvider implements LLMProviderAdapter {
  readonly name = 'anthropic' as const;

  respond(context: ProviderContext, params: RespondParams): Effect.Effect<LLMResponse, LLMExecutionError> {
    return Effect.tryPromise({
      try: () => this.respondAnthropic(context, params),
      catch: (error) => toLLMExecutionError(error, this.name, context.config.model),
    });
  }

  stream(context: ProviderContext, params: StreamParams): Stream.Stream<string, LLMExecutionError> {
    return Stream.unwrapScoped(
      Effect.acquireRelease(
        Effect.sync(() => this.streamAnthropic(context, params)),
        (generator) =>
          Effect.tryPromise({
            try: async () => {
              if (typeof generator.return === 'function') {
                await generator.return(undefined as never);
              }
            },
            catch: () => undefined,
          }).pipe(Effect.orDie)
      ).pipe(
        Effect.map((generator) =>
          Stream.fromAsyncIterable(
            {
              [Symbol.asyncIterator]: async function* () {
                while (true) {
                  const next = await generator.next();
                  if (next.done) {
                    if (next.value) {
                      params.onComplete?.(next.value);
                    }
                    return;
                  }
                  yield next.value;
                }
              },
            },
            (error) => toLLMExecutionError(error, 'anthropic', context.config.model)
          )
        )
      )
    );
  }

  formatTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools
      .filter((t) => t.name !== 'apply_patch')
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object',
          properties: t.parameters.properties,
          required: t.parameters.required,
          additionalProperties: t.parameters.additionalProperties,
        },
      }));
  }

  formatMessages(messages: any[]): Array<{ role: string; content: string | unknown[] }> {
    return messages
      .filter((m) => m && m.role !== 'system' && m.content != null)
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter((block: unknown) => block != null).map((block: Record<string, unknown>) => {
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
                })
              : [],
      }));
  }

  // ============================================
// ANTHROPIC (non-streaming)
  // ============================================

  private async respondAnthropic(
    context: ProviderContext,
    params: RespondParams
  ): Promise<LLMResponse> {
    const { config, logger } = context;
    const resolved = config;

    const systemMessage = params.messages.find((m) => m.role === 'system');
    let systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    if (params.responseSchema) {
      const schemaHint = buildSchemaInstruction(params.responseSchema.schema);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaHint}` : schemaHint;
    }

    const body: Record<string, unknown> = {
      model: resolved.model,
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
      messages: this.formatMessages(params.messages),
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
    }

    const response = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': resolved.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Anthropic API request failed', {
        method: 'respond',
        endpoint: '/v1/messages',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError('Anthropic', resolved.model, response.status, response.headers, errorText);
      }
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

    const content = data.content
      .filter((c): c is { type: string; text?: string } => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text ?? '')
      .join('');

    const toolUseBlocks = data.content
      .filter((c): c is { type: string; id?: string; name?: string; input?: Record<string, unknown> } =>
        c?.type === 'tool_use' &&
        typeof c.id === 'string' && c.id.length > 0 &&
        typeof c.name === 'string' && c.name.length > 0
      );
    const toolCalls: ToolCall[] = toolUseBlocks.map((c) => ({
      id: c.id!,
      name: c.name!,
      arguments: (c.input && typeof c.input === 'object') ? c.input : {},
    }));

    const stopReasonMap: Record<string, StopReason> = {
      end_turn: 'end_turn',
      max_tokens: 'max_tokens',
      stop_sequence: 'stop_sequence',
      tool_use: 'tool_use',
    };
    const stopReason: StopReason =
      stopReasonMap[data.stop_reason] ?? 'end_turn';

    const usageData = data.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
    const usage: TokenUsage = {
      promptTokens: usageData.input_tokens,
      completionTokens: usageData.output_tokens,
      totalTokens: usageData.input_tokens + usageData.output_tokens,
      cachedTokens: usageData.cache_read_input_tokens,
    };

    return {
      content,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: data.model,
      durationMs: Date.now() - context.startTime,
    };
  }

  // ============================================
  // ANTHROPIC STREAMING
  // ============================================

  private async *streamAnthropic(
    context: ProviderContext,
    params: StreamParams
  ): AsyncGenerator<string, LLMResponse> {
    const { config, logger } = context;
    const resolved = config;

    const systemMessage = params.messages.find((m) => m.role === 'system');
    let systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    if (params.responseSchema) {
      const schemaHint = buildSchemaInstruction(params.responseSchema.schema);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaHint}` : schemaHint;
    }

    const body: Record<string, unknown> = {
      model: resolved.model,
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
      messages: this.formatMessages(params.messages),
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
    }

    const response = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': resolved.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      logger.error('Anthropic API stream request failed', {
        method: 'stream',
        endpoint: '/v1/messages',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError('Anthropic', resolved.model, response.status, response.headers, errorText);
      }
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
    let model = resolved.model;
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
              const eventUsage = event.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
              usage = {
                promptTokens: eventUsage.input_tokens,
                completionTokens: eventUsage.output_tokens,
                totalTokens:
                  eventUsage.input_tokens + eventUsage.output_tokens,
                cachedTokens: eventUsage.cache_read_input_tokens,
              };
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (streamError) {
      const cause = streamError instanceof Error ? streamError : new Error(String(streamError));
      logger.warn('Stream interrupted mid-response', {
        method: 'stream',
        model: resolved.model,
        partialContentLength: fullContent.length,
        error: cause.message,
      });
      throw new PartialStreamError(
        'Stream interrupted',
        cause,
        fullContent,
        toolCalls
      );
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      durationMs: Date.now() - context.startTime,
    };
  }
}
