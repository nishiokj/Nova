-- Backfill source_timestamp from JSONB data for canonical tables
-- The data is sometimes double-encoded (string containing JSON) or an array

-- canonical_conversation: extract created_at from data
UPDATE canonical_conversation
SET source_timestamp = CASE
  WHEN jsonb_typeof(data) = 'string' THEN
    ((data #>> '{}')::jsonb->>'created_at')::timestamptz
  WHEN jsonb_typeof(data) = 'array' THEN
    ((data->0 #>> '{}')::jsonb->>'created_at')::timestamptz
  WHEN jsonb_typeof(data) = 'object' THEN
    (data->>'created_at')::timestamptz
  ELSE NULL
END
WHERE source_timestamp IS NULL;

-- canonical_message: extract timestamp from data
UPDATE canonical_message
SET source_timestamp = CASE
  WHEN jsonb_typeof(data) = 'string' THEN
    COALESCE(
      ((data #>> '{}')::jsonb->>'timestamp')::timestamptz,
      ((data #>> '{}')::jsonb->>'created_at')::timestamptz
    )
  WHEN jsonb_typeof(data) = 'array' THEN
    COALESCE(
      ((data->0 #>> '{}')::jsonb->>'timestamp')::timestamptz,
      ((data->0 #>> '{}')::jsonb->>'created_at')::timestamptz
    )
  WHEN jsonb_typeof(data) = 'object' THEN
    COALESCE(
      (data->>'timestamp')::timestamptz,
      (data->>'created_at')::timestamptz
    )
  ELSE NULL
END
WHERE source_timestamp IS NULL;

-- Add source_timestamp to coding_preferences
ALTER TABLE coding_preferences ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;

-- Add source_timestamp to coding_decisions
ALTER TABLE coding_decisions ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;

-- Create indices for source_timestamp queries
CREATE INDEX IF NOT EXISTS idx_coding_preferences_source_ts
  ON coding_preferences(source_timestamp DESC)
  WHERE source_timestamp IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_coding_decisions_source_ts
  ON coding_decisions(source_timestamp DESC)
  WHERE source_timestamp IS NOT NULL;
