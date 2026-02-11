-- Canonical per-type tables

-- Remove FK constraints that assumed canonical_entities
ALTER TABLE entity_source_mappings
  DROP CONSTRAINT IF EXISTS entity_source_mappings_canonical_entity_id_fkey;

ALTER TABLE pending_reviews
  DROP CONSTRAINT IF EXISTS pending_reviews_identity_id_fkey;

ALTER TABLE pending_reviews
  DROP CONSTRAINT IF EXISTS pending_reviews_suggested_person_id_fkey;

-- Create per-type canonical tables
CREATE TABLE IF NOT EXISTS canonical_message (
  id TEXT PRIMARY KEY,
  CONSTRAINT canonical_message_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_type TEXT NOT NULL DEFAULT 'message' CHECK (entity_type = 'message'),
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_text TEXT,
  search_vector TSVECTOR,
  embedding VECTOR(1536),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS canonical_conversation (
  id TEXT PRIMARY KEY,
  CONSTRAINT canonical_conversation_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_type TEXT NOT NULL DEFAULT 'conversation' CHECK (entity_type = 'conversation'),
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_text TEXT,
  search_vector TSVECTOR,
  embedding VECTOR(1536),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS canonical_issue (
  id TEXT PRIMARY KEY,
  CONSTRAINT canonical_issue_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_type TEXT NOT NULL DEFAULT 'issue' CHECK (entity_type = 'issue'),
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_text TEXT,
  search_vector TSVECTOR,
  embedding VECTOR(1536),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS canonical_notification (
  id TEXT PRIMARY KEY,
  CONSTRAINT canonical_notification_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_type TEXT NOT NULL DEFAULT 'notification' CHECK (entity_type = 'notification'),
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_text TEXT,
  search_vector TSVECTOR,
  embedding VECTOR(1536),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_canonical_message_updated ON canonical_message(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_message_data ON canonical_message USING GIN (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_message_search ON canonical_message USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_canonical_message_embedding ON canonical_message USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_canonical_conversation_updated ON canonical_conversation(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_conversation_data ON canonical_conversation USING GIN (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_conversation_search ON canonical_conversation USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_canonical_conversation_embedding ON canonical_conversation USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_canonical_issue_updated ON canonical_issue(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_issue_data ON canonical_issue USING GIN (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_issue_search ON canonical_issue USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_canonical_issue_embedding ON canonical_issue USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_canonical_notification_updated ON canonical_notification(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_notification_data ON canonical_notification USING GIN (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_notification_search ON canonical_notification USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_canonical_notification_embedding ON canonical_notification USING hnsw (embedding vector_cosine_ops);

-- Attach search vector trigger to per-type tables
DROP TRIGGER IF EXISTS trg_update_search_vector_message ON canonical_message;
CREATE TRIGGER trg_update_search_vector_message
  BEFORE INSERT OR UPDATE ON canonical_message
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

DROP TRIGGER IF EXISTS trg_update_search_vector_conversation ON canonical_conversation;
CREATE TRIGGER trg_update_search_vector_conversation
  BEFORE INSERT OR UPDATE ON canonical_conversation
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

DROP TRIGGER IF EXISTS trg_update_search_vector_issue ON canonical_issue;
CREATE TRIGGER trg_update_search_vector_issue
  BEFORE INSERT OR UPDATE ON canonical_issue
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

DROP TRIGGER IF EXISTS trg_update_search_vector_notification ON canonical_notification;
CREATE TRIGGER trg_update_search_vector_notification
  BEFORE INSERT OR UPDATE ON canonical_notification
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Legacy table (kept for now; no longer used by code)
-- DROP TABLE IF EXISTS canonical_entities;
