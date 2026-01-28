-- Derived Jobs Migration
-- Tracks derived post-processing runs

CREATE TABLE IF NOT EXISTS derived_jobs (
  id TEXT PRIMARY KEY,
  CONSTRAINT derived_jobs_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  retry_count INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  metadata JSONB,
  output_ref TEXT
);

CREATE INDEX IF NOT EXISTS idx_derived_jobs_status ON derived_jobs(status);
CREATE INDEX IF NOT EXISTS idx_derived_jobs_pending ON derived_jobs(priority DESC, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_derived_jobs_task ON derived_jobs(task_id);
