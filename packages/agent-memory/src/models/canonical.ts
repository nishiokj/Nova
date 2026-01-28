/**
 * Canonical Data Model
 *
 * Core entity schemas for the agent memory system.
 * All entities share common base fields and are validated via Zod.
 *
 * Design principles:
 * - Every entity has id (ULID), created_at, updated_at, source_refs[]
 * - Relationships are first-class (Link entity)
 * - Minimal required fields, extensive optional fields
 */

import { z } from 'zod'
import { UlidSchema, ConnectorTypeSchema } from '../ids.js'

// ============ Extended Source Reference ============

/**
 * Source reference with sync tracking.
 * Extends the base SourceRef from ids.ts with last_synced_at.
 */
export const CanonicalSourceRefSchema = z.object({
  connector: ConnectorTypeSchema,
  account_id: z.string().min(1),
  entity_type: z.string().min(1),
  source_id: z.string().min(1),
  source_version: z.string().optional(),
  last_synced_at: z.string().datetime(),
})

export type CanonicalSourceRef = z.infer<typeof CanonicalSourceRefSchema>

// ============ Base Entity ============

/**
 * Base fields shared by all canonical entities.
 */
export const BaseEntitySchema = z.object({
  id: UlidSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  source_refs: z.array(CanonicalSourceRefSchema).min(1),
  metadata: z.record(z.unknown()).optional(),
})

export type BaseEntity = z.infer<typeof BaseEntitySchema>

// ============ Platform Enum ============

export const PlatformSchema = z.enum(['github', 'gmail', 'xcom', 'imessage', 'obsidian', 'unknown'])
export type Platform = z.infer<typeof PlatformSchema>

// ============ Core Entities ============

/**
 * Person: A human being (may have multiple identities across platforms)
 */
export const PersonSchema = BaseEntitySchema.extend({
  entity_type: z.literal('person'),
  display_name: z.string().optional(),
  avatar_url: z.string().url().optional(),
  emails: z.array(z.string().email()).default([]),
  phones: z.array(z.string()).default([]),
  usernames: z.array(z.object({
    platform: z.string(),
    username: z.string(),
  })).default([]),
  org_ids: z.array(UlidSchema).default([]),
  identity_ids: z.array(UlidSchema).default([]),
})

export type Person = z.infer<typeof PersonSchema>

/**
 * Identity: A person's presence on a specific platform
 */
export const IdentitySchema = BaseEntitySchema.extend({
  entity_type: z.literal('identity'),
  platform: PlatformSchema,
  platform_user_id: z.string().min(1),
  username: z.string().optional(),
  display_name: z.string().optional(),
  email: z.string().email().optional(),
  avatar_url: z.string().url().optional(),
  profile_url: z.string().url().optional(),
  person_id: UlidSchema.optional(),
})

export type Identity = z.infer<typeof IdentitySchema>

/**
 * Org: An organization or company
 */
export const OrgSchema = BaseEntitySchema.extend({
  entity_type: z.literal('org'),
  name: z.string().min(1),
  domain: z.string().optional(),
  description: z.string().optional(),
  avatar_url: z.string().url().optional(),
  url: z.string().url().optional(),
})

export type Org = z.infer<typeof OrgSchema>

/**
 * Account: A user's connected account to an external service
 */
export const AccountSchema = BaseEntitySchema.extend({
  entity_type: z.literal('account'),
  connector: ConnectorTypeSchema,
  account_id: z.string().min(1),
  display_name: z.string().optional(),
  email: z.string().email().optional(),
  is_active: z.boolean().default(true),
  last_synced_at: z.string().datetime().optional(),
  sync_cursor: z.string().optional(),
})

export type Account = z.infer<typeof AccountSchema>

// ============ Activity Entities ============

/**
 * Message: Email, chat message, DM, comment
 */
export const MessageSchema = BaseEntitySchema.extend({
  entity_type: z.literal('message'),
  thread_id: z.string().optional(),
  conversation_id: UlidSchema.optional(),
  parent_id: UlidSchema.optional(),
  sender_identity_id: UlidSchema.optional(),
  recipient_identity_ids: z.array(UlidSchema).default([]),
  subject: z.string().optional(),
  body_text: z.string().optional(),
  body_html: z.string().optional(),
  sent_at: z.string().datetime().optional(),
  received_at: z.string().datetime().optional(),
  attachment_ids: z.array(UlidSchema).default([]),
  platform_thread_id: z.string().optional(),
  is_read: z.boolean().optional(),
  labels: z.array(z.string()).default([]),
})

export type Message = z.infer<typeof MessageSchema>

/**
 * Event: Calendar event, meeting, scheduled item
 */
export const EventSchema = BaseEntitySchema.extend({
  entity_type: z.literal('event'),
  title: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  start_at: z.string().datetime(),
  end_at: z.string().datetime().optional(),
  is_all_day: z.boolean().default(false),
  timezone: z.string().optional(),
  organizer_identity_id: UlidSchema.optional(),
  attendee_identity_ids: z.array(UlidSchema).default([]),
  recurrence_rule: z.string().optional(),
  recurring_event_id: UlidSchema.optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
})

export type Event = z.infer<typeof EventSchema>

/**
 * Issue: Work item (issue, PR, ticket)
 */
export const IssueSchema = BaseEntitySchema.extend({
  entity_type: z.literal('issue'),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'closed', 'cancelled']).default('open'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  creator_identity_id: UlidSchema.optional(),
  assignee_identity_ids: z.array(UlidSchema).default([]),
  due_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  parent_issue_id: UlidSchema.optional(),
  labels: z.array(z.string()).default([]),
  platform_url: z.string().url().optional(),
})

export type Issue = z.infer<typeof IssueSchema>

/**
 * Notification: Alert, mention, update notification
 */
export const NotificationSchema = BaseEntitySchema.extend({
  entity_type: z.literal('notification'),
  notification_type: z.string().min(1),
  title: z.string().optional(),
  body: z.string().optional(),
  related_entity_id: UlidSchema.optional(),
  related_entity_type: z.string().optional(),
  is_read: z.boolean().default(false),
  read_at: z.string().datetime().optional(),
  triggered_at: z.string().datetime(),
})

export type Notification = z.infer<typeof NotificationSchema>

/**
 * Observation: A note, reflection, or AI-generated insight
 */
export const ObservationSchema = BaseEntitySchema.extend({
  entity_type: z.literal('observation'),
  content: z.string().min(1),
  observation_type: z.enum(['note', 'summary', 'insight', 'reminder']),
  related_entity_ids: z.array(UlidSchema).default([]),
  confidence: z.number().min(0).max(1).optional(),
})

export type Observation = z.infer<typeof ObservationSchema>

/**
 * Preference: Learned user preference or behavioral pattern from sessions
 */
export const PreferenceSchema = BaseEntitySchema.extend({
  entity_type: z.literal('preference'),
  /** Category of preference (e.g., 'coding_style', 'tool_usage', 'communication') */
  category: z.string().min(1),
  /** The preference key/name */
  key: z.string().min(1),
  /** The preference value or description */
  value: z.string().min(1),
  /** Confidence score for inferred preferences */
  confidence: z.number().min(0).max(1).optional(),
  /** Number of times this preference was observed */
  occurrence_count: z.number().int().nonnegative().default(1),
  /** Session IDs where this preference was observed */
  session_ids: z.array(z.string()).default([]),
  /** Whether this was explicitly stated vs inferred */
  is_explicit: z.boolean().default(false),
  /** Last time this preference was observed */
  last_observed_at: z.string().datetime().optional(),
})

export type Preference = z.infer<typeof PreferenceSchema>

/**
 * Conversation: A thread of messages between participants
 *
 * Represents a conversation (e.g., email thread, chat session, DM chain)
 * that spans multiple messages. The conversation aggregates metadata about the
 * exchange and maintains an ordered list of message IDs.
 */
export const ConversationSchema = BaseEntitySchema.extend({
  entity_type: z.literal('conversation'),
  platform: PlatformSchema,
  message_ids: z.array(UlidSchema).default([]),
  message_count: z.number().int().nonnegative().default(0),
  participants: z.array(CanonicalSourceRefSchema).default([]),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().optional(),
  topic: z.string().optional(),
  is_archived: z.boolean().default(false),
})

export type Conversation = z.infer<typeof ConversationSchema>

// ============ Relationship Entity ============

/**
 * Link: Explicit relationship between entities
 */
export const LinkSchema = BaseEntitySchema.extend({
  entity_type: z.literal('link'),
  from_entity_id: UlidSchema,
  from_entity_type: z.string().min(1),
  to_entity_id: UlidSchema,
  to_entity_type: z.string().min(1),
  link_type: z.string().min(1),
  context: z.string().optional(),
})

export type Link = z.infer<typeof LinkSchema>

/**
 * Attachment: File or media attached to messages/tasks
 */
export const AttachmentSchema = BaseEntitySchema.extend({
  entity_type: z.literal('attachment'),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  content_hash: z.string().min(1),
  storage_type: z.enum(['local', 'reference']),
  storage_path: z.string().optional(),
  source_url: z.string().url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
})

export type Attachment = z.infer<typeof AttachmentSchema>

// ============ Entity Type Enum ============

export const EntityTypeSchema = z.enum([
  'person',
  'identity',
  'org',
  'account',
  'message',
  'conversation',
  'issue',
  'notification',
  'event',
  'observation',
  'preference',
  'link',
  'attachment',
])

export type EntityType = z.infer<typeof EntityTypeSchema>

// ============ Discriminated Union ============

/**
 * Union type for any canonical entity.
 * Use EntityTypeSchema.options to get the list of valid entity types.
 */
export type CanonicalEntity =
  | Person
  | Identity
  | Org
  | Account
  | Message
  | Notification
  | Conversation
  | Issue
  | Event
  | Observation
  | Preference
  | Link
  | Attachment

// ============ Schema Registry ============

/**
 * Map from entity type to its schema for runtime validation.
 */
export const EntitySchemas = {
  person: PersonSchema,
  identity: IdentitySchema,
  org: OrgSchema,
  account: AccountSchema,
  message: MessageSchema,
  issue: IssueSchema,
  notification: NotificationSchema,
  conversation: ConversationSchema,
  event: EventSchema,
  observation: ObservationSchema,
  preference: PreferenceSchema,
  link: LinkSchema,
  attachment: AttachmentSchema,
} as const

/**
 * Validate an entity against its schema.
 * Returns a typed result with either the validated entity or error details.
 */
export function validateEntity<T extends EntityType>(
  entityType: T,
  data: unknown
): z.SafeParseReturnType<unknown, z.infer<(typeof EntitySchemas)[T]>> {
  return EntitySchemas[entityType].safeParse(data)
}
