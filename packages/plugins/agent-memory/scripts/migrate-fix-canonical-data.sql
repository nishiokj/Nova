-- Migration: Fix double-serialized JSONB data in canonical_message
-- Date: 2026-01-29
-- Issue: Data was inserted using JSON.stringify()::jsonb which double-serializes
--
-- Run with: psql $DATABASE_URL -f migrate-fix-canonical-data.sql
-- Or: bun run scripts/sql-cli.ts "$(cat migrate-fix-canonical-data.sql)"

BEGIN;

-- Check current state
SELECT
  jsonb_typeof(data) as type,
  COUNT(*) as count
FROM canonical_message
GROUP BY jsonb_typeof(data);

-- Fix string-serialized data (majority of records)
-- The #>> '{}' operator extracts the root as text, then we cast back to jsonb
UPDATE canonical_message
SET data = (data #>> '{}')::jsonb,
    display_text = COALESCE(
      ((data #>> '{}')::jsonb)->>'body_text',
      LEFT(((data #>> '{}')::jsonb)->>'body_text', 200)
    ),
    updated_at = NOW()
WHERE jsonb_typeof(data) = 'string';

-- Fix array-serialized data (take first element and unwrap)
UPDATE canonical_message
SET data = (data->0 #>> '{}')::jsonb,
    display_text = COALESCE(
      ((data->0 #>> '{}')::jsonb)->>'body_text',
      LEFT(((data->0 #>> '{}')::jsonb)->>'body_text', 200)
    ),
    updated_at = NOW()
WHERE jsonb_typeof(data) = 'array';

-- Verify fix
SELECT
  jsonb_typeof(data) as type,
  COUNT(*) as count
FROM canonical_message
GROUP BY jsonb_typeof(data);

-- Show sample of fixed records
SELECT
  id,
  jsonb_typeof(data) as type,
  data->>'entity_type' as entity_type,
  LEFT(data->>'body_text', 50) as body_preview,
  display_text
FROM canonical_message
LIMIT 5;

COMMIT;
