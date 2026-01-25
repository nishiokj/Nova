/**
 * Gmail Transformations
 */

import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { Identity, Message, Conversation } from '../../models/canonical.js'
import type { Transformation, TransformResult, TransformOutput } from '../../transform/types.js'
import {
  GmailMessageSchema,
  GmailThreadSchema,
  type GmailMessage,
  type GmailThread,
  type GmailMessageHeader,
  type GmailMessagePart,
} from './schemas.js'

// ============ Helper Functions ============

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

function createBaseEntity(id: string, sourceRef: Identity['source_refs'][0]) {
  const now = new Date().toISOString()
  return {
    id,
    created_at: now,
    updated_at: now,
    source_refs: [sourceRef],
  }
}

function getHeaderValue(headers: GmailMessageHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return header?.value
}

function extractBodyText(payload: GmailMessagePart): string | undefined {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBodyText(part)
      if (text) return text
    }
  }

  return undefined
}

function extractBodyHtml(payload: GmailMessagePart): string | undefined {
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const html = extractBodyHtml(part)
      if (html) return html
    }
  }

  return undefined
}

function parseEmailAddresses(value: string | undefined): Array<{ email: string; name?: string }> {
  if (!value) return []

  const addresses: Array<{ email: string; name?: string }> = []
  const parts = value.split(/,\s*/)

  for (const part of parts) {
    const match = part.match(/^(?:\"?([^\"]*)\"?\s)?<([^>]+)>$/)
    if (match) {
      const name = match[1]?.trim() || undefined
      const email = match[2].trim()
      addresses.push({ email, name })
    } else {
      const email = part.trim()
      if (email) {
        addresses.push({ email })
      }
    }
  }

  return addresses
}

function platformUserIdFromEmail(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9@._-]/g, '')
}

function buildIdentity(
  accountId: string,
  email: string,
  name?: string
): { entity: Identity; output: TransformOutput } {
  const sourceRef = createSourceRef(accountId, 'identity', platformUserIdFromEmail(email))

  const identity: Identity = {
    ...createBaseEntity(generateCanonicalId(), sourceRef),
    entity_type: 'identity',
    platform: 'gmail',
    platform_user_id: platformUserIdFromEmail(email),
    email,
    display_name: name || email,
  }

  return {
    entity: identity,
    output: {
      entityType: 'identity',
      data: identity,
      displayText: name ? `${name} <${email}>` : email,
      sourceRefKey: sourceRefToKey(sourceRef),
    },
  }
}

// ============ Transformations ============

export const gmailMessageTransform: Transformation<GmailMessage> = {
  id: 'gmail:message:v1',
  name: 'Gmail Message → Canonical Message',
  source: {
    connector: 'gmail',
    entityType: 'message',
  },
  inputSchema: GmailMessageSchema,
  outputType: 'message',
  transform(source, ctx): TransformResult {
    const sourceRef = createSourceRef(ctx.accountId, 'message', source.id, source.historyId)

    const headers = source.payload.headers ?? []
    const from = getHeaderValue(headers, 'From')
    const to = getHeaderValue(headers, 'To')
    const cc = getHeaderValue(headers, 'Cc')
    const bcc = getHeaderValue(headers, 'Bcc')
    const subject = getHeaderValue(headers, 'Subject')

    const fromAddresses = parseEmailAddresses(from)
    const toAddresses = parseEmailAddresses(to)
    const ccAddresses = parseEmailAddresses(cc)
    const bccAddresses = parseEmailAddresses(bcc)

    const allRecipients = [...toAddresses, ...ccAddresses, ...bccAddresses]

    const bodyText = extractBodyText(source.payload)
    const bodyHtml = extractBodyHtml(source.payload)

    const timestamp = new Date(parseInt(source.internalDate, 10)).toISOString()

    const message: Message = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'message',
      sender_identity_id: undefined,
      recipient_identity_ids: [],
      subject: subject ?? '(no subject)',
      body_text: bodyText,
      body_html: bodyHtml,
      sent_at: timestamp,
      received_at: timestamp,
      attachment_ids: [],
      platform_thread_id: source.threadId,
      is_read: !source.labelIds?.includes('UNREAD'),
      labels: source.labelIds ?? [],
    }

    const primary: TransformOutput = {
      entityType: 'message',
      data: message,
      displayText: `${subject} - ${bodyText?.substring(0, 100) ?? '(no body)'}...`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    const related: TransformOutput[] = []

    if (fromAddresses.length > 0) {
      const sender = fromAddresses[0]
      const senderIdentity = buildIdentity(ctx.accountId, sender.email, sender.name)
      related.push(senderIdentity.output)
      message.sender_identity_id = senderIdentity.entity.id
    }

    for (const recipient of allRecipients) {
      const recipientIdentity = buildIdentity(ctx.accountId, recipient.email, recipient.name)
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

export const gmailThreadTransform: Transformation<GmailThread> = {
  id: 'gmail:thread:v1',
  name: 'Gmail Thread → Canonical Conversation',
  source: {
    connector: 'gmail',
    entityType: 'thread',
  },
  inputSchema: GmailThreadSchema,
  outputType: ['conversation', 'message'],
  transform(source, ctx): TransformResult[] {
    const messageOutputs: TransformOutput[] = []

    const participants: Identity['source_refs'][0][] = []
    const messageIds: string[] = []

    for (const message of source.messages) {
      const messageResult = gmailMessageTransform.transform(message, ctx)
      const results = Array.isArray(messageResult) ? messageResult : [messageResult]

      for (const result of results) {
        messageOutputs.push(result.primary)
        if (result.related) {
          messageOutputs.push(...result.related)
          for (const related of result.related) {
            if (related.entityType === 'identity') {
              const refParts = related.sourceRefKey.split(':')
              participants.push({
                connector: 'gmail',
                account_id: ctx.accountId,
                entity_type: 'identity',
                source_id: refParts[3] ?? related.sourceRefKey,
                last_synced_at: new Date().toISOString(),
              })
            }
          }
        }
      }

      const messagePrimary = messageOutputs.find((output) =>
        output.entityType === 'message' && output.sourceRefKey.includes(message.id)
      )
      if (messagePrimary) {
        messageIds.push((messagePrimary.data as Message).id)
      }
    }

    const conversationSourceRef = createSourceRef(ctx.accountId, 'thread', source.id, source.historyId)
    const conversation: Conversation = {
      ...createBaseEntity(generateCanonicalId(), conversationSourceRef),
      entity_type: 'conversation',
      platform: 'gmail',
      message_ids: messageIds,
      message_count: messageIds.length,
      participants,
      started_at: new Date().toISOString(),
      topic: source.snippet ?? undefined,
      is_archived: false,
      metadata: {
        thread_id: source.id,
        history_id: source.historyId,
      },
    }

    const conversationOutput: TransformOutput = {
      entityType: 'conversation',
      data: conversation,
      displayText: source.snippet ?? 'Gmail Thread',
      sourceRefKey: sourceRefToKey(conversationSourceRef),
    }

    return [{
      primary: conversationOutput,
      related: messageOutputs.length > 0 ? messageOutputs : undefined,
    }]
  },
  onError: 'quarantine',
  enabled: true,
  version: 1,
}

export const gmailTransforms = [gmailMessageTransform, gmailThreadTransform]
