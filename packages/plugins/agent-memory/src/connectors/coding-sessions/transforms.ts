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
import type { ConnectorType } from '../../ids.js'
import type { CanonicalSourceRef } from '../../models/canonical.js'
import {
  ClaudeSessionMessageSchema,
  ClaudeSummaryMessageSchema,
  type ClaudeSessionMessage,
  type ClaudeUserMessage,
  type ClaudeAssistantMessage,
  type ClaudeSummaryMessage,
  NovaSessionMessageSchema,
  NovaSummaryMessageSchema,
  type NovaSessionMessage,
  type NovaUserMessage,
  type NovaAssistantMessage,
  type NovaSummaryMessage,
} from './schemas.js'

// ============ Helper Functions ============

function createSourceRef(
  accountId: string,
  entityType: string,
  sourceId: string,
  sourceVersion?: string,
  connector: ConnectorType = 'claude_sessions'
): CanonicalSourceRef {
  return {
    connector,
    account_id: accountId,
    entity_type: entityType,
    source_id: sourceId,
    source_version: sourceVersion,
    last_synced_at: new Date().toISOString(),
  }
}

function createBaseEntity(id: string, sourceRef: CanonicalSourceRef) {
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
    const textBlocks = content
      .filter((block): block is { type: 'text'; text: string } =>
        block && typeof block === 'object' && block.type === 'text')
      .map(block => block.text)

    if (textBlocks.length > 0) {
      return textBlocks.join('\n')
    }

    const toolsUsed = extractToolUsage(content)
    if (toolsUsed.length > 0) {
      return `[Tool calls: ${toolsUsed.join(', ')}]`
    }
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
    const conversationSourceRefKey = `claude_sessions:${ctx.accountId}:conversation:${sessionId}`

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
              conversation_source_ref_key: conversationSourceRefKey,
            },
          },
          displayText: textContent.slice(0, 200),
        },
      })
    })

    // Create Conversation entity

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

  outputType: ['conversation', 'message'],

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
    const conversationSourceRef = createSourceRef(ctx.accountId, 'conversation', msg.sessionId)
    const conversationSourceRefKey = sourceRefToKey(conversationSourceRef)

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
            conversation_source_ref_key: conversationSourceRefKey,
          },
        },
        displayText: textContent.slice(0, 200),
      },
      related: [{
        entityType: 'conversation',
        sourceRefKey: conversationSourceRefKey,
        data: {
          ...createBaseEntity(generateCanonicalId(), conversationSourceRef),
          entity_type: 'conversation',
          platform: 'unknown',
          message_ids: [],
          message_count: 0,
          participants: [],
          started_at: msg.timestamp,
          topic: msg.slug ?? `Session ${msg.sessionId.slice(0, 8)}...`,
          is_archived: false,
          metadata: {
            agent: 'claude',
            session_id: msg.sessionId,
            project_path: msg.cwd,
            git_branch: msg.gitBranch,
            claude_version: msg.version,
            slug: msg.slug,
          },
        },
        displayText: msg.slug ?? `Session ${msg.sessionId.slice(0, 8)}...`,
      }],
    }
  },

  onError: 'skip',
  enabled: true,
  version: 1,
  description: 'Transforms individual Claude session messages into Message canonical entities',
}

/**
 * Transform Claude session summary to a Notification entity.
 * Summaries are AI-generated synopses of session conversations.
 */
export const claudeSummaryTransform: Transformation<ClaudeSummaryMessage> = {
  id: 'claude_sessions:summary_to_notification',
  name: 'Claude Summary → Notification',

  source: {
    connector: 'claude_sessions',
    entityType: 'session_summary',
  },

  inputSchema: ClaudeSummaryMessageSchema,

  outputType: 'notification',

  transform: (msg: ClaudeSummaryMessage, ctx: TransformContext): TransformResult => {
    const meta = (msg as { _meta?: { sessionId?: string; project?: string } })._meta ?? {}
    const sourceRef = createSourceRef(ctx.accountId, 'summary', msg.leafUuid)

    return {
      primary: {
        entityType: 'notification',
        sourceRefKey: sourceRefToKey(sourceRef),
        data: {
          ...createBaseEntity(generateCanonicalId(), sourceRef),
          entity_type: 'notification',
          notification_type: 'session_summary',
          title: 'Session Summary',
          body: msg.summary,
          triggered_at: new Date().toISOString(),
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
  description: 'Transforms Claude session summaries into Notification canonical entities',
}

// ============ Nova Session Transformations ============

/**
 * Transform individual Nova session message to Message entity.
 * Used when processing messages one at a time (incremental sync).
 */
export const novaMessageTransform: Transformation<NovaSessionMessage> = {
  id: 'nova_sessions:message_to_message',
  name: 'Nova Message → Message',

  source: {
    connector: 'nova_sessions',
    entityType: 'session_message',
    filter: (raw: unknown) => {
      const msg = raw as { type?: string }
      return msg.type === 'user' || msg.type === 'assistant'
    },
  },

  inputSchema: NovaSessionMessageSchema,

  outputType: ['conversation', 'message'],

  transform: (msg: NovaSessionMessage, ctx: TransformContext): TransformResult => {
    if (msg.type !== 'user' && msg.type !== 'assistant') {
      throw new Error(`Unexpected message type: ${msg.type}`)
    }

    const meta = (msg as { _meta?: { sessionId?: string; project?: string } })._meta ?? {}
    const textContent = extractTextContent(msg.content)
    const sessionId = msg.session_id

    const sourceRef = createSourceRef(ctx.accountId, 'message', msg.id, undefined, 'nova_sessions')
    const conversationSourceRef = createSourceRef(ctx.accountId, 'conversation', sessionId, undefined, 'nova_sessions')
    const conversationSourceRefKey = sourceRefToKey(conversationSourceRef)

    return {
      primary: {
        entityType: 'message',
        sourceRefKey: sourceRefToKey(sourceRef),
        data: {
          ...createBaseEntity(generateCanonicalId(), sourceRef),
          entity_type: 'message',
          thread_id: sessionId,
          body_text: textContent,
          sent_at: msg.timestamp,
          labels: [msg.type],
          metadata: {
            role: msg.type,
            session_id: sessionId,
            project: meta.project,
            model: msg.type === 'assistant' ? msg.model : undefined,
            tokens: msg.type === 'assistant' ? msg.tokens : undefined,
            conversation_source_ref_key: conversationSourceRefKey,
          },
        },
        displayText: textContent.slice(0, 200),
      },
      related: [{
        entityType: 'conversation',
        sourceRefKey: conversationSourceRefKey,
        data: {
          ...createBaseEntity(generateCanonicalId(), conversationSourceRef),
          entity_type: 'conversation',
          platform: 'unknown',
          message_ids: [],
          message_count: 0,
          participants: [],
          started_at: msg.timestamp,
          topic: `Session ${sessionId.slice(0, 8)}...`,
          is_archived: false,
          metadata: {
            agent: 'nova',
            session_id: sessionId,
            project: meta.project,
          },
        },
        displayText: `Session ${sessionId.slice(0, 8)}...`,
      }],
    }
  },

  onError: 'skip',
  enabled: true,
  version: 1,
  description: 'Transforms individual Nova session messages into Message canonical entities',
}

/**
 * Transform Nova session summary to a Notification entity.
 */
export const novaSummaryTransform: Transformation<NovaSummaryMessage> = {
  id: 'nova_sessions:summary_to_notification',
  name: 'Nova Summary → Notification',

  source: {
    connector: 'nova_sessions',
    entityType: 'session_summary',
  },

  inputSchema: NovaSummaryMessageSchema,

  outputType: 'notification',

  transform: (msg: NovaSummaryMessage, ctx: TransformContext): TransformResult => {
    const meta = (msg as { _meta?: { sessionId?: string; project?: string } })._meta ?? {}
    const sourceRef = createSourceRef(ctx.accountId, 'summary', msg.session_id, undefined, 'nova_sessions')

    return {
      primary: {
        entityType: 'notification',
        sourceRefKey: sourceRefToKey(sourceRef),
        data: {
          ...createBaseEntity(generateCanonicalId(), sourceRef),
          entity_type: 'notification',
          notification_type: 'session_summary',
          title: 'Session Summary',
          body: msg.summary,
          triggered_at: msg.created_at,
          metadata: {
            agent: 'nova',
            session_id: msg.session_id,
            project: meta.project,
          },
        },
        displayText: msg.summary.slice(0, 200),
      },
    }
  },

  onError: 'skip',
  enabled: true,
  version: 1,
  description: 'Transforms Nova session summaries into Notification canonical entities',
}

// ============ Exports ============

export const transforms = [
  claudeSessionTransform,
  claudeMessageTransform,
  claudeSummaryTransform,
]

export const novaTransforms = [
  novaMessageTransform,
  novaSummaryTransform,
]
