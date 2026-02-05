/**
 * Memory Routes
 *
 * Conversational memory query endpoints.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'
import type { Conversation, Message } from '../../models/canonical.js'

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

  // List recent conversational memory digests (no search query)
  server.get('/memory/recent', async (req) => {
    const { limit = '10', connectors } = req.query

    const parsedLimit = Math.min(50, Math.max(1, parseInt(String(limit), 10) || 10))
    const connectorList = parseConnectors(connectors)

    const rows = await sql<{
      conversation_id: string
      summary: string
      updated_at: Date
      source_timestamp: Date | null
      topic: string | null
    }[]>`
      SELECT
        d.conversation_id,
        d.summary,
        d.updated_at,
        c.source_timestamp,
        c.data->>'topic' as topic
      FROM conversation_digests d
      JOIN canonical_conversation c ON c.id = d.conversation_id
      WHERE (
        ${connectorList.length} = 0
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(c.data->'source_refs', '[]'::jsonb)) ref
          WHERE ref->>'connector' = ANY(${connectorList})
        )
      )
      ORDER BY COALESCE(c.source_timestamp, d.updated_at) DESC
      LIMIT ${parsedLimit}
    `

    return {
      body: {
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

  // Expand a conversation to its full message chain
  server.get('/memory/conversations/:id/messages', async (req) => {
    const { id } = req.params
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw badRequest('Missing required path parameter: id')
    }

    const { limit = '50', offset = '0' } = req.query
    const parsedLimit = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50))
    const parsedOffset = Math.max(0, parseInt(String(offset), 10) || 0)

    const conversationEntity = await daemon.entityRepo.findById(id)
    if (!conversationEntity || conversationEntity.entity_type !== 'conversation') {
      throw notFound(`Conversation not found: ${id}`)
    }

    const conversation = conversationEntity.data as Conversation
    const messageIds = Array.isArray(conversation.message_ids) ? conversation.message_ids : []
    const sliceIds = messageIds.slice(parsedOffset, parsedOffset + parsedLimit)

    const messageEntities = sliceIds.length > 0
      ? await daemon.entityRepo.findByIds(sliceIds)
      : []

    const messageMap = new Map(
      messageEntities
        .filter((entity) => entity.entity_type === 'message')
        .map((entity) => [entity.id, entity])
    )

    const orderedMessages = sliceIds
      .map((messageId) => messageMap.get(messageId))
      .filter((entity): entity is typeof messageEntities[number] => !!entity)

    return {
      body: {
        conversation: {
          id: conversationEntity.id,
          topic: conversation.topic,
          started_at: conversation.started_at,
          ended_at: conversation.ended_at,
          message_count: conversation.message_count,
          participants: conversation.participants ?? [],
          source_timestamp: conversationEntity.source_timestamp,
          created_at: conversationEntity.created_at,
        },
        messages: orderedMessages.map((entity) => {
          const message = entity.data as Message
          return {
            id: entity.id,
            conversation_id: message.conversation_id ?? conversationEntity.id,
            sender_identity_id: message.sender_identity_id,
            recipient_identity_ids: message.recipient_identity_ids ?? [],
            subject: message.subject,
            body_text: message.body_text,
            body_html: message.body_html,
            sent_at: message.sent_at,
            received_at: message.received_at,
            created_at: entity.created_at,
            source_timestamp: entity.source_timestamp,
          }
        }),
        total: messageIds.length,
        offset: parsedOffset,
        limit: parsedLimit,
      },
    }
  })
}
