import { afterEach, describe, expect, it } from 'bun:test';
import type { StreamParams } from 'types';
import { CodexProvider } from './codex.js';
import type { ProviderContext } from './types.js';

const originalFetch = globalThis.fetch;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createContext(): ProviderContext {
  return {
    config: {
      provider: 'codex',
      displayProvider: 'codex',
      model: 'gpt-5.3-codex',
      apiKey: 'token',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      chatgptAccountId: 'acct_test',
    },
    logger,
    startTime: Date.now(),
  };
}

function sseFrame(event: Record<string, unknown>, multiline = false): string {
  const payload = multiline ? JSON.stringify(event, null, 2) : JSON.stringify(event);
  const dataLines = payload
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `event: ${event.type}\n${dataLines}\n\n`;
}

async function consumeStream(provider: CodexProvider, context: ProviderContext, params: StreamParams) {
  const chunks: string[] = [];
  const stream = provider.stream(context, params);
  let finalResponse: Awaited<ReturnType<typeof stream.next>>['value'] | undefined;

  while (true) {
    const { value, done } = await stream.next();
    if (done) {
      finalResponse = value;
      break;
    }
    chunks.push(value);
  }

  if (!finalResponse || typeof finalResponse !== 'object') {
    throw new Error('Expected final response object');
  }

  return {
    chunks,
    response: finalResponse,
  };
}

describe('CodexProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses multiline SSE payloads and function calls emitted via output_item events', async () => {
    const provider = new CodexProvider();
    const context = createContext();

    const rawSse = [
      sseFrame({ type: 'response.created', id: 'resp_codex_1' }),
      sseFrame({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'item_call_1', call_id: 'call_read_1', name: 'Read' },
      }, true),
      sseFrame({
        type: 'response.function_call_arguments.delta',
        item_id: 'item_call_1',
        delta: '{"path":"packages/core/agent/src/agent.ts"',
      }),
      sseFrame({
        type: 'response.function_call_arguments.delta',
        item_id: 'item_call_1',
        delta: '}',
      }),
      sseFrame({
        type: 'response.function_call_arguments.done',
        item_id: 'item_call_1',
      }),
      sseFrame({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: 'item_msg_1',
          content: [{ type: 'output_text', text: 'Investigating Codex adapter issue.' }],
        },
      }),
      sseFrame({
        type: 'response.completed',
        response: {
          id: 'resp_codex_1',
          model: 'gpt-5.3-codex-2026-02-01',
          usage: { input_tokens: 111, output_tokens: 22, total_tokens: 133 },
        },
      }),
      'data: [DONE]\n\n',
    ].join('');

    globalThis.fetch = (async () =>
      new Response(rawSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;

    const { chunks, response } = await consumeStream(provider, context, {
      messages: [{ role: 'user', content: 'debug this' }],
      llm: { provider: 'codex', model: 'gpt-5.3-codex' },
    });

    expect(chunks.join('')).toBe('Investigating Codex adapter issue.');
    expect(response.content).toBe('Investigating Codex adapter issue.');
    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      {
        id: 'call_read_1',
        name: 'Read',
        arguments: { path: 'packages/core/agent/src/agent.ts' },
      },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 111,
      completionTokens: 22,
      totalTokens: 133,
    });
    expect(response.model).toBe('gpt-5.3-codex-2026-02-01');
    expect(response.responseId).toBe('resp_codex_1');
  });

  it('falls back to tool-call extraction from response.completed output', async () => {
    const provider = new CodexProvider();
    const context = createContext();

    const rawSse = [
      sseFrame({
        type: 'response.completed',
        response: {
          id: 'resp_codex_2',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          output: [
            {
              type: 'function_call',
              call_id: 'call_search_1',
              name: 'Search',
              arguments: '{"query":"codex adapter"}',
            },
          ],
        },
      }),
      'data: [DONE]\n\n',
    ].join('');

    globalThis.fetch = (async () =>
      new Response(rawSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;

    const { response } = await consumeStream(provider, context, {
      messages: [{ role: 'user', content: 'debug this' }],
      llm: { provider: 'codex', model: 'gpt-5.3-codex' },
    });

    expect(response.toolCalls).toEqual([
      {
        id: 'call_search_1',
        name: 'Search',
        arguments: { query: 'codex adapter' },
      },
    ]);
    expect(response.stopReason).toBe('tool_use');
  });

  it('parses content_part events and broader tool-call item variants', async () => {
    const provider = new CodexProvider();
    const context = createContext();

    const rawSse = [
      sseFrame({ type: 'response.created', id: 'resp_codex_4' }),
      sseFrame({
        type: 'response.content_part.done',
        item_id: 'item_msg_4',
        output_index: 0,
        content_index: 0,
        part: { type: 'text', value: '{"action":"done","goalStateReached":true}' },
      }),
      sseFrame({
        type: 'response.completed',
        response: {
          id: 'resp_codex_4',
          usage: { input_tokens: 33, output_tokens: 12, total_tokens: 45 },
          output: [
            {
              type: 'function_tool_call',
              id: 'item_tool_4',
              call_id: 'call_edit_4',
              name: 'Edit',
              arguments: '{"path":"packages/core/llm/src/providers/codex.ts","old_string":"a","new_string":"b"}',
            },
          ],
        },
      }),
      'data: [DONE]\n\n',
    ].join('');

    globalThis.fetch = (async () =>
      new Response(rawSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;

    const { chunks, response } = await consumeStream(provider, context, {
      messages: [{ role: 'user', content: 'respond with schema and call Edit' }],
      llm: { provider: 'codex', model: 'gpt-5.3-codex' },
    });

    expect(chunks.join('')).toContain('"action":"done"');
    expect(response.content).toContain('"goalStateReached":true');
    expect(response.toolCalls).toEqual([
      {
        id: 'call_edit_4',
        name: 'Edit',
        arguments: {
          path: 'packages/core/llm/src/providers/codex.ts',
          old_string: 'a',
          new_string: 'b',
        },
      },
    ]);
    expect(response.stopReason).toBe('tool_use');
  });

  it('formats function_call history correctly in request input', async () => {
    const provider = new CodexProvider();
    const context = createContext();
    let capturedBody: Record<string, unknown> | null = null;

    const rawSse = [
      sseFrame({
        type: 'response.completed',
        response: {
          id: 'resp_codex_3',
          output_text: 'ok',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
      'data: [DONE]\n\n',
    ].join('');

    globalThis.fetch = (async (_url, options) => {
      capturedBody = JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>;
      return new Response(rawSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    await consumeStream(provider, context, {
      messages: [
        { role: 'user', content: 'Check this file' },
        {
          type: 'function_call',
          call_id: 'call_abc',
          id: 'call_abc',
          name: 'Read',
          arguments: { path: 'packages/core/llm/src/providers/codex.ts' },
        },
        {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: 'file body',
        },
      ] as unknown as StreamParams['messages'],
      llm: { provider: 'codex', model: 'gpt-5.3-codex' },
    });

    expect(capturedBody).not.toBeNull();
    const input = capturedBody?.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { type: 'message', role: 'user', content: 'Check this file' },
      {
        type: 'function_call',
        call_id: 'call_abc',
        name: 'Read',
        arguments: { path: 'packages/core/llm/src/providers/codex.ts' },
      },
      {
        type: 'function_call_output',
        call_id: 'call_abc',
        output: 'file body',
      },
    ]);
  });
});
