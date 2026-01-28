/**
 * iMessage Transformations
 *
 * Transforms raw iMessage data into canonical entities.
 */

import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { CanonicalSourceRef, Message, Conversation } from '../../models/canonical.js'
import type { Transformation, TransformResult, TransformOutput } from '../../transform/types.js'
import { IMessageSourceSchema, IChatSourceSchema, type IMessageSource, type IChatSource } from './schemas.js'

// ============ Helper Functions ============

function createSourceRef(
  accountId: string,
  entityType: string,
  sourceId: string,
  sourceVersion?: string
): CanonicalSourceRef {
  return {
    connector: 'imessage',
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
 * Normalize a phone number or email for use as platform_user_id.
 * Removes formatting, keeps only alphanumeric and @ . - _
 */
function normalizeContactId(id: string): string {
  // If it looks like an email, lowercase it
  if (id.includes('@')) {
    return id.toLowerCase().trim()
  }
  // Otherwise it's a phone - remove everything but digits and +
  return id.replace(/[^\d+]/g, '')
}

// ============ Transformations ============

/**
 * Transform iMessage message to canonical Message entity.
 */
export const imessageMessageTransform: Transformation<IMessageSource> = {
  id: 'imessage:message:v1',
  name: 'iMessage → Canonical Message',
  source: {
    connector: 'imessage',
    entityType: 'message',
  },
  inputSchema: IMessageSourceSchema,
  outputType: ['conversation', 'message'],

  transform(source, ctx): TransformResult {
    const sourceRef = createSourceRef(ctx.accountId, 'message', source.guid)
    const conversationSourceRef = createSourceRef(ctx.accountId, 'chat', source.chat.guid)
    const conversationSourceRefKey = sourceRefToKey(conversationSourceRef)

    // Build the canonical message
    const message: Message = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'message',
      thread_id: source.chat.guid,
      sender_identity_id: undefined, // Will be set if we create identity
      recipient_identity_ids: [],
      subject: undefined, // iMessage doesn't have subjects
      body_text: source.text ?? undefined,
      body_html: undefined,
      sent_at: source.is_from_me ? source.timestamp : undefined,
      received_at: source.is_from_me ? undefined : source.timestamp,
      attachment_ids: [],
      platform_thread_id: source.chat.guid,
      is_read: source.is_read,
      labels: [
        source.service, // 'iMessage' or 'SMS'
        ...(source.is_from_me ? ['sent'] : ['received']),
        ...(source.reaction_to ? ['reaction'] : []),
        ...(source.reply_to ? ['reply'] : []),
        ...(source.has_attachments ? ['has_attachments'] : []),
        ...(source.is_audio_message ? ['audio'] : []),
      ],
      metadata: {
        chat_identifier: source.chat.identifier,
        chat_display_name: source.chat.display_name,
        send_effect: source.send_effect,
        reaction_to: source.reaction_to,
        reply_to: source.reply_to,
        conversation_source_ref_key: conversationSourceRefKey,
        ...(source.text_truncated ? { text_truncated: true } : {}),
        ...(source.text_original_bytes != null ? { text_original_bytes: source.text_original_bytes } : {}),
        ...(source.text_bytes != null ? { text_bytes: source.text_bytes } : {}),
      },
    }

    const primary: TransformOutput = {
      entityType: 'message',
      data: message,
      displayText: source.text?.substring(0, 200) ?? '(no text)',
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    return {
      primary,
      related: [{
        entityType: 'conversation',
        data: {
          ...createBaseEntity(generateCanonicalId(), conversationSourceRef),
          entity_type: 'conversation',
          platform: 'imessage',
          message_ids: [],
          message_count: 0,
          participants: [],
          started_at: source.timestamp,
          topic: source.chat.display_name ?? source.chat.identifier,
          is_archived: false,
        } satisfies Conversation,
        displayText: source.chat.display_name ?? source.chat.identifier,
        sourceRefKey: conversationSourceRefKey,
      }],
    }
  },

  onError: 'quarantine',
  enabled: true,
  version: 1,
}

/**
 * Transform iMessage chat to canonical Conversation entity.
 */
export const imessageChatTransform: Transformation<IChatSource> = {
  id: 'imessage:chat:v1',
  name: 'iMessage Chat → Canonical Conversation',
  source: {
    connector: 'imessage',
    entityType: 'chat',
  },
  inputSchema: IChatSourceSchema,
  outputType: 'conversation',

  transform(source, ctx): TransformResult {
    const sourceRef = createSourceRef(ctx.accountId, 'chat', source.guid)

    // Build participant source refs
    const participants = source.participants.map((p) => ({
      connector: 'imessage' as const,
      account_id: ctx.accountId,
      entity_type: 'contact',
      source_id: normalizeContactId(p),
      last_synced_at: new Date().toISOString(),
    }))

    const conversation: Conversation = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'conversation',
      platform: 'imessage',
      message_ids: [], // Would need to be populated separately
      message_count: 0,
      participants,
      started_at: source.last_message_timestamp ?? new Date().toISOString(),
      topic: source.display_name ?? undefined,
      is_archived: source.is_archived,
      metadata: {
        chat_identifier: source.identifier,
        service: source.service,
        is_group: source.is_group,
      },
    }

    const primary: TransformOutput = {
      entityType: 'conversation',
      data: conversation,
      displayText: source.display_name ?? source.identifier,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    return {
      primary,
    }
  },

  onError: 'quarantine',
  enabled: true,
  version: 1,
}

/**
 * All iMessage transformations.
 */
export const imessageTransforms = [imessageMessageTransform, imessageChatTransform]
