-- Migration: 001_initial
-- Description: Initial schema for agent memory system
-- Version: 1

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgvector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Schema versioning
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT
);

-- ============ Raw Data Layer ============

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

-- ============ Canonical Entities ============

-- Note: embedding column uses a placeholder dimension that must be set via migration config
-- Default is 1536 (OpenAI ada-002), but can be 384 (MiniLM), 768 (BERT), 3072 (OpenAI large), etc.
CREATE TABLE IF NOT EXISTS canonical_entities (
  id TEXT PRIMARY KEY,
  CONSTRAINT canonical_entities_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_type TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_text TEXT,
  search_vector TSVECTOR,
  embedding VECTOR(1536),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_canonical_entities_type ON canonical_entities(entity_type);
CREATE INDEX idx_canonical_entities_type_updated ON canonical_entities(entity_type, updated_at DESC);
CREATE INDEX idx_canonical_entities_data ON canonical_entities USING GIN (data jsonb_path_ops);
CREATE INDEX idx_canonical_entities_search ON canonical_entities USING GIN (search_vector);
CREATE INDEX idx_canonical_entities_embedding ON canonical_entities USING hnsw (embedding vector_cosine_ops);

-- ============ Entity Source Mappings (Lineage) ============

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

-- ============ Sync Jobs ============

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

-- ============ Job Queue ============

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

-- ============ Entity Resolution ============

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

-- ============ Accounts & Auth ============

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

-- ============ Webhook Deliveries (Deduplication) ============

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============ Full-Text Search Trigger ============

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

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES (1, 'Initial schema for agent memory system');
