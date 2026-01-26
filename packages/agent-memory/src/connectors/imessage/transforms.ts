/**
 * iMessage Transformations
 *
 * Transforms raw iMessage data into canonical entities.
 */

import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { Identity, Message, Conversation } from '../../models/canonical.js'
import type { Transformation, TransformResult, TransformOutput } from '../../transform/types.js'
import { IMessageSourceSchema, IChatSourceSchema, type IMessageSource, type IChatSource } from './schemas.js'

// ============ Helper Functions ============

function createSourceRef(
  accountId: string,
  entityType: string,
  sourceId: string,
  sourceVersion?: string
): Identity['source_refs'][0] {
  return {
    connector: 'imessage',
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

/**
 * Build an Identity entity from a contact ID (phone or email).
 */
function buildIdentity(
  accountId: string,
  contactId: string
): { entity: Identity; output: TransformOutput } {
  const normalizedId = normalizeContactId(contactId)
  const sourceRef = createSourceRef(accountId, 'contact', normalizedId)

  const isEmail = contactId.includes('@')

  const identity: Identity = {
    ...createBaseEntity(generateCanonicalId(), sourceRef),
    entity_type: 'identity',
    platform: 'imessage',
    platform_user_id: normalizedId,
    display_name: contactId, // Use original as display name
    email: isEmail ? contactId.toLowerCase() : undefined,
  }

  return {
    entity: identity,
    output: {
      entityType: 'identity',
      data: identity,
      displayText: contactId,
      sourceRefKey: sourceRefToKey(sourceRef),
    },
  }
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
  outputType: 'message',

  transform(source, ctx): TransformResult {
    const sourceRef = createSourceRef(ctx.accountId, 'message', source.guid)

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
      },
    }

    const primary: TransformOutput = {
      entityType: 'message',
      data: message,
      displayText: source.text?.substring(0, 200) ?? '(no text)',
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    const related: TransformOutput[] = []

    // Create identity for the other party (not "me")
    if (!source.is_from_me && source.sender.id !== 'unknown') {
      const senderIdentity = buildIdentity(ctx.accountId, source.sender.id)
      related.push(senderIdentity.output)
      message.sender_identity_id = senderIdentity.entity.id
    }

    // For messages I sent, create identity for the chat recipient
    // (use chat.identifier as the recipient)
    if (source.is_from_me && source.chat.identifier) {
      const recipientIdentity = buildIdentity(ctx.accountId, source.chat.identifier)
      related.push(recipientIdentity.output)
      message.recipient_identity_ids.push(recipientIdentity.entity.id)
    }

    return {
      primary,
      related: related.length > 0 ? related : undefined,
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

    // Create identities for all participants
    const related: TransformOutput[] = []
    for (const participant of source.participants) {
      const identity = buildIdentity(ctx.accountId, participant)
      related.push(identity.output)
    }

    return {
      primary,
      related: related.length > 0 ? related : undefined,
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
