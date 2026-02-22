// API base URL - uses Vite proxy in dev, configurable via env
export const API_BASE = import.meta.env.VITE_GRAPHD_URL ?? '/api'

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit | number,
  timeoutMs = 5000
): Promise<T> {
  const resolvedTimeoutMs = typeof options === 'number' ? options : timeoutMs
  const init = typeof options === 'number' ? undefined : options

  // Compose the caller's abort signal (if any) with our timeout signal.
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), resolvedTimeoutMs)
  const externalSignal = init?.signal
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutController.signal])
    : timeoutController.signal

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...init,
      signal,
    })
    clearTimeout(timeoutId)

    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`)
    }
    return res.json()
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        // If the caller aborted, propagate as AbortError (not a timeout message).
        if (externalSignal?.aborted) throw err
        throw new Error('Request timeout - server not responding')
      }
      if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
        throw new Error(`Cannot connect to GraphD at ${API_BASE} - is the server running?`)
      }
    }
    throw err
  }
}

export interface ExportResponse {
  format: string
  table: string
  data: string // JSONL format
}

export interface GraphDSession {
  session_key: string
  client_type: string
  created_at: number | string // Unix timestamp (seconds or milliseconds) or ISO string
  last_accessed_at: number | string
  expires_at: number | string | null
  working_dir: string | null
  status: string
  metadata_json: string | null
}

export interface GraphDMessage {
  id: number
  session_key: string
  message_index: number
  role: string
  content: string
  request_id: string | null
  created_at: number
  metadata_json: string | null
}

export async function deleteSession(sessionKey: string): Promise<boolean> {
  const response = await fetchAPI<{ deleted: boolean }>(`/session/${sessionKey}`, {
    method: 'DELETE',
  })
  return response.deleted
}
