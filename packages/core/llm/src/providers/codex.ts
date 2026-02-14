/**
 * Codex Provider - Uses ChatGPT's backend API with OAuth tokens.
 *
 * Key differences from standard OpenAI API:
 * - Uses OAuth access tokens (from ChatGPT subscription), not API keys
 * - Endpoint: https://chatgpt.com/backend-api/codex/responses
 * - Requires: stream=true, store=false, instructions field
 * - System prompt goes in 'instructions' field, not in input messages
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
import type { ProviderContext, LLMProviderAdapter } from './types.js';
import { PartialStreamError } from './types.js';
import { compileSchemaForCodex } from './schema_compiler.js';

const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS = 600_000;

function parsePositiveTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

const CODEX_REQUEST_TIMEOUT_MS = parsePositiveTimeoutMs(
  process.env.CODEX_REQUEST_TIMEOUT_MS,
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS
);
const CODEX_STREAM_IDLE_TIMEOUT_MS = parsePositiveTimeoutMs(
  process.env.CODEX_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS
);

// ============================================
// CODEX PROVIDER
// ============================================

export class CodexProvider implements LLMProviderAdapter {
  readonly name = 'codex' as const;

  /**
   * Non-streaming respond - internally uses streaming and collects result.
   * The ChatGPT backend requires stream=true for OAuth requests.
   */
  async respond(context: ProviderContext, params: RespondParams): Promise<LLMResponse> {
    const generator = this.stream(context, {
      ...params,
    });

    // Consume the generator to get the final response
    let result: IteratorResult<string, LLMResponse>;
    do {
      result = await generator.next();
    } while (!result.done);

    return result.value;
  }

  async *stream(context: ProviderContext, params: StreamParams): AsyncGenerator<string, LLMResponse> {
    const { config, logger } = context;
    const { messages, tools, system } = params;

    // Filter out system messages - they go in 'instructions' field
    const nonSystemMessages = messages.filter((m) => (m as { role?: string }).role !== 'system');

    // Build request body per ChatGPT backend requirements
    // NOTE: ChatGPT backend does NOT support max_output_tokens or temperature params
    const body: Record<string, unknown> = {
      model: config.model,
      input: this.formatInput(nonSystemMessages as unknown as Array<Record<string, unknown>>),
      // ChatGPT backend requires these exact settings for OAuth
      stream: true,
      store: false,
      // System prompt goes in instructions field (required by backend)
      instructions: system ?? 'You are a helpful coding assistant.',
      // Reasoning effort: none, minimal, low, medium, high, xhigh
      reasoning: config.reasoning ?? { effort: 'medium' },
    };

    if (params.responseSchema) {
      const schemaValue = (params.responseSchema as { schema?: unknown }).schema;
      const hasValidSchema = !!schemaValue && typeof schemaValue === 'object' && !Array.isArray(schemaValue);
      if (hasValidSchema) {
        const schemaId = typeof params.responseSchema.schemaId === 'string'
          ? params.responseSchema.schemaId
          : undefined;
        const compiledSchema = compileSchemaForCodex(
          schemaValue as Record<string, unknown>,
          schemaId
        );
        body.text = {
          format: {
            type: 'json_schema',
            name: params.responseSchema.name,
            schema: compiledSchema,
            strict: params.responseSchema.strict ?? true,
          },
        };
      } else {
        logger.warn('Codex response schema missing or invalid; skipping structured output', {
          schemaName: params.responseSchema.name,
        });
      }
    }

    if (tools?.length) body.tools = this.formatTools(tools);

    // Endpoint is /responses relative to baseUrl (https://chatgpt.com/backend-api/codex)
    const url = `${config.baseUrl}/responses`;

    logger.debug('Codex stream request', { url, model: config.model });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    };
    if (config.chatgptAccountId) {
      headers['Chatgpt-Account-Id'] = config.chatgptAccountId;
    }

    const abortController = new AbortController();
    let requestTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let streamIdleTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const clearRequestTimeout = () => {
      if (!requestTimeoutHandle) return;
      clearTimeout(requestTimeoutHandle);
      requestTimeoutHandle = null;
    };

    const clearStreamIdleTimeout = () => {
      if (!streamIdleTimeoutHandle) return;
      clearTimeout(streamIdleTimeoutHandle);
      streamIdleTimeoutHandle = null;
    };

    const abortWithReason = (reason: string) => {
      if (abortController.signal.aborted) return;
      abortController.abort(new Error(reason));
    };

    const scheduleRequestTimeout = () => {
      clearRequestTimeout();
      requestTimeoutHandle = setTimeout(() => {
        abortWithReason(`Codex request timed out after ${CODEX_REQUEST_TIMEOUT_MS}ms`);
      }, CODEX_REQUEST_TIMEOUT_MS);
    };

    const resetStreamIdleTimeout = () => {
      clearStreamIdleTimeout();
      streamIdleTimeoutHandle = setTimeout(() => {
        abortWithReason(`Codex stream idle timeout after ${CODEX_STREAM_IDLE_TIMEOUT_MS}ms`);
      }, CODEX_STREAM_IDLE_TIMEOUT_MS);
    };

    let response: Response;
    try {
      scheduleRequestTimeout();
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } finally {
      clearRequestTimeout();
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Codex API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    const toolCallsById = new Map<string, ToolCall>();
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let model = config.model;
    let responseId: string | undefined;
    const textDeltaItemIds = new Set<string>();
    const textPartEventIds = new Set<string>();
    const completedTextItemIds = new Set<string>();
    let parseErrorCount = 0;
    let parseErrorSample: string | undefined;
    // Track function calls being built up (indexed by both item_id and call_id)
    const pendingFunctionCalls = new Map<string, {
      itemId?: string;
      callId?: string;
      name?: string;
      arguments: string;
    }>();

    const getPendingFunctionCall = (itemId?: string, callId?: string) => {
      if (itemId && pendingFunctionCalls.has(itemId)) return pendingFunctionCalls.get(itemId);
      if (callId && pendingFunctionCalls.has(callId)) return pendingFunctionCalls.get(callId);
      return undefined;
    };

    const trackPendingFunctionCall = (pending: {
      itemId?: string;
      callId?: string;
      name?: string;
      arguments: string;
    }) => {
      if (pending.itemId) pendingFunctionCalls.set(pending.itemId, pending);
      if (pending.callId) pendingFunctionCalls.set(pending.callId, pending);
    };

    const dropPendingFunctionCall = (pending: {
      itemId?: string;
      callId?: string;
    } | undefined) => {
      if (!pending) return;
      if (pending.itemId) pendingFunctionCalls.delete(pending.itemId);
      if (pending.callId) pendingFunctionCalls.delete(pending.callId);
    };

    const addToolCall = (callId: string | undefined, name: string | undefined, args: unknown) => {
      if (!callId || !name) return;
      toolCallsById.set(callId, {
        id: callId,
        name,
        arguments: this.parseArguments(args),
      });
    };

    const appendText = (text: string | undefined, itemId?: string): string | null => {
      if (!text) return null;
      if (itemId && textDeltaItemIds.has(itemId)) return null;
      if (itemId && completedTextItemIds.has(itemId)) return null;

      fullContent += text;
      params.onChunk?.(text);
      if (itemId) completedTextItemIds.add(itemId);
      return text;
    };

    const parseSseFrames = (chunk: string): string[] => {
      buffer += chunk.replace(/\r\n/g, '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      return frames;
    };

    const extractSseData = (frame: string): string | null => {
      if (!frame) return null;
      const lines = frame.split('\n');
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) return null;
      const data = dataLines.join('\n').trim();
      if (!data || data === '[DONE]') return null;
      return data;
    };

    try {
      resetStreamIdleTimeout();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetStreamIdleTimeout();

        const chunk = decoder.decode(value, { stream: true });
        const frames = parseSseFrames(chunk);

        for (const frame of frames) {
          const data = extractSseData(frame);
          if (!data) continue;
          try {
            const event = JSON.parse(data) as StreamEvent;

            // Extract response ID from created event
            if (event.type === 'response.created') {
              responseId = event.response?.id ?? event.id ?? responseId;
            }

            // Handle text output deltas
            if (event.type === 'response.output_text.delta') {
              const text = event.delta;
              if (text) {
                if (event.item_id) {
                  textDeltaItemIds.add(event.item_id);
                }
                fullContent += text;
                params.onChunk?.(text);
                yield text;
              }
            }

            if (event.type === 'response.output_text.done') {
              const text = appendText(event.text, event.item_id);
              if (text) {
                yield text;
              }
            }

            // Track function call creation
            if (
              event.type === 'response.output_item.added'
              && event.item
              && this.isFunctionCallItemType(event.item.type)
            ) {
              const itemId = event.item.id;
              const callId = event.item.call_id ?? itemId;
              const pending = getPendingFunctionCall(itemId, callId) ?? {
                itemId,
                callId,
                name: event.item.name,
                arguments: '',
              };
              pending.itemId = pending.itemId ?? itemId;
              pending.callId = pending.callId ?? callId;
              if (event.item.name) {
                pending.name = event.item.name;
              }
              if (typeof event.item.arguments === 'string' && event.item.arguments.length > 0) {
                pending.arguments = event.item.arguments;
              }
              trackPendingFunctionCall(pending);
            }

            // Accumulate function call arguments
            if (event.type === 'response.function_call_arguments.delta') {
              const pending = getPendingFunctionCall(event.item_id, event.call_id);
              if (pending) {
                pending.arguments += event.delta ?? '';
                trackPendingFunctionCall(pending);
              }
            }

            // Finalize function calls
            if (event.type === 'response.function_call_arguments.done') {
              const pending = getPendingFunctionCall(event.item_id, event.call_id);
              const callId = pending?.callId ?? event.call_id ?? event.item_id;
              const name = event.name ?? pending?.name;
              addToolCall(callId, name, event.arguments ?? pending?.arguments);
              if (pending) {
                dropPendingFunctionCall(pending);
              }
            }

            // Some Codex streams emit text via content-part events instead of output_text.*
            if (event.type === 'response.content_part.added' || event.type === 'response.content_part.done') {
              const partKey = `${event.type}:${event.item_id ?? ''}:${event.output_index ?? ''}:${event.content_index ?? ''}`;
              if (!textPartEventIds.has(partKey)) {
                textPartEventIds.add(partKey);
                const text = appendText(this.parseContentPartText(event.part), event.item_id);
                if (text && event.type === 'response.content_part.added') {
                  yield text;
                }
                if (text && event.type === 'response.content_part.done') {
                  yield text;
                }
              }
            }

            if (event.type === 'response.refusal.delta') {
              const text = event.delta;
              if (text) {
                fullContent += text;
                params.onChunk?.(text);
                yield text;
              }
            }

            if (event.type === 'response.refusal.done') {
              const text = appendText(event.refusal, event.item_id);
              if (text) {
                yield text;
              }
            }

            // Handle completed output items (Codex frequently emits text/tool calls here)
            if (event.type === 'response.output_item.done' && event.item) {
              const item = event.item;
              if (this.isFunctionCallItemType(item.type)) {
                const pending = getPendingFunctionCall(item.id, item.call_id);
                const callId = item.call_id ?? item.id ?? pending?.callId;
                const name = item.name ?? pending?.name;
                const args = item.arguments ?? pending?.arguments;
                addToolCall(callId, name, args);
                if (pending) {
                  dropPendingFunctionCall(pending);
                }
              }

              const text = appendText(this.parseOutputItemText(item), item.id);
              if (text) {
                yield text;
              }
            }

            // Extract usage from completed event
            if (event.type === 'response.completed' && event.response) {
              const responseObj = event.response;
              const parsedText = this.parseOutputText(responseObj);
              if (parsedText && fullContent.length === 0) {
                fullContent = parsedText;
              }

              const parsedCalls = this.parseToolCalls(responseObj);
              for (const call of parsedCalls) {
                if (call.name) {
                  toolCallsById.set(call.id, call);
                }
              }

              const usageData = responseObj.usage as Record<string, unknown> | undefined;
              if (usageData) {
                usage = {
                  promptTokens: (usageData.input_tokens as number) ?? 0,
                  completionTokens: (usageData.output_tokens as number) ?? 0,
                  totalTokens:
                    (usageData.total_tokens as number)
                    ?? (((usageData.input_tokens as number) ?? 0) + ((usageData.output_tokens as number) ?? 0)),
                };
              }
              model = (responseObj.model as string) ?? model;
            }
          } catch {
            parseErrorCount++;
            if (!parseErrorSample) {
              parseErrorSample = data.slice(0, 400);
            }
          }
        }
      }

      // Flush decoder remainder and process any final frame.
      const trailing = decoder.decode();
      if (trailing) {
        const frames = parseSseFrames(trailing);
        for (const frame of frames) {
          const data = extractSseData(frame);
          if (!data) continue;
          try {
            const event = JSON.parse(data) as StreamEvent;
            if (event.type === 'response.completed' && event.response) {
              const responseObj = event.response;
              const parsedText = this.parseOutputText(responseObj);
              if (parsedText && fullContent.length === 0) {
                fullContent = parsedText;
              }
              const parsedCalls = this.parseToolCalls(responseObj);
              for (const call of parsedCalls) {
                if (call.name) {
                  toolCallsById.set(call.id, call);
                }
              }
            }
          } catch {
            parseErrorCount++;
            if (!parseErrorSample) {
              parseErrorSample = data.slice(0, 400);
            }
          }
        }
      }

      // Process any final buffer content if the stream ends without trailing blank line.
      const tailData = extractSseData(buffer);
      if (tailData) {
        try {
          const event = JSON.parse(tailData) as StreamEvent;
          if (event.type === 'response.completed' && event.response) {
            const parsedText = this.parseOutputText(event.response);
            if (parsedText && fullContent.length === 0) {
              fullContent = parsedText;
            }
            const parsedCalls = this.parseToolCalls(event.response);
            for (const call of parsedCalls) {
              if (call.name) {
                toolCallsById.set(call.id, call);
              }
            }
          }
        } catch {
          parseErrorCount++;
          if (!parseErrorSample) {
            parseErrorSample = tailData.slice(0, 400);
          }
        }
      }
    } catch (streamError) {
      const rawCause = streamError instanceof Error ? streamError : new Error(String(streamError));
      const abortReason = abortController.signal.reason;
      const abortReasonMessage = abortReason instanceof Error
        ? abortReason.message
        : (typeof abortReason === 'string' ? abortReason : undefined);
      const cause = rawCause.name === 'AbortError'
        ? new Error(abortReasonMessage ?? rawCause.message)
        : rawCause;
      logger.warn('Codex stream interrupted', {
        model: config.model,
        partialContentLength: fullContent.length,
        partialToolCalls: toolCallsById.size,
        error: cause.message,
      });
      throw new PartialStreamError('Stream interrupted', cause, fullContent, Array.from(toolCallsById.values()));
    } finally {
      clearRequestTimeout();
      clearStreamIdleTimeout();
      reader.releaseLock();
    }

    if (parseErrorCount > 0) {
      logger.warn('Codex stream had unparsed events', {
        model: config.model,
        parseErrorCount,
        parseErrorSample,
      });
    }

    const toolCalls = Array.from(toolCallsById.values());
    const stopReason: StopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

    return {
      content: fullContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      stopReason,
      model,
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

  private formatInput(messages: Array<Record<string, unknown>>): ResponsesInput[] {
    const input: ResponsesInput[] = [];

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const item = msg as Record<string, unknown>;
      const role = item.role as string | undefined;
      const type = item.type as string | undefined;

      if (type === 'function_call') {
        const callId = this.pickFirstString(item.call_id, item.callId, item.id);
        const name = typeof item.name === 'string' ? item.name : undefined;
        if (!callId || !name) continue;
        input.push({
          type: 'function_call',
          call_id: callId,
          name,
          arguments: item.arguments as string | Record<string, unknown> | undefined,
        });
        continue;
      }

      if (type === 'function_call_output') {
        const callId = this.pickFirstString(item.call_id, item.callId, item.id, item.toolCallId);
        if (!callId) continue;
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: this.stringifyOutput(item.output ?? item.content),
        });
        continue;
      }

      if (role === 'user' || role === 'assistant') {
        input.push({
          type: 'message',
          role,
          content: item.content,
        });
      }
    }

    return input;
  }

  private pickFirstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private stringifyOutput(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private parseArguments(args: unknown): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
      return {};
    }
    if (typeof args === 'object' && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
    return {};
  }

  private parseOutputItemText(item: Record<string, unknown>): string {
    return this.parseOutputText({ output: [item] });
  }

  private isFunctionCallItemType(value: unknown): boolean {
    return value === 'function_call' || value === 'tool_call' || value === 'function_tool_call';
  }

  private parseContentPartText(part: unknown): string {
    if (!part || typeof part !== 'object') return '';
    const block = part as Record<string, unknown>;
    const blockType = typeof block.type === 'string' ? block.type : undefined;

    if (blockType === 'output_json' || blockType === 'json') {
      const jsonPayload = (block.json as Record<string, unknown> | undefined)
        ?? (block.output as Record<string, unknown> | undefined)
        ?? (block.parsed as Record<string, unknown> | undefined)
        ?? (block.value as Record<string, unknown> | undefined);
      if (jsonPayload) {
        return JSON.stringify(jsonPayload);
      }
    }

    if (blockType === 'refusal') {
      return this.pickFirstString(block.refusal, block.text, block.value) ?? '';
    }

    return this.pickFirstString(block.text, block.value, block.content) ?? '';
  }

  private normalizeOutputItems(output: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(output)) {
      return output.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
    }
    if (output && typeof output === 'object') {
      return [output as Record<string, unknown>];
    }
    return [];
  }

  private parseOutputText(response: Record<string, unknown>): string {
    const direct = response.output_text as string | undefined;
    if (direct) return direct;

    const output = this.normalizeOutputItems(response.output);
    if (output.length === 0) {
      return this.pickFirstString(
        response.text,
        response.content,
        response.message,
      ) ?? '';
    }

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
        if (contentBlocks && typeof contentBlocks === 'object' && !Array.isArray(contentBlocks)) {
          content += this.parseContentPartText(contentBlocks);
          continue;
        }
        if (!Array.isArray(contentBlocks)) continue;

        for (const block of contentBlocks) {
          content += this.parseContentPartText(block);
        }
        continue;
      }

      if (itemType === 'output_text' || itemType === 'text' || itemType === 'input_text') {
        content += this.pickFirstString(item.text, item.value, item.content) ?? '';
        continue;
      }

      if (itemType === 'output_json' || itemType === 'json') {
        const jsonPayload = (item.json as Record<string, unknown> | undefined)
          ?? (item.output as Record<string, unknown> | undefined)
          ?? (item.parsed as Record<string, unknown> | undefined)
          ?? (item.value as Record<string, unknown> | undefined);
        if (jsonPayload) {
          content += JSON.stringify(jsonPayload);
        }
        continue;
      }

      if (itemType === 'refusal') {
        content += this.pickFirstString(item.refusal, item.text) ?? '';
        continue;
      }

      if (!this.isFunctionCallItemType(itemType)) {
        content += this.pickFirstString(item.text, item.value, item.content) ?? '';
      }
    }

    return content;
  }

  private parseToolCalls(response: Record<string, unknown>): ToolCall[] {
    const output = this.normalizeOutputItems(response.output);
    if (output.length === 0) return [];

    const toolCalls: ToolCall[] = [];

    for (const item of output) {
      if (!item || typeof item !== 'object') continue;

      if (this.isFunctionCallItemType(item.type)) {
        const callId = this.pickFirstString(item.call_id, item.id, item.tool_call_id);
        const name = typeof item.name === 'string' ? item.name : undefined;
        if (!callId || !name) continue;

        toolCalls.push({
          id: callId,
          name,
          arguments: this.parseArguments(item.arguments ?? item.input ?? item.params),
        });
        continue;
      }

      const explicitCalls = item.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(explicitCalls)) {
        for (const call of explicitCalls) {
          if (!call || typeof call !== 'object') continue;
          const callId = this.pickFirstString(call.call_id, call.id, call.tool_call_id);
          const name = typeof call.name === 'string' ? call.name : undefined;
          if (!callId || !name) continue;
          toolCalls.push({
            id: callId,
            name,
            arguments: this.parseArguments(call.arguments ?? call.input ?? call.params),
          });
        }
      }

      if (item.type !== 'message') continue;
      const contentBlocks = item.content as Array<Record<string, unknown>> | Record<string, unknown> | undefined;
      if (contentBlocks && typeof contentBlocks === 'object' && !Array.isArray(contentBlocks)) {
        const block = contentBlocks;
        if (this.isFunctionCallItemType(block.type)) {
          const callId = this.pickFirstString(block.call_id, block.id, block.tool_call_id);
          const name = typeof block.name === 'string' ? block.name : undefined;
          if (callId && name) {
            toolCalls.push({
              id: callId,
              name,
              arguments: this.parseArguments(block.arguments ?? block.input ?? block.params),
            });
          }
        }
      }
      if (!contentBlocks || !Array.isArray(contentBlocks)) continue;

      for (const block of contentBlocks) {
        if (!this.isFunctionCallItemType(block.type)) continue;
        const callId = this.pickFirstString(block.call_id, block.id, block.tool_call_id);
        const name = typeof block.name === 'string' ? block.name : undefined;
        if (!callId || !name) continue;

        toolCalls.push({
          id: callId,
          name,
          arguments: this.parseArguments(block.arguments ?? block.input ?? block.params),
        });
      }
    }

    return toolCalls;
  }
}

// ============================================
// Responses API Types (internal)
// ============================================

interface ResponsesInput {
  type: 'message' | 'function_call_output' | 'function_call';
  role?: 'user' | 'assistant';
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  output?: string;
}

interface StreamEvent {
  type: string;
  id?: string;
  delta?: string;
  text?: string;
  refusal?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  part?: {
    type?: string;
    text?: string;
    value?: string;
    content?: string;
    refusal?: string;
    json?: Record<string, unknown>;
    output?: Record<string, unknown>;
    parsed?: Record<string, unknown>;
  };
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    tool_call_id?: string;
    name?: string;
    arguments?: unknown;
    input?: unknown;
    params?: unknown;
    value?: string;
    text?: string;
    refusal?: string;
    content?: Array<Record<string, unknown>> | Record<string, unknown> | string;
    json?: Record<string, unknown>;
    output?: Record<string, unknown>;
    parsed?: Record<string, unknown>;
    tool_calls?: Array<Record<string, unknown>>;
  };
  response?: Record<string, unknown> & {
    id?: string;
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens?: number;
    };
  };
}
