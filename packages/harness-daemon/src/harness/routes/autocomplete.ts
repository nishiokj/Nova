/**
 * Autocomplete route — thin proxy to any OpenAI-compatible endpoint.
 *
 * Configure via env:
 *   AUTOCOMPLETE_ENDPOINT  — base URL (default: http://localhost:11434/v1)
 *   AUTOCOMPLETE_MODEL     — model name (default: qwen2.5-coder:1.5b)
 *   AUTOCOMPLETE_API_KEY   — optional, omit for local inference
 *   AUTOCOMPLETE_MAX_TOKENS — max tokens to generate (default: 60, cap 200)
 *
 * Forwards to ${ENDPOINT}/chat/completions with streaming, converts the
 * OpenAI SSE format into our simpler `data: {"token":"..."}\n\n` format.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody, asString } from './utils.js';

const ENDPOINT = process.env.AUTOCOMPLETE_ENDPOINT ?? 'http://localhost:11434/v1';
const MODEL = process.env.AUTOCOMPLETE_MODEL ?? 'qwen2.5-coder:1.5b';
const API_KEY = process.env.AUTOCOMPLETE_API_KEY ?? '';
const MAX_TOKENS = Math.min(Number(process.env.AUTOCOMPLETE_MAX_TOKENS) || 60, 200);

const SYSTEM_PROMPT =
  'Continue the markdown text naturally. Output ONLY the continuation, no preamble.';

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

  const userContent = title ? `Title: ${title}\n\n${textBefore}` : textBefore;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent + (textAfter ? `\n[text after cursor]: ${textAfter}` : '') },
  ];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  let upstream: Response;
  try {
    upstream = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
        stream: true,
      }),
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Upstream unreachable: ${(err as Error).message}` }));
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Upstream ${upstream.status}: ${text}` }));
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

  const reader = upstream.body?.getReader();
  if (!reader) {
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buf = '';

  try {
    for (;;) {
      if (aborted) break;
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const chunk = JSON.parse(payload);
          const token = chunk.choices?.[0]?.delta?.content;
          if (typeof token === 'string' && token.length > 0 && !aborted) {
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } catch {
    // upstream read error — client likely disconnected
  } finally {
    reader.cancel().catch(() => {});
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  }
}
