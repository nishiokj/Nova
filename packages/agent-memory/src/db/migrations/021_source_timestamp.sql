-- Migration: 021_source_timestamp
-- Description: Add source_timestamp column to canonical tables for efficient time-based queries
--
-- Problem:
--   - created_at stores ingestion time, not when the event actually occurred
--   - sent_at/occurred_at lives inside JSONB data, which is unindexed for time-range queries
--   - Queries like "show messages from yesterday" are misleading or inefficient
--
-- Solution:
--   - Add indexed source_timestamp column to canonical tables
--   - Populate from data->>'sent_at', data->>'triggered_at', data->>'start_at' etc. during normalization
--   - Use for all temporal queries

-- Add source_timestamp to canonical_message
ALTER TABLE canonical_message
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_canonical_message_source_ts
  ON canonical_message (source_timestamp DESC)
  WHERE source_timestamp IS NOT NULL;

-- Add source_timestamp to canonical_conversation
ALTER TABLE canonical_conversation
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_canonical_conversation_source_ts
  ON canonical_conversation (source_timestamp DESC)
  WHERE source_timestamp IS NOT NULL;

-- Add source_timestamp to canonical_notification
ALTER TABLE canonical_notification
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_canonical_notification_source_ts
  ON canonical_notification (source_timestamp DESC)
  WHERE source_timestamp IS NOT NULL;

-- Add source_timestamp to canonical_event
ALTER TABLE canonical_event
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_canonical_event_source_ts
  ON canonical_event (source_timestamp DESC)
  WHERE source_timestamp IS NOT NULL;

-- Add source_timestamp to canonical_issue
ALTER TABLE canonical_issue
  ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_canonical_issue_source_ts
  ON canonical_issue (source_timestamp DESC)
  WHERE source_timestamp IS NOT NULL;

-- Backfill source_timestamp from JSONB data
-- Message: use sent_at
UPDATE canonical_message
SET source_timestamp = (data->>'sent_at')::timestamptz
WHERE source_timestamp IS NULL
  AND data->>'sent_at' IS NOT NULL;

-- Notification: use triggered_at
UPDATE canonical_notification
SET source_timestamp = (data->>'triggered_at')::timestamptz
WHERE source_timestamp IS NULL
  AND data->>'triggered_at' IS NOT NULL;

-- Event: use start_at
UPDATE canonical_event
SET source_timestamp = (data->>'start_at')::timestamptz
WHERE source_timestamp IS NULL
  AND data->>'start_at' IS NOT NULL;

-- Conversation: use started_at
UPDATE canonical_conversation
SET source_timestamp = (data->>'started_at')::timestamptz
WHERE source_timestamp IS NULL
  AND data->>'started_at' IS NOT NULL;

-- Issue: use created_at from data if available
UPDATE canonical_issue
SET source_timestamp = (data->>'created_at')::timestamptz
WHERE source_timestamp IS NULL
  AND data->>'created_at' IS NOT NULL;

-- Record migration
INSERT INTO schema_migrations (version, description)
VALUES (21, 'Add source_timestamp column to canonical tables')
ON CONFLICT (version) DO NOTHING;
