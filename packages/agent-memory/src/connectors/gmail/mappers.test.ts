/**
 * Gmail Entity Mappers Tests
 *
 * Unit tests for Gmail entity mappers.
 *
 * @module connectors/gmail/mappers.test
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  messageMapper,
  identityMapper,
  EmailHeaderSchema,
  type EmailHeader,
  type GmailMessage,
  type GmailMessageHeader,
  type GmailMessagePart,
} from './mappers.js'
import type { MapperContext, MappedEntity } from '../../sync/types.js'
import type { Message, Identity } from '../../models/canonical.js'

// ============ Test Data ============

function createTestGmailMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: 'msg123',
    threadId: 'thread456',
    labelIds: ['INBOX'],
    historyId: '789',
    internalDate: '1704067200000', // 2024-01-01 00:00:00 UTC
    snippet: 'This is a test message',
    payload: {
      headers: [
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: 'recipient@example.com' },
        { name: 'Cc', value: 'cc@example.com' },
        { name: 'Subject', value: 'Test Subject' },
        { name: 'Date', value: 'Mon, 01 Jan 2024 00:00:00 +0000' },
      ],
      body: {
        data: Buffer.from('This is a test email body').toString('base64'),
        size: 23,
      },
      mimeType: 'text/plain',
    },
    sizeEstimate: 500,
    ...overrides,
  }
}

function createMultipartTestGmailMessage(): GmailMessage {
  return {
    id: 'msg124',
    threadId: 'thread457',
    labelIds: ['INBOX', 'UNREAD'],
    historyId: '790',
    internalDate: '1704067260000', // 2024-01-01 00:01:00 UTC
    snippet: 'Multipart message',
    payload: {
      headers: [
        { name: 'From', value: 'Sender Name <sender@example.com>' },
        { name: 'To', value: 'Recipient1 <recipient1@example.com>, recipient2@example.com' },
        { name: 'Cc', value: 'cc1@example.com, CC Name <cc2@example.com>' },
        { name: 'Bcc', value: 'bcc@example.com' },
        { name: 'Subject', value: 'Multipart Test' },
        { name: 'Date', value: 'Mon, 01 Jan 2024 00:01:00 +0000' },
      ],
      mimeType: 'multipart/mixed',
      parts: [
        {
          partId: '0',
          mimeType: 'text/plain',
          body: {
            data: Buffer.from('Plain text content').toString('base64'),
            size: 20,
          },
        },
        {
          partId: '1',
          mimeType: 'text/html',
          body: {
            data: Buffer.from('<html><body>HTML content</body></html>').toString('base64'),
            size: 40,
          },
        },
        {
          partId: '2',
          mimeType: 'application/pdf',
          filename: 'attachment.pdf',
          body: {
            attachmentId: 'att123',
            size: 1024,
          },
        },
      ],
    },
    sizeEstimate: 2000,
  }
}

function createTestContext(accountId = 'test-account'): MapperContext {
  return {
    accountId,
    sourceRef: {
      connector: 'gmail',
      account_id: accountId,
      entity_type: 'message',
      source_id: 'msg123',
    },
    envelope: null,
  }
}

// ============ Message Mapper Tests ============

describe('Gmail messageMapper', () => {
  it('maps Gmail message to canonical Message entity', () => {
    const gmailMessage = createTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context)

    expect(result).toHaveProperty('entityType', 'message')
    expect(result).toHaveProperty('data')
    expect(result).toHaveProperty('displayText')
    expect(result).toHaveProperty('sourceRefKey')
  })

  it('extracts headers correctly', () => {
    const gmailMessage = createTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.subject).toBe('Test Subject')
    expect(message.sent_at).toBe('2024-01-01T00:00:00.000Z')
    expect(message.received_at).toBe('2024-01-01T00:00:00.000Z')
  })

  it('extracts body text from payload', () => {
    const gmailMessage = createTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.body_text).toBe('This is a test email body')
    expect(message.body_html).toBeUndefined()
  })

  it('handles multipart messages with text, HTML, and attachments', () => {
    const gmailMessage = createMultipartTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.body_text).toBe('Plain text content')
    expect(message.body_html).toBe('<html><body>HTML content</body></html>')
    expect(message.metadata?.gmail_attachments_count).toBe(1)
  })

  it('creates related Identity entities for sender and recipients', () => {
    const gmailMessage = createMultipartTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity

    expect(result.relatedEntities).toBeDefined()
    expect(result.relatedEntities).toHaveLength(5) // 1 sender + 2 to + 2 cc + 1 bcc = 6, but one is duplicate
  })

  it('handles "Name <email>" format in From header', () => {
    const gmailMessage = createMultipartTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity

    expect(result.relatedEntities).toBeDefined()
    const sender = result.relatedEntities!.find(
      e => e.data.email === 'sender@example.com'
    )
    expect(sender).toBeDefined()
    expect(sender!.data.display_name).toBe('Sender Name')
  })

  it('handles multiple email addresses in To header', () => {
    const gmailMessage = createMultipartTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.recipient_identity_ids).toHaveLength(5) // 2 to + 2 cc + 1 bcc
  })

  it('sets is_read based on UNREAD label', () => {
    const gmailMessageUnread = createTestGmailMessage({
      labelIds: ['INBOX', 'UNREAD'],
    })
    const gmailMessageRead = createTestGmailMessage({
      labelIds: ['INBOX'],
    })
    const context = createTestContext()

    const resultUnread = messageMapper.map(gmailMessageUnread, context) as MappedEntity
    const resultRead = messageMapper.map(gmailMessageRead, context) as MappedEntity

    expect((resultUnread.data as Message).is_read).toBe(false)
    expect((resultRead.data as Message).is_read).toBe(true)
  })

  it('maps labelIds to labels array', () => {
    const gmailMessage = createTestGmailMessage({
      labelIds: ['INBOX', 'IMPORTANT', 'STARRED'],
    })
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.labels).toEqual(['INBOX', 'IMPORTANT', 'STARRED'])
  })

  it('includes platform_thread_id from threadId', () => {
    const gmailMessage = createTestGmailMessage({ threadId: 'thread789' })
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.platform_thread_id).toBe('thread789')
  })

  it('handles missing From header gracefully', () => {
    const gmailMessage = createTestGmailMessage()
    gmailMessage.payload.headers = gmailMessage.payload.headers!.filter(
      h => h.name !== 'From'
    )
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.sender_identity_id).toBeUndefined()
    expect(result.relatedEntities).toBeUndefined()
  })

  it('handles missing Subject header with default', () => {
    const gmailMessage = createTestGmailMessage()
    gmailMessage.payload.headers = gmailMessage.payload.headers!.filter(
      h => h.name !== 'Subject'
    )
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.subject).toBe('(no subject)')
  })

  it('includes Gmail-specific metadata', () => {
    const gmailMessage = createTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity
    const message = result.data as Message

    expect(message.metadata).toEqual({
      gmail_id: 'msg123',
      gmail_thread_id: 'thread456',
      gmail_history_id: '789',
      gmail_snippet: 'This is a test message',
      gmail_label_ids: ['INBOX'],
      gmail_attachments_count: 0,
      gmail_size_estimate: 500,
    })
  })

  it('creates correct displayText', () => {
    const gmailMessage = createTestGmailMessage()
    const context = createTestContext()

    const result = messageMapper.map(gmailMessage, context) as MappedEntity

    expect(result.displayText).toBe('Test Subject - This is a test email b...')
  })
})

// ============ Identity Mapper Tests ============

describe('Gmail identityMapper', () => {
  it('maps email header to canonical Identity entity', () => {
    const emailHeader: EmailHeader = {
      email: 'test@example.com',
      name: 'Test User',
    }
    const context = createTestContext()
    context.sourceRef.entity_type = 'identity'
    context.sourceRef.source_id = 'test@example.com'.toLowerCase().replace(/[^a-z0-9@._-]/g, '')

    const result = identityMapper.map(emailHeader, context)

    expect(result).toHaveProperty('entityType', 'identity')
    expect(result).toHaveProperty('data')
    expect(result).toHaveProperty('displayText')
  })

  it('sets platform to gmail', () => {
    const emailHeader: EmailHeader = { email: 'test@example.com' }
    const context = createTestContext()
    context.sourceRef.entity_type = 'identity'
    context.sourceRef.source_id = 'test@example.com'.toLowerCase().replace(/[^a-z0-9@._-]/g, '')

    const result = identityMapper.map(emailHeader, context) as MappedEntity
    const identity = result.data as Identity

    expect(identity.platform).toBe('gmail')
  })

  it('uses email as display_name when name not provided', () => {
    const emailHeader: EmailHeader = { email: 'test@example.com' }
    const context = createTestContext()
    context.sourceRef.entity_type = 'identity'
    context.sourceRef.source_id = 'test@example.com'.toLowerCase().replace(/[^a-z0-9@._-]/g, '')

    const result = identityMapper.map(emailHeader, context) as MappedEntity
    const identity = result.data as Identity

    expect(identity.display_name).toBe('test@example.com')
  })

  it('uses name when provided', () => {
    const emailHeader: EmailHeader = {
      email: 'test@example.com',
      name: 'Test User',
    }
    const context = createTestContext()
    context.sourceRef.entity_type = 'identity'
    context.sourceRef.source_id = 'test@example.com'.toLowerCase().replace(/[^a-z0-9@._-]/g, '')

    const result = identityMapper.map(emailHeader, context) as MappedEntity
    const identity = result.data as Identity

    expect(identity.display_name).toBe('Test User')
  })

  it('creates correct displayText with name', () => {
    const emailHeader: EmailHeader = {
      email: 'test@example.com',
      name: 'Test User',
    }
    const context = createTestContext()
    context.sourceRef.entity_type = 'identity'
    context.sourceRef.source_id = 'test@example.com'.toLowerCase().replace(/[^a-z0-9@._-]/g, '')

    const result = identityMapper.map(emailHeader, context)

    expect(result.displayText).toBe('Test User <test@example.com>')
  })

  it('creates correct displayText without name', () => {
    const emailHeader: EmailHeader = { email: 'test@example.com' }
    const context = createTestContext()
    context.sourceRef.entity_type = 'identity'
    context.sourceRef.source_id = 'test@example.com'.toLowerCase().replace(/[^a-z0-9@._-]/g, '')

    const result = identityMapper.map(emailHeader, context)

    expect(result.displayText).toBe('test@example.com')
  })

  it('validates EmailHeaderSchema correctly', () => {
    const valid = { email: 'test@example.com', name: 'Test' }
    const invalid = { email: 'not-an-email' }

    expect(EmailHeaderSchema.safeParse(valid).success).toBe(true)
    expect(EmailHeaderSchema.safeParse(invalid).success).toBe(false)
  })
})
