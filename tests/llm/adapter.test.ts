import { Effect, Stream } from 'effect';
import { createAdapter } from 'llm/adapter.js';
import type { LLMRequestConfig, LLMResponse } from 'types';

const originalFetch = globalThis.fetch;

function mockFetch(implementation: (url: string, options?: RequestInit) => Promise<Response>) {
  globalThis.fetch = implementation as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function createCompatRequest(overrides: Partial<LLMRequestConfig> = {}): LLMRequestConfig {
  return {
    provider: 'openai-compat',
    model: 'mock-model',
    baseUrl: 'https://compat.example/v1',
    apiKey: 'test-key',
    contextWindow: 128_000,
    ...overrides,
  };
}

function createChatCompletionResponse(content: string): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl_test',
    model: 'mock-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    },
  }), { status: 200 });
}

function createSseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('LLM adapter (Effect runtime)', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('respond resolves through Effect.runPromise', async () => {
    let calledUrl = '';
    mockFetch(async (url) => {
      calledUrl = String(url);
      return createChatCompletionResponse('hello from compat');
    });

    const adapter = createAdapter();
    const response = await Effect.runPromise(adapter.respond({
      messages: [{ role: 'user', content: 'hi' }],
      llm: createCompatRequest(),
    }));

    expect(calledUrl).toContain('/chat/completions');
    expect(response.content).toBe('hello from compat');
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage.totalTokens).toBe(5);
  });

  it('stream emits chunks and calls onComplete', async () => {
    mockFetch(async () => createSseResponse([
      'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"id":"chatcmpl_1","choices":[{"delta":{},"finish_reason":"stop"}],"model":"mock-model","usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const adapter = createAdapter();
    let completed: LLMResponse | undefined;

    const chunks = await Effect.runPromise(
      Stream.runCollect(
        adapter.stream({
          messages: [{ role: 'user', content: 'stream please' }],
          llm: createCompatRequest(),
          onComplete: (response) => {
            completed = response;
          },
        })
      )
    );

    expect(Array.from(chunks).join('')).toBe('hello world');
    expect(completed?.content).toBe('hello world');
    expect(completed?.stopReason).toBe('end_turn');
  });

  it('maps provider HTTP failures to Effect errors', async () => {
    mockFetch(async () => new Response(JSON.stringify({
      error: { message: 'Invalid API key' },
    }), { status: 401 }));

    const adapter = createAdapter();

    let caught: unknown;
    try {
      await Effect.runPromise(adapter.respond({
        messages: [{ role: 'user', content: 'hello' }],
        llm: createCompatRequest(),
      }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(String((caught as { message?: string })?.message ?? caught)).toContain('401');
  });
});
