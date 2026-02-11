-- Add vector embedding column to coding_preferences for semantic search

ALTER TABLE coding_preferences ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);

CREATE INDEX IF NOT EXISTS idx_coding_preferences_embedding
  ON coding_preferences USING hnsw (embedding vector_cosine_ops);
