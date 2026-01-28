-- Coding decisions table: explicit choices made when presented with options
-- Includes FTS + embedding support from the start

CREATE TABLE IF NOT EXISTS coding_decisions (
  id TEXT PRIMARY KEY,
  CONSTRAINT coding_decisions_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  category TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  alternatives_considered TEXT NOT NULL DEFAULT '',
  tradeoffs TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  project_context TEXT NOT NULL DEFAULT '',
  task_context TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  signal_strength TEXT NOT NULL CHECK (signal_strength IN ('explicit', 'implicit')),
  reversibility TEXT NOT NULL CHECK (reversibility IN ('easy', 'moderate', 'hard')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_vector TSVECTOR,
  embedding VECTOR(1536)
);

-- Unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_decisions_unique
  ON coding_decisions(category, decision, scope);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_coding_decisions_category ON coding_decisions(category);
CREATE INDEX IF NOT EXISTS idx_coding_decisions_confidence ON coding_decisions(confidence);

-- FTS trigger
CREATE OR REPLACE FUNCTION update_coding_decisions_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.decision, '') || ' ' ||
    COALESCE(NEW.rationale, '') || ' ' ||
    COALESCE(NEW.tradeoffs, '') || ' ' ||
    COALESCE(NEW.scope, '') || ' ' ||
    COALESCE(NEW.category, '') || ' ' ||
    COALESCE(NEW.project_context, '') || ' ' ||
    COALESCE(NEW.task_context, '') || ' ' ||
    COALESCE(NEW.alternatives_considered, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_search_vector_decisions
  BEFORE INSERT OR UPDATE ON coding_decisions
  FOR EACH ROW EXECUTE FUNCTION update_coding_decisions_search_vector();

-- GIN index for FTS
CREATE INDEX IF NOT EXISTS idx_coding_decisions_search
  ON coding_decisions USING GIN (search_vector);

-- HNSW index for embedding similarity
CREATE INDEX IF NOT EXISTS idx_coding_decisions_embedding
  ON coding_decisions USING hnsw (embedding vector_cosine_ops);
