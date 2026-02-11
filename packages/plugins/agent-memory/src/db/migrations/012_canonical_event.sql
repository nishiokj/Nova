-- Canonical event table for calendar events

CREATE TABLE IF NOT EXISTS canonical_event (
  id TEXT PRIMARY KEY,
  CONSTRAINT canonical_event_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_type TEXT NOT NULL DEFAULT 'event' CHECK (entity_type = 'event'),
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_text TEXT,
  search_vector TSVECTOR,
  embedding VECTOR(1536),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_canonical_event_updated ON canonical_event(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_event_data ON canonical_event USING GIN (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_event_search ON canonical_event USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_canonical_event_embedding ON canonical_event USING hnsw (embedding vector_cosine_ops);

DROP TRIGGER IF EXISTS trg_update_search_vector_event ON canonical_event;

-- Only create trigger if it doesn't exist (PostgreSQL doesn't have IF NOT EXISTS for triggers)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_update_search_vector_event'
  ) THEN
    CREATE TRIGGER trg_update_search_vector_event
      BEFORE INSERT OR UPDATE ON canonical_event
      FOR EACH ROW EXECUTE FUNCTION update_search_vector();
  END IF;
END $$;
