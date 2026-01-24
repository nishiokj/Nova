/**
 * Canonical Data Models
 *
 * Re-exports all entity schemas and types from the canonical model,
 * as well as raw envelope and lineage tracking schemas.
 */

// Canonical Entities
export {
  // Extended Source Reference
  CanonicalSourceRefSchema,
  type CanonicalSourceRef,
  // Base Entity
  BaseEntitySchema,
  type BaseEntity,
  // Platform
  PlatformSchema,
  type Platform,
  // Core Entities
  PersonSchema,
  type Person,
  IdentitySchema,
  type Identity,
  OrgSchema,
  type Org,
  AccountSchema,
  type Account,
  // Activity Entities
  MessageSchema,
  type Message,
  ConversationSchema,
  type Conversation,
  EventSchema,
  type Event,
  TaskSchema,
  type Task,
  NotificationSchema,
  type Notification,
  ObservationSchema,
  type Observation,
  // Relationship Entity
  LinkSchema,
  type Link,
  AttachmentSchema,
  type Attachment,
  // Entity Type
  EntityTypeSchema,
  type EntityType,
  type CanonicalEntity,
  // Schema Registry
  EntitySchemas,
  validateEntity,
} from './canonical.js'

// Raw Envelope & Lineage
export {
  CollectionMethodSchema,
  type CollectionMethod,
  RawEnvelopeSchema,
  type RawEnvelope,
  type RawEnvelopeInput,
  EntitySourceMappingSchema,
  type EntitySourceMapping,
  type EntitySourceMappingInput,
} from './raw.js'
