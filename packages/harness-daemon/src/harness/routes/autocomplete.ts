/**
 * Autocomplete route — SSE streaming inline completions via a fast LLM.
 *
 * Lazy-initializes a module-scoped LLM adapter on first request.
 * Streams token chunks as SSE `data:` lines back to the client.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createAdapter, type LLMAdapter } from 'llm';
import type { LLMRequestConfig, LLMResponse } from 'types';
import { getProviderBaseUrl, getCanonicalProvider, getProviderEnvVar } from 'types';
import { readJsonBody, asString } from './utils.js';

// ── configuration from env ──────────────────────────────────────────

const PROVIDER = process.env.AUTOCOMPLETE_PROVIDER ?? 'groq';
const MODEL = process.env.AUTOCOMPLETE_MODEL ?? 'llama-3.3-70b-versatile';
const MAX_TOKENS = Math.min(Number(process.env.AUTOCOMPLETE_MAX_TOKENS) || 60, 200);

const SYSTEM_PROMPT =
  'Continue the markdown text naturally. Output ONLY the continuation, no preamble.';

// ── lazy adapter singleton ──────────────────────────────────────────

let adapter: LLMAdapter | null = null;

function getAdapter(): LLMAdapter {
  if (adapter) return adapter;

  const envVar = getProviderEnvVar(PROVIDER);
  const apiKey = process.env[envVar];
  if (!apiKey) {
    throw new Error(`Missing API key: set ${envVar} environment variable`);
  }

  const canonical = getCanonicalProvider(PROVIDER);
  adapter = createAdapter({
    apiKeys: { [canonical]: apiKey },
  });
  return adapter;
}

// ── route handler ───────────────────────────────────────────────────

export async function handlePostAutocomplete(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const textBefore = asString(body.textBefore);
  if (!textBefore) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'textBefore is required' }));
    return;
  }
  const textAfter = asString(body.textAfter) ?? '';
  const title = asString(body.title) ?? '';

  let llm: LLMAdapter;
  try {
    llm = getAdapter();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
    return;
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let aborted = false;
  req.on('close', () => { aborted = true; });

  const userContent = title
    ? `Title: ${title}\n\n${textBefore}`
    : textBefore;

  const llmConfig: LLMRequestConfig = {
    provider: getCanonicalProvider(PROVIDER),
    displayProvider: PROVIDER,
    model: MODEL,
    baseUrl: getProviderBaseUrl(PROVIDER),
    maxTokens: MAX_TOKENS,
    temperature: 0.3,
  };

  try {
    const stream = llm.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
      system: SYSTEM_PROMPT,
      llm: llmConfig,
      ...(textAfter ? {} : {}), // reserved for future context-after usage
      onChunk(chunk: string) {
        if (aborted) return;
        res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
      },
    });

    // Drain the generator to completion
    let result: IteratorResult<string, LLMResponse>;
    do {
      result = await stream.next();
    } while (!result.done && !aborted);

    if (!aborted) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }
  } catch (err) {
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
    }
  } finally {
    if (!aborted) {
      res.end();
    }
  }
}
