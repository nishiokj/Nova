/**
 * Gmail API Response Schemas
 *
 * Zod schemas for validating Gmail API responses.
 * Based on Gmail REST API v1.
 *
 * @module connectors/gmail/schemas
 */

import { z } from 'zod'

// ============ Message ============

/**
 * Gmail message header.
 */
export const GmailMessageHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
})

export type GmailMessageHeader = z.infer<typeof GmailMessageHeaderSchema>

/**
 * Gmail message part body.
 */
const GmailMessageBodySchema = z.object({
  attachmentId: z.string().optional(),
  size: z.number().optional(),
  data: z.string().optional(), // Base64 encoded
})

/**
 * Gmail message part (supports nesting for multipart messages).
 */
export const GmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(GmailMessageHeaderSchema).optional(),
    body: GmailMessageBodySchema.optional(),
    parts: z.array(z.any()).optional(), // Recursive parts as array
  })
)

export interface GmailMessagePart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailMessageHeader[]
  body?: {
    attachmentId?: string
    size?: number
    data?: string
  }
  parts?: GmailMessagePart[]
}

/**
 * Gmail message label IDs (well-known labels).
 */
export const GmailLabelIdSchema = z.enum([
  'INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED',
  'IMPORTANT', 'SENT', 'DRAFT', 'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES',
  'CATEGORY_FORUMS'
])

/**
 * Gmail message.
 */
export const GmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string(), // Milliseconds since epoch
  payload: GmailMessagePartSchema,
  sizeEstimate: z.number().optional(),
})

export type GmailMessage = z.infer<typeof GmailMessageSchema>

// ============ Message List ============

/**
 * Gmail message reference (from list endpoint).
 */
export const GmailMessageRefSchema = z.object({
  id: z.string(),
  threadId: z.string(),
})

export type GmailMessageRef = z.infer<typeof GmailMessageRefSchema>

/**
 * Gmail message list response.
 */
export const GmailMessageListSchema = z.object({
  messages: z.array(GmailMessageRefSchema),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number(),
})

export type GmailMessageList = z.infer<typeof GmailMessageListSchema>

// ============ Thread ============

/**
 * Gmail thread.
 */
export const GmailThreadSchema = z.object({
  id: z.string(),
  historyId: z.string(),
  messages: z.array(GmailMessageSchema),
  snippet: z.string().optional(),
})

export type GmailThread = z.infer<typeof GmailThreadSchema>

// ============ History ============

/**
 * Message added in history record.
 */
export const GmailMessageAddedSchema = z.object({
  message: z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
  }),
})

export type GmailMessageAdded = z.infer<typeof GmailMessageAddedSchema>

/**
 * Message deleted in history record.
 */
export const GmailMessageDeletedSchema = z.object({
  message: z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
  }),
})

export type GmailMessageDeleted = z.infer<typeof GmailMessageDeletedSchema>

/**
 * Labels added in history record.
 */
export const GmailLabelsAddedSchema = z.object({
  message: z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
  }),
  labelIds: z.array(z.string()),
})

export type GmailLabelsAdded = z.infer<typeof GmailLabelsAddedSchema>

/**
 * Labels removed in history record.
 */
export const GmailLabelsRemovedSchema = z.object({
  message: z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
  }),
  labelIds: z.array(z.string()),
})

export type GmailLabelsRemoved = z.infer<typeof GmailLabelsRemovedSchema>

/**
 * Single history record.
 */
export const GmailHistoryRecordSchema = z.object({
  id: z.string().optional(),
  messagesAdded: z.array(GmailMessageAddedSchema).optional(),
  messagesDeleted: z.array(GmailMessageDeletedSchema).optional(),
  labelsAdded: z.array(GmailLabelsAddedSchema).optional(),
  labelsRemoved: z.array(GmailLabelsRemovedSchema).optional(),
})

export type GmailHistoryRecord = z.infer<typeof GmailHistoryRecordSchema>

/**
 * Gmail history response.
 */
export const GmailHistoryResponseSchema = z.object({
  historyId: z.string(),
  history: z.array(GmailHistoryRecordSchema).optional(),
  nextPageToken: z.string().optional(),
})

export type GmailHistoryResponse = z.infer<typeof GmailHistoryResponseSchema>

// ============ User Info ============

/**
 * Gmail user profile info.
 */
export const GmailProfileSchema = z.object({
  emailAddress: z.string(),
  messagesTotal: z.number().optional(),
  threadsTotal: z.number().optional(),
  historyId: z.string().optional(),
})

export type GmailProfile = z.infer<typeof GmailProfileSchema>

/**
 * Gmail thread list response (internal use).
 */
export const GmailThreadListSchema = z.object({
  threads: z.array(z.object({
    id: z.string(),
    historyId: z.string(),
  })),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number(),
})

export type GmailThreadList = z.infer<typeof GmailThreadListSchema>

// ============ Webhook Types (Pub/Sub) ============

/**
 * Pub/Sub push envelope (Google's format).
 */
export const PubSubPushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(), // Base64 encoded
    messageId: z.string(),
    publishTime: z.string(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string(),
})

export type PubSubPushEnvelope = z.infer<typeof PubSubPushEnvelopeSchema>

/**
 * Gmail webhook notification payload (decoded from Pub/Sub).
 */
export const GmailNotificationSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.coerce.number(),
})

export type GmailNotification = z.infer<typeof GmailNotificationSchema>
