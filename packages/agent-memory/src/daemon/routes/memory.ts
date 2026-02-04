/**
 * Memory Routes
 *
 * Conversational memory query endpoints.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest } from '../server.js'

const DEFAULT_CONNECTORS = ['claude_sessions', 'rex_sessions']

function parseConnectors(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return DEFAULT_CONNECTORS
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

export function registerMemoryRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { sql } = daemon

  // Search conversational memory digests
  server.get('/memory/search', async (req) => {
    const { q, limit = '8', connectors } = req.query
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      throw badRequest('Missing required query parameter: q')
    }

    const parsedLimit = Math.min(50, Math.max(1, parseInt(String(limit), 10) || 8))
    const connectorList = parseConnectors(connectors)

    // Use full-text search with ts_rank for relevance ordering
    const rows = await sql<{
      conversation_id: string
      summary: string
      updated_at: Date
      source_timestamp: Date | null
      topic: string | null
      rank: number
    }[]>`
      SELECT
        d.conversation_id,
        d.summary,
        d.updated_at,
        c.source_timestamp,
        c.data->>'topic' as topic,
        GREATEST(
          COALESCE(ts_rank(d.search_vector, plainto_tsquery('english', ${q})), 0),
          COALESCE(ts_rank(c.search_vector, plainto_tsquery('english', ${q})), 0)
        ) as rank
      FROM conversation_digests d
      JOIN canonical_conversation c ON c.id = d.conversation_id
      WHERE (
        d.search_vector @@ plainto_tsquery('english', ${q})
        OR c.search_vector @@ plainto_tsquery('english', ${q})
      )
      AND (
        ${connectorList.length} = 0
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(c.data->'source_refs', '[]'::jsonb)) ref
          WHERE ref->>'connector' = ANY(${connectorList})
        )
      )
      ORDER BY rank DESC, COALESCE(c.source_timestamp, d.updated_at) DESC
      LIMIT ${parsedLimit}
    `

    return {
      body: {
        query: q,
        items: rows.map((row) => ({
          conversation_id: row.conversation_id,
          summary: row.summary,
          topic: row.topic ?? undefined,
          updated_at: row.updated_at.toISOString(),
          source_timestamp: row.source_timestamp?.toISOString(),
        })),
      },
    }
  })
}
