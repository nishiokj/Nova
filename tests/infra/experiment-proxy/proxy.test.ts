import { classifyUrl } from '../../../packages/infra/experiment-proxy/src/url_classifier.js';
import { createLLMCollector } from '../../../packages/infra/experiment-proxy/src/middleware/llm_collector.js';
import type { FetchContext, NextFn } from '../../../packages/infra/experiment-proxy/src/middleware.js';
import type { DataSink } from '../../../packages/infra/experiment-proxy/src/sink.js';

function makeContext(url: string, classification: FetchContext['classification']): FetchContext {
  return {
    url: new URL(url),
    method: 'POST',
    classification,
    startTime: performance.now(),
    meta: {},
  };
}

function makeSink(records: object[]): DataSink {
  return {
    write(record: object) {
      records.push(record);
    },
    flush() {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('experiment-proxy regressions', () => {
  it('classifies extra allowlist hosts as allowlisted instead of llm', () => {
    const classification = classifyUrl(
      new URL('https://example.com/api'),
      'POST',
      new Set(['example.com']),
    );
    expect(classification).toBe('allowlisted');
  });

  it('does not emit llm_call telemetry for allowlisted non-LLM traffic', async () => {
    const records: object[] = [];
    const middleware = createLLMCollector(makeSink(records), {
      enabled: true,
      allowOutbound: true,
      allowlist: new Set(['example.com']),
      captureRequest: false,
      captureResponse: false,
      maxBodyBytes: 1024,
    });

    const input = new Request('https://example.com/api', {
      method: 'POST',
      body: JSON.stringify({ ping: true }),
      headers: { 'content-type': 'application/json' },
    });

    const next: NextFn = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    const response = await middleware(
      makeContext('https://example.com/api', 'allowlisted'),
      input,
      undefined,
      next,
    );
    expect(response.status).toBe(200);
    expect(records).toHaveLength(0);
  });

  it('detects streaming when request body is passed via Request input', async () => {
    const records: object[] = [];
    const middleware = createLLMCollector(makeSink(records), {
      enabled: true,
      allowOutbound: true,
      allowlist: new Set(),
      captureRequest: false,
      captureResponse: false,
      maxBodyBytes: 1024,
    });

    const input = new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4.5', stream: true }),
      headers: { 'content-type': 'application/json' },
    });

    const encoder = new TextEncoder();
    const sse = 'data: {"usage":{"input_tokens":3,"output_tokens":4}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    });

    const next: NextFn = async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

    const response = await middleware(
      makeContext('https://api.anthropic.com/v1/messages', 'llm'),
      input,
      undefined,
      next,
    );
    await response.text();

    let llmRecord: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i += 1) {
      llmRecord = records.find((record) => (record as { type?: string }).type === 'llm_call') as
        | Record<string, unknown>
        | undefined;
      if (llmRecord) break;
      await sleep(10);
    }

    expect(llmRecord).toBeDefined();
    expect(llmRecord?.is_streaming).toBe(true);
  });
});
