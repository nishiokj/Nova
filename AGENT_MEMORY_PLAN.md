# Agent Memory Spec: Gap Analysis & Enhancement Plan

## Overview

This document expands the original AGENT_MEMORY_PLAN.md scaffold into production-grade specifications.

---

## Critical Gap Analysis

### Resolved Gaps
- **ID System & Idempotency**: Section 1 now specifies ULID storage/checks, account-scoped `source_ref_key`, and stable JSON hashing for dedup keys (ULID schemas + `stableStringify` comment).
- **Storage Layer**: PostgreSQL sketch now commits to ULID CHECK constraints, configurable embedding dimension, and a versioned migration folder with WAL-friendly schema (§4).
- **Sync Engine & Journaling**: Principles (§6) clarify versioned runs, replayable journals, at-least-once processing with retries/backoff, and fail-fast debugging knobs.
- **Queue System**: MicroQueue now documents single-process scope, retry/backoff policy, max runtime enforcement, and failed-job payload dumps (§5).
- **Configuration**: Config schema now exposes embedding dimension and queue runtime limits (§13).

### 1. **ID System & Idempotency** (Originally: 2 sentences)
**Missing:**
- UUID version/format (UUIDv7 for time-ordering? ULID?)
- Composite key strategy (source_type + source_id → canonical_id)
- Namespace isolation (per-tenant? per-connector?)
- Idempotency key computation algorithm
- Deduplication window (how long to track seen IDs?)
- Hash collision handling
- ID generation performance (pre-generated pools?)

### 2. **Storage Layer** (Originally: "SQLite" mentioned 5 times)
**Missing:**
- WAL mode configuration and checkpoint strategy
- Connection pooling for concurrent access
- Transaction isolation levels
- Index design for actual query patterns
- Table partitioning strategy
- Vacuum/maintenance scheduling
- Database file location, naming, lifecycle
- Backup strategy
- Size limits and rotation/archival
- Schema versioning and migration system
- Integrity constraints

### 3. **Sync Engine** (Originally: High-level collect/process phases)
**Missing:**
- Ordering guarantees
- Backpressure handling
- Parallelism model
- Checkpoint/resume
- Transactional boundaries
- State machine for job lifecycle
- Retry policy
- Dead letter queue
- Rate limiting coordination
- Sync scheduling

### 4. **Entity Resolution** (Originally: Bullet list of heuristics)
**Missing:**
- Algorithm specification
- Confidence scoring
- Threshold configuration
- Merge strategy
- Split handling
- Temporal resolution
- Transitive closure
- Performance (blocking strategy for O(n²))
- Human-in-the-loop workflow

### 5. **Connector SDK Contract** (Originally: Abstract description)
**Missing:**
- Interface definitions (TypeScript)
- Lifecycle hooks
- Error types
- Schema versioning
- Testing contract
- Capability negotiation
- Configuration schema
- Secrets management

### 6. **Lineage & Provenance** (Originally: "provenance fields")
**Missing:**
- What's tracked
- Lineage graph
- Audit log format
- Retention policy
- Query patterns
- Causality

### 7. **Queue System "MicroQueue"** (Originally: Name only)
**Missing:**
- Persistence format
- Delivery guarantees
- Priority levels
- Concurrency control
- Job payload schema
- Monitoring
- Poison pill handling

### 8. **Normalization Pipeline** (Originally: Bullet list)
**Missing:**
- Pipeline architecture
- Timestamp handling
- HTML→text library choice
- PII detection approach
- Redaction strategy
- Language detection
- Link extraction
- Attachment handling

### 9. **HTTP Client** (Originally: Feature list)
**Missing:**
- Connection pooling
- Timeout strategy
- Retry classification
- Backoff parameters
- Circuit breaker
- Request/response logging
- Proxy support
- TLS configuration

### 10. **Error Handling** (Originally: Almost absent)
**Missing:**
- Error taxonomy
- Error propagation
- Partial failure handling
- Recovery strategies
- User notification
- Error storage

### 11. **Observability** (Originally: Not mentioned)
**Missing:**
- Metrics
- Logging
- Tracing
- Health checks
- Alerting hooks

### 12. **Configuration** (Originally: Not mentioned)
**Missing:**
- Config schema
- Environment variables
- Config file format
- Secret injection
- Runtime reconfiguration
- Validation

### 13. **Testing Strategy** (Originally: Not mentioned)
**Missing:**
- Unit test patterns
- Integration tests
- E2E tests
- Contract tests
- Fixture management
- Determinism

### 14. **Security Model** (Originally: Minimal)
**Missing:**
- Secrets storage
- Token rotation
- PII handling
- Audit logging
- Input validation
- Dependency security

### 15. **Data Lifecycle** (Originally: Not mentioned)
**Missing:**
- Retention policies
- Archival strategy
- Deletion (GDPR)
- Data export

---

## Decisions Made

- **Approach**: Breadth-first (medium-depth pass on all areas, then iterate)
- **Reference Connector**: GitHub (cleanest API to validate SDK design)
- **Format**: Single mega-spec (update AGENT_MEMORY_PLAN.md inline)
- **Deferred**: Surface layer only (query API / agent integration)
- **Database**: PostgreSQL (not SQLite) for multi-process, pgvector, full-text search
- **Tenancy**: Single-user only
- **Account Scoping**: `source_ref_key` includes `account_id` to prevent cross-account collisions
- **Attachments**: Separate Attachment entity
- **Entity Resolution**: Incremental at runtime, batch reconciliation deferred
- **Embeddings**: Dimension configured at migration time (not hard-coded in code)
- **Queue**: At-least-once, retry 3x with backoff, max job runtime enforced, dump failed jobs to blob
- **Sync**: Versioned, journaled runs that can be replayed; idempotent and restartable
- **Debugging**: Fail loud/fast early; add robust exception handling later

## Dependencies

```json
{
  "dependencies": {
    "postgres": "^3.4.0",
    "zod": "^3.22.0",
    "ulid": "^2.3.0",
    "undici": "^6.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0",
    "bun-types": "^1.0.0"
  }
}
```

**PostgreSQL Extensions Required**:
- `pgvector` - for embedding storage and ANN search
- `pg_trgm` - for fuzzy text matching

---

## Work Plan: Breadth-First Pass

### Pass Order (Dependency-Driven)

1. **ID System** - Foundation for everything else
2. **Canonical Data Model** - Entity schemas
3. **RawEnvelope & Lineage** - Source data capture
4. **Storage Layer** - PostgreSQL schema, migrations
5. **Queue System** - Job persistence and delivery
6. **Sync Engine** - Collect/process coordination
7. **HTTP Client** - Resilient network layer
8. **Connector SDK** - Base classes and contracts
9. **GitHub Connector** - Reference implementation
10. **Entity Resolution** - Matching and merging
11. **Normalization Pipeline** - Data cleaning
12. **Error Handling & Observability** - Cross-cutting concerns
13. **Configuration** - Runtime configuration schema
14. **Testing Strategy** - Verification approach
15. **Other Connectors** - Gmail, X.com, iMessage (brief specs)

---

## 1. ID System

**Problem**: We need globally unique, time-ordered, source-traceable identifiers that support idempotent operations.

### ID Format: ULID
- **Choice**: ULID over UUIDv4/v7
- **Rationale**:
  - Lexicographically sortable (time-ordered)
  - 128-bit compatible with UUID columns
  - Monotonic within same millisecond
  - URL-safe (no hyphens)
  - Better index locality than random UUIDs

```typescript
// src/models/ids.ts
import { ulid } from 'ulid'

// Canonical entity IDs - generated by our system
type CanonicalId = string // ULID format: 01ARZ3NDEKTSV4RRFFQ69G5FAV

// Source IDs - opaque strings from external systems
type SourceId = string // e.g., "github:issue:123", "gmail:msg:abc123"

// Composite source reference
interface SourceRef {
  connector: ConnectorType  // 'github' | 'gmail' | 'xcom' | 'imessage'
  account_id: string        // External account identifier for scoping
  entity_type: string       // 'issue', 'message', 'tweet', etc.
  source_id: string         // ID from the source system
  source_version?: string   // ETag, version number, or hash for change detection
}

// Generate a deterministic ID from source reference (for idempotency)
function sourceRefToKey(ref: SourceRef): string {
  return `${ref.connector}:${ref.account_id}:${ref.entity_type}:${ref.source_id}`
}
```

### Idempotency Strategy

**Problem**: The same source record may be ingested multiple times (backfill, webhook, retry). We must not create duplicates.

**Solution**: Two-tier deduplication

1. **RawEnvelope Dedup**: Before storing raw data
   - Key: `sha256(connector + account_id + source_id + raw_data_hash)`
   - Check: If exists in raw_envelopes, skip insert
   - Window: Permanent (raw data is append-only, never deleted)

2. **Canonical Entity Dedup**: During normalization
   - Key: `source_ref_key` (connector:account_id:entity_type:source_id)
   - Check: entity_source_mappings table
   - Behavior: Update existing canonical entity if source_ref exists

```typescript
// Idempotency key computation
interface IdempotencyKey {
  raw_key: string      // For RawEnvelope dedup
  entity_key: string   // For canonical entity dedup
}

function computeIdempotencyKeys(
  connector: ConnectorType,
  accountId: string,
  entityType: string,
  sourceId: string,
  rawData: unknown
): IdempotencyKey {
  const entityKey = `${connector}:${accountId}:${entityType}:${sourceId}`
  const rawHash = sha256(stableStringify(rawData))
  const rawKey = sha256(`${entityKey}:${rawHash}`)
  return { raw_key: rawKey, entity_key: entityKey }
}

// Use a canonical JSON stringifier to ensure deterministic hashes.
// Example: json-stable-stringify or a small in-house stableStringify.
```

---

## 2. Canonical Data Model

**Design Philosophy**:
- Every entity has `id` (ULID), `created_at`, `updated_at`, `source_refs[]`
- Relationships are first-class (Link entity)
- Minimal required fields, extensive optional fields
- Zod schemas for validation + TypeScript types

```typescript
// src/models/canonical.ts
import { z } from 'zod'

// ============ Base Types ============

const SourceRefSchema = z.object({
  connector: z.enum(['github', 'gmail', 'xcom', 'imessage']),
  account_id: z.string(),
  entity_type: z.string(),
  source_id: z.string(),
  source_version: z.string().optional(),
  last_synced_at: z.string().datetime(),
})

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

const BaseEntitySchema = z.object({
  id: UlidSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  source_refs: z.array(SourceRefSchema).min(1),
  metadata: z.record(z.unknown()).optional(),
})

// ============ Core Entities ============

// Person: A human being (may have multiple identities)
const PersonSchema = BaseEntitySchema.extend({
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

// Identity: A person's presence on a specific platform
const IdentitySchema = BaseEntitySchema.extend({
  entity_type: z.literal('identity'),
  platform: z.enum(['github', 'gmail', 'xcom', 'imessage', 'unknown']),
  platform_user_id: z.string(),
  username: z.string().optional(),
  display_name: z.string().optional(),
  email: z.string().email().optional(),
  avatar_url: z.string().url().optional(),
  profile_url: z.string().url().optional(),
  person_id: UlidSchema.optional(),
})

// Org: An organization or company
const OrgSchema = BaseEntitySchema.extend({
  entity_type: z.literal('org'),
  name: z.string(),
  domain: z.string().optional(),
  description: z.string().optional(),
  avatar_url: z.string().url().optional(),
  url: z.string().url().optional(),
})

// Account: A user's account/connection to an external service
const AccountSchema = BaseEntitySchema.extend({
  entity_type: z.literal('account'),
  connector: z.enum(['github', 'gmail', 'xcom', 'imessage']),
  account_id: z.string(),
  display_name: z.string().optional(),
  email: z.string().email().optional(),
  is_active: z.boolean().default(true),
  last_synced_at: z.string().datetime().optional(),
  sync_cursor: z.string().optional(),
})

// ============ Activity Entities ============

// Message: Email, chat message, DM, comment
const MessageSchema = BaseEntitySchema.extend({
  entity_type: z.literal('message'),
  thread_id: z.string().optional(),
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

// Event: Calendar event, meeting, scheduled item
const EventSchema = BaseEntitySchema.extend({
  entity_type: z.literal('event'),
  title: z.string(),
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

// Task: Issue, PR, todo item, ticket
const TaskSchema = BaseEntitySchema.extend({
  entity_type: z.literal('task'),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'closed', 'cancelled']).default('open'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  creator_identity_id: UlidSchema.optional(),
  assignee_identity_ids: z.array(UlidSchema).default([]),
  due_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  parent_task_id: UlidSchema.optional(),
  labels: z.array(z.string()).default([]),
  platform_url: z.string().url().optional(),
})

// Notification: Alert, mention, update notification
const NotificationSchema = BaseEntitySchema.extend({
  entity_type: z.literal('notification'),
  notification_type: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  related_entity_id: UlidSchema.optional(),
  related_entity_type: z.string().optional(),
  is_read: z.boolean().default(false),
  read_at: z.string().datetime().optional(),
  triggered_at: z.string().datetime(),
})

// Observation: A note, reflection, or AI-generated insight
const ObservationSchema = BaseEntitySchema.extend({
  entity_type: z.literal('observation'),
  content: z.string(),
  observation_type: z.enum(['note', 'summary', 'insight', 'reminder']),
  related_entity_ids: z.array(UlidSchema).default([]),
  confidence: z.number().min(0).max(1).optional(),
})

// ============ Relationship Entity ============

// Link: Explicit relationship between entities
const LinkSchema = BaseEntitySchema.extend({
  entity_type: z.literal('link'),
  from_entity_id: UlidSchema,
  from_entity_type: z.string(),
  to_entity_id: UlidSchema,
  to_entity_type: z.string(),
  link_type: z.string(),
  context: z.string().optional(),
})

// Attachment: File or media attached to messages/tasks
const AttachmentSchema = BaseEntitySchema.extend({
  entity_type: z.literal('attachment'),
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  content_hash: z.string(),
  storage_type: z.enum(['local', 'reference']),
  storage_path: z.string().optional(),
  source_url: z.string().url().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  duration_ms: z.number().int().optional(),
})

// ============ Type Exports ============

type Person = z.infer<typeof PersonSchema>
type Identity = z.infer<typeof IdentitySchema>
type Org = z.infer<typeof OrgSchema>
type Account = z.infer<typeof AccountSchema>
type Message = z.infer<typeof MessageSchema>
type Event = z.infer<typeof EventSchema>
type Task = z.infer<typeof TaskSchema>
type Notification = z.infer<typeof NotificationSchema>
type Observation = z.infer<typeof ObservationSchema>
type Link = z.infer<typeof LinkSchema>
type Attachment = z.infer<typeof AttachmentSchema>

type CanonicalEntity =
  | Person | Identity | Org | Account
  | Message | Event | Task | Notification | Observation | Link | Attachment

const EntityTypeSchema = z.enum([
  'person', 'identity', 'org', 'account',
  'message', 'event', 'task', 'notification', 'observation', 'link', 'attachment'
])
```

---

## 3. RawEnvelope & Lineage

**Purpose**: Immutable capture of all source data for auditability and replay.

```typescript
// src/models/raw.ts
import { z } from 'zod'

const RawEnvelopeSchema = z.object({
  id: UlidSchema,
  idempotency_key: z.string(),
  connector: z.enum(['github', 'gmail', 'xcom', 'imessage']),
  account_id: z.string(),
  entity_type: z.string(),
  source_id: z.string(),
  source_version: z.string().optional(),
  raw_data: z.unknown(),
  raw_data_hash: z.string(),
  source_timestamp: z.string().datetime().optional(),
  received_at: z.string().datetime(),
  processed_at: z.string().datetime().optional(),
  processing_error: z.string().optional(),
  sync_job_id: UlidSchema,
  collection_method: z.enum(['backfill', 'incremental', 'webhook', 'manual']),
})

type RawEnvelope = z.infer<typeof RawEnvelopeSchema>

const EntitySourceMappingSchema = z.object({
  id: UlidSchema,
  canonical_entity_id: UlidSchema,
  canonical_entity_type: z.string(),
  raw_envelope_id: UlidSchema,
  source_ref_key: z.string(), // connector:account_id:entity_type:source_id
  created_at: z.string().datetime(),
  mapping_confidence: z.number().min(0).max(1).default(1.0),
})

type EntitySourceMapping = z.infer<typeof EntitySourceMappingSchema>
```

---

## 4. Storage Layer (PostgreSQL)

**Design Decisions**:
- PostgreSQL for multi-process support, embeddings, full-text search
- JSONB for flexible entity storage with GIN indexes
- pgvector extension for embedding storage and similarity search
- Connection pooling via postgres.js
- Explicit schema versioning with forward migrations only (versioned migration folder)
- Embedding dimension is configurable and set at migration time (single source of truth)

**Why PostgreSQL over SQLite**:
- Multi-process access without locking issues
- pgvector for embedding storage and ANN search
- Native full-text search (tsvector + GIN indexes)
- Better JSONB querying and indexing
- Point-in-time recovery, streaming replication if needed later

```sql
-- src/db/schema.sql
-- Version: 1

CREATE EXTENSION IF NOT EXISTS "pgvector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Schema versioning
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT
);

-- Raw Data
CREATE TABLE IF NOT EXISTS raw_envelopes (
  id TEXT PRIMARY KEY,
  CONSTRAINT raw_envelopes_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  idempotency_key TEXT NOT NULL UNIQUE,
  connector TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT,
  raw_data JSONB NOT NULL,
  raw_data_hash TEXT NOT NULL,
  source_timestamp TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  sync_job_id TEXT NOT NULL,
  collection_method TEXT NOT NULL
);

CREATE INDEX idx_raw_envelopes_connector_entity ON raw_envelopes(connector, entity_type);
CREATE INDEX idx_raw_envelopes_source_ref ON raw_envelopes(connector, entity_type, source_id);
CREATE INDEX idx_raw_envelopes_received_at ON raw_envelopes(received_at DESC);
CREATE INDEX idx_raw_envelopes_unprocessed ON raw_envelopes(received_at) WHERE processed_at IS NULL;
CREATE INDEX idx_raw_envelopes_raw_data ON raw_envelopes USING GIN (raw_data jsonb_path_ops);

-- Canonical Entities
CREATE TABLE IF NOT EXISTS canonical_entities (
  id TEXT PRIMARY KEY,
  CONSTRAINT canonical_entities_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_type TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_text TEXT,
  search_vector TSVECTOR,
  embedding VECTOR(/* configured at migration time */),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_canonical_entities_type ON canonical_entities(entity_type);
CREATE INDEX idx_canonical_entities_type_updated ON canonical_entities(entity_type, updated_at DESC);
CREATE INDEX idx_canonical_entities_data ON canonical_entities USING GIN (data jsonb_path_ops);
CREATE INDEX idx_canonical_entities_search ON canonical_entities USING GIN (search_vector);
CREATE INDEX idx_canonical_entities_embedding ON canonical_entities USING hnsw (embedding vector_cosine_ops);

-- Entity Source Mappings (Lineage)
CREATE TABLE IF NOT EXISTS entity_source_mappings (
  id TEXT PRIMARY KEY,
  CONSTRAINT entity_source_mappings_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  canonical_entity_id TEXT NOT NULL REFERENCES canonical_entities(id) ON DELETE CASCADE,
  canonical_entity_type TEXT NOT NULL,
  raw_envelope_id TEXT NOT NULL REFERENCES raw_envelopes(id),
  source_ref_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mapping_confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0
);

CREATE UNIQUE INDEX idx_entity_source_mappings_source_key ON entity_source_mappings(source_ref_key);
CREATE INDEX idx_entity_source_mappings_canonical ON entity_source_mappings(canonical_entity_id);

-- Sync Jobs
CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  CONSTRAINT sync_jobs_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  connector TEXT NOT NULL,
  account_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  cursor_state JSONB,
  items_fetched INTEGER DEFAULT 0,
  items_processed INTEGER DEFAULT 0,
  items_failed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  retry_count INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  metadata JSONB
);

CREATE INDEX idx_sync_jobs_status ON sync_jobs(status);
CREATE INDEX idx_sync_jobs_pending ON sync_jobs(priority DESC, created_at ASC) WHERE status = 'pending';

-- Job Queue
CREATE TABLE IF NOT EXISTS job_queue (
  id TEXT PRIMARY KEY,
  CONSTRAINT job_queue_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  visible_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  locked_by TEXT,
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  idempotency_key TEXT UNIQUE
);

CREATE INDEX idx_job_queue_pending ON job_queue(status, priority DESC, visible_at ASC)
  WHERE status = 'pending';

-- Entity Resolution
CREATE TABLE IF NOT EXISTS merge_decisions (
  id TEXT PRIMARY KEY,
  CONSTRAINT merge_decisions_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  primary_entity_id TEXT NOT NULL,
  merged_entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  reason JSONB,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by TEXT,
  is_reversed BOOLEAN DEFAULT FALSE,
  reversed_at TIMESTAMPTZ,
  reversed_by TEXT
);

CREATE INDEX idx_merge_decisions_primary ON merge_decisions(primary_entity_id);
CREATE INDEX idx_merge_decisions_merged ON merge_decisions(merged_entity_id);

CREATE TABLE IF NOT EXISTS pending_reviews (
  id TEXT PRIMARY KEY,
  CONSTRAINT pending_reviews_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  identity_id TEXT NOT NULL REFERENCES canonical_entities(id),
  suggested_person_id TEXT NOT NULL REFERENCES canonical_entities(id),
  match_scores JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  decision TEXT
);

-- Accounts & Auth
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  CONSTRAINT accounts_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  connector TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  auth_type TEXT NOT NULL,
  credentials_encrypted BYTEA,
  credentials_iv BYTEA,
  token_expires_at TIMESTAMPTZ,
  refresh_token_encrypted BYTEA,
  is_active BOOLEAN DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ,
  sync_cursor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(connector, external_account_id)
);

-- Webhook Deliveries (Deduplication)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full-Text Search Trigger
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.display_text, '') || ' ' ||
    COALESCE(NEW.data->>'title', '') || ' ' ||
    COALESCE(NEW.data->>'description', '') || ' ' ||
    COALESCE(NEW.data->>'body_text', '') || ' ' ||
    COALESCE(NEW.data->>'content', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_search_vector
  BEFORE INSERT OR UPDATE ON canonical_entities
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();
```

---

## 5. Queue System (MicroQueue)

**Design**: PostgreSQL-backed job queue with at-least-once delivery, visibility timeout, and exponential backoff.
**Scope**: Single-process worker (no cross-process rate-limiting or circuit-breaker coordination).
**Policy**:
- Retry 3x with exponential backoff
- Enforce max job runtime (few minutes), then mark failed
- On final failure, dump payload + error context into a blob for later inspection

```typescript
// src/sync/queue.ts

interface QueueConfig {
  defaultVisibilityTimeout: number  // ms, default 30000
  maxAttempts: number               // default 3
  baseRetryDelay: number            // ms, default 1000
  maxRetryDelay: number             // ms, default 60000
  maxJobRuntime: number             // ms, default 180000
}

interface Job<T = unknown> {
  id: string
  type: string
  payload: T
  priority: number
  attemptCount: number
  createdAt: Date
}

interface JobResult {
  success: boolean
  error?: Error
  retryDelay?: number
}

type JobHandler<T> = (job: Job<T>) => Promise<JobResult>

class MicroQueue {
  private db: Sql
  private handlers: Map<string, JobHandler<unknown>>
  private config: QueueConfig
  private workerId: string
  private isRunning: boolean

  constructor(db: Sql, config: QueueConfig) {
    this.db = db
    this.config = config
    this.workerId = ulid()
    this.handlers = new Map()
    this.isRunning = false
  }

  register<T>(jobType: string, handler: JobHandler<T>): void {
    this.handlers.set(jobType, handler as JobHandler<unknown>)
  }

  async enqueue<T>(
    jobType: string,
    payload: T,
    options?: { priority?: number; delay?: number; idempotencyKey?: string }
  ): Promise<string> {
    const id = ulid()
    const visibleAt = new Date(Date.now() + (options?.delay ?? 0))

    await this.db`
      INSERT INTO job_queue (id, job_type, payload, priority, visible_at, idempotency_key)
      VALUES (${id}, ${jobType}, ${JSON.stringify(payload)}::jsonb, ${options?.priority ?? 0}, ${visibleAt}, ${options?.idempotencyKey ?? null})
      ON CONFLICT (idempotency_key) DO NOTHING
    `
    return id
  }

  private async dequeue(): Promise<Job | null> {
    const lockUntil = new Date(Date.now() + this.config.defaultVisibilityTimeout)

    const [row] = await this.db`
      UPDATE job_queue
      SET status = 'running', locked_until = ${lockUntil}, locked_by = ${this.workerId},
          started_at = NOW(), attempt_count = attempt_count + 1
      WHERE id = (
        SELECT id FROM job_queue
        WHERE status = 'pending' AND visible_at <= NOW()
        ORDER BY priority DESC, visible_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `

    if (!row) return null

    return {
      id: row.id,
      type: row.job_type,
      payload: row.payload,
      priority: row.priority,
      attemptCount: row.attempt_count,
      createdAt: new Date(row.created_at),
    }
  }

  async start(): Promise<void> {
    this.isRunning = true
    while (this.isRunning) {
      const job = await this.dequeue()
      if (!job) {
        await sleep(100)
        continue
      }

      const handler = this.handlers.get(job.type)
      if (!handler) {
        await this.fail(job.id, new Error(`No handler for job type: ${job.type}`))
        continue
      }

      try {
        const result = await withTimeout(handler(job), this.config.maxJobRuntime)
        if (result.success) {
          await this.complete(job.id)
        } else {
          await this.fail(job.id, result.error ?? new Error('Unknown error'), result.retryDelay)
        }
      } catch (error) {
        await this.fail(job.id, error as Error)
      }
    }
  }

  stop(): void { this.isRunning = false }
}
```

---

## 6. Sync Engine

**Architecture**: Two-phase pipeline with clear separation.
**Principles**:
- Journal sync runs; every run is versioned and replayable
- Idempotent processing (safe to re-run the same source data)
- Expect bad data and mid-job crashes; jobs can be restarted
- Fail loud and fast in early implementations; add guardrails later
- Keep knobs for max retries/timeouts to simplify debugging and restarts
**Journaling**:
- Use `sync_jobs` as the run journal with immutable run IDs and cursor snapshots
- Reprocessing = re-enqueue processing jobs for the run's raw envelopes

```
┌─────────────────────────────────────────────────────────────────────┐
│                        COLLECT PHASE                                │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                      │
│  │ Backfill │    │Incremental│   │ Webhook  │                      │
│  │   Job    │    │ Sync Job │    │ Handler  │                      │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘                      │
│       └───────────────┴───────────────┘                             │
│                       ▼                                             │
│              ┌────────────────┐                                     │
│              │  RawEnvelope   │  (Append-only, immutable)           │
│              └────────┬───────┘                                     │
└───────────────────────│─────────────────────────────────────────────┘
                        │ Enqueue ProcessEnvelopeJob
                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                       PROCESS PHASE                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐         │
│  │   Validate   │───▶│  Normalize   │───▶│    Upsert    │         │
│  │ (Zod parse)  │    │  (Cleaning)  │    │  (Canonical) │         │
│  └──────────────┘    └──────────────┘    └──────────────┘         │
│                                                  │                 │
│                                                  ▼                 │
│                                    ┌──────────────────────┐        │
│                                    │  Entity Resolution   │        │
│                                    └──────────────────────┘        │
└────────────────────────────────────────────────────────────────────┘
```

### Failure Modes & Recovery

| Failure Mode | Detection | Recovery |
|-------------|-----------|----------|
| Network timeout | HTTP client timeout | Retry with backoff |
| Rate limited | 429 status | Respect Retry-After |
| Auth expired | 401 status | Refresh token, retry |
| Parse error | Zod validation failure | Log error, skip record |
| DB write failure | PostgreSQL error | Retry job |
| Webhook invalid | Verification fails | Reject, no retry |

---

## 7. HTTP Client (Resilient)

```typescript
// src/connector/sdk/http.ts

interface HttpClientConfig {
  connectTimeout: number      // ms, default 5000
  requestTimeout: number      // ms, default 30000
  maxRetries: number          // default 3
  retryableStatuses: number[] // default [429, 500, 502, 503, 504]
  baseRetryDelay: number      // ms, default 1000
  maxRetryDelay: number       // ms, default 30000
  maxRequestsPerSecond: number  // default 10
  circuitBreakerThreshold: number  // failures before open, default 5
  circuitBreakerResetMs: number    // time before half-open, default 30000
  maxConnections: number      // default 10
}

class ResilientHttpClient {
  private config: HttpClientConfig
  private circuitState: 'closed' | 'open' | 'half-open' = 'closed'
  private failureCount: number = 0
  private rateLimiter: TokenBucket

  async request<T>(url: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    // Circuit breaker check
    if (this.circuitState === 'open') {
      if (Date.now() - this.lastFailure!.getTime() > this.config.circuitBreakerResetMs) {
        this.circuitState = 'half-open'
      } else {
        throw new CircuitBreakerOpenError()
      }
    }

    // Rate limiting
    await this.rateLimiter.acquire()

    // Retry loop with exponential backoff
    // ... implementation
  }
}
```

---

## 8. Connector SDK

```typescript
// src/connector/sdk/types.ts

interface ConnectorCapabilities {
  supportsBackfill: boolean
  supportsIncrementalSync: boolean
  supportsWebhook: boolean
  supportsWrite: boolean
  supportedEntityTypes: string[]
}

type AuthType = 'oauth2' | 'api_key' | 'local'

// src/connector/sdk/base.ts

abstract class BaseConnector {
  abstract readonly type: ConnectorType
  abstract readonly displayName: string
  abstract readonly capabilities: ConnectorCapabilities
  abstract readonly authConfig: AuthConfig

  // Auth
  abstract getAuthorizationUrl(state: string): string
  abstract exchangeCodeForTokens(code: string): Promise<AuthTokens>
  abstract refreshTokens(refreshToken: string): Promise<AuthTokens>

  // Discovery
  abstract listAccounts(): Promise<AccountInfo[]>

  // Sync
  abstract fetchPage(options: FetchPageOptions): Promise<FetchPageResult>
  abstract fetchChanges(options: FetchChangesOptions): Promise<FetchPageResult>

  // Webhooks
  abstract verifyWebhookSignature(event: WebhookEvent): Promise<boolean>
  abstract parseWebhookPayload(payload: unknown): Promise<SourceItem[]>

  // Schema
  abstract getSourceSchema(entityType: string): z.ZodSchema
  abstract getMapper(entityType: string): EntityMapper
}
```

---

## 9. GitHub Connector (Reference Implementation)

```typescript
// src/connectors/github/index.ts

class GitHubConnector extends BaseConnector {
  readonly type = 'github' as const
  readonly displayName = 'GitHub'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: true,
    supportsWrite: true,
    supportedEntityTypes: ['user', 'repo', 'issue', 'pull_request', 'comment', 'notification'],
  }

  readonly authConfig: OAuth2Config = {
    type: 'oauth2',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user', 'read:org', 'notifications'],
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  }

  // Full implementation with Zod schemas, mappers, sync logic...
}
```

---

## 10. Entity Resolution

```typescript
// src/resolution/engine.ts

interface MatchScores {
  emailExact: number      // 0 or 100
  emailDomain: number     // 0-30
  phoneExact: number      // 0 or 100
  usernameMatch: number   // 0-50
  nameExact: number       // 0-40
  nameFuzzy: number       // 0-30
  orgOverlap: number      // 0-20
}

const MERGE_THRESHOLD = 80  // Auto-merge
const REVIEW_THRESHOLD = 50 // Human review

class EntityResolutionEngine {
  async resolveIdentity(identityId: string): Promise<void> {
    const identity = getCanonicalEntity(this.db, identityId)
    if (identity.person_id) return  // Already resolved

    const candidates = this.findCandidatePersons(identity)

    if (candidates.length === 0) {
      // Create new person
      const person = this.createPersonFromIdentity(identity)
      this.linkIdentityToPerson(identity.id, person.id)
      return
    }

    // Score each candidate
    const matches = candidates.map(c => ({
      entityB: c.id,
      scores: this.computeMatchScores(identity, c),
      totalScore: this.computeTotalScore(scores),
    }))

    const bestMatch = matches.reduce((best, m) => m.totalScore > best.totalScore ? m : best)

    if (bestMatch.totalScore >= MERGE_THRESHOLD) {
      this.linkIdentityToPerson(identity.id, bestMatch.entityB)
      this.recordMergeDecision({ ... })
    } else if (bestMatch.totalScore >= REVIEW_THRESHOLD) {
      this.queueForReview(identity.id, bestMatch.entityB, bestMatch)
    } else {
      const person = this.createPersonFromIdentity(identity)
      this.linkIdentityToPerson(identity.id, person.id)
    }
  }
}
```

---

## 11. Embedding Support (pgvector)

```typescript
// src/embeddings/search.ts

async function semanticSearch(
  db: Sql,
  client: EmbeddingClient,
  query: string,
  options: SimilaritySearchOptions = {}
): Promise<Array<{ id: string; entity_type: string; similarity: number }>> {
  const queryEmbedding = await client.embedSingle(query)

  return db`
    SELECT id, entity_type, 1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector) as similarity
    FROM canonical_entities
    WHERE embedding IS NOT NULL AND deleted_at IS NULL
    ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
    LIMIT ${options.limit ?? 10}
  `
}

async function hybridSearch(
  db: Sql,
  client: EmbeddingClient,
  query: string,
  options: { ftWeight?: number; semanticWeight?: number } = {}
): Promise<Array<{ id: string; score: number }>> {
  // Combine full-text (tsvector) and semantic (vector) search
  // ...
}
```

---

## 12. Error Handling

```typescript
// src/errors/types.ts

class AgentMemoryError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly metadata: Record<string, unknown>
}

class AuthError extends AgentMemoryError { ... }
class TokenExpiredError extends AuthError { ... }
class NetworkError extends AgentMemoryError { ... }
class RateLimitError extends NetworkError { readonly retryAfter: number }
class ValidationError extends AgentMemoryError { ... }
class SyncError extends AgentMemoryError { ... }
```

---

## 13. Configuration

```typescript
// src/config/schema.ts

const AppConfigSchema = z.object({
  database: DatabaseConfigSchema.default({}),
  queue: QueueConfigSchema.default({}),
  http: HttpConfigSchema.default({}),
  sync: SyncConfigSchema.default({}),
  entityResolution: EntityResolutionConfigSchema.default({}),
  embeddings: z.object({
    dimension: z.number().int().positive().default(1536),
  }).default({}),
  connectors: ConnectorConfigSchema.default({}),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  dataDir: z.string().default('./data'),
})

function loadConfig(): AppConfig {
  // Load from file + environment overrides
  // PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
  // GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, etc.
}
```

---

## 14. Other Connectors (Brief Specs)

### Gmail Connector
- **Auth**: OAuth 2.0 with offline access
- **Sync**: `users.messages.list` + `historyId` for delta
- **Entities**: Message, Thread, Contact
- **Webhook**: Pub/Sub push notifications

### X.com Connector
- **Auth**: OAuth 2.0 (Twitter API v2)
- **Sync**: `users/:id/tweets` + `since_id`
- **Entities**: Tweet, User, Mention
- **Webhook**: Account Activity API

### iMessage Connector
- **Auth**: Local
- **Sync**: Query local `chat.db` SQLite
- **Entities**: Message, Attachment, Chat, Contact
- **Notes**: macOS `~/Library/Messages/chat.db`

---

## Implementation Order

1. **Week 1**: Project setup, ID system, canonical schemas, PostgreSQL schema
2. **Week 2**: Database client, MicroQueue, HTTP client
3. **Week 3**: Connector SDK, cursor helpers, webhook framework
4. **Week 4**: Sync engine (collect + process phases)
5. **Week 5**: GitHub connector (reference implementation)
6. **Week 6**: Entity resolution, merge decisions
7. **Week 7**: Normalization, configuration, observability
8. **Week 8**: Gmail, X.com, iMessage connectors

---

## Remaining Open Questions

- [ ] Encrypt raw_data at rest?
- [ ] Backup automation approach?
- [ ] Ordering guarantees per entity type?
- [ ] Migration strategy if embedding dimension changes?
