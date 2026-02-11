/**
 * Streaming autocomplete API client.
 *
 * Sends a POST with the cursor context, reads SSE token chunks from the
 * response body stream, and fires `onToken` for each received token.
 */

import { API_BASE } from './fetch';

export interface AutocompleteParams {
  textBefore: string;
  textAfter?: string;
  title?: string;
}

/**
 * Stream inline completion tokens from the daemon.
 *
 * Resolves when the stream ends (or is aborted).  Throws only on network
 * errors — individual SSE parse failures are silently skipped.
 */
export async function streamCompletion(
  params: AutocompleteParams,
  signal: AbortSignal,
  onToken: (token: string) => void,
): Promise<void> {
  const res = await fetch(`${API_BASE}/cockpit/autocomplete/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Autocomplete API ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop()!; // keep incomplete trailing line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (payload.done) return;
        if (typeof payload.token === 'string') {
          onToken(payload.token);
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }
}
