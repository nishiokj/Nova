/**
 * iMessage Schema Definitions
 *
 * Zod schemas matching macOS Messages chat.db SQLite structure.
 * The chat.db uses a somewhat complex relational schema with join tables.
 *
 * @module connectors/imessage/schemas
 */

import { z } from 'zod'

// ============ Raw SQLite Row Schemas ============

/**
 * Handle - represents a contact/participant (phone number or email)
 */
export const HandleRowSchema = z.object({
  ROWID: z.number(),
  id: z.string(), // Phone number or email (e.g., "+1234567890" or "user@icloud.com")
  service: z.string(), // "iMessage" or "SMS"
  uncanonicalized_id: z.string().nullable(),
})

export type HandleRow = z.infer<typeof HandleRowSchema>

/**
 * Chat - represents a conversation thread
 */
export const ChatRowSchema = z.object({
  ROWID: z.number(),
  guid: z.string(), // Unique identifier like "iMessage;-;+1234567890"
  chat_identifier: z.string(), // The recipient identifier
  service_name: z.string().nullable(), // "iMessage" or "SMS"
  display_name: z.string().nullable(), // Group chat name if set
  room_name: z.string().nullable(),
  group_id: z.string().nullable(),
  is_archived: z.number().default(0),
  last_read_message_timestamp: z.number().default(0),
})

export type ChatRow = z.infer<typeof ChatRowSchema>

/**
 * Message - individual message record
 *
 * Note: Apple uses macOS timestamps (nanoseconds since 2001-01-01)
 * We need to convert these to Unix timestamps.
 */
export const MessageRowSchema = z.object({
  ROWID: z.number(),
  guid: z.string(), // Unique message ID
  text: z.string().nullable(), // Message text content
  handle_id: z.number(), // Foreign key to handle
  service: z.string().nullable(), // "iMessage" or "SMS"
  date: z.number(), // macOS timestamp (nanoseconds since 2001-01-01)
  date_read: z.number().nullable(),
  date_delivered: z.number().nullable(),
  is_from_me: z.number(), // 1 = sent, 0 = received
  is_read: z.number(),
  is_delivered: z.number(),
  is_sent: z.number(),
  is_audio_message: z.number().default(0),
  cache_has_attachments: z.number().default(0),
  associated_message_guid: z.string().nullable(), // For reactions/replies
  associated_message_type: z.number().default(0), // 0 = normal, 2000-2999 = reactions
  balloon_bundle_id: z.string().nullable(), // For app messages
  expressive_send_style_id: z.string().nullable(), // "slam", "loud", etc.
  reply_to_guid: z.string().nullable(), // Thread reply
  thread_originator_guid: z.string().nullable(),
  thread_originator_part: z.string().nullable(),
})

export type MessageRow = z.infer<typeof MessageRowSchema>

/**
 * Attachment - media files
 */
export const AttachmentRowSchema = z.object({
  ROWID: z.number(),
  guid: z.string(),
  filename: z.string().nullable(), // Full path like ~/Library/Messages/Attachments/...
  mime_type: z.string().nullable(),
  transfer_name: z.string().nullable(), // Original filename
  total_bytes: z.number().default(0),
  is_outgoing: z.number().default(0),
  created_date: z.number().default(0),
})

export type AttachmentRow = z.infer<typeof AttachmentRowSchema>

/**
 * Join table: message_attachment_join
 */
export const MessageAttachmentJoinSchema = z.object({
  message_id: z.number(),
  attachment_id: z.number(),
})

/**
 * Join table: chat_message_join
 */
export const ChatMessageJoinSchema = z.object({
  chat_id: z.number(),
  message_id: z.number(),
})

/**
 * Join table: chat_handle_join
 */
export const ChatHandleJoinSchema = z.object({
  chat_id: z.number(),
  handle_id: z.number(),
})

// ============ Enriched/Joined Schemas ============

/**
 * Message with chat and handle info joined
 * This is what we actually work with after querying
 */
export const EnrichedMessageSchema = z.object({
  // From message table
  message_rowid: z.number(),
  guid: z.string(),
  text: z.string().nullable(),
  date: z.number(),
  date_read: z.number().nullable(),
  is_from_me: z.number(),
  is_read: z.number(),
  is_audio_message: z.number(),
  cache_has_attachments: z.number(),
  associated_message_guid: z.string().nullable(),
  associated_message_type: z.number(),
  expressive_send_style_id: z.string().nullable(),
  reply_to_guid: z.string().nullable(),
  thread_originator_guid: z.string().nullable(),
  service: z.string().nullable(),

  // From chat table (via join)
  chat_rowid: z.number(),
  chat_guid: z.string(),
  chat_identifier: z.string(),
  display_name: z.string().nullable(),

  // From handle table (via join)
  handle_id: z.string().nullable(), // Phone/email of other party
  handle_service: z.string().nullable(),
})

export type EnrichedMessage = z.infer<typeof EnrichedMessageSchema>

/**
 * Chat with participant info
 */
export const EnrichedChatSchema = z.object({
  chat_rowid: z.number(),
  guid: z.string(),
  chat_identifier: z.string(),
  service_name: z.string().nullable(),
  display_name: z.string().nullable(),
  is_archived: z.number(),
  participant_count: z.number(),
  last_message_date: z.number().nullable(),
  participants: z.array(z.string()), // Array of handle IDs
})

export type EnrichedChat = z.infer<typeof EnrichedChatSchema>

// ============ Source Item Schemas (for connector output) ============

/**
 * Message as a source item
 */
export const IMessageSourceSchema = z.object({
  guid: z.string(),
  text: z.string().nullable(),
  timestamp: z.string(), // ISO string
  is_from_me: z.boolean(),
  is_read: z.boolean(),
  service: z.string(), // "iMessage" or "SMS"
  chat: z.object({
    guid: z.string(),
    identifier: z.string(),
    display_name: z.string().nullable(),
  }),
  sender: z.object({
    id: z.string(), // Phone or email
    is_me: z.boolean(),
  }),
  // Optional metadata
  is_audio_message: z.boolean().optional(),
  has_attachments: z.boolean().optional(),
  reaction_to: z.string().nullable().optional(),
  reply_to: z.string().nullable().optional(),
  send_effect: z.string().nullable().optional(),
  text_truncated: z.boolean().optional(),
  text_bytes: z.number().int().nonnegative().optional(),
  text_original_bytes: z.number().int().nonnegative().optional(),
})

export type IMessageSource = z.infer<typeof IMessageSourceSchema>

/**
 * Chat as a source item
 */
export const IChatSourceSchema = z.object({
  guid: z.string(),
  identifier: z.string(),
  display_name: z.string().nullable(),
  service: z.string(),
  is_group: z.boolean(),
  is_archived: z.boolean(),
  participants: z.array(z.string()),
  last_message_timestamp: z.string().nullable(), // ISO string
})

export type IChatSource = z.infer<typeof IChatSourceSchema>

// ============ Constants ============

/**
 * macOS epoch is 2001-01-01 00:00:00 UTC
 * Difference from Unix epoch in seconds
 */
export const MACOS_EPOCH_OFFSET = 978307200

/**
 * Convert macOS timestamp (nanoseconds since 2001-01-01) to JavaScript Date
 */
export function macosTimestampToDate(timestamp: number): Date {
  // macOS stores in nanoseconds, but sometimes in seconds depending on the column
  // If the timestamp is very large (>10^15), it's nanoseconds
  // Otherwise it's seconds
  const seconds = timestamp > 1e15 ? timestamp / 1e9 : timestamp
  const unixSeconds = seconds + MACOS_EPOCH_OFFSET
  return new Date(unixSeconds * 1000)
}

/**
 * Convert macOS timestamp to ISO string
 */
export function macosTimestampToISOString(timestamp: number): string {
  return macosTimestampToDate(timestamp).toISOString()
}
