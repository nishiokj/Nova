/**
 * OpenAI provider implementation.
 * Handles OpenAI Responses API (new) - streaming and non-streaming.
 */

import type {
  ToolDefinition,
  ToolCall,
  TokenUsage,
  StopReason,
  LLMResponse,
  RespondParams,
  StreamParams,
} from 'types';
import type { ProviderContext, ResolvedRequestConfig, LLMProviderAdapter } from './types.js';
import { PartialStreamError } from './types.js';
import {
  createRateLimitError,
} from '../rate-limits.js';
import { parseApiErrorResponse, formatApiError } from '../response_schemas.js';

function parseApiError(provider: string, status: number, responseText: string): Error {
  const parsed = parseApiErrorResponse(provider, status, responseText);
  return formatApiError(provider, status, parsed);
}

// ============================================
// OPENAI PROVIDER
// ============================================

export class OpenAIProvider implements LLMProviderAdapter {
  readonly name = 'openai' as const;

  respond(context: ProviderContext, params: RespondParams): Promise<LLMResponse> {
    return this.respondOpenAI(context, params);
  }

  async *stream(context: ProviderContext, params: StreamParams): AsyncGenerator<string, LLMResponse> {
    return yield* this.streamOpenAI(context, params);
  }

  formatTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.parameters.properties,
        required: t.parameters.required,
        additionalProperties: t.parameters.additionalProperties,
      },
      strict: t.strict ?? false,
    }));
  }

  // ============================================
  // OPENAI RESPONSES API (non-streaming)
  // ============================================

  private async respondOpenAI(
    context: ProviderContext,
    params: RespondParams
  ): Promise<LLMResponse> {
    const { config, logger } = context;
    const resolved = config;

    // Extract system message as instructions
    const systemMessage = params.messages.find((m) => m.role === 'system');
    const instructions =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: resolved.model,
      background: true,
    };

    if (instructions) {
      body.instructions = instructions;
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
      body.text = {
        format: {
          type: 'json_schema',
          name: params.responseSchema.name,
          schema: params.responseSchema.schema,
          strict: params.responseSchema.strict ?? true,
        },
      };
    }

    if (params.promptCacheKey) {
      body.prompt_cache_key = params.promptCacheKey;
    }

    if (params.promptCacheRetention && supportsPromptCacheRetention(resolved.model)) {
      body.prompt_cache_retention = params.promptCacheRetention;
    }

    if (params.previousResponseId) {
      body.previous_response_id = params.previousResponseId;
    }

    if (supportsSamplingParams(resolved.model)) {
      if (params.temperature ?? resolved.temperature) {
        body.temperature = params.temperature ?? resolved.temperature;
      }
    }

    const reasoningEffort = resolved.reasoning?.effort;
    if (reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== 'standard') {
      body.reasoning = { effort: reasoningEffort };
    }

    body.max_output_tokens = params.maxTokens ?? resolved.maxTokens ?? 4096;

    if (params.maxToolCalls !== undefined) {
      body.max_tool_calls = params.maxToolCalls;
    }
    if (params.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = params.parallelToolCalls;
    }

    body.input = this.normalizeInput(params.messages);
    const inputArray = body.input as Array<Record<string, unknown>>;
    if (!inputArray || inputArray.length === 0) {
      logger.error('OpenAI request has no input items', {
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

    logger.debug('OpenAI API request', {
      method: 'respond',
      endpoint: '/v1/responses',
      model: resolved.model,
      maxOutputTokens: body.max_output_tokens,
      hasInstructions: !!body.instructions,
      hasReasoning: !!body.reasoning,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      inputLength: inputArray.length,
      messageCount: params.messages.length,
    });

    const response = await fetch(`${resolved.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('OpenAI API request failed', {
        method: 'respond',
        endpoint: '/v1/responses',
        status: response.status,
        model: resolved.model,
        inputLength: Array.isArray(body.input) ? body.input.length : 0,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError('OpenAI', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('OpenAI', response.status, errorText);
    }

    let data = (await response.json()) as Record<string, unknown>;

    const status = data.status as string;
    const responseId = data.id as string | undefined;

    logger.debug('OpenAI initial response', {
      status,
      responseId,
      model: resolved.model,
    });

    logger.debug('OpenAI full response', {
      data: JSON.stringify(data, null, 2),
    });

    if (status === 'queued' || status === 'in_progress') {
      if (!responseId) {
        logger.error('OpenAI background response missing id', {
          method: 'respond',
          endpoint: '/v1/responses',
          status,
        });
        throw new Error('OpenAI Responses API: background response missing id');
      }
      data = await this.pollForCompletion(resolved, responseId, logger);
    } else if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
      const error = data.error as Record<string, unknown> | undefined;
      const errorMessage = error?.message ?? `Response ${status}`;
      const errorCode = error?.code ?? 'unknown';
      logger.error(`OpenAI immediate ${status}`, {
        method: 'respond',
        endpoint: '/v1/responses',
        errorCode,
        errorMessage,
        responseId: data.id,
      });
      throw new Error(`OpenAI Responses API ${status} [${errorCode}]: ${errorMessage}`);
    }

    const outputText = this.parseOutputText(data);
    const toolCalls = this.parseToolCalls(data);

    const finalStatus = (data.status as string) ?? 'completed';
    const stopReasonMap: Record<string, StopReason> = {
      completed: 'end_turn',
      failed: 'end_turn',
      cancelled: 'end_turn',
    };
    const stopReason: StopReason = toolCalls.length > 0
      ? 'tool_use'
      : (stopReasonMap[finalStatus] ?? 'end_turn');

    const usageData = data.usage as Record<string, unknown> | undefined;
    const promptDetails = usageData?.prompt_tokens_details as Record<string, number> | undefined;
    const usage: TokenUsage = usageData
      ? {
          promptTokens: (usageData.input_tokens as number) ?? 0,
          completionTokens: (usageData.output_tokens as number) ?? 0,
          totalTokens: (usageData.total_tokens as number) ?? 0,
          cachedTokens: promptDetails?.cached_tokens,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    return {
      content: outputText,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: (data.model as string) ?? resolved.model,
      durationMs: Date.now() - context.startTime,
      responseId: data.id as string | undefined,
    };
  }

  private async pollForCompletion(
    resolved: ResolvedRequestConfig,
    responseId: string,
    logger: any,
    maxWaitMs: number = 300000,
    pollIntervalMs: number = 2000
  ): Promise<Record<string, unknown>> {
    const startTime = Date.now();
    let pollCount = 0;

    logger.debug('Starting background poll', {
      responseId,
      model: resolved.model,
      maxOutputTokens: resolved.maxTokens,
      maxWaitMs,
      pollIntervalMs,
    });

    while (Date.now() - startTime < maxWaitMs) {
      pollCount++;
      const response = await fetch(`${resolved.baseUrl}/v1/responses/${responseId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${resolved.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('OpenAI poll request failed', {
          method: 'pollForCompletion',
          endpoint: `/v1/responses/${responseId}`,
          status: response.status,
          responseId,
          errorPreview: errorText.slice(0, 200),
        });
        if (response.status === 429) {
          throw createRateLimitError('OpenAI', resolved.model, response.status, response.headers, errorText);
        }
        throw parseApiError('OpenAI', response.status, errorText);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const status = data.status as string;
      const incompleteDetails = data.incomplete_details as Record<string, unknown> | undefined;

      logger.debug('Poll status', {
        responseId,
        pollCount,
        status,
        elapsedMs: Date.now() - startTime,
        incompleteDetails,
      });

      if (status === 'completed') {
        logger.debug('Poll completed', { responseId, pollCount });
        logger.debug('OpenAI poll result full response', {
          data: JSON.stringify(data, null, 2),
        });
        return data;
      }

      if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
        const error = data.error as Record<string, unknown> | undefined;
        const errorMessage = error?.message ?? `Response ${status}`;
        const errorCode = error?.code ?? 'unknown';
        logger.error(`OpenAI response ${status}`, {
          method: 'pollForCompletion',
          endpoint: `/v1/responses/${responseId}`,
          responseId,
          model: resolved.model,
          maxOutputTokens: resolved.maxTokens,
          incompleteDetails,
          errorCode,
          errorMessage,
        });
        throw new Error(`OpenAI Responses API ${status} [${errorCode}]: ${errorMessage} (model=${resolved.model}, maxOutputTokens=${resolved.maxTokens})`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    logger.error('OpenAI response timeout', {
      method: 'pollForCompletion',
      endpoint: `/v1/responses/${responseId}`,
      responseId,
      maxWaitMs,
    });
    throw new Error(`OpenAI Responses API timeout: response ${responseId} did not complete within ${maxWaitMs}ms`);
  }

  // ============================================
  // OPENAI STREAMING
  // ============================================

  private async *streamOpenAI(
    context: ProviderContext,
    params: StreamParams
  ): AsyncGenerator<string, LLMResponse> {
    const { config, logger } = context;
    const resolved = config;

    const systemMessage = params.messages.find((m) => m.role === 'system');
    const instructions =
      params.system ??
      (systemMessage && typeof systemMessage.content === 'string'
        ? systemMessage.content
        : undefined);

    const body: Record<string, unknown> = {
      model: resolved.model,
      stream: true,
      background: true,
    };

    if (instructions) {
      body.instructions = instructions;
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
      body.text = {
        format: {
          type: 'json_schema',
          name: params.responseSchema.name,
          schema: params.responseSchema.schema,
          strict: params.responseSchema.strict ?? true,
        },
      };
    }

    if (params.promptCacheKey) {
      body.prompt_cache_key = params.promptCacheKey;
    }
    if (params.promptCacheRetention && supportsPromptCacheRetention(resolved.model)) {
      body.prompt_cache_retention = params.promptCacheRetention;
    }

    if (params.previousResponseId) {
      body.previous_response_id = params.previousResponseId;
    }

    if (supportsSamplingParams(resolved.model)) {
      if (params.temperature ?? resolved.temperature) {
        body.temperature = params.temperature ?? resolved.temperature;
      }
    }

    const reasoningEffort = resolved.reasoning?.effort;
    if (reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== 'standard') {
      body.reasoning = { effort: reasoningEffort };
    }

    body.max_output_tokens = params.maxTokens ?? resolved.maxTokens ?? 4096;

    if (params.maxToolCalls !== undefined) {
      body.max_tool_calls = params.maxToolCalls;
    }
    if (params.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = params.parallelToolCalls;
    }

    body.input = this.normalizeInput(params.messages);

    const response = await fetch(`${resolved.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      logger.error('OpenAI API stream request failed', {
        method: 'stream',
        endpoint: '/v1/responses',
        status: response.status,
        model: resolved.model,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError('OpenAI', resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError('OpenAI', response.status, errorText);
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
                const promptDetails = usageData?.prompt_tokens_details as Record<string, number> | undefined;
                if (usageData) {
                  usage = {
                    promptTokens: (usageData.input_tokens as number) ?? 0,
                    completionTokens: (usageData.output_tokens as number) ?? 0,
                    totalTokens: (usageData.total_tokens as number) ?? 0,
                    cachedTokens: promptDetails?.cached_tokens,
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
  // HELPERS
  // ============================================

  private normalizeInput(messages: any[]): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];
    const isValidToolName = (name: unknown): name is string =>
      typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name);

    for (const msg of messages) {
      if (!msg) continue;
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
        input.push({
          type: 'function_call_output',
          call_id: outputCallId,
          output: item.output,
        });
        continue;
      }

      if (msg.content === undefined || msg.content === null) {
        continue;
      }

      if (typeof msg.content === 'string') {
        input.push({
          role: msg.role,
          content: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        input.push({
          role: msg.role,
          content: msg.content.filter((block: unknown) => block != null).map((block: Record<string, unknown>) => {
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
        });
      }
    }

    return input;
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
    if (!output) return [];

    const toolCalls: ToolCall[] = [];
    const isValidToolName = (name: unknown): name is string =>
      typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name);

    for (const item of output) {
      if (item.type === 'function_call') {
        const callId = (item.call_id ?? item.id) as string;
        const name = item.name as string;
        if (!isValidToolName(name)) continue;
        const argsJson = item.arguments as string;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsJson);
        } catch {
          args = {};
        }
        toolCalls.push({ id: callId, name, arguments: args });
        continue;
      }

      if (item.type !== 'message') continue;
      const contentBlocks = item.content as Array<Record<string, unknown>> | undefined;
      if (!contentBlocks) continue;

      for (const block of contentBlocks) {
        if (block.type !== 'tool_call') continue;
        const callId = block.id as string;
        const name = block.name as string;
        if (!isValidToolName(name)) continue;
        const argsJson = block.arguments as string;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsJson);
        } catch {
          args = {};
        }
        toolCalls.push({ id: callId, name, arguments: args });
      }
    }

    return toolCalls;
  }
}

// ============================================
// MODEL HELPERS
// ============================================

function isReasoningModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith('gpt-5') || lower.startsWith('o1') || lower.startsWith('o3');
}

function supportsSamplingParams(model: string): boolean {
  const lower = model.toLowerCase();
  return !lower.startsWith('gpt-5') && !lower.startsWith('o1') && !lower.startsWith('o3');
}

function supportsPromptCacheRetention(model: string): boolean {
  const lower = model.toLowerCase();
  return !lower.includes('nano');
}
