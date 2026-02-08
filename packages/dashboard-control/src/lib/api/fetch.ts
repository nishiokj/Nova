/**
 * Control Plane API Client — shared fetch utilities.
 */

export const API_BASE = '/control-plane';

export async function fetchAPI<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const parsed = await res.json() as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      detail = null;
    }
    throw new Error(detail ? `API error: ${res.status} ${detail}` : `API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function postAPI<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const parsed = await res.json() as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      detail = null;
    }
    throw new Error(detail ? `API error: ${res.status} ${detail}` : `API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function postAPIResult<T extends Record<string, unknown>>(
  endpoint: string,
  body: unknown
): Promise<T & { statusCode: number }> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    const json = await res.json() as unknown;
    if (typeof json === 'object' && json !== null) {
      parsed = json as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  if (!res.ok && typeof parsed.error !== 'string') {
    parsed.error = `API error: ${res.status} ${res.statusText}`;
  }
  if (typeof parsed.success !== 'boolean') {
    parsed.success = res.ok;
  }
  return {
    ...(parsed as T),
    statusCode: res.status,
  };
}
