import type { LLMResponse, StreamParams } from 'types';
import { Effect } from 'effect';
import { CodexProvider } from 'llm/providers/codex.js';
import { VercelGatewayProvider } from 'llm/providers/vercel-gateway.js';
import type { ProviderContext } from 'llm/providers/types.js';

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

async function consumeStream(
  provider: CodexProvider,
  context: ProviderContext,
  params: StreamParams
): Promise<{ chunks: string[]; response: LLMResponse }> {
  const chunks: string[] = [];
  const response = await Effect.runPromise(
    provider.respond(context, {
      ...params,
      onChunk: (chunk: string) => chunks.push(chunk),
    })
  );

  return {
    chunks,
    response,
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
      llm: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 },
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
      llm: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 },
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

  it('unwraps apply_patch JSON fallback arguments from response output', () => {
    const provider = new CodexProvider();
    const patchText = '*** Begin Patch\n*** Add File: patched.txt\n+ok\n*** End Patch';

    const calls = (provider as unknown as {
      parseToolCalls(response: Record<string, unknown>): unknown[];
    }).parseToolCalls({
      output: [
        {
          type: 'function_call',
          call_id: 'call_patch_1',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: patchText }),
        },
      ],
    });

    expect(calls).toEqual([
      {
        id: 'call_patch_1',
        name: 'apply_patch',
        arguments: { input: patchText },
      },
    ]);
  });

  it('drops malformed apply_patch arguments instead of executing empty JSON as a patch', () => {
    const provider = new CodexProvider();

    const calls = (provider as unknown as {
      parseToolCalls(response: Record<string, unknown>): unknown[];
    }).parseToolCalls({
      output: [
        {
          type: 'function_call',
          call_id: 'call_patch_empty',
          name: 'apply_patch',
          arguments: '{}',
        },
      ],
    });

    expect(calls).toEqual([]);
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
      llm: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 },
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
      llm: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 },
    });

    expect(capturedBody).not.toBeNull();
    const input = (capturedBody as Record<string, unknown> | null)?.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { type: 'message', role: 'user', content: 'Check this file' },
      {
        type: 'function_call',
        call_id: 'call_abc',
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'packages/core/llm/src/providers/codex.ts' }),
      },
      {
        type: 'function_call_output',
        call_id: 'call_abc',
        output: 'file body',
      },
    ]);
  });

  it('replays apply_patch history using the JSON function shape expected by Codex', () => {
    const provider = new CodexProvider();
    const patchText = '*** Begin Patch\n*** Add File: patched.txt\n+ok\n*** End Patch';

    const input = (provider as unknown as {
      formatInput(messages: Record<string, unknown>[]): Record<string, unknown>[];
    }).formatInput([
        {
          type: 'function_call',
          call_id: 'call_patch_history',
          id: 'call_patch_history',
          name: 'apply_patch',
          arguments: { input: patchText },
        },
        {
          type: 'function_call_output',
          call_id: 'call_patch_history',
          output: 'Patch applied',
        },
      ]);

    expect(input[0]).toEqual({
      type: 'function_call',
      call_id: 'call_patch_history',
      name: 'apply_patch',
      arguments: JSON.stringify({ input: patchText }),
    });
  });

  it('compiles response schema for codex without anyOf', async () => {
    const provider = new CodexProvider();
    const context = createContext();
    let capturedBody: Record<string, unknown> | null = null;

    const rawSse = [
      sseFrame({
        type: 'response.completed',
        response: {
          id: 'resp_codex_schema',
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

    const originalSchema = {
      anyOf: [
        {
          type: 'object',
          properties: { action: { type: 'string', const: 'done' } },
          required: ['action'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { action: { type: 'string', const: 'continue' } },
          required: ['action'],
          additionalProperties: false,
        },
      ],
    };

    await consumeStream(provider, context, {
      messages: [{ role: 'user', content: 'return structured output' }],
      llm: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 64_000 },
      responseSchema: {
        name: 'test_schema',
        schemaId: 'agent_action',
        schema: originalSchema,
        strict: true,
      },
    });

    const outboundSchema = (
      ((capturedBody as Record<string, unknown> | null)?.text as { format?: { schema?: unknown } })?.format?.schema ?? null
    ) as Record<string, unknown> | null;

    expect(outboundSchema).not.toBeNull();
    const outboundSerialized = JSON.stringify(outboundSchema);
    expect(outboundSerialized).not.toContain('"anyOf"');
    expect(outboundSerialized).not.toContain('"oneOf"');
    expect(outboundSchema?.type).toBe('object');
    expect((outboundSchema?.properties as Record<string, unknown>)?.result).toBeUndefined();
    expect((((outboundSchema?.properties as Record<string, unknown>)?.action as Record<string, unknown> | undefined)?.enum)).toEqual(['done', 'continue']);

    // Compiler must not mutate caller-owned schema objects.
    expect(JSON.stringify(originalSchema)).toContain('"anyOf"');
  });

  it('discovers visible Codex models with account-scoped auth and ETag support', async () => {
    const provider = new CodexProvider();
    const context = createContext();

    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toContain('/models?client_version=');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
      expect(new Headers(init?.headers).get('Chatgpt-Account-Id')).toBe('acct_test');
      expect(new Headers(init?.headers).get('If-None-Match')).toBe('old-etag');
      return Response.json({
        models: [
          {
            slug: 'gpt-visible',
            display_name: 'GPT Visible',
            description: 'Visible model',
            visibility: 'list',
            supported_in_api: true,
            context_window: 272_000,
            supported_reasoning_levels: [
              { effort: 'low', description: 'Low' },
              { effort: 'high', description: 'High' },
            ],
          },
          {
            slug: 'gpt-hidden',
            display_name: 'GPT Hidden',
            visibility: 'hide',
            supported_in_api: true,
          },
        ],
      }, { headers: { ETag: 'new-etag' } });
    }) as typeof fetch;

    await expect(provider.listModels?.(context, { etag: 'old-etag' })).resolves.toEqual({
      models: [{
        id: 'gpt-visible',
        name: 'GPT Visible',
        description: 'Visible model',
        context_window: 272_000,
        reasoning: ['low', 'high'],
      }],
      etag: 'new-etag',
    });
  });

  it('returns an unchanged marker for a cached Codex catalog', async () => {
    const provider = new CodexProvider();
    globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;

    await expect(provider.listModels?.(createContext(), { etag: 'current-etag' })).resolves.toEqual({
      models: [],
      etag: 'current-etag',
      notModified: true,
    });
  });

  it('discovers language models from the Vercel Gateway catalog', async () => {
    const provider = new VercelGatewayProvider();
    const context = createContext();
    context.config = {
      ...context.config,
      provider: 'vercel-gateway',
      displayProvider: 'vercel-gateway',
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
    };

    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe('https://ai-gateway.vercel.sh/v1/models');
      return Response.json({
        data: [
          {
            id: 'anthropic/claude-test',
            name: 'Claude Test',
            description: 'Language model',
            type: 'language',
            context_window: 200_000,
            max_tokens: 64_000,
          },
          { id: 'openai/embed-test', name: 'Embed Test', type: 'embedding' },
        ],
      });
    }) as typeof fetch;

    await expect(provider.listModels?.(context)).resolves.toEqual({
      models: [{
        id: 'anthropic/claude-test',
        name: 'Claude Test',
        description: 'Language model',
        context_window: 200_000,
        max_tokens: 64_000,
      }],
    });
  });
});
