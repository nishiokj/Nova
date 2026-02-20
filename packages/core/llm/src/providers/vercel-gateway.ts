/**
 * Vercel AI Gateway provider implementation.
 * Uses the OpenResponses API.
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
import { compileSchemaForOpenAI } from './schema_compiler.js';
import { createRateLimitError } from '../rate-limits.js';
import { parseApiErrorResponse, formatApiError } from '../response_schemas.js';

function parseApiError(provider: string, status: number, responseText: string): Error {
  const parsed = parseApiErrorResponse(provider, status, responseText);
  return formatApiError(provider, status, parsed);
}

function buildSchemaInstruction(schema: Record<string, unknown>): string {
  return `Return a single JSON object that matches this schema:\n${JSON.stringify(schema)}`;
}

export class VercelGatewayProvider implements LLMProviderAdapter {
  readonly name = 'vercel-gateway' as const;

  respond(context: ProviderContext, params: RespondParams): Effect.Effect<LLMResponse, LLMExecutionError> {
    return Effect.tryPromise({
      try: () => {
        if (params.responseSchema) {
          return this.respondChatCompletions(context, params);
        }
        return this.respondGateway(context, params);
      },
      catch: (error) => toLLMExecutionError(error, this.name, context.config.model),
    });
  }

  stream(context: ProviderContext, params: StreamParams): Stream.Stream<string, LLMExecutionError> {
    return Stream.unwrapScoped(
      Effect.acquireRelease(
        Effect.sync(() =>
          params.responseSchema
            ? this.streamChatCompletions(context, params)
            : this.streamGateway(context, params)
        ),
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
            (error) => toLLMExecutionError(error, 'vercel-gateway', context.config.model)
          )
        )
      )
    );
  }

  formatTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: t.parameters.properties,
          required: t.parameters.required,
          additionalProperties: t.parameters.additionalProperties,
        },
      },
    }));
  }

  formatMessages(messages: any[], systemPrompt?: string): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    const functionCalls: Array<{ callId: string; name: string; argumentsStr: string }> = [];
    let pendingReasoningContent = '';

    for (const msg of messages) {
      if (!msg || msg.role === 'system') continue;
      const item = msg as unknown as Record<string, unknown>;

      if (item.type === 'reasoning') {
        const content = item.content as string;
        if (content) {
          pendingReasoningContent += (pendingReasoningContent ? '\n' : '') + content;
        }
        continue;
      }

      if (item.type === 'function_call') {
        const callId = (item.call_id ?? item.callId) as string;
        const name = item.name as string;
        const args = item.arguments;
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
        functionCalls.push({ callId, name, argumentsStr: argsStr });
        continue;
      }

      if (item.type === 'function_call_output') {
        if (functionCalls.length > 0) {
          const assistantMsg: Record<string, unknown> = {
            role: 'assistant',
            content: '',
            tool_calls: functionCalls.map((fc) => ({
              id: fc.callId,
              type: 'function',
              function: {
                name: fc.name,
                arguments: fc.argumentsStr,
              },
            })),
          };
          if (pendingReasoningContent) {
            assistantMsg.reasoning_content = pendingReasoningContent;
            pendingReasoningContent = '';
          }
          result.push(assistantMsg);
          functionCalls.length = 0;
        }

        const outputCallId = (item.call_id ?? item.callId) as string;
        const rawOutput = item.output as string;
        const isError = item.isError as boolean | undefined;
        const output = isError && rawOutput && !rawOutput.startsWith('Error')
          ? `Error: ${rawOutput}`
          : rawOutput;
        result.push({
          role: 'tool',
          tool_call_id: outputCallId,
          content: output,
        });
        continue;
      }

      if (msg.content === undefined || msg.content === null) {
        continue;
      }

      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const content = msg.content
          .filter((block: unknown) => block != null)
          .map((block: Record<string, unknown>) => {
            if (block.type === 'text') {
              return { type: 'text', text: block.text };
            }
            if (block.type === 'image') {
              const source = block.source as { mediaType?: string; data?: string } | undefined;
              if (source?.mediaType && source?.data) {
                return {
                  type: 'image_url',
                  image_url: {
                    url: `data:${source.mediaType};base64,${source.data}`,
                  },
                };
              }
            }
            return block;
          });
        result.push({ role: msg.role, content });
      }
    }

    return result;
  }

  // ============================================
  // OpenResponses API (non-streaming)
  // ============================================

  private async respondGateway(
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

    const input = this.normalizeInput(params.messages, systemPrompt);
    if (input.length === 0) {
      logger.error('Vercel Gateway request has no input items', {
        method: 'respond',
        endpoint: '/v1/responses',
        totalMessages: params.messages.length,
        messageRoles: params.messages.map(m => m.role),
      });
      throw new Error(
        `OpenResponses API requires input: got ${params.messages.length} messages ` +
        `but normalized to 0 input items. Roles: [${params.messages.map(m => m.role).join(', ')}]`
      );
    }

    const body: Record<string, unknown> = {
      model: resolved.model,
      input,
      max_output_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
    };

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
    }

    if (params.toolChoice) {
      body.tool_choice = params.toolChoice;
    } else if (params.tools && params.tools.length > 0) {
      body.tool_choice = 'auto';
    }

    const reasoningEffort = resolved.reasoning?.effort;
    if (reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== 'standard') {
      body.reasoning = { effort: reasoningEffort };
    }

    logger.debug('Vercel Gateway API request', {
      method: 'respond',
      endpoint: '/v1/responses',
      model: resolved.model,
      maxOutputTokens: body.max_output_tokens,
      hasReasoning: !!body.reasoning,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      inputLength: input.length,
      messageCount: params.messages.length,
    });

    const response = await fetch(`${resolved.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Vercel Gateway API request failed', {
        method: 'respond',
        endpoint: '/v1/responses',
        status: response.status,
        model: resolved.model,
        inputLength: input.length,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError('Vercel AI Gateway', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('Vercel AI Gateway', response.status, errorText);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const responseId = data.id as string | undefined;

    const content = this.parseOutputText(data);
    const toolCalls = this.parseToolCalls(data);

    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    const usageData = data.usage as Record<string, unknown> | undefined;
    if (usageData) {
      usage = {
        promptTokens: (usageData.input_tokens as number) ?? 0,
        completionTokens: (usageData.output_tokens as number) ?? 0,
        totalTokens: (usageData.total_tokens as number) ?? 0,
      };
    }

    const stopReason: StopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

    return {
      content,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: (data.model as string) ?? resolved.model,
      durationMs: Date.now() - context.startTime,
      responseId,
    };
  }

  // ============================================
  // OpenResponses API (streaming)
  // ============================================

  private async *streamGateway(
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

    const input = this.normalizeInput(params.messages, systemPrompt);
    if (input.length === 0) {
      logger.error('Vercel Gateway stream request has no input items', {
        method: 'stream',
        endpoint: '/v1/responses',
        totalMessages: params.messages.length,
        messageRoles: params.messages.map(m => m.role),
      });
      throw new Error(
        `OpenResponses API requires input: got ${params.messages.length} messages ` +
        `but normalized to 0 input items. Roles: [${params.messages.map(m => m.role).join(', ')}]`
      );
    }

    const body: Record<string, unknown> = {
      model: resolved.model,
      input,
      stream: true,
      max_output_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
    };

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
    }

    if (params.toolChoice) {
      body.tool_choice = params.toolChoice;
    } else if (params.tools && params.tools.length > 0) {
      body.tool_choice = 'auto';
    }

    const reasoningEffort = resolved.reasoning?.effort;
    if (reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== 'standard') {
      body.reasoning = { effort: reasoningEffort };
    }

    logger.debug('Vercel Gateway stream request', {
      method: 'stream',
      endpoint: '/v1/responses',
      model: resolved.model,
      maxOutputTokens: body.max_output_tokens,
      hasReasoning: !!body.reasoning,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      inputLength: input.length,
      messageCount: params.messages.length,
    });

    const response = await fetch(`${resolved.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      logger.error('Vercel Gateway stream request failed', {
        method: 'stream',
        endpoint: '/v1/responses',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError('Vercel AI Gateway', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('Vercel AI Gateway', response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';
    let fullReasoningContent = '';
    let stopReason: StopReason = 'end_turn';
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const toolCalls: ToolCall[] = [];
    let model = resolved.model;
    let responseId: string | undefined;
    let sawTextDelta = false;
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
          if (!data) continue;
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as Record<string, unknown>;

            if (event.type === 'response.created') {
              responseId = event.id as string | undefined;
            }

            if (event.type === 'response.output_text.delta') {
              const delta = event.delta as string;
              if (delta) {
                sawTextDelta = true;
                fullContent += delta;
                params.onChunk?.(delta);
                yield delta;
              }
            }

            if (event.type === 'response.output_text.done') {
              const text = event.text as string;
              if (text && !sawTextDelta) {
                fullContent += text;
                params.onChunk?.(text);
                yield text;
              }
            }

            if (event.type === 'response.reasoning.delta') {
              const delta = event.delta as string;
              if (delta) {
                fullReasoningContent += delta;
                params.onReasoningChunk?.(delta);
              }
            }

            if (event.type === 'response.reasoning.done') {
              const reasoning = event.reasoning as string;
              if (reasoning && fullReasoningContent.length === 0) {
                fullReasoningContent += reasoning;
                params.onReasoningChunk?.(reasoning);
              }
            }

            if (event.type === 'response.completed') {
              const responseObj = event.response as Record<string, unknown> | undefined;
              if (responseObj) {
                const parsedText = this.parseOutputText(responseObj);
                if (parsedText && fullContent.length === 0) {
                  fullContent += parsedText;
                }
                const parsedCalls = this.parseToolCalls(responseObj);
                if (parsedCalls.length > 0) {
                  toolCalls.length = 0;
                  toolCalls.push(...parsedCalls.filter((call) => !!call.name));
                }
                const usageData = responseObj.usage as Record<string, unknown> | undefined;
                if (usageData) {
                  usage = {
                    promptTokens: (usageData.input_tokens as number) ?? 0,
                    completionTokens: (usageData.output_tokens as number) ?? 0,
                    totalTokens: (usageData.total_tokens as number) ?? 0,
                  };
                }
                model = (responseObj.model as string) ?? model;
              }
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
        partialToolCalls: toolCalls.length,
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

    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    }

    return {
      content: fullContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      durationMs: Date.now() - context.startTime,
      responseId,
      reasoningContent: fullReasoningContent || undefined,
    };
  }

  // ============================================
  // Chat Completions API (structured outputs)
  // ============================================

  private async respondChatCompletions(
    context: ProviderContext,
    params: RespondParams
  ): Promise<LLMResponse> {
    const { config, logger } = context;
    const resolved = config;

    const systemMessage = params.messages.find((m) => m.role === 'system');
    const systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: this.formatMessages(params.messages, systemPrompt),
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
    };

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
    }
    if (params.toolChoice) {
      body.tool_choice = params.toolChoice;
    } else if (params.tools && params.tools.length > 0) {
      body.tool_choice = 'auto';
    }

    if (params.responseSchema) {
      const compiledSchema = compileSchemaForOpenAI(
        params.responseSchema.schema,
        params.responseSchema.schemaId
      );
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: params.responseSchema.name,
          schema: compiledSchema,
          strict: params.responseSchema.strict ?? true,
        },
      };
    }

    logger.debug('Vercel Gateway chat completions request', {
      method: 'respond',
      endpoint: '/chat/completions',
      model: resolved.model,
      maxTokens: body.max_tokens,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      hasResponseFormat: !!body.response_format,
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.apiKey) {
      headers['Authorization'] = `Bearer ${resolved.apiKey}`;
    }

    const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Vercel Gateway chat completions request failed', {
        method: 'respond',
        endpoint: '/chat/completions',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError('Vercel AI Gateway', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('Vercel AI Gateway', response.status, errorText);
    }

    const data = (await response.json()) as {
      id: string;
      object: string;
      created: number;
      model: string;
      choices: Array<{
        index: number;
        message: {
          role: string;
          content: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const choice = data.choices[0];
    const content = this.normalizeContent(choice?.message?.content);
    const reasoningContent = choice?.message?.reasoning_content ?? undefined;

    const toolCalls: ToolCall[] = [];
    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        });
      }
    }

    const stopReasonMap: Record<string, StopReason> = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'end_turn',
    };
    const stopReason: StopReason =
      stopReasonMap[choice?.finish_reason ?? 'stop'] ?? 'end_turn';

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };

    return {
      content,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: data.model ?? resolved.model,
      durationMs: Date.now() - context.startTime,
      reasoningContent,
    };
  }

  private async *streamChatCompletions(
    context: ProviderContext,
    params: StreamParams
  ): AsyncGenerator<string, LLMResponse> {
    const { config, logger } = context;
    const resolved = config;

    const systemMessage = params.messages.find((m) => m.role === 'system');
    const systemPrompt =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: this.formatMessages(params.messages, systemPrompt),
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
      stream: true,
    };

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = this.formatTools(params.tools);
    }
    if (params.toolChoice) {
      body.tool_choice = params.toolChoice;
    } else if (params.tools && params.tools.length > 0) {
      body.tool_choice = 'auto';
    }

    if (params.responseSchema) {
      const compiledSchema = compileSchemaForOpenAI(
        params.responseSchema.schema,
        params.responseSchema.schemaId
      );
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: params.responseSchema.name,
          schema: compiledSchema,
          strict: params.responseSchema.strict ?? true,
        },
      };
    }

    const streamHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.apiKey) {
      streamHeaders['Authorization'] = `Bearer ${resolved.apiKey}`;
    }

    const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: streamHeaders,
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      logger.error('Vercel Gateway chat completions stream request failed', {
        method: 'stream',
        endpoint: '/chat/completions',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError('Vercel AI Gateway', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('Vercel AI Gateway', response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';
    let fullReasoningContent = '';
    let stopReason: StopReason = 'end_turn';
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const toolCalls: ToolCall[] = [];
    const toolCallBuilders: Map<number, { id: string; name: string; arguments: string }> = new Map();
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
              model?: string;
              choices?: Array<{
                index: number;
                delta: {
                  role?: string;
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: string;
                    function?: {
                      name?: string;
                      arguments?: string;
                    };
                  }>;
                };
                finish_reason?: string;
              }>;
              usage?: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
              };
            };

            if (event.model) {
              model = event.model;
            }

            const choice = event.choices?.[0];
            if (choice) {
              if (choice.delta?.reasoning_content) {
                const reasoningChunk = choice.delta.reasoning_content;
                fullReasoningContent += reasoningChunk;
                params.onReasoningChunk?.(reasoningChunk);
              }

              const deltaContent = (choice.delta as { content?: unknown }).content;
              if (deltaContent !== undefined) {
                const normalized = this.normalizeContent(deltaContent);
                if (normalized) {
                  fullContent += normalized;
                  params.onChunk?.(normalized);
                  yield normalized;
                }
              }

              if (choice.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  if (!toolCallBuilders.has(tc.index)) {
                    toolCallBuilders.set(tc.index, {
                      id: tc.id ?? '',
                      name: tc.function?.name ?? '',
                      arguments: '',
                    });
                  }
                  const builder = toolCallBuilders.get(tc.index)!;
                  if (tc.id) builder.id = tc.id;
                  if (tc.function?.name) builder.name = tc.function.name;
                  if (tc.function?.arguments) builder.arguments += tc.function.arguments;
                }
              }

              if (choice.finish_reason) {
                const stopReasonMap: Record<string, StopReason> = {
                  stop: 'end_turn',
                  length: 'max_tokens',
                  tool_calls: 'tool_use',
                  content_filter: 'end_turn',
                };
                stopReason = stopReasonMap[choice.finish_reason] ?? 'end_turn';
              }
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
    } catch (streamError) {
      const partialToolCalls: ToolCall[] = [];
      for (const builder of toolCallBuilders.values()) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(builder.arguments);
        } catch {
          args = {};
        }
        partialToolCalls.push({
          id: builder.id,
          name: builder.name,
          arguments: args,
        });
      }

      const cause = streamError instanceof Error ? streamError : new Error(String(streamError));
      logger.warn('Stream interrupted mid-response', {
        method: 'stream',
        model: resolved.model,
        partialContentLength: fullContent.length,
        partialToolCalls: partialToolCalls.length,
        error: cause.message,
      });

      throw new PartialStreamError(
        'Stream interrupted',
        cause,
        fullContent,
        partialToolCalls
      );
    } finally {
      reader.releaseLock();
    }

    if (toolCallBuilders.size > 0) {
      for (const builder of toolCallBuilders.values()) {
        if (!builder.name) continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(builder.arguments);
        } catch {
          args = {};
        }
        toolCalls.push({
          id: builder.id,
          name: builder.name,
          arguments: args,
        });
      }
    }

    return {
      content: fullContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      durationMs: Date.now() - context.startTime,
      reasoningContent: fullReasoningContent || undefined,
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  private normalizeInput(messages: any[], systemPrompt?: string): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];
    const isValidToolName = (name: unknown): name is string =>
      typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name);

    if (systemPrompt) {
      input.push({
        type: 'message',
        role: 'system',
        content: systemPrompt,
      });
    }

    for (const msg of messages) {
      if (!msg) continue;
      if (msg.role === 'system') continue;
      const item = msg as unknown as Record<string, unknown>;
      const callId = (item.call_id ?? item.id ?? item.callId) as string;

      if (item.type === 'function_call') {
        if (!isValidToolName(item.name)) {
          continue;
        }
        input.push({
          type: 'function_call',
          call_id: callId,
          name: item.name,
          arguments: item.arguments,
        });
        continue;
      }

      if (item.type === 'function_call_output') {
        const outputCallId = (item.call_id ?? item.callId) as string;
        const rawOutput = item.output as string;
        const isError = item.isError as boolean | undefined;
        const output = isError && rawOutput && !rawOutput.startsWith('Error')
          ? `Error: ${rawOutput}`
          : rawOutput;
        input.push({
          type: 'function_call_output',
          call_id: outputCallId,
          output,
        });
        continue;
      }

      if (msg.content === undefined || msg.content === null) {
        continue;
      }

      if (typeof msg.content === 'string') {
        input.push({
          type: 'message',
          role: msg.role,
          content: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        const content = msg.content
          .filter((block: unknown) => block != null)
          .map((block: Record<string, unknown>) => {
            if (block.type === 'text') {
              return { type: 'text', text: block.text };
            }
            if (block.type === 'image') {
              const source = block.source as { mediaType?: string; data?: string } | undefined;
              if (source?.mediaType && source?.data) {
                return {
                  type: 'image_url',
                  image_url: {
                    url: `data:${source.mediaType};base64,${source.data}`,
                  },
                };
              }
            }
            return block;
          });

        input.push({
          type: 'message',
          role: msg.role,
          content,
        });
      }
    }

    return input;
  }

  private normalizeContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!content) return '';
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (typeof block === 'string') {
          parts.push(block);
          continue;
        }
        if (block && typeof block === 'object') {
          const record = block as Record<string, unknown>;
          if (typeof record.text === 'string') {
            parts.push(record.text);
            continue;
          }
          if (typeof record.content === 'string') {
            parts.push(record.content);
            continue;
          }
          try {
            parts.push(JSON.stringify(block));
          } catch {
            // Ignore non-serializable blocks.
          }
        }
      }
      return parts.join('\n');
    }
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }

  private parseOutputText(response: Record<string, unknown>): string {
    const direct = response.output_text as string | undefined;
    if (direct) return direct;

    const output = response.output as Array<Record<string, unknown>> | undefined;
    if (!output) return '';

    let content = '';
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const itemType = item.type as string | undefined;

      if (itemType === 'message') {
        const contentBlocks = item.content as Array<Record<string, unknown>> | string | undefined;
        if (typeof contentBlocks === 'string') {
          content += contentBlocks;
          continue;
        }
        if (!Array.isArray(contentBlocks)) continue;

        for (const block of contentBlocks) {
          const blockType = block.type as string | undefined;
          if (blockType === 'output_text' || blockType === 'text') {
            content += (block.text as string) ?? '';
          } else if (blockType === 'output_json' || blockType === 'json') {
            const jsonPayload = (block.json as Record<string, unknown> | undefined)
              ?? (block.output as Record<string, unknown> | undefined);
            if (jsonPayload) {
              content += JSON.stringify(jsonPayload);
            }
          } else if (blockType === 'refusal') {
            content += (block.refusal as string) ?? '';
          }
        }
        continue;
      }

      if (itemType === 'output_text' || itemType === 'text') {
        content += (item.text as string) ?? '';
        continue;
      }

      if (itemType === 'output_json' || itemType === 'json') {
        const jsonPayload = (item.json as Record<string, unknown> | undefined)
          ?? (item.output as Record<string, unknown> | undefined);
        if (jsonPayload) {
          content += JSON.stringify(jsonPayload);
        }
        continue;
      }

      if (itemType === 'refusal') {
        content += (item.refusal as string) ?? '';
      }
    }

    return content;
  }

  private parseToolCalls(response: Record<string, unknown>): ToolCall[] {
    const output = response.output as Array<Record<string, unknown>> | undefined;
    if (!output || !Array.isArray(output)) return [];

    const toolCalls: ToolCall[] = [];
    const isValidToolName = (name: unknown): name is string =>
      typeof name === 'string' && name.length > 0 && /^[A-Za-z0-9_-]+$/.test(name);

    const isValidCallId = (id: unknown): id is string =>
      typeof id === 'string' && id.length > 0;

    for (const item of output) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'function_call') {
        const callId = (item.call_id ?? item.id) as string;
        const name = item.name as string;
        if (!isValidToolName(name) || !isValidCallId(callId)) continue;

        let args: Record<string, unknown> = {};
        const argsJson = item.arguments as string;
        if (typeof argsJson === 'string' && argsJson.length > 0) {
          try {
            const parsed = JSON.parse(argsJson);
            if (parsed && typeof parsed === 'object') {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            // Invalid JSON, keep empty args
          }
        }

        toolCalls.push({ id: callId, name, arguments: args });
        continue;
      }

      if (item.type !== 'message') continue;
      const contentBlocks = item.content as Array<Record<string, unknown>> | undefined;
      if (!contentBlocks || !Array.isArray(contentBlocks)) continue;

      for (const block of contentBlocks) {
        if (block.type !== 'tool_call') continue;
        const callId = block.id as string;
        const name = block.name as string;
        if (!isValidToolName(name) || !isValidCallId(callId)) continue;

        let args: Record<string, unknown> = {};
        const argsJson = block.arguments as string;
        if (typeof argsJson === 'string' && argsJson.length > 0) {
          try {
            const parsed = JSON.parse(argsJson);
            if (parsed && typeof parsed === 'object') {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            // Invalid JSON, keep empty args
          }
        }

        toolCalls.push({ id: callId, name, arguments: args });
      }
    }

    return toolCalls;
  }
}
