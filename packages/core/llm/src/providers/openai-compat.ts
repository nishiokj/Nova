/**
 * OpenAI-compatible provider implementation.
 * Handles Chat Completions API for Cerebras, Groq, Together, etc.
 */

import type {
  ToolDefinition,
  ToolCall,
  TokenUsage,
  StopReason,
  LLMResponse,
  LLMItem,
  RespondParams,
  StreamParams,
  LLMExecutionError,
} from 'types';
import { Effect, Stream } from 'effect';
import type { ProviderContext, LLMProviderAdapter } from './types.js';
import { PartialStreamError, toLLMExecutionError } from './types.js';
import { getProviderResponseFormat } from 'types';
import {
  createRateLimitError,
} from '../rate-limits.js';
import { parseApiErrorResponse, formatApiError } from '../response_schemas.js';
import { profiler } from 'shared';
import { compileSchemaForOpenAI } from './schema_compiler.js';
import { normalizeChatCompletionsUsage } from './token_usage.js';

function parseApiError(provider: string, status: number, responseText: string): Error {
  const parsed = parseApiErrorResponse(provider, status, responseText);
  return formatApiError(provider, status, parsed);
}

// ============================================
// THINK TAG FILTER
// ============================================

/**
 * Strips `<think>...</think>` blocks from streaming content, separating
 * reasoning from actual output. Handles tag boundaries that split across chunks.
 *
 * Models like Qwen3.5 and DeepSeek emit thinking via `<think>` tags inside
 * `delta.content` rather than using a dedicated `reasoning_content` field.
 * Without filtering, the think content leaks into the context window, causing
 * the model to see its own raw output on the next turn and loop.
 */
class ThinkTagFilter {
  private inThink: boolean;
  private buffer = '';

  /**
   * @param startInThink - Set true when the model's prompt template ends with
   *   `<think>\n` (Qwen, DeepSeek). Without this, multi-chunk reasoning before
   *   the closing `</think>` leaks into the content stream because the filter
   *   doesn't know it's inside a think block.
   */
  constructor(startInThink = false) {
    this.inThink = startInThink;
  }

  processChunk(chunk: string): { content: string; reasoning: string } {
    let input = this.buffer + chunk;
    this.buffer = '';
    let content = '';
    let reasoning = '';

    while (input.length > 0) {
      if (this.inThink) {
        const idx = input.indexOf('</think>');
        if (idx === -1) {
          const partial = this.partialTagAt(input, '</think>');
          if (partial >= 0) {
            reasoning += input.slice(0, partial);
            this.buffer = input.slice(partial);
          } else {
            reasoning += input;
          }
          break;
        }
        reasoning += input.slice(0, idx);
        this.inThink = false;
        input = input.slice(idx + 8);
      } else {
        const openIdx = input.indexOf('<think>');
        const closeIdx = input.indexOf('</think>');

        // Unpaired </think> before any <think> — the opening tag was in the
        // generation prompt, so everything before it is reasoning.
        if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
          reasoning += input.slice(0, closeIdx);
          input = input.slice(closeIdx + 8);
          continue;
        }

        if (openIdx === -1) {
          const partial = this.partialTagAt(input, '<think>');
          if (partial >= 0) {
            content += input.slice(0, partial);
            this.buffer = input.slice(partial);
          } else {
            content += input;
          }
          break;
        }
        content += input.slice(0, openIdx);
        this.inThink = true;
        input = input.slice(openIdx + 7);
      }
    }

    return { content, reasoning };
  }

  flush(): { content: string; reasoning: string } {
    const buf = this.buffer;
    this.buffer = '';
    return this.inThink
      ? { content: '', reasoning: buf }
      : { content: buf, reasoning: '' };
  }

  private partialTagAt(input: string, tag: string): number {
    for (let len = Math.min(tag.length - 1, input.length); len > 0; len--) {
      if (input.endsWith(tag.slice(0, len))) {
        return input.length - len;
      }
    }
    return -1;
  }
}

/**
 * Strip `<think>` blocks from a complete string (non-streaming).
 * Handles both paired `<think>...</think>` and unpaired `</think>` where
 * the opening tag was part of the generation prompt.
 */
function separateThinkTags(text: string): { content: string; reasoning: string } {
  let reasoning = '';
  // First pass: strip paired <think>...</think> blocks
  let cleaned = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, inner) => {
    reasoning += inner;
    return '';
  });
  // Second pass: handle unpaired </think> (opening was in generation prompt)
  const unpairedClose = cleaned.indexOf('</think>');
  if (unpairedClose !== -1) {
    reasoning = cleaned.slice(0, unpairedClose) + reasoning;
    cleaned = cleaned.slice(unpairedClose + 8);
  }
  return { content: cleaned.trimStart(), reasoning };
}

/**
 * Streaming filter for `<tool_call>...</tool_call>` blocks.
 * Suppresses tool call markup from display content while preserving it
 * for post-stream tool call parsing.
 */
class ToolCallTagFilter {
  private inTag = false;
  private buffer = '';

  processChunk(chunk: string): string {
    let input = this.buffer + chunk;
    this.buffer = '';
    let content = '';

    while (input.length > 0) {
      if (this.inTag) {
        const idx = input.indexOf('</tool_call>');
        if (idx === -1) {
          const partial = this.partialTagAt(input, '</tool_call>');
          if (partial >= 0) {
            this.buffer = input.slice(partial);
          }
          break; // Swallow everything inside the tag
        }
        this.inTag = false;
        input = input.slice(idx + 12);
      } else {
        const idx = input.indexOf('<tool_call>');
        if (idx === -1) {
          const partial = this.partialTagAt(input, '<tool_call>');
          if (partial >= 0) {
            content += input.slice(0, partial);
            this.buffer = input.slice(partial);
          } else {
            content += input;
          }
          break;
        }
        content += input.slice(0, idx);
        this.inTag = true;
        input = input.slice(idx + 11);
      }
    }

    return content;
  }

  flush(): string {
    const buf = this.buffer;
    this.buffer = '';
    // If we're still inside a tag, discard it. Otherwise emit buffered content.
    return this.inTag ? '' : buf;
  }

  private partialTagAt(input: string, tag: string): number {
    for (let len = Math.min(tag.length - 1, input.length); len > 0; len--) {
      if (input.endsWith(tag.slice(0, len))) {
        return input.length - len;
      }
    }
    return -1;
  }
}

/** Strip `<tool_call>...</tool_call>` blocks from a complete string (non-streaming). */
function stripToolCallTags(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trimStart();
}

// ============================================
// OPENAI-COMPAT PROVIDER
// ============================================

function buildSchemaInstruction(schema: Record<string, unknown>): string {
  return `Return a single JSON object that matches this schema:\n${JSON.stringify(schema)}`;
}


export class OpenAICompatProvider implements LLMProviderAdapter {
  readonly name = 'openai-compat' as const;

  respond(context: ProviderContext, params: RespondParams): Effect.Effect<LLMResponse, LLMExecutionError> {
    return Effect.tryPromise({
      try: () => this.respondOpenAICompat(context, params),
      catch: (error) => toLLMExecutionError(error, this.name, context.config.model),
    });
  }

  stream(context: ProviderContext, params: StreamParams): Stream.Stream<string, LLMExecutionError> {
    return Stream.unwrapScoped(
      Effect.acquireRelease(
        Effect.sync(() => this.streamOpenAICompat(context, params)),
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
            (error) => toLLMExecutionError(error, 'openai-compat', context.config.model)
          )
        )
      )
    );
  }

  formatTools(
    tools: ToolDefinition[],
    options?: { model?: string; displayProvider?: string }
  ): Record<string, unknown>[] {
    const useQwenSkin = this.shouldUseQwenToolSkin(options?.model, options?.displayProvider);

    return tools.map((t) => {
      const qwenHint = useQwenSkin
        ? `\nQwen tool call syntax: <function=${t.name}>{\"arg\":\"value\"}</function>`
        : '';

      return {
        type: 'function',
        function: {
          name: t.name,
          description: `${t.description}${qwenHint}`,
          parameters: {
            type: 'object',
            properties: t.parameters.properties,
            required: t.parameters.required,
          },
        },
      };
    });
  }

  formatMessages(messages: LLMItem[], systemPrompt?: string): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    const functionCalls: { callId: string; name: string; argumentsStr: string }[] = [];
    // Track pending reasoning content to attach to the next assistant message (GLM-4.7)
    let pendingReasoningContent = '';

    for (const msg of messages) {
      if (!msg || msg.role === 'system') continue;
      const item = msg as unknown as Record<string, unknown>;

      // Handle reasoning items (GLM-4.7 thinking traces)
      // Collect reasoning content to attach to the next assistant message
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
          // Attach pending reasoning content to assistant message
          if (pendingReasoningContent) {
            assistantMsg.reasoning_content = pendingReasoningContent;
            pendingReasoningContent = '';
          }
          result.push(assistantMsg);
          functionCalls.length = 0;
        }

        const callId = (item.call_id ?? item.callId) as string;
        const rawOutput = item.output as string;
        const isError = item.isError as boolean | undefined;
        // Prefix error outputs so the LLM knows it's an error (OpenAI doesn't have is_error field)
        const content = isError && rawOutput && !rawOutput.startsWith('Error')
          ? `Error: ${rawOutput}`
          : rawOutput;
        result.push({
          role: 'tool',
          tool_call_id: callId,
          content,
        });
        continue;
      }

      if (typeof msg.content === 'string') {
        const formattedMsg: Record<string, unknown> = { role: msg.role, content: msg.content };
        // Attach pending reasoning content to assistant messages
        if (msg.role === 'assistant' && pendingReasoningContent) {
          formattedMsg.reasoning_content = pendingReasoningContent;
          pendingReasoningContent = '';
        }
        result.push(formattedMsg);
        continue;
      }

      if (!msg.content) continue;
      if (!Array.isArray(msg.content)) continue;

      const textParts: string[] = [];
      const toolCalls: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === 'tool_result') {
          result.push({
            role: 'tool',
            tool_call_id: block.toolUseId,
            content: block.content ?? '',
          });
        }
      }

      if (toolCalls.length > 0) {
        const assistantMsg: Record<string, unknown> = {
          role: 'assistant',
          content: textParts.join('\n') || '',
          tool_calls: toolCalls,
        };
        // Attach pending reasoning content to assistant message
        if (pendingReasoningContent) {
          assistantMsg.reasoning_content = pendingReasoningContent;
          pendingReasoningContent = '';
        }
        result.push(assistantMsg);
      } else if (textParts.length > 0) {
        const formattedMsg: Record<string, unknown> = {
          role: msg.role,
          content: textParts.join('\n'),
        };
        // Attach pending reasoning content to assistant messages
        if (msg.role === 'assistant' && pendingReasoningContent) {
          formattedMsg.reasoning_content = pendingReasoningContent;
          pendingReasoningContent = '';
        }
        result.push(formattedMsg);
      }
    }

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
      // Attach pending reasoning content to final assistant message
      if (pendingReasoningContent) {
        assistantMsg.reasoning_content = pendingReasoningContent;
        pendingReasoningContent = '';
      }
      result.push(assistantMsg);
    }

    return result;
  }

  // ============================================
  // OPENAI-COMPAT (non-streaming)
  // ============================================

  private async respondOpenAICompat(
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
    const responseFormat = params.responseSchema
      ? getProviderResponseFormat(resolved.displayProvider)
      : null;
    if (params.responseSchema && (responseFormat === 'json_object' || responseFormat === 'none')) {
      const schemaHint = buildSchemaInstruction(params.responseSchema.schema);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaHint}` : schemaHint;
    }

    // When using the Qwen tool skin, inject tool instructions into the system prompt
    // and skip sending tools via the API. LM Studio's tool calling interceptor hijacks
    // the chat template when it sees `tools` in the body, preventing the model from
    // emitting native <tool_call> tags. The harness content parser recovers tool calls
    // from the model's text output instead.
    const useQwenSkin = params.tools && params.tools.length > 0
      && this.shouldUseQwenToolSkin(resolved.model, resolved.displayProvider);

    if (useQwenSkin) {
      const qwenHint = this.buildQwenToolSkinInstruction(params.tools!);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${qwenHint}` : qwenHint;
    }

    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: this.formatMessages(params.messages, systemPrompt),
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
    };

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    // z.ai-coder uses GLM's thinking API instead of standard reasoning
    const isZaiCoder = resolved.displayProvider === 'z.ai-coder';

    if (isZaiCoder && resolved.reasoning?.effort && resolved.reasoning.effort !== 'none') {
      body.thinking = {
        type: 'enabled',
        clear_thinking: false, // Preserve thinking across turns for multi-turn salience
      };
    }

    if (params.tools && params.tools.length > 0 && !useQwenSkin) {
      body.tools = this.formatTools(params.tools, {
        model: resolved.model,
        displayProvider: resolved.displayProvider,
      });
    }
    if (!useQwenSkin) {
      if (params.toolChoice) {
        body.tool_choice = params.toolChoice;
      } else if (params.tools && params.tools.length > 0) {
        body.tool_choice = 'auto';
      }
    }

    if (params.responseSchema && responseFormat !== 'none') {
      if (responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' };
      } else {
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
    }

    const formattedMessages = body.messages as Record<string, unknown>[];
    const messageTypes = formattedMessages.map(m => {
      if (m.role === 'tool') return 'tool';
      if (m.role === 'assistant' && m.tool_calls) return 'assistant+tools';
      return m.role;
    });

    logger.debug('OpenAI-compat API request', {
      method: 'respond',
      endpoint: '/chat/completions',
      model: resolved.model,
      maxTokens: body.max_tokens,
      messageCount: formattedMessages.length,
      messageTypes: messageTypes.join(', '),
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      hasResponseFormat: !!body.response_format,
      responseFormat: responseFormat ?? undefined,
      responseSchemaName: params.responseSchema?.name,
    });

    if (messageTypes.includes('tool') || messageTypes.includes('assistant+tools')) {
      logger.debug('OpenAI-compat messages with tools', {
        messages: JSON.stringify(formattedMessages.slice(-6), null, 2),
      });
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.apiKey) {
      headers.Authorization = `Bearer ${resolved.apiKey}`;
    }

    const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const providerInfo = `${resolved.displayProvider} (${resolved.baseUrl})`;
      logger.error(`${resolved.displayProvider} API request failed`, {
        method: 'respond',
        endpoint: '/chat/completions',
        status: response.status,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError(providerInfo, resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError(providerInfo, response.status, errorText);
    }

    const data = (await response.json()) as {
      id: string;
      object: string;
      created: number;
      model: string;
      choices: {
        index: number;
        message: {
          role: string;
          content: string | null;
          reasoning_content?: string | null; // GLM-4.7 thinking trace
          tool_calls?: {
            id: string;
            type: string;
            function: {
              name: string;
              arguments: string;
            };
          }[];
        };
        finish_reason: string;
      }[];
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        completion_tokens_details?: Record<string, unknown>;
        output_tokens_details?: Record<string, unknown>;
        prompt_tokens_details?: Record<string, unknown>;
      };
    };

    const choice = data.choices[0];
    const rawMessageContent = choice?.message?.content as unknown;
    const rawContent = this.normalizeContent(rawMessageContent);
    // Separate <think> blocks from content — Qwen/DeepSeek emit reasoning in content tags
    const { content: strippedContent, reasoning: thinkReasoning } = separateThinkTags(rawContent);
    const content = strippedContent;
    const reasoningContent = choice?.message?.reasoning_content ?? (thinkReasoning || undefined);

    logger.debug('OpenAI-compat response received', {
      model: resolved.model,
      finishReason: choice?.finish_reason,
      hasContent: !!content,
      contentLength: content?.length ?? 0,
      contentPreview: content?.slice(0, 200),
      hasToolCalls: !!choice?.message?.tool_calls,
      toolCallCount: choice?.message?.tool_calls?.length ?? 0,
    });

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

    if (toolCalls.length === 0) {
      toolCalls.push(...this.parseToolCallsFromMessageContent(rawMessageContent));
    }

    if (toolCalls.length === 0 && content) {
      // Parse tool calls from content before stripping tags
      toolCalls.push(...this.parseToolCallsFromContent(content));
      if (toolCalls.length > 0) {
        logger.debug('Recovered tool calls from text content', {
          model: resolved.model,
          recoveredCount: toolCalls.length,
        });
      }
    }

    // Strip tool call tags from content for clean storage/display
    const cleanContent = stripToolCallTags(content);

    const stopReasonMap: Record<string, StopReason> = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'end_turn',
    };
    let stopReason: StopReason =
      stopReasonMap[choice?.finish_reason ?? 'stop'] ?? 'end_turn';
    if (toolCalls.length > 0 && stopReason === 'end_turn') {
      stopReason = 'tool_use';
    }

    const usage: TokenUsage = normalizeChatCompletionsUsage(data.usage);

    return {
      content: cleanContent,
      stopReason,
      usage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: data.model ?? resolved.model,
      durationMs: Date.now() - context.startTime,
      reasoningContent,
    };
  }

  // ============================================
  // OPENAI-COMPAT STREAMING
  // ============================================

  private async *streamOpenAICompat(
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
    const responseFormat = params.responseSchema
      ? getProviderResponseFormat(resolved.displayProvider)
      : null;
    if (params.responseSchema && (responseFormat === 'json_object' || responseFormat === 'none')) {
      const schemaHint = buildSchemaInstruction(params.responseSchema.schema);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaHint}` : schemaHint;
    }

    const useQwenSkin = params.tools && params.tools.length > 0
      && this.shouldUseQwenToolSkin(resolved.model, resolved.displayProvider);

    if (useQwenSkin) {
      const qwenHint = this.buildQwenToolSkinInstruction(params.tools!);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${qwenHint}` : qwenHint;
    }

    // Profile message formatting
    profiler.begin('llm:format:messages', 'llm');
    const formattedMessages = this.formatMessages(params.messages, systemPrompt);
    profiler.end('llm:format:messages', 'llm', { messageCount: params.messages.length });

    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: formattedMessages,
      max_tokens: params.maxTokens ?? resolved.maxTokens ?? 4096,
      stream: true,
    };

    if (params.temperature ?? resolved.temperature) {
      body.temperature = params.temperature ?? resolved.temperature;
    }

    // z.ai-coder uses GLM's thinking API instead of standard reasoning
    const isZaiCoder = resolved.displayProvider === 'z.ai-coder';

    if (isZaiCoder && resolved.reasoning?.effort && resolved.reasoning.effort !== 'none') {
      body.thinking = {
        type: 'enabled',
        clear_thinking: false, // Preserve thinking across turns for multi-turn salience
      };
      // Enable tool_stream to get reasoning_content with tool calls
      body.tool_stream = true;
      logger.debug('z.ai-coder thinking enabled for stream', {
        model: resolved.model,
        effort: resolved.reasoning.effort,
      });
    }

    if (params.tools && params.tools.length > 0 && !useQwenSkin) {
      body.tools = this.formatTools(params.tools, {
        model: resolved.model,
        displayProvider: resolved.displayProvider,
      });
    }
    if (!useQwenSkin) {
      if (params.toolChoice) {
        body.tool_choice = params.toolChoice;
      } else if (params.tools && params.tools.length > 0) {
        body.tool_choice = 'auto';
      }
    }

    if (params.responseSchema && responseFormat !== 'none') {
      if (responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' };
      } else {
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
    }


    const streamHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (resolved.apiKey) {
      streamHeaders.Authorization = `Bearer ${resolved.apiKey}`;
    }

    // Profile request serialization
    profiler.begin('llm:serialize:body', 'llm');
    const bodyJson = JSON.stringify(body);
    profiler.end('llm:serialize:body', 'llm', { bodyBytes: bodyJson.length });

    // Profile fetch (time to first byte - network + server processing + inference start)
    const fetchAsyncId = profiler.asyncBegin('llm:fetch:ttfb', 'http');
    const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: streamHeaders,
      body: bodyJson,
    });
    profiler.asyncEnd('llm:fetch:ttfb', fetchAsyncId, 'http', { status: response.status });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      const providerInfo = `${resolved.displayProvider} (${resolved.baseUrl})`;
      logger.error(`${resolved.displayProvider} API stream request failed`, {
        method: 'stream',
        endpoint: '/chat/completions',
        status: response.status,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        errorPreview: errorText.slice(0, 200),
      });
      if (response.status === 429) {
        throw createRateLimitError(providerInfo, resolved.model, response.status, response.headers, errorText);
      }
      throw parseApiError(providerInfo, response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';           // Clean content for display/storage (no think, no tool_call tags)
    let rawContentForParsing = '';  // Post-think content with tool_call tags preserved for fallback parsing
    let fullReasoningContent = '';
    let stopReason: StopReason = 'end_turn';
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const toolCalls: ToolCall[] = [];
    const toolCallBuilders = new Map<number, { id: string; name: string; arguments: string }>();
    let model = resolved.model;
    let buffer = '';
    let eventCount = 0;
    const thinkFilter = new ThinkTagFilter(this.modelStartsInThinkBlock(resolved.model));
    const toolCallFilter = new ToolCallTagFilter();

    // Profile stream consumption (reading all SSE events)
    const streamAsyncId = profiler.asyncBegin('llm:stream:consume', 'http');
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

          eventCount++;

          try {
            const event = JSON.parse(data) as {
              id?: string;
              object?: string;
              model?: string;
              choices?: {
                index: number;
                delta: {
                  role?: string;
                  content?: string;
                  reasoning_content?: string; // GLM-4.7 thinking trace
                  tool_calls?: {
                    index: number;
                    id?: string;
                    type?: string;
                    function?: {
                      name?: string;
                      arguments?: string;
                    };
                  }[];
                };
                finish_reason?: string;
              }[];
              usage?: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
                completion_tokens_details?: Record<string, unknown>;
                output_tokens_details?: Record<string, unknown>;
                prompt_tokens_details?: Record<string, unknown>;
              };
            };

            if (event.model) {
              model = event.model;
            }

            const choice = event.choices?.[0];
            if (choice) {
              // Stream reasoning content (z.ai-coder thinking trace)
              if (choice.delta?.reasoning_content) {
                const reasoningChunk = choice.delta.reasoning_content;
                fullReasoningContent += reasoningChunk;
                logger.debug('Received reasoning chunk', {
                  model: resolved.model,
                  chunkLength: reasoningChunk.length,
                  totalLength: fullReasoningContent.length,
                });
                params.onReasoningChunk?.(reasoningChunk);
              }

              const deltaContent = (choice.delta as { content?: unknown }).content;
              if (deltaContent !== undefined) {
                const normalized = this.normalizeContent(deltaContent);
                if (normalized) {
                  const { content: contentPart, reasoning: reasoningPart } = thinkFilter.processChunk(normalized);
                  if (reasoningPart) {
                    fullReasoningContent += reasoningPart;
                    params.onReasoningChunk?.(reasoningPart);
                  }
                  if (contentPart) {
                    rawContentForParsing += contentPart;
                    const cleanPart = toolCallFilter.processChunk(contentPart);
                    if (cleanPart) {
                      fullContent += cleanPart;
                      params.onChunk?.(cleanPart);
                      yield cleanPart;
                    }
                  }
                }
              }

              const messageContent = (choice as { message?: { content?: unknown } }).message?.content;
              if (fullContent.length === 0 && messageContent !== undefined) {
                const normalized = this.normalizeContent(messageContent);
                if (normalized) {
                  const { content: contentPart, reasoning: reasoningPart } = thinkFilter.processChunk(normalized);
                  if (reasoningPart) {
                    fullReasoningContent += reasoningPart;
                    params.onReasoningChunk?.(reasoningPart);
                  }
                  if (contentPart) {
                    rawContentForParsing += contentPart;
                    const cleanPart = toolCallFilter.processChunk(contentPart);
                    if (cleanPart) {
                      fullContent += cleanPart;
                      params.onChunk?.(cleanPart);
                      yield cleanPart;
                    }
                  }
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
              usage = normalizeChatCompletionsUsage(event.usage);
            }
          } catch {
            // Skip malformed events
          }
        }
      }
      // Flush any remaining buffered content from both filters
      const flushed = thinkFilter.flush();
      if (flushed.reasoning) {
        fullReasoningContent += flushed.reasoning;
        params.onReasoningChunk?.(flushed.reasoning);
      }
      if (flushed.content) {
        rawContentForParsing += flushed.content;
        const cleanPart = toolCallFilter.processChunk(flushed.content);
        if (cleanPart) {
          fullContent += cleanPart;
          params.onChunk?.(cleanPart);
          yield cleanPart;
        }
      }
      const toolCallFlushed = toolCallFilter.flush();
      if (toolCallFlushed) {
        fullContent += toolCallFlushed;
        params.onChunk?.(toolCallFlushed);
        yield toolCallFlushed;
      }

      // End stream consumption profiling on success
      profiler.asyncEnd('llm:stream:consume', streamAsyncId, 'http', { eventCount, contentLength: fullContent.length });
    } catch (streamError) {
      // End stream consumption profiling on error
      profiler.asyncEnd('llm:stream:consume', streamAsyncId, 'http', { eventCount, contentLength: fullContent.length, error: true });

      // Convert partial tool call builders to tool calls for error recovery
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

    // Parse tool calls from raw content (which still has <tool_call> tags intact)
    if (toolCalls.length === 0 && rawContentForParsing) {
      toolCalls.push(...this.parseToolCallsFromContent(rawContentForParsing));
      if (toolCalls.length > 0) {
        logger.debug('Recovered streamed tool calls from text content', {
          model: resolved.model,
          recoveredCount: toolCalls.length,
        });
      }
    }

    if (toolCalls.length > 0 && stopReason === 'end_turn') {
      stopReason = 'tool_use';
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

  private shouldUseQwenToolSkin(model?: string, displayProvider?: string): boolean {
    const modelLower = (model ?? '').toLowerCase();
    const providerLower = (displayProvider ?? '').toLowerCase();
    if (!modelLower.includes('qwen')) return false;
    return providerLower.includes('lmstudio') || providerLower.includes('vllm') || providerLower.includes('openai-compat');
  }

  /**
   * Models whose prompt template ends with `<think>\n`, causing the model to
   * start generation inside a think block. Without startInThink=true, the
   * ThinkTagFilter misclassifies multi-chunk reasoning as content.
   */
  private modelStartsInThinkBlock(model?: string): boolean {
    const m = (model ?? '').toLowerCase();
    return m.includes('qwen') || m.includes('deepseek');
  }

  private buildQwenToolSkinInstruction(tools: ToolDefinition[]): string {
    const exampleTool = tools.find((t) => t && typeof t.name === 'string' && t.name.length > 0);
    const toolName = exampleTool?.name ?? 'Read';
    const argName = exampleTool?.parameters?.required?.[0]
      ?? Object.keys(exampleTool?.parameters?.properties ?? {})[0]
      ?? 'path';
    const argValue = argName.toLowerCase().includes('path')
      ? 'packages/core/agent/src/agent.ts'
      : 'value';

    return [
      'Qwen tool-calling skin:',
      'When you need a tool, emit a tool-call block directly.',
      'Use this exact shape:',
      '<tool_call>',
      `<function=${toolName}>{\"${argName}\":\"${argValue}\"}</function>`,
      '</tool_call>',
      'Do not output only prose about calling tools.',
    ].join('\n');
  }

  private parseToolCallsFromMessageContent(content: unknown): ToolCall[] {
    if (!content) return [];

    if (typeof content === 'string') {
      return this.parseToolCallsFromContent(content);
    }

    if (!Array.isArray(content)) return [];

    const calls: ToolCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';

      if (type === 'tool_call' || type === 'function_call') {
        const name = typeof record.name === 'string'
          ? record.name
          : (record.function && typeof record.function === 'object' && typeof (record.function as Record<string, unknown>).name === 'string'
            ? ((record.function as Record<string, unknown>).name as string)
            : '');
        if (!name) continue;

        const callId = typeof record.id === 'string' ? record.id : `parsed_structured_tool_call_${calls.length}`;
        const argsRaw = record.arguments
          ?? (record.function && typeof record.function === 'object' ? (record.function as Record<string, unknown>).arguments : undefined)
          ?? record.input;
        const args = this.normalizeToolArguments(argsRaw);
        this.pushUniqueToolCall(calls, { id: callId, name, arguments: args });
        continue;
      }

      if (typeof record.text === 'string') {
        for (const call of this.parseToolCallsFromContent(record.text)) {
          this.pushUniqueToolCall(calls, call);
        }
        continue;
      }

      if (typeof record.content === 'string') {
        for (const call of this.parseToolCallsFromContent(record.content)) {
          this.pushUniqueToolCall(calls, call);
        }
      }
    }

    return calls;
  }

  private parseToolCallsFromContent(content: string): ToolCall[] {
    if (!content || content.trim().length === 0) return [];

    const calls: ToolCall[] = [];
    const tagRegex = /<(tool_call|function_call)>\s*([\s\S]*?)\s*<\/\1>/gi;
    let match: RegExpExecArray | null;
    let index = 0;

    while ((match = tagRegex.exec(content)) !== null) {
      const bodyCalls = this.parseJsonToolCallsFromBody(match[2]);
      if (bodyCalls.length > 0) {
        for (const bodyCall of bodyCalls) {
          this.pushUniqueToolCall(calls, {
            id: `parsed_tool_call_${index++}`,
            name: bodyCall.name,
            arguments: bodyCall.arguments,
          });
        }
        continue;
      }

      const parsed = this.parseTextToolCallBody(match[2]);
      if (!parsed) continue;
      this.pushUniqueToolCall(calls, {
        id: `parsed_tool_call_${index++}`,
        name: parsed.name,
        arguments: parsed.arguments,
      });
    }

    for (const fnCall of this.parseFunctionTagToolCalls(content)) {
      this.pushUniqueToolCall(calls, {
        id: `parsed_tool_call_${index++}`,
        name: fnCall.name,
        arguments: fnCall.arguments,
      });
    }

    return calls;
  }

  private parseJsonToolCallsFromBody(body: string): { name: string; arguments: Record<string, unknown> }[] {
    const trimmed = this.stripMarkdownFence(body.trim());
    if (!trimmed) return [];

    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const single = this.tryParseJsonObject(trimmed);
    if (single) {
      const parsed = this.parseJsonToolCall(single);
      if (parsed) calls.push(parsed);
      return calls;
    }

    const lines = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      const parsedLine = this.tryParseJsonObject(line);
      if (!parsedLine) continue;
      const parsed = this.parseJsonToolCall(parsedLine);
      if (parsed) calls.push(parsed);
    }

    return calls;
  }

  private parseFunctionTagToolCalls(content: string): { name: string; arguments: Record<string, unknown> }[] {
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const fnRegex = /<function=([A-Za-z0-9_.\-\/]+)>\s*([\s\S]*?)\s*<\/function>/gi;
    let match: RegExpExecArray | null;

    while ((match = fnRegex.exec(content)) !== null) {
      const name = (match[1] ?? '').trim();
      if (!name) continue;
      const args = this.normalizeToolArguments(match[2]);
      calls.push({ name, arguments: args });
    }

    return calls;
  }

  private parseTextToolCallBody(body: string): { name: string; arguments: Record<string, unknown> } | null {
    const trimmed = this.stripMarkdownFence(body.trim());
    if (!trimmed) return null;

    const asJson = this.tryParseJsonObject(trimmed);
    if (asJson) {
      const fromJson = this.parseJsonToolCall(asJson);
      if (fromJson) return fromJson;
    }

    const firstArgIndex = trimmed.search(/<arg_key>/i);
    const name = (firstArgIndex >= 0 ? trimmed.slice(0, firstArgIndex) : '').trim();
    if (!name) return null;

    const args: Record<string, unknown> = {};
    const argRegex = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
    let foundArg = false;
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argRegex.exec(trimmed)) !== null) {
      const key = argMatch[1]?.trim();
      if (!key) continue;
      args[key] = this.parseLooseValue(argMatch[2] ?? '');
      foundArg = true;
    }

    return foundArg ? { name, arguments: args } : { name, arguments: {} };
  }

  private parseJsonToolCall(candidate: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } | null {
    const directName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (directName) {
      return {
        name: directName,
        arguments: this.normalizeToolArguments(candidate.arguments ?? candidate.input ?? candidate.args),
      };
    }

    const directTool = typeof candidate.tool === 'string' ? candidate.tool.trim() : '';
    if (directTool) {
      return {
        name: directTool,
        arguments: this.normalizeToolArguments(candidate.arguments ?? candidate.input ?? candidate.args),
      };
    }

    const fn = candidate.function;
    if (fn && typeof fn === 'object') {
      const fnRecord = fn as Record<string, unknown>;
      const functionName = typeof fnRecord.name === 'string' ? fnRecord.name.trim() : '';
      if (!functionName) return null;
      return {
        name: functionName,
        arguments: this.normalizeToolArguments(fnRecord.arguments ?? fnRecord.input ?? fnRecord.args),
      };
    }

    if (typeof fn === 'string' && fn.trim().length > 0) {
      return {
        name: fn.trim(),
        arguments: this.normalizeToolArguments(candidate.arguments ?? candidate.input ?? candidate.params),
      };
    }

    return null;
  }

  private pushUniqueToolCall(calls: ToolCall[], call: ToolCall): void {
    const serializedArgs = JSON.stringify(call.arguments ?? {});
    const exists = calls.some(
      (candidate) =>
        candidate.name === call.name &&
        JSON.stringify(candidate.arguments ?? {}) === serializedArgs
    );
    if (!exists) {
      calls.push(call);
    }
  }

  private normalizeToolArguments(raw: unknown): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === 'string') {
      const parsed = this.tryParseJsonObject(this.stripMarkdownFence(raw.trim()));
      return parsed ?? {};
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return {};
  }

  private parseLooseValue(raw: string): unknown {
    const trimmed = this.stripMarkdownFence(raw.trim());
    if (!trimmed) return '';
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const asNum = Number(trimmed);
      if (!Number.isNaN(asNum)) return asNum;
    }
    const parsed = this.tryParseJsonObject(trimmed);
    if (parsed) return parsed;
    return trimmed;
  }

  private stripMarkdownFence(value: string): string {
    if (!value.startsWith('```')) return value;
    const withoutStart = value.replace(/^```[a-zA-Z0-9_-]*\s*/, '');
    return withoutStart.replace(/\s*```$/, '');
  }

  private tryParseJsonObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
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
}
