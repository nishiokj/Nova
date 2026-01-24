/**
 * Gmail Entity Mappers
 *
 * Transforms Gmail API responses into canonical entities.
 *
 * @module connectors/gmail/mappers
 */

import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { EntityMapper, MapperContext, MappedEntity } from '../../sync/types.js'
import type { Identity, Message, EntityType } from '../../models/canonical.js'
import {
  GmailMessageSchema,
  type GmailMessage,
  type GmailMessageHeader,
  type GmailMessagePart,
} from './schemas.js'

// ============ Helper Functions ============

/**
 * Create a source ref for a Gmail entity.
 */
function createSourceRef(
  accountId: string,
  entityType: string,
  sourceId: string,
  sourceVersion?: string
): Identity['source_refs'][0] {
  return {
    connector: 'gmail',
    account_id: accountId,
    entity_type: entityType,
    source_id: sourceId,
    source_version: sourceVersion,
    last_synced_at: new Date().toISOString(),
  }
}

/**
 * Create base entity fields.
 */
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
 * Extract header value by name from headers array.
 */
function getHeaderValue(headers: GmailMessageHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase())
  return header?.value
}

/**
 * Extract body text from message payload.
 * Recursively searches through parts for text/plain content.
 */
function extractBodyText(payload: GmailMessagePart): string | undefined {
  // Check if this part has text/plain content
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }

  // Check children parts
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBodyText(part)
      if (text) return text
    }
  }

  return undefined
}

/**
 * Extract body HTML from message payload.
 * Recursively searches through parts for text/html content.
 */
function extractBodyHtml(payload: GmailMessagePart): string | undefined {
  // Check if this part has text/html content
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }

  // Check children parts
  if (payload.parts) {
    for (const part of payload.parts) {
      const html = extractBodyHtml(part)
      if (html) return html
    }
  }

  return undefined
}

/**
 * Extract attachment metadata from message payload.
 */
function extractAttachments(payload: GmailMessagePart): Array<{
  filename: string
  size?: number
  attachmentId: string
  mimeType?: string
}> {
  const attachments: Array<{ filename: string; size?: number; attachmentId: string; mimeType?: string }> = []

  // Check if this part is an attachment
  if (payload.body?.attachmentId && payload.filename) {
    attachments.push({
      filename: payload.filename,
      size: payload.body.size,
      attachmentId: payload.body.attachmentId,
      mimeType: payload.mimeType,
    })
  }

  // Check children parts
  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part))
    }
  }

  return attachments
}

/**
 * Parse email addresses from a header value.
 * Handles simple addresses and "Name <email>" format.
 */
function parseEmailAddresses(value: string | undefined): Array<{ email: string; name?: string }> {
  if (!value) return []

  const addresses: Array<{ email: string; name?: string }> = []
  const parts = value.split(/,\s*/)

  for (const part of parts) {
    // Match "Name <email>" or just "email"
    const match = part.match(/^(?:\"?([^"]*)\"?\s)?<([^>]+)>$/)
    if (match) {
      const name = match[1]?.trim() || undefined
      const email = match[2].trim()
      addresses.push({ email, name })
    } else {
      // Just an email address
      const email = part.trim()
      if (email) {
        addresses.push({ email })
      }
    }
  }

  return addresses
}

/**
 * Generate a stable platform_user_id from an email address.
 * Gmail doesn't expose user IDs for external contacts, so we use email.
 */
function platformUserIdFromEmail(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9@._-]/g, '')
}

// ============ Message Mapper ============

/**
 * Maps Gmail Message to canonical Message entity.
 *
 * Also creates related Identity entities for:
 * - Sender (From header)
 * - Recipients (To, Cc, Bcc headers)
 */
export const messageMapper: EntityMapper<GmailMessage> = {
  sourceEntityType: 'message',
  targetEntityType: 'message',
  sourceSchema: GmailMessageSchema,

  map(source: GmailMessage, context: MapperContext): MappedEntity | MappedEntity[] {
    const sourceRef = createSourceRef(
      context.accountId,
      'message',
      source.id,
      source.historyId
    )

    // Extract headers
    const headers = source.payload.headers ?? []
    const from = getHeaderValue(headers, 'From')
    const to = getHeaderValue(headers, 'To')
    const cc = getHeaderValue(headers, 'Cc')
    const bcc = getHeaderValue(headers, 'Bcc')
    const subject = getHeaderValue(headers, 'Subject')
    const date = getHeaderValue(headers, 'Date')

    // Parse email addresses
    const fromAddresses = parseEmailAddresses(from)
    const toAddresses = parseEmailAddresses(to)
    const ccAddresses = parseEmailAddresses(cc)
    const bccAddresses = parseEmailAddresses(bcc)

    const allRecipients = [
      ...toAddresses,
      ...ccAddresses,
      ...bccAddresses,
    ]

    // Extract body content
    const bodyText = extractBodyText(source.payload)
    const bodyHtml = extractBodyHtml(source.payload)

    // Extract attachments (metadata only for MVP)
    const attachments = extractAttachments(source.payload)

    // Convert internalDate (milliseconds) to ISO timestamp
    const timestamp = new Date(parseInt(source.internalDate, 10)).toISOString()

    const message: Message = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'message',
      sender_identity_id: undefined, // Will be resolved from related entity
      recipient_identity_ids: [], // Will be resolved from related entities
      subject: subject ?? '(no subject)',
      body_text: bodyText,
      body_html: bodyHtml,
      sent_at: timestamp,
      received_at: timestamp,
      attachment_ids: [], // Attachment IDs would be created if downloading files
      platform_thread_id: source.threadId,
      is_read: !source.labelIds?.includes('UNREAD'),
      labels: source.labelIds ?? [],
    }

    const result: MappedEntity = {
      entityType: 'message',
      data: message,
      displayText: `${subject} - ${bodyText?.substring(0, 100) ?? '(no body)'}...`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    // Create related Identity entities for sender and recipients
    const relatedEntities: MappedEntity[] = []

    // Map sender
    if (fromAddresses.length > 0) {
      const sender = fromAddresses[0]
      const senderIdentity: Identity = {
        ...createBaseEntity(generateCanonicalId(), {
          connector: 'gmail',
          account_id: context.accountId,
          entity_type: 'identity',
          source_id: platformUserIdFromEmail(sender.email),
          last_synced_at: new Date().toISOString(),
        }),
        entity_type: 'identity',
        platform: 'gmail',
        platform_user_id: platformUserIdFromEmail(sender.email),
        email: sender.email,
        display_name: sender.name || sender.email,
      }

      relatedEntities.push({
        entityType: 'identity',
        data: senderIdentity,
        displayText: sender.name ? `${sender.name} <${sender.email}>` : sender.email,
        sourceRefKey: sourceRefToKey(senderIdentity.source_refs[0]),
      })

      // Link sender to message - need to cast to Message type
      ;(result.data as any).sender_identity_id = senderIdentity.id
    }

    // Map recipients
    for (const recipient of allRecipients) {
      const recipientIdentity: Identity = {
        ...createBaseEntity(generateCanonicalId(), {
          connector: 'gmail',
          account_id: context.accountId,
          entity_type: 'identity',
          source_id: platformUserIdFromEmail(recipient.email),
          last_synced_at: new Date().toISOString(),
        }),
        entity_type: 'identity',
        platform: 'gmail',
        platform_user_id: platformUserIdFromEmail(recipient.email),
        email: recipient.email,
        display_name: recipient.name || recipient.email,
      }

      relatedEntities.push({
        entityType: 'identity',
        data: recipientIdentity,
        displayText: recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email,
        sourceRefKey: sourceRefToKey(recipientIdentity.source_refs[0]),
      })

      ;(result.data as any).recipient_identity_ids.push(recipientIdentity.id)
    }

    if (relatedEntities.length > 0) {
      result.relatedEntities = relatedEntities
    }

    return result
  },
}

// ============ Thread Mapper ============

/**
 * Maps Gmail Thread to... nothing directly.
 *
 * Threads are derived from messages in the canonical model.
 * This mapper is placeholder for potential future thread-level operations.
 */
export const threadMapper: EntityMapper<GmailMessage> = {
  sourceEntityType: 'thread',
  targetEntityType: 'message', // Thread messages map to Message entities
  sourceSchema: GmailMessageSchema,

  map(source: GmailMessage, context: MapperContext): MappedEntity | MappedEntity[] {
    // Delegate to message mapper - each message in a thread is mapped separately
    return messageMapper.map(source, context)
  },
}

// ============ Identity Mapper (for direct mapping) ============

/**
 * Maps an email address directly to an Identity entity.
 *
 * Useful when you have email addresses without full message context.
 */
export interface EmailHeader {
  email: string
  name?: string
}

export const EmailHeaderSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
})

import { z } from 'zod'

/**
 * Maps email header to canonical Identity entity.
 */
export const identityMapper: EntityMapper<EmailHeader> = {
  sourceEntityType: 'identity',
  targetEntityType: 'identity',
  sourceSchema: EmailHeaderSchema,

  map(source: EmailHeader, context: MapperContext): MappedEntity {
    const sourceRef = createSourceRef(
      context.accountId,
      'identity',
      platformUserIdFromEmail(source.email)
    )

    const identity: Identity = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'identity',
      platform: 'gmail',
      platform_user_id: platformUserIdFromEmail(source.email),
      email: source.email,
      display_name: source.name || source.email,
    }

    return {
      entityType: 'identity',
      data: identity,
      displayText: source.name ? `${source.name} <${source.email}>` : source.email,
      sourceRefKey: sourceRefToKey(sourceRef),
    }
  },
}

// ============ Mapper Registry ============

/**
 * All Gmail entity mappers.
 */
export const gmailMappers = {
  message: messageMapper,
  thread: threadMapper,
  identity: identityMapper,
} as const

/**
 * Get a mapper by entity type.
 */
export function getGmailMapper(entityType: string): EntityMapper | undefined {
  return gmailMappers[entityType as keyof typeof gmailMappers]
}

/**
 * Get all supported entity types.
 */
export function getGmailEntityTypes(): string[] {
  return Object.keys(gmailMappers)
}
