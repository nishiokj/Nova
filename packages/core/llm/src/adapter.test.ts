/**
 * Comprehensive test suite for LLM Adapter
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - OpenAI polling edge cases
 * - Error classification
 * - Response parsing edge cases
 * - Circuit breaker integration
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createAdapter } from './adapter.js';
import type { LLMClientConfig, LLMRequestConfig } from 'types';

// Mock fetch globally
const originalFetch = globalThis.fetch;

function mockFetch(implementation: (url: string, options?: RequestInit) => Promise<Response>) {
  globalThis.fetch = implementation as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

describe('OpenAIAdapter', () => {
  let adapter: ReturnType<typeof createAdapter>;
  const clientConfig: LLMClientConfig = {
    apiKeys: { openai: 'test-key' },
  };
  const baseRequest: LLMRequestConfig = {
    model: 'gpt-4o',
    provider: 'openai',
  };

  beforeEach(() => {
    adapter = createAdapter(clientConfig);
    const baseRespond = adapter.respond.bind(adapter);
    (adapter as any).respond = (params: Record<string, unknown>) =>
      baseRespond({
        ...params,
        llm: { ...baseRequest, ...((params as { llm?: LLMRequestConfig }).llm ?? {}) },
      });
  });

  afterEach(() => {
    restoreFetch();
  });

  describe('pollForCompletion edge cases', () => {
    it('should handle status transitioning from queued to in_progress to completed', async () => {
      let callCount = 0;
      mockFetch(async (url, options) => {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 'resp_123',
            status: 'queued',
          }), { status: 200 });
        }
        // GET polling
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ id: 'resp_123', status: 'queued' }), { status: 200 });
        }
        if (callCount === 2) {
          return new Response(JSON.stringify({ id: 'resp_123', status: 'in_progress' }), { status: 200 });
        }
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'Test response',
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('Test response');
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should throw on unexpected status like "expired"', async () => {
      mockFetch(async (url, options) => {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 'resp_123',
            status: 'queued',
          }), { status: 200 });
        }
        // Return unexpected status
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'expired', // Unexpected status
        }), { status: 200 });
      });

      // BUG CANDIDATE: The polling loop doesn't handle 'expired' status
      // It will loop until timeout, wasting resources
      // This test may timeout, revealing the bug
      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow(/timeout/i);
    });

    it('should handle API returning failed status with error details', async () => {
      mockFetch(async (url, options) => {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 'resp_123',
            status: 'queued',
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'failed',
          error: { message: 'Content policy violation', code: 'content_filter' },
        }), { status: 200 });
      });

      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow(/failed.*Content policy/i);
    });

    it('should handle cancelled status', async () => {
      mockFetch(async (url, options) => {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 'resp_123',
            status: 'queued',
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'cancelled',
        }), { status: 200 });
      });

      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow(/cancelled/i);
    });

    it('should handle poll returning 500 error', async () => {
      mockFetch(async (url, options) => {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 'resp_123',
            status: 'queued',
          }), { status: 200 });
        }
        return new Response('Internal Server Error', { status: 500 });
      });

      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow(/500/);
    });

    it('should handle poll returning malformed JSON', async () => {
      let getPollCount = 0;
      mockFetch(async (url, options) => {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 'resp_123',
            status: 'queued',
          }), { status: 200 });
        }
        getPollCount++;
        if (getPollCount === 1) {
          return new Response('not json at all', { status: 200 });
        }
        // Recover on second poll
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'Recovered',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      // BUG CANDIDATE: JSON parse error in poll is not caught gracefully
      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow();
    });
  });

  describe('parseOutputText edge cases', () => {
    it('should handle output as object with nested message types', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'First' }] },
            { type: 'message', content: [{ type: 'text', text: 'Second' }] },
          ],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('FirstSecond');
    });

    it('should handle output_text at top level taking precedence', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'Top level',
          output: [{ type: 'text', text: 'Nested' }],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      // BUG CANDIDATE: Should top-level output_text take precedence?
      expect(response.content).toBe('Top level');
    });

    it('should handle empty output array with no output_text', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('');
    });

    it('should handle null output_text', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: null,
          output: [{ type: 'output_text', text: 'From output array' }],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('From output array');
    });

    it('should handle output_json blocks', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_json', json: { action: 'done', response: 'ok', goalStateReached: true, userPrompt: null } },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('{"action":"done","response":"ok","goalStateReached":true,"userPrompt":null}');
    });
  });

  describe('parseToolCalls edge cases', () => {
    it('should handle function_call with arguments as string', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'search',
              arguments: '{"query": "test"}', // String, not object
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].arguments).toEqual({ query: 'test' });
    });

    it('should handle function_call with malformed JSON arguments string', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'search',
              arguments: '{not valid json}',
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      // Should handle gracefully with empty args
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].arguments).toEqual({});
    });

    it('should handle function_call with id field instead of call_id', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'call_fallback', // id instead of call_id
              name: 'search',
              arguments: { query: 'test' },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].id).toBe('call_fallback');
    });

    it('should handle function_call with missing name', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              // name missing!
              arguments: { query: 'test' },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      // BUG: Tool call with empty name will cause issues downstream
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].name).toBe('');
    });
  });

  describe('supportsPromptCacheRetention', () => {
    it('should return false for gpt-5-nano', () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        // Verify prompt_cache_retention is NOT included
        expect(body.prompt_cache_retention).toBeUndefined();
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'OK',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      return adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
        promptCacheRetention: '1h',
        llm: { model: 'gpt-5-nano' },
      });
    });

    it('should include prompt_cache_retention for gpt-4o', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        expect(body.prompt_cache_retention).toBe('1h');
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'OK',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
        promptCacheRetention: '1h',
      });
    });
  });

  describe('structured outputs', () => {
    it('should include text.format when responseSchema is provided', async () => {
      mockFetch(async (_url, options) => {
        const body = JSON.parse(options?.body as string);
        expect(body.text).toEqual({
          format: {
            type: 'json_schema',
            name: 'test_schema',
            schema: { type: 'object' },
            strict: true,
          },
        });
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: '{"action":"done","response":"ok","goalStateReached":true,"userPrompt":null}',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
        responseSchema: { name: 'test_schema', schema: { type: 'object' }, strict: true },
      });
    });
  });

  describe('isReasoningModel', () => {
    it('should force tool_choice required for o1 models', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        expect(body.tool_choice).toBe('required');
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'OK',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [{ name: 'test', description: 'test', parameters: { type: 'object', properties: {}, required: [] } }],
        llm: { model: 'o1-preview' },
      });
    });

    it('should NOT set temperature for reasoning models', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        // BUG CANDIDATE: Temperature should NOT be set for o3 models
        expect(body.temperature).toBeUndefined();
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'OK',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
        llm: { model: 'o3-mini', temperature: 0.7 },
      });
    });
  });

  describe('normalizeInput edge cases', () => {
    it('should handle tool_use content blocks correctly', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        // Verify function_call items are created
        const hasFunctionCall = body.input.some((i: { type: string }) => i.type === 'function_call');
        expect(hasFunctionCall).toBe(true);
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'OK',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me search' },
              { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'Results here', isError: false },
            ],
          },
        ],
      });
    });

    it('should handle empty message content array', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'resp_123',
          status: 'completed',
          output_text: 'OK',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200 });
      });

      // Should not throw
      await adapter.respond({
        messages: [
          { role: 'user', content: [] },
        ],
      });
    });
  });

  describe('background mode response ID handling', () => {
    it('should throw if background response has no id', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          status: 'queued',
          // id missing!
        }), { status: 200 });
      });

      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow(/missing id/i);
    });
  });
});

describe('AnthropicAdapter', () => {
  let adapter: ReturnType<typeof createAdapter>;
  const clientConfig: LLMClientConfig = {
    apiKeys: { anthropic: 'test-key' },
  };
  const baseRequest: LLMRequestConfig = {
    model: 'claude-3-opus',
    provider: 'anthropic',
  };

  beforeEach(() => {
    adapter = createAdapter(clientConfig);
    const baseRespond = adapter.respond.bind(adapter);
    (adapter as any).respond = (params: Record<string, unknown>) =>
      baseRespond({
        ...params,
        llm: { ...baseRequest, ...((params as { llm?: LLMRequestConfig }).llm ?? {}) },
      });
  });

  afterEach(() => {
    restoreFetch();
  });

  describe('formatMessages', () => {
    it('should filter out system messages from messages array', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        // System should be top-level, not in messages
        expect(body.system).toBe('You are helpful');
        const hasSystemInMessages = body.messages.some((m: { role: string }) => m.role === 'system');
        expect(hasSystemInMessages).toBe(false);
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'Hello!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
      });
    });

    it('should handle tool_result with is_error flag', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        const toolResult = body.messages.find((m: { content: Array<{ type: string }> }) =>
          Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')
        );
        const resultBlock = toolResult?.content.find((c: { type: string }) => c.type === 'tool_result');
        expect(resultBlock.is_error).toBe(true);
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'I see there was an error' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [
          { role: 'user', content: 'Run command' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'Command failed', isError: true },
            ],
          },
        ],
      });
    });
  });

  describe('response parsing', () => {
    it('should handle mixed text and tool_use content blocks', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          content: [
            { type: 'text', text: 'Let me search for that. ' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } },
            { type: 'text', text: 'Done searching.' },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 15 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Search for test' }],
      });

      expect(response.content).toBe('Let me search for that. Done searching.');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.stopReason).toBe('tool_use');
    });

    it('should handle content array with no text blocks', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          content: [
            { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'List files' }],
      });

      expect(response.content).toBe('');
      expect(response.toolCalls).toHaveLength(1);
    });

    it('should handle unknown stop_reason gracefully', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: 'unknown_reason',
          usage: { input_tokens: 10, output_tokens: 5 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      // Should default to end_turn
      expect(response.stopReason).toBe('end_turn');
    });
  });

  describe('error handling', () => {
    it('should include status code in error message', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
        });
      });

      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow(/401/);
    });
  });
});

describe('OpenAICompatAdapter', () => {
  let adapter: ReturnType<typeof createAdapter>;
  const clientConfig: LLMClientConfig = {
    apiKeys: { 'openai-compat': 'test-key' },
  };
  const baseRequest: LLMRequestConfig = {
    model: 'glm-4.7',
    provider: 'openai-compat',
    baseUrl: 'https://api.z.ai/api/paas/v4',
  };

  beforeEach(() => {
    adapter = createAdapter(clientConfig);
    const baseRespond = adapter.respond.bind(adapter);
    (adapter as any).respond = (params: Record<string, unknown>) =>
      baseRespond({
        ...params,
        llm: { ...baseRequest, ...((params as { llm?: LLMRequestConfig }).llm ?? {}) },
      });
  });

  afterEach(() => {
    restoreFetch();
  });

  describe('basic response parsing', () => {
    it('should parse standard Chat Completions response', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: 1234567890,
          model: 'glm-4.7',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello! How can I help you today?',
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 15,
            total_tokens: 25,
          },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('Hello! How can I help you today?');
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage.promptTokens).toBe(10);
      expect(response.usage.completionTokens).toBe(15);
      expect(response.usage.totalTokens).toBe(25);
      expect(response.model).toBe('glm-4.7');
    });

    it('should handle null content gracefully', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('');
    });

    it('should handle max_tokens finish_reason', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Truncated...' },
            finish_reason: 'length',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.stopReason).toBe('max_tokens');
    });
  });

  describe('tool calling', () => {
    it('should parse tool calls from response', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_abc123',
                type: 'function',
                function: {
                  name: 'search',
                  arguments: '{"query": "weather"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'What is the weather?' }],
        tools: [{
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }],
      });

      expect(response.stopReason).toBe('tool_use');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].id).toBe('call_abc123');
      expect(response.toolCalls![0].name).toBe('search');
      expect(response.toolCalls![0].arguments).toEqual({ query: 'weather' });
    });

    it('should handle multiple tool calls', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Let me search for both.',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query": "a"}' } },
                { id: 'call_2', type: 'function', function: { name: 'search', arguments: '{"query": "b"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 15, completion_tokens: 30, total_tokens: 45 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Search for a and b' }],
        tools: [{
          name: 'search',
          description: 'Search',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }],
      });

      expect(response.toolCalls).toHaveLength(2);
      expect(response.toolCalls![0].arguments).toEqual({ query: 'a' });
      expect(response.toolCalls![1].arguments).toEqual({ query: 'b' });
    });

    it('should handle malformed tool call arguments', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'test', arguments: '{not valid json}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }), { status: 200 });
      });

      const response = await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].arguments).toEqual({});
    });

    it('should format tools correctly in request', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        // Verify Chat Completions tool format
        expect(body.tools).toEqual([{
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Do math',
            parameters: {
              type: 'object',
              properties: { expression: { type: 'string' } },
              required: ['expression'],
            },
          },
        }]);
        expect(body.tool_choice).toBe('auto');
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [{
          name: 'calculator',
          description: 'Do math',
          parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
        }],
      });
    });
  });

  describe('message formatting', () => {
    it('should include system message at the start', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
        expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello' });
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
      });
    });

    it('should handle tool_use and tool_result blocks', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        // Assistant message with tool_calls
        const assistantMsg = body.messages.find((m: { tool_calls?: unknown }) => m.tool_calls);
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg.tool_calls[0].id).toBe('call_1');
        expect(assistantMsg.tool_calls[0].function.name).toBe('search');
        // Tool result message
        const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
        expect(toolMsg).toBeDefined();
        expect(toolMsg.tool_call_id).toBe('call_1');
        expect(toolMsg.content).toBe('Search results here');
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Based on the results...' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [
          { role: 'user', content: 'Search for info' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me search' },
              { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'info' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'Search results here', isError: false },
            ],
          },
        ],
      });
    });
  });

  describe('error handling', () => {
    it('should parse API errors correctly', async () => {
      mockFetch(async () => {
        return new Response(JSON.stringify({
          error: {
            message: 'Invalid API key',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        }), { status: 401 });
      });

      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow(/401.*Invalid API key/);
    });

    it('should handle non-JSON error responses', async () => {
      mockFetch(async () => {
        return new Response('Bad Gateway', { status: 502 });
      });

      await expect(
        adapter.respond({ messages: [{ role: 'user', content: 'Hello' }] })
      ).rejects.toThrow(/502.*Bad Gateway/);
    });
  });

  describe('endpoint configuration', () => {
    it('should use /chat/completions endpoint', async () => {
      mockFetch(async (url) => {
        expect(url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    it('should include correct authorization header', async () => {
      mockFetch(async (url, options) => {
        expect(options?.headers).toEqual(expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        }));
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });
  });

  describe('request parameters', () => {
    it('should include temperature when specified', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        expect(body.temperature).toBe(0.7);
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      });
    });

    it('should include max_tokens when specified', async () => {
      mockFetch(async (url, options) => {
        const body = JSON.parse(options?.body as string);
        expect(body.max_tokens).toBe(1000);
        return new Response(JSON.stringify({
          id: 'chatcmpl-123',
          model: 'glm-4.7',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { status: 200 });
      });

      await adapter.respond({
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 1000,
      });
    });
  });
});

describe('VercelGatewayAdapter', () => {
  let adapter: ReturnType<typeof createAdapter>;
  const clientConfig: LLMClientConfig = {
    apiKeys: { 'vercel-gateway': 'gateway-key' },
  };
  const baseRequest: LLMRequestConfig = {
    model: 'anthropic/claude-3.5-sonnet',
  };

  beforeEach(() => {
    adapter = createAdapter(clientConfig);
    const baseRespond = adapter.respond.bind(adapter);
    (adapter as any).respond = (params: Record<string, unknown>) =>
      baseRespond({
        ...params,
        llm: { ...baseRequest, ...((params as { llm?: LLMRequestConfig }).llm ?? {}) },
      });
  });

  afterEach(() => {
    restoreFetch();
  });

  it('should infer vercel-gateway provider when model includes slash', async () => {
    mockFetch(async (url, options) => {
      expect(url).toBe('https://ai-gateway.vercel.sh/v1/responses');
      expect(options?.headers).toEqual(expect.objectContaining({
        Authorization: 'Bearer gateway-key',
      }));
      const body = JSON.parse(options?.body as string);
      expect(body.model).toBe('anthropic/claude-3.5-sonnet');
      return new Response(JSON.stringify({
        id: 'resp_123',
        status: 'completed',
        output_text: 'OK',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200 });
    });

    await adapter.respond({
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('should convert bare model to gateway format using displayProvider hint', async () => {
    mockFetch(async (url, options) => {
      expect(url).toBe('https://ai-gateway.vercel.sh/v1/responses');
      const body = JSON.parse(options?.body as string);
      expect(body.model).toBe('anthropic/claude-sonnet-4.5');
      return new Response(JSON.stringify({
        id: 'resp_123',
        status: 'completed',
        output_text: 'OK',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200 });
    });

    await adapter.respond({
      messages: [{ role: 'user', content: 'Hello' }],
      llm: {
        provider: 'vercel-gateway',
        model: 'claude-sonnet-4.5',
        displayProvider: 'anthropic',
      },
    });
  });

  it('should use chat completions endpoint when responseSchema is provided', async () => {
    mockFetch(async (url, options) => {
      expect(url).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
      const body = JSON.parse(options?.body as string);
      expect(body.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'test_schema',
          schema: { type: 'object' },
          strict: true,
        },
      });
      return new Response(JSON.stringify({
        id: 'chatcmpl_123',
        model: 'anthropic/claude-3.5-sonnet',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '{"ok":true}' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200 });
    });

    await adapter.respond({
      messages: [{ role: 'user', content: 'Hello' }],
      responseSchema: { name: 'test_schema', schema: { type: 'object' } },
    });
  });
});

describe('createAdapter factory', () => {
  it('should create adapter with api key map', () => {
    const adapter = createAdapter({
      apiKeys: { openai: 'key', anthropic: 'key' },
    });
    expect(adapter).toBeTruthy();
  });

  it('should create adapter with openai-compat provider', () => {
    const adapter = createAdapter({
      apiKeys: { 'openai-compat': 'key' },
      modelRegistry: {
        'glm-4.7': { provider: 'openai-compat', baseUrl: 'https://api.z.ai/api/paas/v4' },
      },
    });
    expect(adapter).toBeTruthy();
  });
});
