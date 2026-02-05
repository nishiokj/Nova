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

  /**
   * Non-streaming respond - internally uses streaming and collects result.
   * The ChatGPT backend requires stream=true for OAuth requests.
   */
  async respond(context: ProviderContext, params: RespondParams): Promise<LLMResponse> {
    // Collect streaming response
    let fullContent = '';
    const generator = this.stream(context, {
      ...params,
      onChunk: (chunk) => {
        fullContent += chunk;
      },
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
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    // Build request body per ChatGPT backend requirements
    // NOTE: ChatGPT backend does NOT support max_output_tokens or temperature params
    const body: Record<string, unknown> = {
      model: config.model,
      input: this.formatInput(nonSystemMessages),
      // ChatGPT backend requires these exact settings for OAuth
      stream: true,
      store: false,
      // System prompt goes in instructions field (required by backend)
      instructions: system ?? 'You are a helpful coding assistant.',
      // Reasoning effort: none, minimal, low, medium, high, xhigh
      reasoning: config.reasoning ?? { effort: 'medium' },
    };

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

    const response = await fetch(url, {
      method: 'POST',
      headers,
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
    // Track function calls being built up
    const pendingFunctionCalls = new Map<string, { name?: string; arguments?: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          // Handle SSE format: "event: <type>\ndata: <json>"
          if (line.startsWith('event:')) continue;
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6).trim();
          if (data === '[DONE]' || !data) continue;

          try {
            const event = JSON.parse(data) as StreamEvent;

            // Extract response ID from created event
            if (event.type === 'response.created' && event.response?.id) {
              responseId = event.response.id;
            }

            // Handle text output deltas
            if (event.type === 'response.output_text.delta') {
              const text = event.delta ?? '';
              fullContent += text;
              params.onChunk?.(text);
              yield text;
            }

            // Track function call creation
            if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
              const callId = event.item.call_id ?? event.item.id;
              if (callId) {
                pendingFunctionCalls.set(callId, {
                  name: event.item.name,
                  arguments: '',
                });
              }
            }

            // Accumulate function call arguments
            if (event.type === 'response.function_call_arguments.delta' && event.item_id) {
              const pending = pendingFunctionCalls.get(event.item_id);
              if (pending) {
                pending.arguments = (pending.arguments ?? '') + (event.delta ?? '');
              }
            }

            // Finalize function calls
            if (event.type === 'response.function_call_arguments.done') {
              const callId = event.item_id ?? event.call_id;
              if (callId) {
                const pending = pendingFunctionCalls.get(callId);
                if (pending?.name) {
                  toolCalls.push({
                    id: callId,
                    name: pending.name,
                    arguments: this.parseArguments(event.arguments ?? pending.arguments),
                  });
                  pendingFunctionCalls.delete(callId);
                }
              }
            }

            // Extract usage from completed event
            if (event.type === 'response.completed' && event.response?.usage) {
              usage = {
                promptTokens: event.response.usage.input_tokens ?? 0,
                completionTokens: event.response.usage.output_tokens ?? 0,
                totalTokens:
                  (event.response.usage.input_tokens ?? 0) + (event.response.usage.output_tokens ?? 0),
              };
            }
          } catch {
            // Ignore parse errors in stream - may be partial data
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
    return messages
      .filter((msg) => msg.role !== 'system') // System messages go in 'instructions'
      .map((msg) => {
        if (msg.role === 'user') {
          return { type: 'message', role: 'user', content: msg.content as string };
        }
        if (msg.role === 'assistant') {
          return { type: 'message', role: 'assistant', content: msg.content as string };
        }
        // Tool results
        return {
          type: 'function_call_output',
          call_id: (msg as ToolMessage).toolCallId,
          output: msg.content as string,
        };
      });
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
  role?: 'user' | 'assistant';
  content?: string;
  call_id?: string;
  output?: string;
}

interface StreamEvent {
  type: string;
  delta?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
  };
  response?: {
    id?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}
