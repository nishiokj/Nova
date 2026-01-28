-- Add full-text search support to coding_preferences table

-- Create a custom trigger function for coding_preferences
CREATE OR REPLACE FUNCTION update_coding_preferences_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.preference, '') || ' ' ||
    COALESCE(NEW.context, '') || ' ' ||
    COALESCE(NEW.failure_mode_prevented, '') || ' ' ||
    COALESCE(NEW.counterexample, '') || ' ' ||
    COALESCE(NEW.category, '') || ' ' ||
    COALESCE(NEW.kind, '') || ' ' ||
    COALESCE(NEW.scope, '') || ' ' ||
    COALESCE(NEW.entity_free_formulation, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add search_vector column
ALTER TABLE coding_preferences ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

-- Create GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_coding_preferences_search
  ON coding_preferences USING GIN (search_vector);

-- Create trigger to auto-update search_vector
DROP TRIGGER IF EXISTS trg_update_search_vector_preferences ON coding_preferences;
CREATE TRIGGER trg_update_search_vector_preferences
  BEFORE INSERT OR UPDATE ON coding_preferences
  FOR EACH ROW EXECUTE FUNCTION update_coding_preferences_search_vector();

-- Backfill existing records
UPDATE coding_preferences
SET search_vector = to_tsvector('english',
  COALESCE(preference, '') || ' ' ||
  COALESCE(context, '') || ' ' ||
  COALESCE(failure_mode_prevented, '') || ' ' ||
  COALESCE(counterexample, '') || ' ' ||
  COALESCE(category, '') || ' ' ||
  COALESCE(kind, '') || ' ' ||
  COALESCE(scope, '') || ' ' ||
  COALESCE(entity_free_formulation, '')
)
WHERE search_vector IS NULL;
