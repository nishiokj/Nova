-- Sync Tasks Migration
-- Persistent representation of sync subscriptions

CREATE TABLE sync_tasks (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- What to sync
  entity_types TEXT[] DEFAULT NULL,  -- NULL = all entity types
  sync_type TEXT NOT NULL CHECK (sync_type IN ('backfill', 'incremental')),

  -- Execution mode
  mode TEXT NOT NULL CHECK (mode IN ('once', 'recurring', 'webhook')),
  interval_ms BIGINT DEFAULT NULL,

  -- State
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_job_id TEXT REFERENCES sync_jobs(id) ON DELETE SET NULL,
  next_run_at TIMESTAMPTZ DEFAULT NULL,
  webhook_subscription_id TEXT DEFAULT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for scheduler: find enabled tasks that are due to run
CREATE INDEX idx_sync_tasks_scheduler
  ON sync_tasks (enabled, mode, next_run_at)
  WHERE enabled = true;

-- Index for looking up tasks by account
CREATE INDEX idx_sync_tasks_account
  ON sync_tasks (account_id);

-- Prevent duplicate active tasks for same account/connector/entityTypes/syncType
CREATE UNIQUE INDEX idx_sync_tasks_unique
  ON sync_tasks (account_id, connector, sync_type, COALESCE(entity_types::text, ''))
  WHERE enabled = true;
