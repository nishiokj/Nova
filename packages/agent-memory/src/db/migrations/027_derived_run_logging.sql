-- Derived Run Logging + Readability Fields
-- Adds structured run logs/samples plus human-readable fields on tasks.

-- Readability + sanity policy fields on tasks
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS purpose TEXT;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS sanity_policy JSONB;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS last_error_msg TEXT;

-- Structured per-run logging
CREATE TABLE IF NOT EXISTS derived_run_log (
  id TEXT PRIMARY KEY,
  CONSTRAINT derived_run_log_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  job_id TEXT NOT NULL REFERENCES derived_jobs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES derived_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'skipped', 'failed')),
  input_count INTEGER,
  output_count INTEGER,
  output_unusable_count INTEGER,
  model_version TEXT,
  duration_ms INTEGER,
  skip_reason TEXT,
  error_code TEXT,
  error_msg TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_derived_run_log_job ON derived_run_log(job_id);
CREATE INDEX IF NOT EXISTS idx_derived_run_log_task ON derived_run_log(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_derived_run_log_status ON derived_run_log(status);

-- Small sample outputs per run for quick sanity checks
CREATE TABLE IF NOT EXISTS derived_run_samples (
  run_id TEXT NOT NULL REFERENCES derived_run_log(id) ON DELETE CASCADE,
  sample_index INTEGER NOT NULL,
  label TEXT,
  sample JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, sample_index)
);

CREATE INDEX IF NOT EXISTS idx_derived_run_samples_run ON derived_run_samples(run_id);
