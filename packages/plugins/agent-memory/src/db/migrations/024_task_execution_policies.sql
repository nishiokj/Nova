-- Task Execution Policies
-- Adds replay policies, failure classification, rate limiting, and timeout configuration

-- Replay Policy (P0)
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS replay_policy TEXT DEFAULT 'always';
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS idempotent INTEGER DEFAULT 1;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS cooldown_ms INTEGER;

-- Timeout Policy (P1)
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS timeout_ms INTEGER DEFAULT 30000;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS heartbeat_interval_ms INTEGER;

-- Rate Limiting (P1)
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS rate_limit_max INTEGER;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS rate_limit_window_ms INTEGER;
ALTER TABLE derived_tasks ADD COLUMN IF NOT EXISTS resource_pool TEXT;

-- Failure Classification (P0)
ALTER TABLE derived_jobs ADD COLUMN IF NOT EXISTS failure_class TEXT;
ALTER TABLE derived_jobs ADD COLUMN IF NOT EXISTS retry_after BIGINT;
ALTER TABLE derived_jobs ADD COLUMN IF NOT EXISTS cost_cents INTEGER;

-- Resource Pools Table (P1)
CREATE TABLE IF NOT EXISTS resource_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  max_concurrent INTEGER DEFAULT 10,
  requests_per_minute INTEGER,
  daily_budget_cents INTEGER,
  current_spend_cents INTEGER DEFAULT 0,
  budget_reset_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_derived_tasks_resource_pool ON derived_tasks(resource_pool);
CREATE INDEX IF NOT EXISTS idx_derived_jobs_failure_class ON derived_jobs(failure_class);

-- Comments
COMMENT ON COLUMN derived_tasks.replay_policy IS 'Replay policy: always, on_failure, once, cooldown';
COMMENT ON COLUMN derived_tasks.idempotent IS 'Whether the task is safe to retry (1=true)';
COMMENT ON COLUMN derived_tasks.cooldown_ms IS 'Minimum time between runs when replay_policy=cooldown';
COMMENT ON COLUMN derived_tasks.timeout_ms IS 'Maximum runtime for a single job execution';
COMMENT ON COLUMN derived_tasks.heartbeat_interval_ms IS 'Expected heartbeat interval for long-running tasks';
COMMENT ON COLUMN derived_tasks.rate_limit_max IS 'Maximum executions within rate_limit_window_ms';
COMMENT ON COLUMN derived_tasks.rate_limit_window_ms IS 'Time window for rate limiting in milliseconds';
COMMENT ON COLUMN derived_tasks.resource_pool IS 'Optional resource pool for shared limits';

COMMENT ON COLUMN derived_jobs.failure_class IS 'Failure classification: transient, rate_limited, resource, permanent, unknown';
COMMENT ON COLUMN derived_jobs.retry_after IS 'Unix timestamp (ms) when retry is allowed';
COMMENT ON COLUMN derived_jobs.cost_cents IS 'Cost of this job execution in cents';

COMMENT ON TABLE resource_pools IS 'Shared resource pools for rate limiting and budget management';
