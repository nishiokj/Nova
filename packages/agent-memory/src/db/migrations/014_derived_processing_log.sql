-- Derived Processing Log
--
-- Tracks which entities have been processed by each derived task.
-- Enables skip-already-processed, automatic retry of failures,
-- and reprocessing when config (prompt) changes.

CREATE TABLE IF NOT EXISTS derived_processing_log (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  job_id            TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  config_hash       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error             TEXT,
  entity_updated_at TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core lookup + upsert target: one result per (task, entity, config_hash)
CREATE UNIQUE INDEX IF NOT EXISTS idx_dpl_task_entity_config
  ON derived_processing_log (task_id, entity_id, entity_type, config_hash);

-- Stats and cleanup queries by task
CREATE INDEX IF NOT EXISTS idx_dpl_task_id
  ON derived_processing_log (task_id);

-- Retry queries: find failed entries for a given task + config
CREATE INDEX IF NOT EXISTS idx_dpl_task_config_failed
  ON derived_processing_log (task_id, config_hash, status)
  WHERE status = 'failed';
