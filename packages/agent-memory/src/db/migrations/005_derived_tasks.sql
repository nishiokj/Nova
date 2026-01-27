-- Derived Tasks Migration
-- Persistent representation of derived job schedules

CREATE TABLE IF NOT EXISTS derived_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  script_path TEXT NOT NULL,

  -- Execution mode
  mode TEXT NOT NULL CHECK (mode IN ('once', 'recurring', 'event')),
  interval_ms BIGINT DEFAULT NULL,

  -- State
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_job_id TEXT REFERENCES derived_jobs(id) ON DELETE SET NULL,
  next_run_at TIMESTAMPTZ DEFAULT NULL,
  metadata JSONB,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for scheduler: find enabled tasks that are due to run
CREATE INDEX IF NOT EXISTS idx_derived_tasks_scheduler
  ON derived_tasks (enabled, mode, next_run_at)
  WHERE enabled = true;

-- Optional index for name lookups
CREATE INDEX IF NOT EXISTS idx_derived_tasks_name
  ON derived_tasks (name);
