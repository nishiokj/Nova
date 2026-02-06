-- Migration: 034_test_reports
-- Description: Test reports - artifacts from testing WorkItems with category breakdowns
-- Version: 34

CREATE TABLE IF NOT EXISTS test_reports (
  id TEXT PRIMARY KEY,
  CONSTRAINT test_reports_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  session_key TEXT NOT NULL,
  work_item_id TEXT NOT NULL,

  -- Aggregate verdict
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'error', 'skip')),

  -- Category summaries (only categories that ran)
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Individual test cases
  cases JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Evidence
  cli_output TEXT,
  command TEXT,

  -- Optional metrics
  coverage JSONB,
  mutation_score REAL CHECK (mutation_score IS NULL OR (mutation_score >= 0 AND mutation_score <= 100)),

  -- Agent commentary
  agent_note TEXT NOT NULL,

  -- Metadata
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying by session
CREATE INDEX IF NOT EXISTS idx_test_reports_session_key ON test_reports(session_key);

-- Index for querying by work item
CREATE INDEX IF NOT EXISTS idx_test_reports_work_item_id ON test_reports(work_item_id);

-- Index for filtering by verdict
CREATE INDEX IF NOT EXISTS idx_test_reports_verdict ON test_reports(verdict);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_test_reports_created_at ON test_reports(created_at DESC);

-- GIN index for JSONB queries on categories
CREATE INDEX IF NOT EXISTS idx_test_reports_categories ON test_reports USING GIN (categories jsonb_path_ops);

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES (34, 'Test reports - artifacts from testing WorkItems with category breakdowns');
