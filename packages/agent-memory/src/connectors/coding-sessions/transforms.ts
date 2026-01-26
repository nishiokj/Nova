/**
 * Coding Agent Session Transformations
 *
 * Deterministic transformations from raw session data to canonical entities.
 * Produces Conversation and Message entities from session JSONL files.
 *
 * @module connectors/coding-sessions/transforms
 */

import type { Transformation, TransformContext, TransformResult } from '../../transform/types.js'
import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { Identity } from '../../models/canonical.js'
import {
  ClaudeSessionMessageSchema,
  ClaudeSummaryMessageSchema,
  type ClaudeSessionMessage,
  type ClaudeUserMessage,
  type ClaudeAssistantMessage,
  type ClaudeSummaryMessage,
} from './schemas.js'

// ============ Helper Functions ============

function createSourceRef(
  accountId: string,
  entityType: string,
  sourceId: string,
  sourceVersion?: string
): Identity['source_refs'][0] {
  return {
    connector: 'claude_sessions',
    account_id: accountId,
    entity_type: entityType,
    source_id: sourceId,
    source_version: sourceVersion,
    last_synced_at: new Date().toISOString(),
  }
}

function createBaseEntity(id: string, sourceRef: Identity['source_refs'][0]) {
  const now = new Date().toISOString()
  return {
    id,
    created_at: now,
    updated_at: now,
    source_refs: [sourceRef],
  }
}

/**
 * Extract text content from message content (handles string or content blocks)
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: 'text'; text: string } =>
        block && typeof block === 'object' && block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }

  return ''
}

/**
 * Extract tool usage from assistant message
 */
function extractToolUsage(content: unknown): string[] {
  if (!Array.isArray(content)) return []

  return content
    .filter((block): block is { type: 'tool_use'; name: string } =>
      block && typeof block === 'object' && block.type === 'tool_use')
    .map(block => block.name)
}

// ============ Claude Session Transformations ============

/**
 * Transform Claude session messages to Conversation + Message entities.
 *
 * This transformation:
 * 1. Creates a Conversation entity for the session
 * 2. Creates Message entities for each user/assistant turn
 * 3. Links messages to the conversation via conversation_id
 */
export const claudeSessionTransform: Transformation<ClaudeSessionMessage[]> = {
  id: 'claude_sessions:session_to_conversation',
  name: 'Claude Session → Conversation + Messages',

  source: {
    connector: 'claude_sessions',
    entityType: 'session',  // Note: This processes batched session data
  },

  inputSchema: ClaudeSessionMessageSchema.array(),

  outputType: ['conversation', 'message'],

  transform: (messages: ClaudeSessionMessage[], ctx: TransformContext): TransformResult[] => {
    const results: TransformResult[] = []

    // Extract session metadata from first message
    const firstUserMsg = messages.find((m): m is ClaudeUserMessage => m.type === 'user')
    const lastMsg = messages[messages.length - 1]

    if (!firstUserMsg) {
      return []  // No valid messages
    }

    const sessionId = firstUserMsg.sessionId
    const messageIds: string[] = []

    // Create Message entities for each turn
    const conversationalMessages = messages.filter(
      (m): m is ClaudeUserMessage | ClaudeAssistantMessage =>
        m.type === 'user' || m.type === 'assistant'
    )

    conversationalMessages.forEach((msg, index) => {
      const msgSourceRefKey = `claude_sessions:${ctx.accountId}:message:${msg.uuid}`
      messageIds.push(msgSourceRefKey)

      const textContent = extractTextContent(msg.message.content)
      const toolsUsed = msg.type === 'assistant'
        ? extractToolUsage(msg.message.content)
        : []

      results.push({
        primary: {
          entityType: 'message',
          sourceRefKey: msgSourceRefKey,
          data: {
            entity_type: 'message',
            thread_id: sessionId,  // Use session as thread
            body_text: textContent,
            sent_at: msg.timestamp,
            labels: [msg.type],  // 'user' or 'assistant'
            metadata: {
              role: msg.type,
              sequence_number: index,
              session_id: sessionId,
              model: msg.type === 'assistant' ? msg.message.model : undefined,
              tools_used: toolsUsed.length > 0 ? toolsUsed : undefined,
              usage: msg.type === 'assistant' ? msg.message.usage : undefined,
              cwd: msg.cwd,
              git_branch: msg.gitBranch,
              claude_version: msg.version,
            },
          },
          displayText: textContent.slice(0, 200),
        },
      })
    })

    // Create Conversation entity
    const conversationSourceRefKey = `claude_sessions:${ctx.accountId}:conversation:${sessionId}`

    // Extract summary if present
    const summaryMsg = messages.find(m => m.type === 'summary')
    const summary = summaryMsg?.type === 'summary' ? summaryMsg.summary : undefined

    // Get timestamps
    const startedAt = firstUserMsg.timestamp
    const endedAt = lastMsg && ('timestamp' in lastMsg) ? lastMsg.timestamp : startedAt

    results.unshift({
      primary: {
        entityType: 'conversation',
        sourceRefKey: conversationSourceRefKey,
        data: {
          entity_type: 'conversation',
          started_at: startedAt,
          ended_at: endedAt,
          message_count: conversationalMessages.length,
          message_ids: messageIds,
          topic: summary,
          metadata: {
            agent: 'claude',
            session_id: sessionId,
            project_path: firstUserMsg.cwd,
            git_branch: firstUserMsg.gitBranch,
            claude_version: firstUserMsg.version,
            slug: firstUserMsg.slug,
          },
        },
        displayText: summary ?? `Session ${sessionId.slice(0, 8)}...`,
      },
    })

    return results
  },

  onError: 'skip',
  enabled: true,
  version: 1,
  description: 'Transforms Claude Code session JSONL data into Conversation and Message canonical entities',
}

/**
 * Transform individual Claude session message to Message entity.
 * Used when processing messages one at a time (incremental sync).
 */
export const claudeMessageTransform: Transformation<ClaudeSessionMessage> = {
  id: 'claude_sessions:message_to_message',
  name: 'Claude Message → Message',

  source: {
    connector: 'claude_sessions',
    entityType: 'session_message',
    // Only process user and assistant messages
    filter: (raw: unknown) => {
      const msg = raw as { type?: string }
      return msg.type === 'user' || msg.type === 'assistant'
    },
  },

  inputSchema: ClaudeSessionMessageSchema,

  outputType: 'message',

  transform: (msg: ClaudeSessionMessage, ctx: TransformContext): TransformResult => {
    if (msg.type !== 'user' && msg.type !== 'assistant') {
      throw new Error(`Unexpected message type: ${msg.type}`)
    }

    const meta = (msg as { _meta?: { sessionId?: string; project?: string } })._meta ?? {}
    const textContent = extractTextContent(msg.message.content)
    const toolsUsed = msg.type === 'assistant'
      ? extractToolUsage(msg.message.content)
      : []

    const sourceRef = createSourceRef(ctx.accountId, 'message', msg.uuid)

    return {
      primary: {
        entityType: 'message',
        sourceRefKey: sourceRefToKey(sourceRef),
        data: {
          ...createBaseEntity(generateCanonicalId(), sourceRef),
          entity_type: 'message',
          thread_id: msg.sessionId,
          body_text: textContent,
          sent_at: msg.timestamp,
          labels: [msg.type],
          metadata: {
            role: msg.type,
            session_id: msg.sessionId,
            project: meta.project,
            model: msg.type === 'assistant' ? msg.message.model : undefined,
            tools_used: toolsUsed.length > 0 ? toolsUsed : undefined,
            usage: msg.type === 'assistant' ? msg.message.usage : undefined,
            cwd: msg.cwd,
            git_branch: msg.gitBranch,
            claude_version: msg.version,
          },
        },
        displayText: textContent.slice(0, 200),
      },
    }
  },

  onError: 'skip',
  enabled: true,
  version: 1,
  description: 'Transforms individual Claude session messages into Message canonical entities',
}

/**
 * Transform Claude session summary to an Observation entity.
 * Summaries are AI-generated synopses of session conversations.
 */
export const claudeSummaryTransform: Transformation<ClaudeSummaryMessage> = {
  id: 'claude_sessions:summary_to_observation',
  name: 'Claude Summary → Observation',

  source: {
    connector: 'claude_sessions',
    entityType: 'session_summary',
  },

  inputSchema: ClaudeSummaryMessageSchema,

  outputType: 'observation',

  transform: (msg: ClaudeSummaryMessage, ctx: TransformContext): TransformResult => {
    const meta = (msg as { _meta?: { sessionId?: string; project?: string } })._meta ?? {}
    const sourceRef = createSourceRef(ctx.accountId, 'summary', msg.leafUuid)

    return {
      primary: {
        entityType: 'observation',
        sourceRefKey: sourceRefToKey(sourceRef),
        data: {
          ...createBaseEntity(generateCanonicalId(), sourceRef),
          entity_type: 'observation',
          content: msg.summary,
          observation_type: 'summary',
          related_entity_ids: [],
          metadata: {
            agent: 'claude',
            session_id: meta.sessionId,
            project: meta.project,
            leaf_uuid: msg.leafUuid,
          },
        },
        displayText: msg.summary.slice(0, 200),
      },
    }
  },

  onError: 'skip',
  enabled: true,
  version: 1,
  description: 'Transforms Claude session summaries into Observation canonical entities',
}

// ============ Exports ============

export const transforms = [
  claudeSessionTransform,
  claudeMessageTransform,
  claudeSummaryTransform,
]
