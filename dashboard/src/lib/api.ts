// API base URL - uses Vite proxy in dev, configurable via env
export const API_BASE = import.meta.env.VITE_GRAPHD_URL ?? '/api'

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit | number,
  timeoutMs = 5000
): Promise<T> {
  const controller = new AbortController()
  const resolvedTimeoutMs = typeof options === 'number' ? options : timeoutMs
  const init = typeof options === 'number' ? undefined : options
  const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs)

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...init,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`)
    }
    return res.json()
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timeout - server not responding')
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
  created_at: number // Unix timestamp
  last_accessed_at: number
  expires_at: number | null
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
