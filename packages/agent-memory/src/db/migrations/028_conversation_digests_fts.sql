-- Add full-text search support to conversation_digests table

-- Create trigger function for conversation_digests
CREATE OR REPLACE FUNCTION update_conversation_digests_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.summary, '') || ' ' ||
    COALESCE(NEW.outcome, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add search_vector column
ALTER TABLE conversation_digests ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

-- Create GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_conversation_digests_search
  ON conversation_digests USING GIN (search_vector);

-- Create trigger to auto-update search_vector
DROP TRIGGER IF EXISTS trg_update_search_vector_digests ON conversation_digests;
CREATE TRIGGER trg_update_search_vector_digests
  BEFORE INSERT OR UPDATE ON conversation_digests
  FOR EACH ROW EXECUTE FUNCTION update_conversation_digests_search_vector();

-- Backfill existing records
UPDATE conversation_digests
SET search_vector = to_tsvector('english',
  COALESCE(summary, '') || ' ' ||
  COALESCE(outcome, '')
)
WHERE search_vector IS NULL;
